package dev.boujoy.personalagent;

import android.os.SystemClock;
import android.util.Log;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import org.json.JSONArray;
import org.json.JSONObject;

/** One command lane for the authenticated display protocol; no action is retried or sent to display 0. */
public final class DisplayExecutor implements AutoCloseable {
    public interface Backend {
        JSONObject status();
        /** Must be a nonblocking local snapshot; invoked from an injection permit callback. */
        JSONObject session();
        JSONObject open(JSONObject args) throws Exception;
        void close() throws Exception;
        JSONObject screenshot(int maxDimension) throws Exception;
        default JSONObject screenshot(int maxDimension,BooleanSupplier allowed) throws Exception {
            if(!allowed.getAsBoolean())throw new BackendException("LOCALLY_PAUSED",false);
            return screenshot(maxDimension);
        }
        JSONObject effect(String op, JSONObject args, BooleanSupplier allowed) throws Exception;
        JSONArray listApps() throws Exception;
        default void markContentChanged() throws Exception {}
        /** Brings this session's pages back from the main display. Never required for correctness. */
        default void recallStray() throws Exception {}
        default JSONObject handoff(JSONObject session,JSONObject args,BooleanSupplier allowed)throws Exception {throw new BackendException("UNSUPPORTED_ON_DISPLAY",false);}
        /** Local invalidation must not block on Binder. */
        default void abandonHandoff(String reason) {}
        default void idleHandoff() {}
    }
    /** started=false is valid only when the backend knows no event/launch was attempted. */
    public static class BackendException extends Exception {
        public final String code;
        public final boolean started;
        public BackendException(String code, boolean started) { super(code); this.code=code; this.started=started; }
    }
    private final ControlState gate;
    private final Backend backend;
    private final Supplier<String> deviceId;
    private final LongSupplier now;
    private final BooleanSupplier locked;
    private final String instance=UUID.randomUUID().toString();
    private final AtomicLong sequence=new AtomicLong();
    private final AtomicLong revision=new AtomicLong();
    private final DisplayCommandGuard guard=new DisplayCommandGuard();
    private final Object operationLock=new Object();
    private final Object lifecycleLock=new Object();
    private final ExecutorService cleanup=Executors.newSingleThreadExecutor();
    private final Set<String> seen=new LinkedHashSet<>();
    private final Set<String> nodeIds=new HashSet<>();
    private volatile long lastCommandAt;
    private volatile JSONObject activeSession;
    private record ActiveTask(String taskId, DisplayCommandGuard.Session session, long revision) {}
    private ActiveTask activeTask; // Guarded by lifecycleLock; never derived from task-list ordering.
    private volatile boolean closed;
    private static final Set<String> EFFECTS=Set.of("launch_app","tap","long_press","swipe","scroll","input_text","back");
    private static final Set<String> WITHOUT_SESSION=Set.of("status","list_apps","session_open");

