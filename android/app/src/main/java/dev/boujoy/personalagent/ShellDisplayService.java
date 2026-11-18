package dev.boujoy.personalagent;

import android.app.KeyguardManager;
import android.content.AttributionSource;
import android.content.ComponentName;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.Binder;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Display;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.KeyEvent;
import android.view.MotionEvent;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/** Narrow shell-only service. No arbitrary shell. Main-display movement is limited to an explicitly accepted handoff. */
public final class ShellDisplayService extends IShellDisplay.Stub {
    private final Context shell;
    private final int ownerUid;
    private final String ownerPackage;
    private final DisplayManager displays;
    private final HandlerThread thread = new HandlerThread("Boujoy-display-surface");
    private final Handler handler;
    private final AtomicLong revocation = new AtomicLong();
    private volatile IBinder client;
    private final RearSleepLease rearSleepLease=RearSleepLease.create();
    private IBinder.DeathRecipient clientDeath;
    private VirtualDisplay virtualDisplay;
    private volatile ImageReader reader;
    private JSONObject session;
    private final DisplayHandoff handoff=new DisplayHandoff();
    private HandoffTaskMover.Root heldTarget;
    // Tasks that belong to the current session: seen on its display, or started by an app that
    // was on it after the session opened (task IDs only grow). Used to bring back pages an app
    // opened on the main display (application-context launches follow the top focused display,
    // and the session display never takes top focus).
    private final java.util.Set<Integer> sessionTaskIds=new java.util.HashSet<>();
    private final java.util.Set<String> sessionPackages=new java.util.HashSet<>();
    private int sessionTaskFloor=Integer.MAX_VALUE;
    private Bitmap latestFrame;
    private long latestFrameAt, latestFrameNanos, latestFrameReceivedNanos, minimumFrameNanos;
    private long readerGeneration, latestFrameReaderGeneration;
    private long recoveredBarrierNanos = -1;
    private String lastFrameIssue = "no_frame";
    private static final long MAX_FRAME_RECEIVE_DELAY_NANOS = 5_000_000_000L;
    private long lastCommandElapsed;
    // Lock order: service monitor -> frameLock. Frame callbacks never enter the service monitor.
    // Also owns ImageReader acquisition/copy/Image.close and reader.close lifetimes.
    private final Object frameLock = new Object();
    private volatile boolean attached, keyguardKnown;
    private final Runnable idle = new Runnable() {
        @Override public void run() {
            synchronized (ShellDisplayService.this) {
                expireHandoff();
                if (session != null && !handoff.retaining() && SystemClock.elapsedRealtime() - lastCommandElapsed > 600_000) closeDisplay();
            }
            handler.postDelayed(this, 30_000);
        }
    };

    public ShellDisplayService(Context context) throws Exception {
        if(!BuildConfig.BACKGROUND_SUPPORTED)throw new SecurityException("background_not_supported");
        if (android.os.Process.myUid() != 2000) throw new SecurityException("shell_identity_required");
        ownerUid = context.getApplicationInfo().uid;
        ownerPackage = context.getPackageName();
        shell = new ContextWrapper(context) {
            @Override public String getPackageName() { return "com.android.shell"; }
            @Override public String getOpPackageName() { return "com.android.shell"; }
            @Override public AttributionSource getAttributionSource() {
                return new AttributionSource.Builder(2000).setPackageName("com.android.shell").build();
            }
            @Override public Context getApplicationContext() { return this; }
        };
        Constructor<DisplayManager> ctor = DisplayManager.class.getDeclaredConstructor(Context.class);
        ctor.setAccessible(true);
        displays = ctor.newInstance(shell);
        thread.start(); handler = new Handler(thread.getLooper());
        handler.postDelayed(idle, 30_000);
        displays.registerDisplayListener(new DisplayManager.DisplayListener() {
            public void onDisplayAdded(int id) {}
            public void onDisplayChanged(int id) {
                synchronized(ShellDisplayService.this){
                    if(session!=null&&session.optInt("displayId",-1)==id&&!ownedGeometryValid())closeDisplay();
                }
            }
            public void onDisplayRemoved(int id) {
                if(id==1)rearSleepLease.revoke();
                synchronized (ShellDisplayService.this) {
                    if (session != null && session.optInt("displayId", -1) == id) closeDisplay();
                }
            }
        }, handler);
    }
    private void owner() {
        if (Binder.getCallingUid() != ownerUid) throw new SecurityException("owner_uid_required");
    }
    @Override public synchronized void attach(IBinder token) {
        owner();
        if (token == null) throw new IllegalArgumentException("client_required");
        if (client != null && clientDeath != null) client.unlinkToDeath(clientDeath, 0);
        if(client!=null&&client!=token){revocation.incrementAndGet();rearSleepLease.revoke();closeDisplay();}
        client = token; attached = true;
        clientDeath = () -> { attached = false; revocation.incrementAndGet(); rearSleepLease.revoke(); synchronized (this) { closeDisplay(); } };
        try { token.linkToDeath(clientDeath, 0); } catch (Exception e) { attached = false; rearSleepLease.revoke(); closeDisplay(); }
    }
    @Override public void revoke() { owner(); revocation.incrementAndGet(); rearSleepLease.revoke(); }
    @Override public void destroy() {
        int uid = Binder.getCallingUid();
        if (uid != ownerUid && uid != 2000 && uid != 0) throw new SecurityException("owner_uid_required");
        attached = false; revocation.incrementAndGet(); rearSleepLease.revoke();
        synchronized (this) { closeDisplay(); }
        thread.quitSafely(); System.exit(0);
    }
    private boolean locked() {
        try {
            Class<?> global=Class.forName("android.view.WindowManagerGlobal");
            Object service=global.getDeclaredMethod("getWindowManagerService").invoke(null);
            Method query=Class.forName("android.view.IWindowManager").getMethod("isKeyguardLocked");
            boolean value=(Boolean)query.invoke(service);keyguardKnown=true;return value;
        } catch (Exception e) { keyguardKnown=false;return true; }
    }
    // The main screen may be locked only when the user's background mode allows it
    // and this session's display is itself always unlocked (or is about to be created so).
    private void permitted(IDisplayPermit permit, long epoch) throws Exception { permitted(permit, epoch, false); }
    private void permitted(IDisplayPermit permit, long epoch, boolean opening) throws Exception {
        if (!attached || client == null || !client.isBinderAlive() || epoch != revocation.get()) throw new Failure("LOCALLY_PAUSED", false);
        if (locked() && !((opening || sessionAlwaysUnlocked()) && permit != null && permit.permitsWhileLocked())) throw new Failure("LOCKED", false);
        if (permit == null || !permit.permits()) throw new Failure("LOCALLY_PAUSED", false);
    }
    /** Rear progress is a separate physical display and needs no active virtual session. */
    static String rearPermissionFailure(boolean ownerLive,long expectedEpoch,long actualEpoch,boolean keyguardLocked,boolean backgroundAllowed,boolean callerAllowed){
        if(!ownerLive||expectedEpoch!=actualEpoch)return "LOCALLY_PAUSED";
        if(keyguardLocked&&!backgroundAllowed)return "LOCKED";
        return callerAllowed?null:"LOCALLY_PAUSED";
    }
    // Wake paths that lit the main screen or do not exist on this system are not tried again in this process.
    private static final java.util.Set<String> REAR_WAKE_BANNED=java.util.concurrent.ConcurrentHashMap.newKeySet();
    private boolean displayOn(int displayId){
        try{Display display=displays.getDisplay(displayId);return display!=null&&display.getState()==Display.STATE_ON;}
        catch(RuntimeException unavailable){return false;}
    }
    private boolean awaitDisplayOn(int displayId,long timeoutMs){
        long end=SystemClock.elapsedRealtime()+timeoutMs;
        while(true){
            if(displayOn(displayId))return true;
            if(SystemClock.elapsedRealtime()>=end)return false;
            SystemClock.sleep(50);
        }
    }
    /**
     * Lights the rear panel only, and only when both panels are off. While the phone is awake
     * the launch itself lights the rear panel. Each path is checked after use: one that turns
     * the main screen on is never used again (the lock screen then times out by itself);
     * nothing here unlocks the phone or changes a setting.
     */
    private String wakeRearDisplay(int rearId){
        if(displayOn(rearId))return "already_on";
        if(displayOn(Display.DEFAULT_DISPLAY))return "main_on";
        StringBuilder trail=new StringBuilder();
        for(String path:new String[]{"power_display","wake_key"}){
            if(REAR_WAKE_BANNED.contains(path)){trail.append(path).append(":skipped ");continue;}
            try{
                if("power_display".equals(path))wakeByPowerManager(rearId);else wakeByKey(rearId);
            }catch(Throwable unavailable){REAR_WAKE_BANNED.add(path);trail.append(path).append(":unavailable ");continue;}
            boolean on=awaitDisplayOn(rearId,700);
            if(displayOn(Display.DEFAULT_DISPLAY)){REAR_WAKE_BANNED.add(path);trail.append(path).append(":woke_main");return trail.toString();}
            if(on){trail.append(path).append(":ok");return trail.toString();}
            trail.append(path).append(":no_effect ");
        }
        return trail.toString().trim();
    }
    @android.annotation.SuppressLint({"BlockedPrivateApi","PrivateApi"})
    private void wakeByPowerManager(int displayId)throws Exception{
        Object binder=Class.forName("android.os.ServiceManager").getMethod("getService",String.class).invoke(null,"power");
        Object power=Class.forName("android.os.IPowerManager$Stub").getMethod("asInterface",IBinder.class).invoke(null,binder);
        Method wake=Class.forName("android.os.IPowerManager").getMethod("wakeUpWithDisplayId",long.class,int.class,String.class,String.class,int.class);
        // 2 = PowerManager.WAKE_REASON_APPLICATION
        wake.invoke(power,SystemClock.uptimeMillis(),2,"boujoy:rear_progress","com.android.shell",displayId);
    }
    private void wakeByKey(int displayId)throws Exception{
        Object input=inputManager();
        Method inject=input.getClass().getMethod("injectInputEvent",InputEvent.class,int.class);
        Method setDisplay=InputEvent.class.getMethod("setDisplayId",int.class);
        long down=SystemClock.uptimeMillis();
        for(int action:new int[]{KeyEvent.ACTION_DOWN,KeyEvent.ACTION_UP}){
            KeyEvent event=new KeyEvent(down,SystemClock.uptimeMillis(),action,KeyEvent.KEYCODE_WAKEUP,0,0,android.view.KeyCharacterMap.VIRTUAL_KEYBOARD,0,0,InputDevice.SOURCE_KEYBOARD);
            setDisplay.invoke(event,displayId);
            inject.invoke(input,event,0);
        }
    }
    private void permittedRear(IDisplayPermit permit,long epoch)throws Exception{
        boolean keyguard=locked();
        boolean background=!keyguard||permit!=null&&permit.permitsWhileLocked();
        boolean allowed=permit!=null&&permit.permits();
        String failure=rearPermissionFailure(attached&&client!=null&&client.isBinderAlive(),epoch,revocation.get(),keyguard,background,allowed);
        if(failure!=null)throw new Failure(failure,false);
    }
    private boolean sessionAlwaysUnlocked() { return session != null && session.optBoolean("alwaysUnlocked", false) && virtualDisplay != null; }
    static boolean displayGeometryMatches(int width,int height,int actualWidth,int actualHeight,int rotation) {
        return width>0&&height>0&&actualWidth==width&&actualHeight==height&&rotation==android.view.Surface.ROTATION_0;
    }
    private boolean ownedGeometryValid() {
        if(session==null||virtualDisplay==null)return false;
        int id=session.optInt("displayId",-1);
        if(id<=Display.DEFAULT_DISPLAY)return false;
        try{
            Display owned=virtualDisplay.getDisplay();
            if(owned==null||!owned.isValid()||owned.getDisplayId()!=id)return false;
            // Query only this owned virtual display; never inspect the foreground display.
            Display live=displays.getDisplay(id);
            if(live==null||!live.isValid())return false;
            DisplayMetrics metrics=new DisplayMetrics();live.getRealMetrics(metrics);
            return displayGeometryMatches(session.optInt("width"),session.optInt("height"),metrics.widthPixels,metrics.heightPixels,live.getRotation());
        }catch(Exception unavailable){return false;}
    }
    private void match(JSONObject requested) throws Exception {
        if(handoff.retaining())throw new Failure("SESSION_STALE",false);
        matchOwned(requested);
    }
    private void matchOwned(JSONObject requested) throws Exception {
        // Reject late cleanup from an old generation before inspecting or releasing the new one.
        if(requested==null||session==null||!session.optString("sessionId").equals(requested.optString("sessionId"))
                ||session.optLong("generation")!=requested.optLong("generation",-1)
                ||session.optInt("displayId")!=requested.optInt("displayId",-1))throw new Failure("SESSION_STALE",false);
        if(!ownedGeometryValid()){
            closeDisplay();throw new Failure("SESSION_STALE",false);
        }
    }
    @Override public String command(String op,String raw,IDisplayPermit permit){
        if("rear_sleep_lease".equals(op)||"rear_sleep_release".equals(op))return rearSleepCommand(op,raw,permit);
        return displayCommand(op,raw,permit);
    }
    /** Physical rear power leases never wait behind a long synchronized display command. */
    private String rearSleepCommand(String op,String raw,IDisplayPermit permit){
        owner();String id="";long generation=-1,requestedDeadline=-1;boolean acquired=false,acquiring="rear_sleep_lease".equals(op);
        try{
            JSONObject args=new JSONObject(raw==null?"{}":raw);id=args.getString("leaseId");generation=args.getLong("generation");
            RearSleepLease.Result result;
            if(acquiring){
                long epoch=revocation.get();permittedRear(permit,epoch);
                // This private firmware has exactly one secondary INTERNAL display at id 1.
                if(rear().optInt("displayId",-1)!=1||!displayOn(1))throw new Failure("REAR_DISPLAY_NOT_VISIBLE",false);
                requestedDeadline=args.getLong("expiresAtElapsedMs");
                result=rearSleepLease.acquireOrRenew(id,generation,requestedDeadline);acquired=result.ok();
                permittedRear(permit,epoch);
                if(!result.ok())throw new Failure(result.code(),false);
            }else result=rearSleepLease.release(id,generation);
            JSONObject value=new JSONObject().put("active",result.active()).put("code",result.code())
                    .put("leaseId",result.leaseId()).put("generation",result.generation()).put("expiresAtElapsedMs",result.expiresAtElapsedMs());
            return new JSONObject().put("ok",true).put("value",value).toString();
        }catch(Exception error){
            if(acquired)rearSleepLease.releaseIfNotRenewed(id,generation,requestedDeadline);
            String code=error instanceof Failure?((Failure)error).code:"REAR_LEASE_UNAVAILABLE";
            Log.i("BoujoyRear","{\"event\":\"rear_lease_rejected\",\"code\":\""+code+"\"}");
            try{return new JSONObject().put("ok",false).put("code",code).put("started",false).toString();}catch(Exception ignored){return "{\"ok\":false,\"code\":\"REAR_LEASE_UNAVAILABLE\",\"started\":false}";}
        }
    }
    private synchronized String displayCommand(String op, String raw, IDisplayPermit permit) {
        owner(); boolean started = false; EffectAttempt attempt = new EffectAttempt();
        try {
            JSONObject args = new JSONObject(raw == null ? "{}" : raw);
            expireHandoff();
            long epoch = revocation.get();
            lastCommandElapsed = SystemClock.elapsedRealtime();
            JSONObject value;
            switch (op) {
                case "status":
                    if(session!=null&&!ownedGeometryValid())closeDisplay();
                    boolean keyguard=locked();
                    value = new JSONObject().put("session", session == null || handoff.retaining() ? JSONObject.NULL : session)
                            .put("heldSession",handoff.retaining()?session:JSONObject.NULL).put("handoff",handoff.snapshot()==null?JSONObject.NULL:handoff.snapshot())
                            .put("features",new JSONArray().put("session_handoff")).put("rear", rear()).put("uid", android.os.Process.myUid())
                            .put("keyguardKnown",keyguardKnown).put("keyguardLocked",keyguard); break;
                case "list_apps":
                    value = new JSONObject().put("apps", apps()); break;
                case "open":
                    permitted(permit, epoch, true);
                    if(handoff.retaining())finishHandoff("dismissed","new_session");
                    if(session!=null&&!ownedGeometryValid())closeDisplay();
                    if(session==null){
                        try{
                            open(args);
                            permitted(permit,epoch);match(session);
                            if(locked()&&!sessionAlwaysUnlocked())throw new Failure("LOCKED",false);
                            // A real application window makes first observation possible before opening a task app.
                            markFrameBarrier();started=true;startWorkspace(session.getInt("displayId"),session.getString("sessionId"));
                            permitted(permit,epoch);match(session);
                        }catch(Exception failure){closeDisplay();throw failure;}
                    }
                    value = session; break;
                case "close":
                    // A late open reply may only release the session that it created.
                    if(args.optJSONObject("session")!=null)matchOwned(args.optJSONObject("session"));
                    closeDisplay(); value = new JSONObject().put("closed", true); break;
                case "handoff": {
                    match(args.optJSONObject("session"));permitted(permit,epoch);
                    String id=args.getString("handoffId"),task=args.getString("task_id");
                    if(!validSessionUuid(id)||task.isBlank()||task.length()>128)throw new Failure("INVALID_ARGUMENT",false);
                    handoff.begin(id,task,args.getString("title"),args.getString("summary"),System.currentTimeMillis(),SystemClock.elapsedRealtime());
                    heldTarget=null;
                    value=new JSONObject().put("handoff",handoff.snapshot()).put("heldSession",session);break;
                }
                case "handoff_dismiss": {
                    String id=args.getString("handoffId"),state=args.optString("state","dismissed");
                    if(!handoff.matches(id)||!handoff.retaining())throw new Failure("HANDOFF_STALE",false);
                    if(!"dismissed".equals(state)&&!"expired".equals(state))throw new Failure("INVALID_ARGUMENT",false);
                    finishHandoff(state,args.optString("reason",state));value=new JSONObject().put("handoff",handoff.snapshot());break;
                }
                case "handoff_take": {
                    String id=args.getString("handoffId");
                    if(!handoff.matches(id)||!handoff.retaining()||session==null)throw new Failure("HANDOFF_STALE",false);
                    try{
                        matchOwned(args.optJSONObject("session"));
                        if(locked()||permit==null||!permit.permits())throw new Failure("HANDOFF_NOT_ALLOWED",false);
                        HandoffTaskMover.Platform tasks=taskPlatform();int source=session.getInt("displayId");
                        if(heldTarget==null)heldTarget=HandoffTaskMover.select(tasks.roots(source),source,ownerPackage);
                        final long acceptedEpoch=epoch;
                        HandoffTaskMover.moveAndConfirm(tasks,heldTarget,source,
                                ()->takeAllowed(permit,acceptedEpoch),()->takeStillLive(id,acceptedEpoch,permit),
                                SystemClock::elapsedRealtime,Thread::sleep);
                        handoff.transition(id,"taken","user_take","",System.currentTimeMillis());closeDisplay();
                    }catch(Exception failed){
                        if(handoff.retaining())handoff.transition(id,"failed","move_failed",handoffError(failed),System.currentTimeMillis());
                    }
                    value=new JSONObject().put("handoff",handoff.snapshot());break;
                }
                case "recall": {
                    match(args.optJSONObject("session")); permitted(permit, epoch);
                    value=new JSONObject().put("moved",recallStrayTasks(session.getInt("displayId")));break;
                }
                case "frame_barrier":
                    match(args.optJSONObject("session"));markFrameBarrier();value=new JSONObject();break;
                case "rear": {
                    permittedRear(permit,epoch);
                    int rearId=rear().optInt("displayId",-1);
                    if(rearId<=Display.DEFAULT_DISPLAY)throw new Failure("DISPLAY_UNAVAILABLE",false);
                    // Revalidate the uniquely discovered INTERNAL destination before the fixed launch.
                    String[] launch=rearLaunchCommand(ownerPackage,rearId,rear().optInt("displayId",-1));
                    permittedRear(permit,epoch);
                    // With the main screen asleep the rear panel is off, and a page started on an
                    // off panel is paused at once. Light the rear panel alone first.
                    String wake=wakeRearDisplay(rearId);
                    Log.i("BoujoyRear","{\"event\":\"rear_wake\",\"displayId\":"+rearId+",\"result\":\""+wake+"\"}");
                    permittedRear(permit,epoch);
                    started=true;String output=process(launch,8000);
                    if(!rearStartConfirmed(output))throw new Failure("REAR_LAUNCH_UNCONFIRMED",true);
                    permittedRear(permit,epoch);
                    if(rear().optInt("displayId",-1)!=rearId)throw new Failure("DISPLAY_UNAVAILABLE",true);
                    // This confirms only am-start. The coordinator separately requires real visibility.
                    value=new JSONObject().put("displayId",rearId).put("wake",wake);break;
                }
                case "launch_app": {
                    match(args.optJSONObject("session")); permitted(permit, epoch);
                    String pkg = args.optString("package_name");
                    if (!pkg.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+")) throw new Failure("TARGET_MISSING", false);
                    String component = resolve(pkg);
                    permitted(permit, epoch); match(args.optJSONObject("session"));
                    sessionPackages.add(pkg);
                    bringExistingTaskToSession(pkg, session.getInt("displayId"));
                    permitted(permit, epoch); match(args.optJSONObject("session"));
                    markFrameBarrier();started = true; startComponent(component, session.getInt("displayId"));
                    value = new JSONObject(); break;
                }
                case "tap": case "long_press": case "swipe": case "back": {
                    match(args.optJSONObject("session")); permitted(permit, epoch);
                    validateInput(op, args);
                    // All reflection is resolved before the first event; display ID is set on every event.
                    Object input = inputManager();
                    Method inject = input.getClass().getMethod("injectInputEvent", InputEvent.class, int.class);
                    Method setDisplay = InputEvent.class.getMethod("setDisplayId", int.class);
                    inject(op, args, input, inject, setDisplay, permit, epoch, attempt);
                    value = new JSONObject(); break;
                }
                default: throw new Failure("UNSUPPORTED_ON_DISPLAY", false);
            }
            return new JSONObject().put("ok", true).put("value", value).toString();
        } catch (Throwable e) {
            Throwable cause = e;
            while (cause.getCause() != null) cause = cause.getCause();
            String code = e instanceof Failure ? ((Failure)e).code : cause instanceof SecurityException ? "PERMISSION_DENIED" : "DISPLAY_BACKEND_ERROR";
            try { return new JSONObject().put("ok", false).put("code", code).put("started", started || attempt.started)
                    .put("detail", cause.getClass().getSimpleName() + ": " + String.valueOf(cause.getMessage())).toString(); }
            catch (Exception ignored) { return "{\"ok\":false,\"code\":\"DISPLAY_BACKEND_ERROR\",\"started\":true}"; }
        }
    }
    private void open(JSONObject args) throws Exception {
        int width = args.optInt("width", 1080), height = args.optInt("height", 2348), density = args.optInt("densityDpi", 420);
        if (width < 320 || width > 1440 || height < 320 || height > 3200 || density < 120 || density > 640
                || args.optLong("generation", 0) < 1 || !validSessionUuid(args.optString("sessionId"))) throw new Failure("INVALID_ARGUMENT", false);
        ImageReader next = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 3);
        synchronized(frameLock){reader=next;readerGeneration++;minimumFrameNanos=System.nanoTime();}
        next.setOnImageAvailableListener(this::frame, handler);
        // A separate non-mirrored, touch-capable display in its own display group, so it
        // keeps running and stays unlocked when the main screen sleeps or locks, and it
        // never takes top focus from the main screen. No global settings are changed.
        // SUPPORTS_TOUCH 1<<6, DESTROY_CONTENT_ON_REMOVAL 1<<8, TRUSTED 1<<10, OWN_DISPLAY_GROUP 1<<11,
        // ALWAYS_UNLOCKED 1<<12, TOUCH_FEEDBACK_DISABLED 1<<13, OWN_FOCUS 1<<14, STEAL_TOP_FOCUS_DISABLED 1<<16.
        int base = DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC | DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION
                | DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY | (1 << 6) | (1 << 8) | (1 << 10) | (1 << 14);
        int background = base | (1 << 11) | (1 << 12) | (1 << 13) | (1 << 16);
        int legacy = base | (1 << 15);
        boolean alwaysUnlocked = true;
        try {
            try { virtualDisplay = displays.createVirtualDisplay(sessionDisplayName(args.getString("sessionId")), width, height, density, next.getSurface(), background); }
            catch (SecurityException | IllegalArgumentException denied) {
                // This system refuses an always-unlocked display: keep the previous behavior,
                // which pauses when the main screen locks.
                alwaysUnlocked = false;
                virtualDisplay = displays.createVirtualDisplay(sessionDisplayName(args.getString("sessionId")), width, height, density, next.getSurface(), legacy);
            }
            int actualFlags = virtualDisplay == null ? 0 : virtualDisplay.getDisplay().getFlags();
            // Display.FLAG_ALWAYS_UNLOCKED is 1<<9 on the display itself; require the system to confirm it.
            alwaysUnlocked = alwaysUnlocked && (actualFlags & (1 << 9)) != 0;
            if (virtualDisplay == null || virtualDisplay.getDisplay().getDisplayId() == 0) throw new Failure("DISPLAY_UNSUPPORTED", false);
            confirmDestroyMode(virtualDisplay.getDisplay().getDisplayId());
            sessionTaskIds.clear();sessionPackages.clear();sessionTaskFloor=highestTaskId();
            session = new JSONObject().put("sessionId", args.getString("sessionId")).put("generation", args.getLong("generation"))
                    .put("displayId", virtualDisplay.getDisplay().getDisplayId()).put("width", width).put("height", height)
                    .put("densityDpi", density).put("createdAtMs", System.currentTimeMillis())
                    .put("alwaysUnlocked", alwaysUnlocked).put("displayFlags", actualFlags).put("contentRemovalPolicy","destroy");
        } catch (Exception e) { closeDisplay(); throw e; }
    }
    private void frame(ImageReader source) {
        // ImageReader.close releases acquired image buffers too. Keep the entire native
        // ByteBuffer read, including Image.close, exclusive with every reader retirement.
        synchronized(frameLock) {
            // A replacement listener can run before publication. Leave its first buffer queued.
            if(source!=reader)return;
            try (Image image = source.acquireLatestImage()) {
                if (image == null) return;
                Image.Plane plane = image.getPlanes()[0];
                int stride = plane.getPixelStride(), row = plane.getRowStride();
                if(stride!=4)throw new IllegalStateException("unsupported_frame_stride");
                Bitmap padded = Bitmap.createBitmap(row / stride, image.getHeight(), Bitmap.Config.ARGB_8888);
                ByteBuffer buffer = plane.getBuffer(); padded.copyPixelsFromBuffer(buffer);
                Bitmap bitmap = Bitmap.createBitmap(padded, 0, 0, image.getWidth(), image.getHeight());
                if (bitmap != padded) padded.recycle();
                synchronized (frameLock) {
                    if (source != reader) { bitmap.recycle(); return; }
                    if (latestFrame != null) latestFrame.recycle();
                    long received=System.nanoTime(),timestamp=image.getTimestamp();
                    latestFrame=bitmap;latestFrameNanos=timestamp;latestFrameReceivedNanos=received;latestFrameReaderGeneration=readerGeneration;
                    // ImageReader clocks are producer-dependent. Reject frames unless this source
                    // demonstrably uses the same recent monotonic timebase as System.nanoTime().
                    latestFrameAt=validFrameClock(timestamp,received)?System.currentTimeMillis()-(received-timestamp)/1_000_000L:0;
                    lastFrameIssue=latestFrameAt>0?null:"frame_clock_invalid";
                    frameLock.notifyAll();
                }
            } catch (RuntimeException unavailable) {
                synchronized(frameLock){
                    if(source==reader){latestFrameAt=0;latestFrameReceivedNanos=0;lastFrameIssue="frame_copy_failed";frameLock.notifyAll();}
                }
            }
        }
    }
    private void closeReader(ImageReader source) {
        if(source==null)return;
        synchronized(frameLock) {
            try{source.setOnImageAvailableListener(null,null);}catch(Exception ignored){}
            try{source.close();}catch(Exception ignored){}
        }
    }
    @Override public ParcelFileDescriptor capture(String raw, int maxDimension, IDisplayPermit permit) {
        owner();
        final long began=SystemClock.elapsedRealtime(),epoch=revocation.get();
        final ParcelFileDescriptor[] pipe;
        try{pipe=ParcelFileDescriptor.createPipe();}
        catch(Exception unavailable){logFrame("capture_failed",null,"NO_FRAME","pipe_create_failed",began);return null;}
        new Thread(() -> {
            JSONObject expected=null;
            try (ParcelFileDescriptor.AutoCloseOutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
                JSONObject result;
                try {
                    expected=new JSONObject(raw);
                    result=captureFrame(expected,maxDimension,epoch,permit);
                    logFrame("capture_complete",expected,null,null,began);
                }catch(Exception failure){
                    String code=failure instanceof Failure?((Failure)failure).code:"NO_FRAME";
                    String reason=failure instanceof Failure?((Failure)failure).reason:"capture_exception";
                    result=frameFailure(code,reason);
                    logFrame("capture_failed",expected,code,reason,began);
                }
                out.write(result.toString().getBytes(StandardCharsets.UTF_8));
            } catch (Exception unavailable) { logFrame("capture_failed",expected,"NO_FRAME","pipe_write_failed",began); }
        }, "Boujoy-frame-pipe").start();
        return pipe[0];
    }
    private static JSONObject frameJson(Object... fields) {
        JSONObject value=new JSONObject();
        try{for(int i=0;i<fields.length;i+=2)value.put(String.valueOf(fields[i]),fields[i+1]);}
        catch(Exception error){throw new IllegalArgumentException("frame_metadata_invalid",error);}
        return value;
    }
    /** Internal capture receipt. No exception message, page data or arbitrary strings cross this pipe. */
    static JSONObject frameFailure(String code,String reason) {
        String safeCode=java.util.Set.of("NO_FRAME","SESSION_STALE","LOCALLY_PAUSED","LOCKED","PERMISSION_DENIED").contains(code)?code:"NO_FRAME";
        String safeReason=java.util.Set.of("no_frame","pre_barrier","pre_barrier_timeout","reader_changed","reader_invalid",
                "frame_clock_invalid","frame_copy_failed","frame_source_changed","drain_timeout","drain_rejected",
                "recovery_failed","recovery_pending","capture_exception","capture_timeout","jpeg_failed",
                "barrier_changed","pipe_create_failed","pipe_write_failed","session_gate").contains(reason)?reason:"capture_exception";
        return frameJson("available",false,"error",frameJson("code",safeCode,"reason",safeReason));
    }
    private void logFrame(String event,JSONObject expected,String code,String reason,long began) {
        try {
            JSONObject value;
            synchronized(frameLock){
                value=frameJson("event",event,"sessionId",expected==null?JSONObject.NULL:expected.opt("sessionId"),
                        "generation",expected==null?JSONObject.NULL:expected.opt("generation"),"displayId",expected==null?JSONObject.NULL:expected.opt("displayId"),
                        "readerGeneration",readerGeneration,"frameReaderGeneration",latestFrameReaderGeneration,
                        "frameNanos",latestFrameNanos,"receivedNanos",latestFrameReceivedNanos,"barrierNanos",minimumFrameNanos,
                        "recoveredBarrierNanos",recoveredBarrierNanos,"frameAtMs",latestFrameAt,
                        "elapsedMs",Math.max(0,SystemClock.elapsedRealtime()-began),"code",code==null?JSONObject.NULL:code,
                        "reason",reason==null?JSONObject.NULL:reason);
            }
            Log.i("BoujoyFrame",value.toString());
        }catch(Exception ignored){ /* Diagnostics cannot change capture results. */ }
    }
    private void capturePermitted(long epoch)throws Exception {
        if(!attached||client==null||!client.isBinderAlive()||revocation.get()!=epoch)throw new Failure("SESSION_STALE",false,"session_gate");
        if(handoff.retaining())throw new Failure("SESSION_STALE",false,"session_gate");
        if(locked()&&!sessionAlwaysUnlocked())throw new Failure("LOCKED",false,"session_gate");
    }
    private void captureChecks(JSONObject expected,long epoch,IDisplayPermit permit)throws Exception {
        synchronized(this){match(expected);capturePermitted(epoch);}
        // This callback can enter the app's Binder. Never hold the service/frame lock here.
        permitted(permit,epoch);
        synchronized(this){match(expected);capturePermitted(epoch);}
    }
    static boolean validFrameClock(long timestamp,long now) {
        return timestamp>0&&timestamp<=now&&now-timestamp<=MAX_FRAME_RECEIVE_DELAY_NANOS;
    }
    /** The clock is trusted at reception; static compositor output does not expire with wall time. */
    static boolean frameCurrent(long timestamp,long received,long barrier,long now,
            long frameSource,long activeSource,boolean sourceLive) {
        return sourceLive&&frameSource>0&&frameSource==activeSource&&received<=now
                &&timestamp>=barrier&&validFrameClock(timestamp,received);
    }
    private void markFrameBarrier(){synchronized(frameLock){minimumFrameNanos=System.nanoTime();frameLock.notifyAll();}}
    /** Read on the ImageReader's handler, after its queued callbacks, without waiting under a service lock. */
    private void drainLatest(ImageReader source,long deadline)throws Exception {
        CountDownLatch drained=new CountDownLatch(1);AtomicBoolean valid=new AtomicBoolean();
        Runnable drain=()->{
            try{
                synchronized(frameLock) {
                    if(source==reader&&source.getSurface().isValid()){
                        frame(source);valid.set(source==reader&&source.getSurface().isValid());
                    }
                }
            }catch(RuntimeException ignored){ /* released reader is not a live source */ }
            finally{drained.countDown();}
        };
        if(android.os.Looper.myLooper()==handler.getLooper())drain.run();
        else if(!handler.post(drain))throw new Failure("NO_FRAME",false,"drain_rejected");
        long remaining=deadline-SystemClock.elapsedRealtime();
        if(remaining<=0||!drained.await(remaining,TimeUnit.MILLISECONDS))throw new Failure("NO_FRAME",false,"drain_timeout");
        if(!valid.get())throw new Failure("SESSION_STALE",false,"reader_invalid");
    }
    /** Caller holds frameLock. Only a valid old frame is eligible for one surface refresh. */
    private String frameIssue(ImageReader source,long sourceGeneration) {
        if(reader!=source||readerGeneration!=sourceGeneration)return "reader_changed";
        if(source==null||!source.getSurface().isValid())return "reader_invalid";
        if(latestFrame==null)return lastFrameIssue==null?"no_frame":lastFrameIssue;
        if(latestFrameReaderGeneration!=sourceGeneration)return "frame_source_changed";
        long now=System.nanoTime();
        if(latestFrameAt<=0||latestFrameReceivedNanos>now||!validFrameClock(latestFrameNanos,latestFrameReceivedNanos))
            return lastFrameIssue==null?"frame_clock_invalid":lastFrameIssue;
        return latestFrameNanos<minimumFrameNanos?"pre_barrier":null;
    }
    /** Actual recovery transaction, also exercised with a fake platform surface in Robolectric. */
    boolean recoverFrameSource(JSONObject expected,ImageReader source,long sourceGeneration,long barrier,long epoch,
            long deadline,IDisplayPermit permit)throws Exception {
        long began=SystemClock.elapsedRealtime();
        captureChecks(expected,epoch,permit);
        synchronized(frameLock){
            if(minimumFrameNanos!=barrier||recoveredBarrierNanos==barrier||!"pre_barrier".equals(frameIssue(source,sourceGeneration)))return false;
            if(SystemClock.elapsedRealtime()>=deadline)throw new Failure("NO_FRAME",false,"capture_timeout");
            // Count the attempt even if allocation or setSurface fails. Never loop on one action.
            recoveredBarrierNanos=barrier;
        }
        logFrame("surface_recovery_started",expected,null,"pre_barrier",began);
        ImageReader next=null;boolean published=false;
        try {
            next=ImageReader.newInstance(expected.getInt("width"),expected.getInt("height"),PixelFormat.RGBA_8888,3);
            next.setOnImageAvailableListener(this::frame,handler);
            captureChecks(expected,epoch,permit);
            synchronized(this){
                match(expected);capturePermitted(epoch);
                synchronized(frameLock){
                    if(SystemClock.elapsedRealtime()>=deadline)throw new Failure("NO_FRAME",false,"capture_timeout");
                    if(minimumFrameNanos!=barrier||!"pre_barrier".equals(frameIssue(source,sourceGeneration)))return false;
                }
                // Non-null -> non-null, same display/task/geometry. This requests a new output
                // target; only a real frame proves that this device actually recomposed it.
                if(virtualDisplay==null||virtualDisplay.getSurface()!=source.getSurface()||!next.getSurface().isValid())
                    throw new Failure("SESSION_STALE",false,"reader_invalid");
                if(revocation.get()!=epoch||!attached)throw new Failure("SESSION_STALE",false,"session_gate");
                virtualDisplay.setSurface(next.getSurface());
                synchronized(frameLock){
                    reader=next;readerGeneration++;
                    if(latestFrame!=null)latestFrame.recycle();
                    latestFrame=null;latestFrameAt=0;latestFrameNanos=0;latestFrameReceivedNanos=0;latestFrameReaderGeneration=0;
                    lastFrameIssue="recovery_pending";published=true;frameLock.notifyAll();
                }
            }
            captureChecks(expected,epoch,permit);
            logFrame("surface_recovery_complete",expected,null,"recovery_pending",began);
            return true;
        }catch(Failure failure){logFrame("surface_recovery_failed",expected,failure.code,failure.reason,began);throw failure;}
        catch(Exception failure){logFrame("surface_recovery_failed",expected,"NO_FRAME","recovery_failed",began);throw new Failure("NO_FRAME",false,"recovery_failed");}
        finally {
            if(published)closeReader(source);
            else closeReader(next);
        }
    }
    private JSONObject captureFrame(JSONObject expected,int maxDimension,long epoch,IDisplayPermit permit)throws Exception {
        long start=System.currentTimeMillis(),began=SystemClock.elapsedRealtime(),deadline=began+1500,recoveryAt=began+250;
        captureChecks(expected,epoch,permit);
        ImageReader source;long sourceGeneration;
        synchronized(frameLock){source=reader;sourceGeneration=readerGeneration;}
        if(source==null)throw new Failure("NO_FRAME",false,"reader_invalid");
        drainLatest(source,deadline);
        Bitmap copy;long frameAt,frameNanos,receivedNanos,frameGeneration,barrier;
        while(true){
            captureChecks(expected,epoch,permit);
            long recoverBarrier=-1;
            synchronized(frameLock){
                String issue=frameIssue(source,sourceGeneration);
                if(issue==null){
                    copy=latestFrame.copy(Bitmap.Config.ARGB_8888,false);
                    frameAt=latestFrameAt;frameNanos=latestFrameNanos;receivedNanos=latestFrameReceivedNanos;
                    frameGeneration=latestFrameReaderGeneration;barrier=minimumFrameNanos;break;
                }
                if("reader_changed".equals(issue)||"reader_invalid".equals(issue))throw new Failure("SESSION_STALE",false,issue);
                long now=SystemClock.elapsedRealtime(),remaining=deadline-now;
                if(remaining<=0)throw new Failure("NO_FRAME",false,"pre_barrier".equals(issue)?"pre_barrier_timeout":issue);
                if("pre_barrier".equals(issue)&&recoveredBarrierNanos!=minimumFrameNanos&&now>=recoveryAt)recoverBarrier=minimumFrameNanos;
                else frameLock.wait(Math.min(remaining,"pre_barrier".equals(issue)&&recoveredBarrierNanos!=minimumFrameNanos?Math.max(1,recoveryAt-now):remaining));
            }
            if(recoverBarrier>=0&&recoverFrameSource(expected,source,sourceGeneration,recoverBarrier,epoch,deadline,permit)){
                synchronized(frameLock){source=reader;sourceGeneration=readerGeneration;}
                drainLatest(source,deadline);
            }
        }
        try {
            captureChecks(expected,epoch,permit);
            int max=Math.max(320,Math.min(1440,maxDimension));
            double factor=Math.min(1,max/(double)Math.max(copy.getWidth(),copy.getHeight()));
            int w=Math.max(1,(int)Math.round(copy.getWidth()*factor)),h=Math.max(1,(int)Math.round(copy.getHeight()*factor));
            Bitmap scaled=Bitmap.createScaledBitmap(copy,w,h,true);
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();
            try{if(!scaled.compress(Bitmap.CompressFormat.JPEG,75,bytes))throw new Failure("NO_FRAME",false,"jpeg_failed");}
            finally{if(scaled!=copy)scaled.recycle();}
            captureChecks(expected,epoch,permit);
            synchronized(frameLock){
                if(barrier!=minimumFrameNanos)throw new Failure("NO_FRAME",false,"barrier_changed");
                if(latestFrameAt<=0||latestFrameReceivedNanos<=0||!frameCurrent(frameNanos,receivedNanos,minimumFrameNanos,System.nanoTime(),
                        frameGeneration,readerGeneration,reader==source&&source.getSurface().isValid()))throw new Failure("NO_FRAME",false,"frame_source_changed");
            }
            return new JSONObject().put("available",true).put("started_at_ms",start).put("finished_at_ms",System.currentTimeMillis())
                    .put("frame_at_ms",frameAt).put("width",w).put("height",h).put("scale_x",copy.getWidth()/(double)w)
                    .put("scale_y",copy.getHeight()/(double)h).put("offset_x",0).put("offset_y",0)
                    .put("mime_type","image/jpeg").put("data_base64",Base64.encodeToString(bytes.toByteArray(),Base64.NO_WRAP));
        }finally{copy.recycle();}
    }
    private synchronized void closeDisplay() {
        if(handoff.retaining())handoff.transition(handoff.snapshot().optString("handoffId"),"dismissed","display_closed","",System.currentTimeMillis());
        heldTarget=null;session = null;sessionTaskIds.clear();sessionPackages.clear();sessionTaskFloor=Integer.MAX_VALUE;
        VirtualDisplay old = virtualDisplay; virtualDisplay = null;
        if (old != null) try { old.release(); } catch (Exception ignored) {}
        synchronized (frameLock) {
            ImageReader oldReader=reader;reader=null;
            closeReader(oldReader);
            if(latestFrame!=null)latestFrame.recycle();latestFrame=null;latestFrameAt=0;latestFrameNanos=0;latestFrameReceivedNanos=0;
            latestFrameReaderGeneration=0;readerGeneration++;minimumFrameNanos=System.nanoTime();recoveredBarrierNanos=-1;lastFrameIssue="no_frame";frameLock.notifyAll();
        }
    }
    private void expireHandoff(){if(handoff.due(System.currentTimeMillis(),SystemClock.elapsedRealtime()))finishHandoff("expired","timeout");}
    private void finishHandoff(String state,String reason){
        handoff.transition(handoff.snapshot().optString("handoffId"),state,reason,"",System.currentTimeMillis());closeDisplay();
    }
    private boolean takeAllowed(IDisplayPermit permit,long epoch){
        try{return attached&&client!=null&&client.isBinderAlive()&&revocation.get()==epoch&&!locked()&&permit.permits();}catch(Exception unavailable){return false;}
    }
    private boolean takeStillLive(String id,long epoch,IDisplayPermit permit){
        try{return permit!=null&&permit.permitsWhileLocked()&&attached&&client!=null&&client.isBinderAlive()&&revocation.get()==epoch&&!locked()
                &&handoff.matches(id)&&handoff.retaining()&&!handoff.due(System.currentTimeMillis(),SystemClock.elapsedRealtime());}catch(Exception denied){return false;}
    }
    private static String handoffError(Exception error){
        if(error instanceof Failure)return ((Failure)error).code;
        String value=error.getMessage();return value!=null&&value.matches("HANDOFF_[A-Z_]+")?value:"HANDOFF_MOVE_UNCONFIRMED";
    }
    /** These two constant spaces are intentionally kept separate. */
    static boolean displayDestroyModeConfirmed(int displayRemoveMode){return displayRemoveMode==1;}
    static boolean destroyModeConfirmed(int windowManagerMode){return windowManagerMode==2;}
    private void confirmDestroyMode(int displayId)throws Exception{
        if(displayId<=0||virtualDisplay==null||virtualDisplay.getDisplay().getDisplayId()!=displayId)throw new Failure("SESSION_STALE",false);
        // Android 17 Display.getRemoveMode() exposes the create-time destroy-content policy.
        // Prefer this read-only confirmation; do not require a new WindowManager API on HyperOS.
        try{
            Display live=displays.getDisplay(displayId);
            if(live!=null&&live.isValid()&&displayDestroyModeConfirmed((Integer)Display.class.getMethod("getRemoveMode").invoke(live)))return;
        }catch(Exception unavailable){ /* Narrow per-display fallback below. */ }
        try{
            Object wm=Class.forName("android.view.WindowManagerGlobal").getDeclaredMethod("getWindowManagerService").invoke(null);
            Class<?> api=Class.forName("android.view.IWindowManager");Method get=api.getMethod("getRemoveContentMode",int.class);
            if(!destroyModeConfirmed((Integer)get.invoke(wm,displayId)))api.getMethod("setRemoveContentMode",int.class,int.class).invoke(wm,displayId,2);
            if(destroyModeConfirmed((Integer)get.invoke(wm,displayId)))return;
        }catch(Exception unavailable){ /* No application is launched until destruction is confirmed. */ }
        throw new Failure("DISPLAY_DESTROY_MODE_UNCONFIRMED",false);
    }
    /**
     * An app that already has a task on the main screen reopens there instead of on the session
     * display (single-task launchers such as Clock and Settings do). Its existing task is moved
     * to the session display first, so the launch below resumes it in the background.
     * A task the user can see on an unlocked main screen is never taken away from them.
     */
    @android.annotation.SuppressLint("BlockedPrivateApi")
    private void bringExistingTaskToSession(String pkg,int target)throws Failure{
        if(target<=Display.DEFAULT_DISPLAY)return;
        java.util.List<HandoffTaskMover.Root> roots;Object manager;Method move;
        try{
            roots=taskPlatform().roots(Display.DEFAULT_DISPLAY);
            manager=Class.forName("android.app.ActivityTaskManager").getDeclaredMethod("getService").invoke(null);
            move=Class.forName("android.app.IActivityTaskManager").getMethod("moveRootTaskToDisplay",int.class,int.class);
        }catch(Exception unavailable){return;} // The launch proceeds; its landing check still reports where the app went.
        boolean mainLocked=locked();
        for(HandoffTaskMover.Root root:roots){
            if(root.displayId()!=Display.DEFAULT_DISPLAY||root.taskId()<0||!pkg.equals(root.packageName()))continue;
            if(root.visible()&&!mainLocked)throw new Failure("APP_IN_USE_ON_MAIN",false);
            try{move.invoke(manager,root.taskId(),target);sessionTaskIds.add(root.taskId());}catch(Exception refused){ /* The landing check reports the result. */ }
        }
    }
    private int highestTaskId(){
        int highest=-1;
        try{
            HandoffTaskMover.Platform tasks=taskPlatform();
            for(HandoffTaskMover.Root root:tasks.roots(Display.DEFAULT_DISPLAY))highest=Math.max(highest,root.taskId());
        }catch(Exception unavailable){return Integer.MAX_VALUE;} // Without a floor, only tasks seen on the session are recalled.
        return highest;
    }
    /**
     * Moves the session's own pages that an app opened on the main display back to the session
     * display. A page of ours that the user has on an unlocked main screen is left with them.
     * Pages of other apps (a payment app, the system) are never taken.
     */
    @android.annotation.SuppressLint("BlockedPrivateApi")
    private JSONArray recallStrayTasks(int target){
        JSONArray moved=new JSONArray();
        if(target<=Display.DEFAULT_DISPLAY)return moved;
        try{
            HandoffTaskMover.Platform tasks=taskPlatform();
            for(HandoffTaskMover.Root root:tasks.roots(target)){
                if(root.taskId()<0)continue;
                sessionTaskIds.add(root.taskId());
                String pkg=root.packageName();
                if(pkg!=null&&!pkg.isBlank()&&!pkg.equals(ownerPackage))sessionPackages.add(pkg);
            }
            if(sessionTaskIds.isEmpty()&&sessionPackages.isEmpty())return moved;
            Object manager=Class.forName("android.app.ActivityTaskManager").getDeclaredMethod("getService").invoke(null);
            Method move=Class.forName("android.app.IActivityTaskManager").getMethod("moveRootTaskToDisplay",int.class,int.class);
            boolean mainLocked=locked();
            for(HandoffTaskMover.Root root:tasks.roots(Display.DEFAULT_DISPLAY)){
                String pkg=root.packageName();
                if(root.displayId()!=Display.DEFAULT_DISPLAY||root.taskId()<0||pkg==null||pkg.isBlank()||pkg.equals(ownerPackage))continue;
                boolean ours=sessionTaskIds.contains(root.taskId());
                boolean startedByOurApp=root.taskId()>sessionTaskFloor&&sessionPackages.contains(pkg);
                if(!ours&&!startedByOurApp)continue;
                // Never take a page the user can see on an unlocked main screen: they may have opened it themselves.
                if(root.visible()&&!mainLocked)continue;
                try{move.invoke(manager,root.taskId(),target);moved.put(root.taskId());sessionTaskIds.add(root.taskId());}
                catch(Exception refused){ /* Left where it is; the next read reports what is on the session display. */ }
            }
        }catch(Exception unavailable){ /* No task API: nothing moves. */ }
        if(moved.length()>0)Log.i("BoujoyDisplay","{\"event\":\"recall\",\"displayId\":"+target+",\"moved\":"+moved+"}");
        return moved;
    }
    private static HandoffTaskMover.Root rootTask(Object info)throws Exception{
        if(info==null)return null;Class<?> type=info.getClass();
        ComponentName top=(ComponentName)type.getField("topActivity").get(info);
        return new HandoffTaskMover.Root(type.getField("taskId").getInt(info),type.getField("displayId").getInt(info),
                type.getField("userId").getInt(info),type.getField("position").getInt(info),type.getField("visible").getBoolean(info),top==null?"":top.getPackageName());
    }
    // This class refuses construction outside shell UID 2000; only its owner-checked,
    // explicitly accepted handoff command reaches these system task APIs. A runtime
    // restriction returns failed and retains the original task; there is no app-process fallback.
    @android.annotation.SuppressLint("BlockedPrivateApi")
    private HandoffTaskMover.Platform taskPlatform()throws Exception{
        Object manager=Class.forName("android.app.ActivityTaskManager").getDeclaredMethod("getService").invoke(null);
        Class<?> api=Class.forName("android.app.IActivityTaskManager");
        Method roots=api.getMethod("getAllRootTaskInfosOnDisplay",int.class),focused=api.getMethod("getFocusedRootTaskInfo"),
                move=api.getMethod("moveRootTaskToDisplay",int.class,int.class),focus=api.getMethod("setFocusedRootTask",int.class);
        return new HandoffTaskMover.Platform(){
            public java.util.List<HandoffTaskMover.Root> roots(int display)throws Exception{
                java.util.List<HandoffTaskMover.Root> result=new java.util.ArrayList<>();
                Object value=roots.invoke(manager,display);
                if(!(value instanceof java.util.List<?>))throw new IllegalStateException("HANDOFF_TASKS_UNAVAILABLE");
                for(Object info:(java.util.List<?>)value){HandoffTaskMover.Root root=rootTask(info);if(root!=null)result.add(root);}return result;
            }
            public HandoffTaskMover.Root focused()throws Exception{return rootTask(focused.invoke(manager));}
            public void move(int taskId,int display)throws Exception{if(display!=0)throw new IllegalArgumentException("main_destination_required");move.invoke(manager,taskId,display);}
            public void focus(int taskId)throws Exception{focus.invoke(manager,taskId);}
        };
    }
    private JSONObject rear() throws Exception {
        Display found = null;
        for (Display display : displays.getDisplays()) {
            // This custom build is for the 17 Pro Max: rear = the unique other INTERNAL display.
            int type = (int)Display.class.getMethod("getType").invoke(display);
            if (display.getDisplayId() != Display.DEFAULT_DISPLAY && type == 1 && display.isValid()) {
                if (found != null) return new JSONObject().put("available",false);
                found = display;
            }
        }
        return new JSONObject().put("available",found != null).put("displayId",found == null ? JSONObject.NULL : found.getDisplayId());
    }
    private JSONArray apps() throws Exception {
        String output = process(new String[]{"/system/bin/cmd","package","query-activities","--brief","--components","-a",Intent.ACTION_MAIN,"-c",Intent.CATEGORY_LAUNCHER}, 5000);
        JSONArray result = new JSONArray(); java.util.HashSet<String> seen = new java.util.HashSet<>();
        for (String line : output.split("\\R")) {
            ComponentName component = ComponentName.unflattenFromString(line.trim());
            if (component == null || !seen.add(component.getPackageName())) continue;
            String label = component.getPackageName();
            try { label = String.valueOf(shell.getPackageManager().getApplicationLabel(shell.getPackageManager().getApplicationInfo(label,0))); } catch (Exception ignored) {}
            result.put(new JSONObject().put("package_name",component.getPackageName()).put("label",label));
        }
        return result;
    }
    private String resolve(String pkg) throws Exception {
        String output = process(new String[]{"/system/bin/cmd","package","resolve-activity","--brief","-a",Intent.ACTION_MAIN,"-c",Intent.CATEGORY_LAUNCHER,pkg},5000);
        for (String line : output.split("\\R")) {
            ComponentName c = ComponentName.unflattenFromString(line.trim());
            if (c != null && pkg.equals(c.getPackageName())) return c.flattenToString();
        }
        throw new Failure("TARGET_MISSING", false);
    }
    static boolean validSessionUuid(String sessionId){
        if(sessionId==null||sessionId.length()!=36)return false;
        try{return java.util.UUID.fromString(sessionId).toString().equalsIgnoreCase(sessionId);}
        catch(IllegalArgumentException invalid){return false;}
    }
    static String sessionDisplayName(String sessionId){
        if(!validSessionUuid(sessionId))throw new IllegalArgumentException("invalid_workspace_session");
        return "Boujoy session "+sessionId;
    }
    static String[] workspaceLaunchCommand(String packageName,int displayId,String sessionId){
        if(!BuildConfig.APPLICATION_ID.equals(packageName)||displayId<=Display.DEFAULT_DISPLAY||!validSessionUuid(sessionId))throw new IllegalArgumentException("invalid_workspace_destination");
        return new String[]{"/system/bin/am","start","-W","--display",String.valueOf(displayId),"-n",
                BuildConfig.APPLICATION_ID+"/dev.boujoy.personalagent.DisplayWorkspaceActivity","-f","0x18000000",
                "--ei","expectedDisplayId",String.valueOf(displayId),"--es","sessionId",sessionId};
    }
    private void startWorkspace(int displayId,String sessionId)throws Exception{
        String output=process(workspaceLaunchCommand(ownerPackage,displayId,sessionId),8000);
        if(output.contains("Error:")||output.contains("Exception")||!output.contains("Status: ok"))throw new IllegalStateException("workspace_launch_not_confirmed");
    }
    static String[] rearLaunchCommand(String packageName,int displayId,int verifiedRearId){
        if(displayId<=Display.DEFAULT_DISPLAY||displayId!=verifiedRearId
                ||!BuildConfig.APPLICATION_ID.equals(packageName)&&!"dev.boujoy.displaylab".equals(packageName))throw new IllegalArgumentException("invalid_rear_destination");
        String component=packageName+"/"+("dev.boujoy.displaylab".equals(packageName)?"dev.boujoy.displaylab.RearActivity":"dev.boujoy.personalagent.RearStatusActivity");
        return new String[]{"/system/bin/am","start","-W","--display",String.valueOf(displayId),"-n",component,"-f","0x18000000"};
    }
    static boolean rearStartConfirmed(String output){return output!=null&&output.contains("Status: ok")&&!output.contains("Error:")&&!output.contains("Exception");}
    private void startComponent(String component, int displayId) throws Exception {
        if (displayId <= 0) throw new Failure("SESSION_STALE", false);
        String output = process(new String[]{"/system/bin/am","start","-W","--display",String.valueOf(displayId),"-n",component,"-f","0x18000000"},8000);
        if (output.contains("Error:") || output.contains("Exception")) throw new IllegalStateException("launch_not_confirmed");
    }
    private String process(String[] args, long timeout) throws Exception {
        Process process = new ProcessBuilder(args).redirectErrorStream(true).start();
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        Thread drain = new Thread(() -> { try (InputStream in = process.getInputStream()) { byte[] buf = new byte[4096]; int n; while((n=in.read(buf))!=-1) { if(output.size()<131072) output.write(buf,0,n); } } catch(Exception ignored){} });
        drain.start();
        if (!process.waitFor(timeout, TimeUnit.MILLISECONDS)) { process.destroy(); throw new IllegalStateException("command_timeout"); }
        drain.join(1000);
        if (process.exitValue()!=0) throw new IllegalStateException("command_failed_"+process.exitValue());
        return output.toString("UTF-8");
    }
    private Object inputManager() throws Exception {
        Class<?> c;
        try { c=Class.forName("android.hardware.input.InputManagerGlobal"); }
        catch (ClassNotFoundException e) { c=Class.forName("android.hardware.input.InputManager"); }
        return c.getMethod("getInstance").invoke(null);
    }
    private void validateInput(String op,JSONObject args) throws Exception {
        if(op.equals("back"))return;
        if(op.equals("swipe")) {
            JSONArray points=args.optJSONArray("points");
            if(points==null||points.length()<2||points.length()>64)throw new Failure("INVALID_ARGUMENT",false);
            int duration=args.optInt("duration_ms",350);
            if(duration<50||duration>3000)throw new Failure("INVALID_ARGUMENT",false);
            for(int i=0;i<points.length();i++)point(points.getJSONObject(i));
        } else point(args);
    }
    private void point(JSONObject point) throws Exception {
        double x=point.optDouble("x",Double.NaN),y=point.optDouble("y",Double.NaN);
        if(!Double.isFinite(x)||!Double.isFinite(y)||x<0||y<0||x>=session.getInt("width")||y>=session.getInt("height"))throw new Failure("INVALID_ARGUMENT",false);
    }
    private void send(InputEvent event,Object manager,Method method,Method setDisplay,int displayId,EffectAttempt attempt) throws Exception {
        setDisplay.invoke(event,displayId);
        if(!attempt.started)markFrameBarrier();
        attempt.started=true;
        if(!(Boolean)method.invoke(manager,event,2))throw new IllegalStateException("injection_not_confirmed");
    }
    private void inject(String op,JSONObject args,Object manager,Method method,Method setDisplay,IDisplayPermit permit,long epoch,EffectAttempt attempt) throws Exception {
        int id=session.getInt("displayId"); long down=SystemClock.uptimeMillis();
        permitted(permit,epoch);
        if(op.equals("back")) {
            KeyEvent first=new KeyEvent(down,down,KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_BACK,0,0,android.view.KeyCharacterMap.VIRTUAL_KEYBOARD,0,0,InputDevice.SOURCE_KEYBOARD);
            send(first,manager,method,setDisplay,id,attempt);
            KeyEvent last=new KeyEvent(down,SystemClock.uptimeMillis(),KeyEvent.ACTION_UP,KeyEvent.KEYCODE_BACK,0,0,android.view.KeyCharacterMap.VIRTUAL_KEYBOARD,0,0,InputDevice.SOURCE_KEYBOARD);
            // Finish the key lifecycle even if stop raced with down; never send a new action.
            send(last,manager,method,setDisplay,id,attempt);return;
        }
        JSONArray points=op.equals("swipe")?args.getJSONArray("points"):new JSONArray().put(args).put(args);
        int duration=op.equals("swipe")?args.optInt("duration_ms",350):op.equals("long_press")?650:60;
        float x=(float)points.getJSONObject(0).getDouble("x"),y=(float)points.getJSONObject(0).getDouble("y");
        boolean pressed=false;
        try {
            motion(MotionEvent.ACTION_DOWN,x,y,down,id,manager,method,setDisplay,attempt);pressed=true;
            int steps=Math.max(1,duration/16);
            for(int i=1;i<=steps;i++) {
                SystemClock.sleep(Math.max(1, down+(long)duration*i/steps-SystemClock.uptimeMillis()));
                permitted(permit,epoch);match(args.optJSONObject("session"));
                double position=(points.length()-1)*i/(double)steps;
                int left=Math.min(points.length()-2,(int)position);double fraction=position-left;
                JSONObject a=points.getJSONObject(left),b=points.getJSONObject(left+1);
                x=(float)(a.getDouble("x")+(b.getDouble("x")-a.getDouble("x"))*fraction);
                y=(float)(a.getDouble("y")+(b.getDouble("y")-a.getDouble("y"))*fraction);
                if(op.equals("swipe"))motion(MotionEvent.ACTION_MOVE,x,y,down,id,manager,method,setDisplay,attempt);
            }
            motion(MotionEvent.ACTION_UP,x,y,down,id,manager,method,setDisplay,attempt);pressed=false;
        } finally { if(pressed)try { motion(MotionEvent.ACTION_CANCEL,x,y,down,id,manager,method,setDisplay,attempt); }catch(Exception ignored){} }
    }
    private void motion(int action,float x,float y,long down,int displayId,Object manager,Method method,Method setDisplay,EffectAttempt attempt)throws Exception {
        MotionEvent event=MotionEvent.obtain(down,SystemClock.uptimeMillis(),action,x,y,0);event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        try{send(event,manager,method,setDisplay,displayId,attempt);}finally{event.recycle();}
    }
    private static final class EffectAttempt { boolean started; }
    private static final class Failure extends Exception {
        final String code,reason; Failure(String code,boolean ignored){this(code,ignored,"session_gate");}
        Failure(String code,boolean ignored,String reason){super(code);this.code=code;this.reason=reason;}
    }
}