    public DisplayExecutor(ControlState gate, Backend backend, Supplier<String> deviceId, LongSupplier serverNow, BooleanSupplier locked) {
        this.gate=gate;this.backend=backend;this.deviceId=deviceId;this.now=serverNow;this.locked=locked;lastCommandAt=serverNow.getAsLong();
    }
    public JSONObject status() {
        try {
            JSONObject value=new JSONObject(backend.status().toString());
            boolean service=BoujoyDisplayService.isConnected();
            boolean keyguard=locked.getAsBoolean();
            boolean ready=!closed&&service&&value.optBoolean("userService",false)&&"running".equals(value.optString("shizuku"))&&!keyguard;
            value.put("protocol",1).put("executorService",service).put("session",nullable(backend.session())).put("ready",ready);
            if(keyguard)value.put("reason","locked");
            else if(!service)value.put("reason","executor_service_disabled");
            else if(ready)value.put("reason",JSONObject.NULL);
            return value;
        }catch(Exception error){return Tunnel.json("protocol",1,"shizuku","not_running","executorService",BoujoyDisplayService.isConnected(),
                "userService",false,"session",JSONObject.NULL,"rear",Tunnel.json("available",false,"showing",false),"ready",false,"reason","user_service_unavailable");}
    }
    /** Invalidates evidence immediately. Releasing binder resources happens away from the caller/UI. */
    public void invalidate(String reason) {
        final JSONObject stale;
        synchronized(lifecycleLock){stale=activeSession;activeSession=null;activeTask=null;revision.incrementAndGet();guard.invalidate(stale);BoujoyDisplayService.setSessionDisplay(-1);}
        backend.abandonHandoff(reason);
        if(closed)return;
        try {cleanup.execute(()->{synchronized(operationLock){
            JSONObject current=backend.session();
            if(DisplayCommandGuard.Session.read(stale)!=null&&DisplayCommandGuard.Session.read(stale).equals(DisplayCommandGuard.Session.read(current))) {
                try{backend.close();}catch(Exception ignored){}
            }
        }});}catch(java.util.concurrent.RejectedExecutionException ignored){}
    }
    private void setActiveSession(JSONObject value){synchronized(lifecycleLock){
        activeSession=value;
        if(activeTask!=null&&!activeTask.session().equals(DisplayCommandGuard.Session.read(value)))activeTask=null;
    }}
    /** Local presentation hint only. Never invent a task or retain one across session replacement. */
    public String activeTaskId(){
        synchronized(lifecycleLock){
            if(activeTask==null)return "";
            JSONObject current=backend.session();
            if(closed||gate.paused()||activeTask.revision()!=revision.get()
                    ||!activeTask.session().equals(DisplayCommandGuard.Session.read(current))
                    ||!guard.validSession(activeSession,current)){
                activeTask=null;return "";
            }
            return activeTask.taskId();
        }
    }
    /** Called only after the operation's admission/argument/evidence prechecks have passed. */
    private void rememberActiveTask(JSONObject command,JSONObject session,long expectedRevision){
        synchronized(lifecycleLock){
            if(closed||revision.get()!=expectedRevision||!admitted(command)||!guard.validSession(session,backend.session()))return;
            Object task=command.opt("taskId");
            String id=task instanceof String?(String)task:"";
            activeTask=id.isBlank()?null:new ActiveTask(id,DisplayCommandGuard.Session.read(session),expectedRevision);
        }
    }
    /** Only an established identity disappearing/changing revokes; an initial empty backend is normal. */
    public void reconcileLifecycle() {
        synchronized(lifecycleLock){
            DisplayCommandGuard.Session expected=DisplayCommandGuard.Session.read(activeSession);
            if(expected!=null&&!expected.equals(DisplayCommandGuard.Session.read(backend.session())))invalidate("session_lost");
        }
    }
    public void idleTick() {
        if(!closed)backend.idleHandoff();
        if(!closed&&backend.session()!=null&&now.getAsLong()-lastCommandAt>=600000)invalidate("idle_timeout");
    }
    @Override public void close() {
        if(closed)return;
        invalidate("executor_closed");closed=true;cleanup.shutdown();
    }
    public JSONObject execute(JSONObject command) {
        synchronized(operationLock) {
            String id=command==null?"":command.optString("id","");
            JSONObject session=backend.session();setActiveSession(session);
            String op=command==null?"":command.optString("op","");
            boolean dispatched=false;
            try {
                if(command==null||id.isEmpty()||id.length()>200)throw new BackendException("INVALID_COMMAND",false);
                if(seen.contains(id))throw new BackendException("DUPLICATE_COMMAND",false);
                if(seen.size()>=50000)throw new BackendException("EXECUTOR_CAPACITY",false);
                seen.add(id); // Preserve for this process lifetime: an effect ID is never replayed.
                long rev=revision.get();
                preflight(command,session,rev);
                JSONObject args=command.optJSONObject("args");if(args==null)args=new JSONObject();
                lastCommandAt=now.getAsLong();
                if("status".equals(op))return Tunnel.json("state",status());
                if("list_apps".equals(op))return Tunnel.json("apps",backend.listApps());
                if("session_open".equals(op)) {
                    validateDimensions(args);
                    if(session!=null&&!guard.validSession(session,session)){setActiveSession(null);backend.close();session=null;}
                    preflight(command,session,rev);
                    session=backend.open(args);setActiveSession(session);
                    if(DisplayCommandGuard.Session.read(session)==null)throw new BackendException("SESSION_STALE",false);
                    if(revision.get()!=rev||!admitted(command)){guard.invalidate(session);backend.close();throw new BackendException("LOCALLY_PAUSED",false);}
                    BoujoyDisplayService.setSessionDisplay(session.getInt("displayId"));
                    rememberActiveTask(command,session,rev);
                    return Tunnel.json("session",session);
                }
                if("session_close".equals(op)) {guard.invalidate(session);BoujoyDisplayService.setSessionDisplay(-1);setActiveSession(null);backend.close();return Tunnel.json("closed",true);}
                if("session_handoff".equals(op)) {
                    validateHandoff(args);
                    final JSONObject handed=session;final long handoffRevision;
                    synchronized(lifecycleLock){
                        preflight(command,session,rev);
                        guard.invalidate(session);forgetEvidence();activeSession=null;activeTask=null;
                        handoffRevision=revision.incrementAndGet();BoujoyDisplayService.setSessionDisplay(-1);
                    }
                    try {
                        JSONObject result=backend.handoff(handed,args,()->revision.get()==handoffRevision&&admitted(command)&&BoujoyDisplayService.isConnected());
                        return Tunnel.json("handoff",result);
                    }catch(Exception failed){
                        // Old evidence stays revoked even if handoff creation cannot be confirmed.
                        backend.abandonHandoff("handoff_unconfirmed");
                        if(DisplayCommandGuard.Session.read(handed).equals(DisplayCommandGuard.Session.read(backend.session())))try{backend.close();}catch(Exception ignored){}
                        throw failed;
                    }
                }
                if("observe".equals(op))return Tunnel.json("observation",observe(command,args,session,rev));
                if(!EFFECTS.contains(op))throw new BackendException("UNSUPPORTED_ON_DISPLAY",false);
                final JSONObject expectedSession=session;
                final long expectedRevision=rev;
                BooleanSupplier allowed=()->sessionAllowed(command,expectedSession,expectedRevision);
                if("launch_app".equals(op)) {
                    String pkg=args.optString("package_name","");
                    if(!pkg.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+"))throw new BackendException("INVALID_ARGUMENT",false);
                    preflight(command,session,rev);forgetEvidence();
                    rememberActiveTask(command,session,rev);
                    dispatched=true;JSONObject result=backend.effect(op,args,allowed);
                    // A successful start request still needs evidence of its actual destination.
                    if(result==null)result=new JSONObject();
                    result.put("landing",landing(expectedSession,pkg,allowed));
                    return merge(receipt(id,"executed",true,null,expectedSession),result);
                }
                BoujoyDisplayService.setSessionDisplay(session.getInt("displayId"));
                // Back has no target element or coordinates. Still verify the live window, session and epoch.
                try(BoujoyDisplayService.Frame frame=BoujoyDisplayService.snapshot(session.getInt("displayId"),!"back".equals(op))) {
                    String failure=guard.checkObservation(session,args,frame.windowId,frame.packageName,frame.uiVersion);
                    if(failure!=null)throw new BackendException(failure,false);
                    if(Set.of("long_press","scroll","input_text").contains(op)&&!nodeIds.contains(args.optString("element_id","")))throw new BackendException("TARGET_MISSING",false);
                    validateCoordinates(op,args,session,frame.tree);
                    JSONObject effective="long_press".equals(op)?BoujoyDisplayService.nodeArguments(frame,op,args):args;
                    if("long_press".equals(op))validateCoordinates("tap",effective,session,frame.tree);
                    preflight(command,session,rev);
                    if(!frame.stillCurrent())throw new BackendException("STALE_OBSERVATION",false);
                    rememberActiveTask(command,session,rev);
                    // Consume the observation before dispatch. Unknown or completed effects both require a fresh read.
                    forgetEvidence();
                    if("input_text".equals(op)||"scroll".equals(op)) {
                        // Fence the old frame before the node action can produce its only new frame.
                        try{backend.markContentChanged();}catch(Exception barrierFailure){throw new BackendException("FRAME_BARRIER_UNAVAILABLE",false);}
                        dispatched=true;BoujoyDisplayService.nodeEffect(frame,op,effective,allowed);
                        return receipt(id,"executed",true,null,expectedSession);
                    }
                    dispatched=true;JSONObject result=backend.effect(op,effective,allowed);
                    return merge(receipt(id,"executed",true,null,expectedSession),result);
                }
            }catch(BackendException error) {
                if(error.started)forgetEvidence();
                if("observe".equals(op))return Tunnel.json("observation",failedObservation(error.code,session));
                return receipt(id,error.started?"unknown":"failed",error.started,error.code,session);
            }catch(Exception error) {
                if(dispatched)forgetEvidence();
                if("observe".equals(op))return Tunnel.json("observation",failedObservation("OBSERVATION_INCONSISTENT",session));
                return receipt(id,dispatched?"unknown":"failed",dispatched,dispatched?"ACTION_UNCONFIRMED":"EXECUTOR_ERROR",session);
            }
        }
    }
    private void forgetEvidence(){guard.forgetObservation();nodeIds.clear();}
    private JSONObject observe(JSONObject command, JSONObject args, JSONObject session, long rev) throws Exception {
        final long begin=SystemClock.elapsedRealtime();long treeMs=-1,screenshotMs=-1,recheckMs=-1;boolean success=false;String errorCode="OBSERVATION_INCONSISTENT";JSONObject treeDiagnostics=null;
        try {
            String mode=args.optString("mode","both");
            if(!Set.of("tree","screenshot","both").contains(mode))throw new BackendException("INVALID_ARGUMENT",false);
            int max=args.optInt("max_dimension",1440);if(max<128||max>1440)throw new BackendException("INVALID_ARGUMENT",false);
            rememberActiveTask(command,session,rev);
            BoujoyDisplayService.setSessionDisplay(session.getInt("displayId"));forgetEvidence();
            try{backend.recallStray();}catch(Exception ignored){ /* The read reports what is on the display. */ }
            BoujoyDisplayService.Frame captured;long part=SystemClock.elapsedRealtime();
            try{captured=BoujoyDisplayService.snapshot(session.getInt("displayId"),!"screenshot".equals(mode));}
            finally{treeMs=SystemClock.elapsedRealtime()-part;}
            try(BoujoyDisplayService.Frame frame=captured) {
                treeDiagnostics=treeDiagnostics(frame.tree);
                JSONObject screenshot;
                part=SystemClock.elapsedRealtime();
                try{screenshot="tree".equals(mode)?Tunnel.json("available",false):backend.screenshot(max,()->sessionAllowed(command,session,rev));}
                catch(BackendException error){
                    if(Set.of("SESSION_STALE","EXECUTOR_UNAVAILABLE","LOCALLY_PAUSED","LOCKED").contains(error.code))throw error;
                    throw new BackendException("FRAME_UNAVAILABLE",false);
                }catch(Exception error){throw new BackendException("FRAME_UNAVAILABLE",false);}
                finally{if(!"tree".equals(mode))screenshotMs=SystemClock.elapsedRealtime()-part;}
                preflight(command,session,rev);
                part=SystemClock.elapsedRealtime();
                try(BoujoyDisplayService.Frame after=BoujoyDisplayService.snapshot(session.getInt("displayId"),false)) {
                    if(!frame.stillCurrent()||frame.windowId!=after.windowId||!frame.packageName.equals(after.packageName))throw new BackendException("WINDOW_CHANGED",false);
                }finally{recheckMs=SystemClock.elapsedRealtime()-part;}
                if(!"tree".equals(mode)&&!validScreenshot(screenshot,session))throw new BackendException("FRAME_UNAVAILABLE",false);
                // Autoplaying feeds change while the tree is walked (a child vanishes mid-walk).
                // Like Phone Use, such a tree is still returned when nothing was cut off and the
                // window and package held across the read; the Mac accepts it only with this
                // capture record. A truncated tree is still a failed read.
                boolean treeWhole=frame.tree.optBoolean("collection_complete");
                boolean treeUsable=usableTree(frame.tree);
                boolean complete=("screenshot".equals(mode)||treeUsable)
                        &&("tree".equals(mode)||screenshot.optBoolean("available"));
                if(!complete)throw new BackendException("OBSERVATION_INCONSISTENT",false);
                JSONObject diagnostics=Tunnel.json("tree",treeDiagnostics);
                if(!"screenshot".equals(mode)&&!treeWhole)diagnostics.put("capture_diagnostics_truncated",false).put("captures",new JSONArray().put(Tunnel.json(
                        "before_window_id",frame.windowId,"after_window_id",frame.windowId,"before_package_name",frame.packageName,"after_package_name",frame.packageName,"inconsistency_reason",JSONObject.NULL)));
                String observationId=instance+":"+sequence.incrementAndGet();
                JSONObject result=Tunnel.json("observation_status","complete","device_id",deviceId.get(),"service_instance_id",instance,
                        "observation_id",observationId,"captured_at_ms",Math.max(now.getAsLong(),Math.max(frame.tree.optLong("finished_at_ms"),screenshot.optLong("finished_at_ms"))),
                        "package_name",frame.packageName,"window_id",frame.windowId,"ui_version",frame.uiVersion,
                        "display",Tunnel.json("id",session.getInt("displayId"),"width",session.getInt("width"),"height",session.getInt("height"),
                                "rotation",0,"coordinates","physical_pixels","origin","top_left","includes_system_bars_and_ime",true),
                        "display_session",session,"windows",frame.windows,"tree",frame.tree,"screenshot",screenshot);
                if(diagnostics!=null)result.put("diagnostics",diagnostics);
                synchronized(lifecycleLock){
                    preflight(command,session,rev);
                    guard.observed(observationId,session,frame.windowId,frame.packageName,frame.uiVersion);
                    JSONArray nodes=frame.tree.optJSONArray("elements");if(nodes!=null)for(int i=0;i<nodes.length();i++)nodeIds.add(nodes.getJSONObject(i).getString("element_id"));
                }
                success=true;errorCode=null;return result;
            }
        }catch(BackendException error){
            errorCode=error.code;JSONObject failure=failedObservation(error.code,session);
            if(treeDiagnostics!=null)failure.put("diagnostics",Tunnel.json("tree",treeDiagnostics));return failure;
        }
        finally{
            try{Log.i("BoujoyDisplayTiming",Tunnel.json("cmdId",command.optString("id"),"sessionId",session==null?JSONObject.NULL:session.opt("sessionId"),
                    "generation",session==null?JSONObject.NULL:session.opt("generation"),"displayId",session==null?JSONObject.NULL:session.opt("displayId"),
                    "tree_ms",treeMs<0?JSONObject.NULL:treeMs,"screenshot_ms",screenshotMs<0?JSONObject.NULL:screenshotMs,
                    "window_recheck_ms",recheckMs<0?JSONObject.NULL:recheckMs,"observe_total_ms",SystemClock.elapsedRealtime()-begin,
                    "success",success,"errorCode",nullable(errorCode),"tree_diagnostics",nullable(treeDiagnostics)).toString());}catch(Exception ignored){}
        }
    }
    static boolean usableTree(JSONObject tree){
        // Completeness is advisory for a changing tree; truncation is always a hard boundary.
        return tree!=null&&Boolean.TRUE.equals(tree.opt("available"))
                &&Boolean.FALSE.equals(tree.opt("collection_truncated"))&&Boolean.FALSE.equals(tree.opt("truncated"));
    }
    private static JSONObject treeDiagnostics(JSONObject tree){
        JSONObject summary=Tunnel.json("available",tree.optBoolean("available"),"collection_complete",tree.optBoolean("collection_complete"),
                "collection_truncated",tree.optBoolean("collection_truncated"),"truncated",tree.optBoolean("truncated"),
                "output_nodes",tree.optInt("output_nodes",-1),"collected_nodes",tree.optInt("collected_nodes",-1));
        JSONObject counts=tree.optJSONObject("diagnostics"),safe=new JSONObject();
        for(String key:new String[]{"missing_children","foreign_package_nodes","foreign_window_nodes","node_limit_hits","depth_limit_hits"}){
            Object value=counts==null?null:counts.opt(key);
            try{safe.put(key,value instanceof Number&&((Number)value).longValue()>=0?value:JSONObject.NULL);}catch(Exception ignored){}
        }
        try{summary.put("collection_counters",safe);}catch(Exception ignored){}return summary;
    }
    private static void validateHandoff(JSONObject args)throws BackendException{
        Object task=args.opt("task_id"),title=args.opt("title"),summary=args.opt("summary");
        if(!(task instanceof String)||((String)task).isBlank()||((String)task).length()>128
                ||!(title instanceof String)||((String)title).codePointCount(0,((String)title).length())>40
                ||!(summary instanceof String)||((String)summary).codePointCount(0,((String)summary).length())>160)throw new BackendException("INVALID_ARGUMENT",false);
    }
    private JSONObject failedObservation(String code,JSONObject session) {
        String mapped=switch(code){
            case "WINDOW_CHANGED", "STALE_OBSERVATION" -> "OBSERVATION_INCONSISTENT";
            case "NO_FRAME", "SCREENSHOT_UNAVAILABLE", "FRAME_UNAVAILABLE" -> "FRAME_UNAVAILABLE";
            default -> code;
        };
        return Tunnel.json("observation_status","failed","device_id",deviceId.get(),"service_instance_id",instance,
                "captured_at_ms",now.getAsLong(),"display_session",nullable(session),"error",Tunnel.json("code",mapped,"message",mapped));
    }
    private JSONObject landing(JSONObject session,String pkg,BooleanSupplier allowed) throws Exception {
        int display=session.getInt("displayId");
        long end=System.nanoTime()+4_000_000_000L; // a cold start with a splash screen needs more than a second or two
        do {
            if(!allowed.getAsBoolean())break;
            try(BoujoyDisplayService.Frame frame=BoujoyDisplayService.snapshot(display,false)) {
                if(pkg.equals(frame.packageName)&&frame.stillCurrent())return Tunnel.json("displayId",display,"packageName",pkg,"windowId",frame.windowId,"onSessionDisplay",true);
            }catch(BackendException absent){ /* No session-window evidence yet; never read another display. */ }
            catch(Exception unavailable){break;}
            if(System.nanoTime()>=end)break;
            Thread.sleep(120);
        }while(true);
        return Tunnel.json("displayId",JSONObject.NULL,"packageName",pkg,"windowId",JSONObject.NULL,"onSessionDisplay",false);
    }
    private static boolean validScreenshot(JSONObject screenshot,JSONObject session) {
        if(screenshot==null||!screenshot.optBoolean("available")||screenshot.optString("data_base64","").isEmpty())return false;
        double width=screenshot.optDouble("width",0)*screenshot.optDouble("scale_x",0);
        double height=screenshot.optDouble("height",0)*screenshot.optDouble("scale_y",0);
        return Math.abs(width-session.optInt("width"))<0.01&&Math.abs(height-session.optInt("height"))<0.01;
    }
    private boolean available() {
        JSONObject status=backend.status();return BoujoyDisplayService.isConnected()&&status.optBoolean("userService",false)&&"running".equals(status.optString("shizuku"));
    }
    private boolean admitted(JSONObject command) {
        return !closed&&DisplayCommandGuard.admission(gate,command.optLong("controlEpoch",-1),command.optLong("deadlineAtMs",0),now.getAsLong(),locked.getAsBoolean())==null;
    }
    /** A capture or effect permit must remain callable while execute holds operationLock. */
    private boolean sessionAllowed(JSONObject command,JSONObject session,long rev) {
        return revision.get()==rev&&admitted(command)
                &&guard.validSession(command.optJSONObject("session"),session)
                &&guard.validSession(session,backend.session())&&BoujoyDisplayService.isConnected();
    }
    private void preflight(JSONObject command,JSONObject session,long rev) throws BackendException {
        String error=DisplayCommandGuard.admission(gate,command.optLong("controlEpoch",-1),command.optLong("deadlineAtMs",0),now.getAsLong(),locked.getAsBoolean());
        if(closed||revision.get()!=rev)error="LOCALLY_PAUSED";
        if(error!=null)throw new BackendException(error,false);
        if(!available())throw new BackendException("EXECUTOR_UNAVAILABLE",false);
        String op=command.optString("op","");
        if(!WITHOUT_SESSION.contains(op)&&(!guard.validSession(command.optJSONObject("session"),session)
                ||!guard.validSession(session,backend.session())))throw new BackendException("SESSION_STALE",false);
    }
    private static void validateDimensions(JSONObject args)throws BackendException {
        for(String key:Set.of("width","height"))if(args.has(key)&&(args.optInt(key,-1)<240||args.optInt(key,-1)>4096))throw new BackendException("INVALID_ARGUMENT",false);
        if(args.has("densityDpi")&&(args.optInt("densityDpi",-1)<120||args.optInt("densityDpi",-1)>640))throw new BackendException("INVALID_ARGUMENT",false);
    }
    private static void validateCoordinates(String op,JSONObject args,JSONObject session,JSONObject tree)throws Exception {
        if("tap".equals(op)) {
            double x=args.optDouble("x",Double.NaN),y=args.optDouble("y",Double.NaN);point(x,y,session);
            JSONArray elements=tree.optJSONArray("elements");
            if(elements!=null)for(int i=0;i<elements.length();i++) {
                JSONObject node=elements.optJSONObject(i);if(node==null||!node.optBoolean("password"))continue;
                JSONArray b=node.optJSONArray("bounds");if(b!=null&&b.length()==4&&x>=b.optInt(0)&&x<b.optInt(2)&&y>=b.optInt(1)&&y<b.optInt(3))throw new BackendException("PROTECTED_INPUT",false);
            }
        } else if("swipe".equals(op)) {
            JSONArray points=args.optJSONArray("points");if(points==null||points.length()!=2)throw new BackendException("INVALID_ARGUMENT",false);
            for(int i=0;i<points.length();i++){JSONObject p=points.optJSONObject(i);if(p==null)throw new BackendException("INVALID_ARGUMENT",false);point(p.optDouble("x",Double.NaN),p.optDouble("y",Double.NaN),session);}
            validateCoordinates("tap",points.getJSONObject(0),session,tree);
            int duration=args.optInt("duration_ms",-1);if(duration<50||duration>3000)throw new BackendException("INVALID_ARGUMENT",false);
        }
    }
    private static void point(double x,double y,JSONObject session)throws BackendException {
        if(!Double.isFinite(x)||!Double.isFinite(y)||x<0||y<0||x>=session.optInt("width")||y>=session.optInt("height"))throw new BackendException("INVALID_ARGUMENT",false);
    }
    private JSONObject receipt(String id,String state,boolean executed,String code,JSONObject session) {
        JSONObject request=Tunnel.json("request_id",id,"state",state,"action_executed",executed);
        if(code!=null)try{request.put("error",Tunnel.json("code",code,"message",code));}catch(Exception ignored){}
        return Tunnel.json("request",request,"device_id",deviceId.get(),"service_instance_id",instance,"session",nullable(session));
    }
    private static Object nullable(Object value){return value==null?JSONObject.NULL:value;}
    private static JSONObject merge(JSONObject target,JSONObject fields)throws Exception {
        if(fields!=null&&fields.has("landing"))target.put("landing",fields.get("landing"));return target;
    }
}
