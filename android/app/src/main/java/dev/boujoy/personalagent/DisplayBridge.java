package dev.boujoy.personalagent;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.hardware.display.DisplayManager;
import android.os.Binder;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import moe.shizuku.server.IShizukuService;
import rikka.shizuku.Shizuku;

/** App-process cache and binding. Privileged work stays in the narrow shell UserService. */
public final class DisplayBridge implements DisplayExecutor.Backend {
    // Bump for privileged implementation changes even when the private APK stays code 33.
    private static final int USER_SERVICE_VERSION=BuildConfig.VERSION_CODE*100+4;
    private static volatile DisplayBridge instance;
    public static DisplayBridge get(Context context) {
        if(!BuildConfig.BACKGROUND_SUPPORTED)throw new IllegalStateException("background_not_supported");
        if(instance==null)synchronized(DisplayBridge.class){if(instance==null)instance=new DisplayBridge(context.getApplicationContext());}
        return instance;
    }
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final CopyOnWriteArrayList<Runnable> listeners = new CopyOnWriteArrayList<>();
    private final Binder client = new Binder();
    private final Shizuku.UserServiceArgs serviceArgs;
    private final Object stateLock = new Object();
    private final Object mutationLock = new Object();
    private final AtomicBoolean refreshing = new AtomicBoolean();
    private volatile IShellDisplay remote;
    private volatile JSONObject current;
    private volatile JSONObject heldSession, handoffSnapshot;
    // A local cancellation remains final even if a new status probe beats asynchronous cleanup.
    private final java.util.Set<String> retiredHandoffIds=new java.util.HashSet<>();
    private final java.util.Set<DisplayCommandGuard.Session> retiredHandoffSessions=new java.util.HashSet<>();
    private long lastHandoffRefresh;
    private volatile JSONObject rear = new JSONObject();
    private volatile boolean binding, showing, closing;
    private boolean takingHandoff; // stateLock: a successful move releases its source before the reply arrives.
    private long rearVisibilityRevision;
    public record RearVisibility(long revision, boolean showing) {}
    public synchronized RearVisibility rearVisibility(){return new RearVisibility(rearVisibilityRevision, showing);}
    private long lifecycleEpoch, bindAttempt;
    private long lastBindAttempt=-4_000,lastPermissionRefresh=-1_000;
    private final AtomicBoolean permissionRefreshing=new AtomicBoolean();
    private final AuthorizationState authorization=new AuthorizationState();
    private final Runnable permissionWatch=new Runnable(){
        @Override public void run(){schedulePermissionRefresh(false);main.postDelayed(this,2_000);}
    };
    /** State for fresh server probes; no Shizuku request callback is needed for transitions. */
    static final class AuthorizationState {
        private volatile String status="not_running";
        record Update(String previous,String current){boolean changed(){return !previous.equals(current);}boolean granted(){return "running".equals(current);}boolean invalidatesExisting(){return !granted();}}
        synchronized Update probe(Supplier<String> source){
            String next;try{next=source.get();}catch(Exception error){next="not_running";}
            String previous=status;status=next;return new Update(previous,next);
        }
        String status(){return status;}
        boolean shouldBind(boolean live,boolean pending,boolean closing,long now,long lastAttempt){
            return "running".equals(status)&&!live&&!pending&&!closing&&now-lastAttempt>=4_000;
        }
    }
    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name,IBinder binder){
            final IShellDisplay next=IShellDisplay.Stub.asInterface(binder);
            final long epoch;
            synchronized(stateLock){
                if(remote!=null&&remote.asBinder()==binder){binding=false;return;}
                binding=true;remote=null;current=null;heldSession=null;endLocalHandoff("dismissed","service_replaced");epoch=++lifecycleEpoch;
            }
            // Attaching/status calls must never block the UI or the rear stop button.
            new Thread(()->{
                try {
                    if(!authorized())throw new IllegalStateException("shizuku_permission_required");
                    next.attach(client);binder.linkToDeath(()->lost(next),0);
                    boolean freshGrant=authorized(),accepted;
                    synchronized(stateLock){accepted=lifecycleEpoch==epoch&&!closing&&freshGrant&&binder.isBinderAlive();if(accepted){remote=next;binding=false;}else if(lifecycleEpoch==epoch)binding=false;}
                    if(!accepted)return;
                    refreshRemoteAsync();changed();
                }catch(Exception error){synchronized(stateLock){if(lifecycleEpoch==epoch)binding=false;}lost(next);}
            },"Boujoy-display-attach").start();
        }
        @Override public void onServiceDisconnected(ComponentName name){lost(null);}
    };
    private DisplayBridge(Context context) {
        if(!BuildConfig.BACKGROUND_SUPPORTED)throw new IllegalStateException("background_not_supported");
        this.context=context;
        serviceArgs=new Shizuku.UserServiceArgs(new ComponentName(context,ShellDisplayService.class))
                .tag("boujoy-display-v1").daemon(false).processNameSuffix("boujoy_display").debuggable(false).version(USER_SERVICE_VERSION);
        Shizuku.addBinderReceivedListenerSticky(this::refresh);
        Shizuku.addBinderDeadListener(()->lost(null));
        Shizuku.addRequestPermissionResultListener((code,result)->{if(code==17031)refresh();});
        DisplayManager dm=(DisplayManager)context.getSystemService(Context.DISPLAY_SERVICE);
        if(dm!=null)dm.registerDisplayListener(new DisplayManager.DisplayListener(){
            public void onDisplayAdded(int id){refreshRemoteAsync();}
            public void onDisplayChanged(int id){}
            public void onDisplayRemoved(int id){
                synchronized(stateLock){JSONObject s=current;if(s!=null&&s.optInt("displayId",-1)==id){current=null;++lifecycleEpoch;}
                    if(!takingHandoff&&heldSession!=null&&heldSession.optInt("displayId",-1)==id){heldSession=null;endLocalHandoff("dismissed","display_removed");++lifecycleEpoch;}}
                changed();refreshRemoteAsync();
            }
        },main);
        main.post(permissionWatch);
    }
    public void addLifecycleListener(Runnable listener){listeners.addIfAbsent(listener);}
    public void removeLifecycleListener(Runnable listener){listeners.remove(listener);}
    private void changed(){main.post(()->{for(Runnable r:listeners)try{r.run();}catch(Exception ignored){}});}
    private void lost(IShellDisplay expected){
        IShellDisplay old;JSONObject oldSession;
        synchronized(stateLock){
            if(expected!=null&&remote!=expected)return;
            old=remote;oldSession=current!=null?current:heldSession;if(retainingHandoff())retireSession(oldSession);remote=null;binding=false;current=null;heldSession=null;endLocalHandoff("dismissed","service_disconnected");showing=false;++lifecycleEpoch;
        }
        if(old!=null&&oldSession!=null)new Thread(()->releaseOrphan(old,oldSession),"Boujoy-display-release").start();
        changed();
    }
    private void releaseOrphan(IShellDisplay value,JSONObject oldSession){
        if(value==null||oldSession==null)return;
        // Close only the abandoned generation. A late cleanup must not revoke a new attachment.
        try{value.command("close",new JSONObject().put("session",oldSession).toString(),null);}catch(Exception ignored){}
    }
    private String queryAuthorization(){
        try{
            IBinder binder=Shizuku.getBinder();
            if(binder==null||!binder.isBinderAlive())return "not_running";
            if(Shizuku.getUid()!=2000)return "unsupported";
            // The public API caches granted=true. Query the official server AIDL so a
            // permission change made in Shizuku Manager is authoritative immediately.
            return IShizukuService.Stub.asInterface(binder).checkSelfPermission()?"running":"permission_required";
        }catch(Exception unavailable){return "not_running";}
    }
    private boolean authorized(){
        // Never invoke this while holding stateLock/mutationLock: it performs Binder IPC.
        AuthorizationState.Update update=authorization.probe(this::queryAuthorization);
        boolean invalidate;
        synchronized(stateLock){invalidate=update.invalidatesExisting()&&(remote!=null||current!=null||binding);}
        if(invalidate)lost(null);else if(update.changed())changed();
        return update.granted();
    }
    public void refresh(){schedulePermissionRefresh(true);}
    private void schedulePermissionRefresh(boolean force){
        long now=SystemClock.elapsedRealtime();
        synchronized(stateLock){
            if(!force&&now-lastPermissionRefresh<1_000)return;
            if(!permissionRefreshing.compareAndSet(false,true))return;
            lastPermissionRefresh=now;
        }
        new Thread(()->{
            try{
                if(!authorized())return;
                IShellDisplay active=remote;
                if(active!=null&&!active.asBinder().isBinderAlive())lost(active);
                final long attempt;
                synchronized(stateLock){
                    long at=SystemClock.elapsedRealtime();
                    if(!authorization.shouldBind(remote!=null,binding,closing,at,lastBindAttempt))return;
                    binding=true;lastBindAttempt=at;attempt=++bindAttempt;
                }
                main.post(()->{
                    synchronized(stateLock){if(attempt!=bindAttempt||!binding||closing||!"running".equals(authorization.status()))return;}
                    try{
                        Shizuku.bindUserService(serviceArgs,connection);
                        main.postDelayed(()->{synchronized(stateLock){if(attempt==bindAttempt&&remote==null)binding=false;}},8_000);
                    }catch(Exception error){synchronized(stateLock){if(attempt==bindAttempt)binding=false;}changed();}
                });
            }finally{permissionRefreshing.set(false);}
        },"Boujoy-display-permission").start();
    }
    public void requestPermission(Activity activity){
        try {
            if(!Shizuku.pingBinder())throw new IllegalStateException("请先在 Shizuku 中启动服务");
            if(authorized())refresh();
            else Shizuku.requestPermission(17031);
        }catch(RuntimeException e){android.widget.Toast.makeText(activity,e.getMessage(),android.widget.Toast.LENGTH_LONG).show();}
    }
    public boolean isLocked(){try{KeyguardManager km=(KeyguardManager)context.getSystemService(Context.KEYGUARD_SERVICE);return km==null||km.isKeyguardLocked();}catch(Exception e){return true;}}
    // Set by the connection service from the Mac's execution mode (background) and the user's
    // explicit request to keep running with the screen off. Never true in main-screen mode.
    private volatile boolean lockedExecutionAllowed;
    public void setLockedExecutionAllowed(boolean value){if(lockedExecutionAllowed!=value){lockedExecutionAllowed=value;changed();}}
    public boolean lockedExecutionAllowed(){return lockedExecutionAllowed;}
    /** A locked main screen blocks execution unless background mode allows it and the session display is always unlocked. */
    public boolean effectiveLocked(){return effectiveLocked(isLocked(),lockedExecutionAllowed,current);}
    static boolean effectiveLocked(boolean keyguardLocked,boolean allowed,JSONObject session){
        if(!keyguardLocked)return false;
        if(!allowed)return true;
        // No session yet: the next one is created always-unlocked or refused by the shell.
        return session!=null&&!session.optBoolean("alwaysUnlocked",false);
    }
    @Override public JSONObject status(){
        schedulePermissionRefresh(false);
        try {
            String shizuku=authorization.status();
            IShellDisplay active=remote;boolean live="running".equals(shizuku)&&active!=null&&active.asBinder().isBinderAlive()&&!closing;
            String reason=switch(shizuku){
                case "unsupported"->"display_unsupported";
                case "permission_required"->"shizuku_permission_required";
                case "running"->!live?"user_service_unavailable":!BoujoyDisplayService.isConnected()?"executor_service_disabled":null;
                default->"shizuku_not_running";
            };
            boolean ready=reason==null;
            if(ready&&effectiveLocked()){ready=false;reason="locked";}
            JSONObject r=copy(rear);r.put("showing",showing);
            JSONObject cached=current;
            return new JSONObject().put("protocol",1).put("shizuku",shizuku).put("executorService",BoujoyDisplayService.isConnected())
                    .put("userService",live).put("session",cached==null?JSONObject.NULL:copy(cached))
                    .put("features",new JSONArray().put("session_handoff")).put("handoff",handoffSnapshot==null?JSONObject.NULL:copy(handoffSnapshot))
                    .put("rear",r).put("ready",ready).put("reason",reason==null?JSONObject.NULL:reason);
        }catch(Exception e){return new JSONObject();}
    }
    /** Local snapshot only: safe in UI and revocation paths, never calls the shell. */
    @Override public JSONObject session(){JSONObject value=current;return value==null?null:copy(value);}
    private void refreshRemoteAsync(){
        final IShellDisplay value;final long epoch;
        synchronized(stateLock){value=remote;epoch=lifecycleEpoch;if(value==null||closing)return;}
        if(!refreshing.compareAndSet(false,true))return;
        new Thread(()->{
            try {
                synchronized(mutationLock){
                    synchronized(stateLock){if(remote!=value||lifecycleEpoch!=epoch||closing)return;}
                    JSONObject result=unpack(value.command("status","{}",null));
                    synchronized(stateLock){
                        if(remote!=value||lifecycleEpoch!=epoch||closing)return;
                        JSONObject incoming=result.optJSONObject("session"),incomingHandoff=result.optJSONObject("handoff");
                        current=isRetiredSession(incoming)?null:incoming;
                        if(incomingHandoff==null||!retiredHandoffIds.contains(incomingHandoff.optString("handoffId"))){
                            JSONObject held=result.optJSONObject("heldSession");heldSession=isRetiredSession(held)?null:held;handoffSnapshot=incomingHandoff;
                        }else heldSession=null; // Keep the local terminal snapshot and its reason.

                        rear=result.optJSONObject("rear");if(rear==null)rear=new JSONObject();
                    }
                }
                changed();
            }catch(Exception error){synchronized(stateLock){if(remote!=value||lifecycleEpoch!=epoch)return;}lost(value);}
            finally{refreshing.set(false);}
        },"Boujoy-display-state").start();
    }
    @Override public JSONObject open(JSONObject args)throws Exception{
        if(!authorized()||isLocked()&&!lockedExecutionAllowed||!BoujoyDisplayService.isConnected())throw new DisplayExecutor.BackendException("EXECUTOR_UNAVAILABLE",false);
        final IShellDisplay value;final long epoch;final JSONObject opened,abandoned;
        synchronized(mutationLock){
            synchronized(stateLock){
                if(closing)throw new DisplayExecutor.BackendException("LOCALLY_PAUSED",false);
                value=require();
                if(current!=null)return copy(current);
                // The old display's expected removal must not invalidate this new open's epoch.
                abandoned=heldSession;retireSession(abandoned);heldSession=null;endLocalHandoff("dismissed","new_session");
                epoch=++lifecycleEpoch;
            }
            try{
            long generation=Math.addExact(context.getSharedPreferences("display_backend",Context.MODE_PRIVATE).getLong("generation",0),1);
            if(!context.getSharedPreferences("display_backend",Context.MODE_PRIVATE).edit().putLong("generation",generation).commit())throw new DisplayExecutor.BackendException("EXECUTOR_UNAVAILABLE",false);
            JSONObject request=copy(args).put("sessionId",UUID.randomUUID().toString()).put("generation",generation);
            // The Binder permit executes on a different thread and never takes mutationLock.
            opened=unpack(value.command("open",request.toString(),permit(()->same(value,epoch)&&BoujoyDisplayService.isConnected())));}
            catch(Exception failed){releaseOrphanAsync(value,abandoned);changed();throw failed;}
        }
        boolean freshGrant=authorized(),unlocked=!isLocked()||lockedExecutionAllowed&&opened.optBoolean("alwaysUnlocked",false),accepted;
        synchronized(stateLock){
            accepted=remote==value&&lifecycleEpoch==epoch&&!closing&&freshGrant&&unlocked&&BoujoyDisplayService.isConnected();
            if(accepted){current=opened;heldSession=null;endLocalHandoff("dismissed","new_session");}
        }
        if(!accepted){releaseOrphan(value,opened);throw new DisplayExecutor.BackendException("LOCALLY_PAUSED",false);}
        changed();return copy(opened);
    }
    private boolean same(IShellDisplay value,long epoch){synchronized(stateLock){return remote==value&&lifecycleEpoch==epoch&&!closing;}}
    @Override public void close()throws Exception{
        final IShellDisplay value;
        synchronized(stateLock){value=remote;if(retainingHandoff())retireSession(heldSession!=null?heldSession:current);current=null;heldSession=null;endLocalHandoff("dismissed","closed");closing=true;++lifecycleEpoch;}
        changed();
        try{
            if(value!=null)value.revoke();
            synchronized(mutationLock){if(value!=null)unpack(value.command("close","{}",null));}
        }finally{synchronized(stateLock){closing=false;}changed();}
    }
    public void revoke(){
        final IShellDisplay value;
        synchronized(stateLock){value=remote;if(retainingHandoff())retireSession(heldSession!=null?heldSession:current);current=null;heldSession=null;endLocalHandoff("dismissed","revoked");++lifecycleEpoch;}
        if(value!=null)try{value.revoke();}catch(Exception ignored){}changed();
    }
    /** Local-only presentation state. Pending/failed pages remain inaccessible to the Mac. */
    public JSONObject handoff(){JSONObject value=handoffSnapshot;return value==null?null:copy(value);}
    private boolean retainingHandoff(){JSONObject h=handoffSnapshot;return h!=null&&("pending".equals(h.optString("state"))||"failed".equals(h.optString("state")));}
    private void endLocalHandoff(String state,String reason){
        if(!retainingHandoff())return;
        retiredHandoffIds.add(handoffSnapshot.optString("handoffId"));retireSession(heldSession);
        JSONObject next=copy(handoffSnapshot);
        try{next.put("state",state).put("reason",reason).put("at",java.time.Instant.now().toString());}catch(Exception ignored){}
        handoffSnapshot=next;
    }
    private void retireSession(JSONObject value){DisplayCommandGuard.Session id=DisplayCommandGuard.Session.read(value);if(id!=null)retiredHandoffSessions.add(id);}
    private boolean isRetiredSession(JSONObject value){DisplayCommandGuard.Session id=DisplayCommandGuard.Session.read(value);return id!=null&&retiredHandoffSessions.contains(id);}
    private boolean sameHandoff(IShellDisplay value,long epoch,String id){
        synchronized(stateLock){return same(value,epoch)&&retainingHandoff()&&heldSession!=null
                &&id.equals(handoffSnapshot.optString("handoffId"))&&System.currentTimeMillis()<handoffSnapshot.optLong("expiresAtMs");}
    }
    @Override public JSONObject handoff(JSONObject session,JSONObject args,BooleanSupplier allowed)throws Exception{
        if(!authorized()||!allowed.getAsBoolean())throw new DisplayExecutor.BackendException("LOCALLY_PAUSED",false);
        final IShellDisplay value;final long epoch;final String id=UUID.randomUUID().toString();final JSONObject result;
        synchronized(mutationLock){
            synchronized(stateLock){
                value=require();
                if(!sameSession(session,current)||closing)throw new DisplayExecutor.BackendException("SESSION_STALE",false);
                DisplayHandoff local=new DisplayHandoff();local.begin(id,args.getString("task_id"),args.getString("title"),args.getString("summary"),System.currentTimeMillis(),SystemClock.elapsedRealtime());
                current=null;heldSession=copy(session);handoffSnapshot=local.snapshot();epoch=++lifecycleEpoch;
            }
            changed();
            try{
                result=unpack(value.command("handoff",copy(args).put("handoffId",id).put("session",session).toString(),
                        permit(()->sameHandoff(value,epoch,id)&&allowed.getAsBoolean())));
            }catch(Exception failure){
                synchronized(stateLock){if(same(value,epoch)){retireSession(session);heldSession=null;endLocalHandoff("dismissed","handoff_unconfirmed");++lifecycleEpoch;}}
                releaseOrphan(value,session);changed();throw failure;
            }
            synchronized(stateLock){
                if(!sameHandoff(value,epoch,id)){releaseOrphanAsync(value,session);throw new DisplayExecutor.BackendException("LOCALLY_PAUSED",false);}
                handoffSnapshot=result.getJSONObject("handoff");heldSession=result.getJSONObject("heldSession");
            }
        }
        changed();return handoff();
    }
    /** Explicit user acceptance only; movement causes the trampoline to lose focus normally. */
    public JSONObject takeHandoff(String id,BooleanSupplier allowed)throws Exception{
        if(!authorized()||isLocked()||!allowed.getAsBoolean())throw new DisplayExecutor.BackendException("HANDOFF_NOT_ALLOWED",false);
        synchronized(mutationLock){
            final IShellDisplay value;final long epoch;final JSONObject held;
            synchronized(stateLock){value=require();epoch=lifecycleEpoch;if(!sameHandoff(value,epoch,id))throw new DisplayExecutor.BackendException("HANDOFF_STALE",false);held=copy(heldSession);}
            IDisplayPermit permission=new IDisplayPermit.Stub(){
                public boolean permits(){try{return authorized()&&sameHandoff(value,epoch,id)&&!isLocked()&&allowed.getAsBoolean();}catch(Exception denied){return false;}}
                // For this narrow operation this is the post-move liveness channel, never lock permission.
                public boolean permitsWhileLocked(){return authorized()&&sameHandoff(value,epoch,id)&&!isLocked();}
            };
            synchronized(stateLock){takingHandoff=true;}
            try{
                JSONObject result=unpack(value.command("handoff_take",Tunnel.json("handoffId",id,"session",held).toString(),permission));
                synchronized(stateLock){
                    if(!same(value,epoch))throw new DisplayExecutor.BackendException("HANDOFF_STALE",false);
                    handoffSnapshot=result.getJSONObject("handoff");if(!retainingHandoff())heldSession=null;
                }
            }finally{synchronized(stateLock){takingHandoff=false;}refreshRemoteAsync();}
        }
        changed();return handoff();
    }
    public void dismissHandoff(String id,String state)throws Exception{
        if(!"dismissed".equals(state)&&!"expired".equals(state))throw new IllegalArgumentException("handoff_state");
        synchronized(mutationLock){
            final IShellDisplay value;final long epoch;
            synchronized(stateLock){value=require();epoch=lifecycleEpoch;if(!sameHandoff(value,epoch,id)&&!(retainingHandoff()&&id.equals(handoffSnapshot.optString("handoffId"))))throw new DisplayExecutor.BackendException("HANDOFF_STALE",false);}
            JSONObject result=unpack(value.command("handoff_dismiss",Tunnel.json("handoffId",id,"state",state).toString(),null));
            synchronized(stateLock){if(!same(value,epoch))return;handoffSnapshot=result.getJSONObject("handoff");heldSession=null;++lifecycleEpoch;}
        }
        changed();
    }
    /** Revocation cannot wait behind a Binder call or UI operation. Cleanup is generation-specific. */
    @Override public void abandonHandoff(String reason){abandonHandoffMatching(null,reason);}
    /** Explicit local dismissal can revoke a move immediately, without waiting in its worker queue. */
    public boolean abandonHandoff(String id,String reason){return id!=null&&!id.isBlank()&&abandonHandoffMatching(id,reason);}
    private boolean abandonHandoffMatching(String expectedId,String reason){
        final IShellDisplay value;final JSONObject held;
        synchronized(stateLock){
            if(heldSession==null||!retainingHandoff()||expectedId!=null&&!expectedId.equals(handoffSnapshot.optString("handoffId")))return false;
            value=remote;held=heldSession;retireSession(held);heldSession=null;endLocalHandoff("dismissed",reason);++lifecycleEpoch;
        }
        changed();releaseOrphanAsync(value,held);return true;
    }
    private void releaseOrphanAsync(IShellDisplay value,JSONObject held){if(value!=null&&held!=null)new Thread(()->releaseOrphan(value,held),"Boujoy-handoff-release").start();}
    @Override public void idleHandoff(){
        JSONObject h=handoffSnapshot;if(h==null||!retainingHandoff())return;
        if(System.currentTimeMillis()>=h.optLong("expiresAtMs")){
            final IShellDisplay value;final JSONObject held;
            synchronized(stateLock){if(!retainingHandoff())return;value=remote;held=heldSession;retireSession(held);heldSession=null;endLocalHandoff("expired","timeout");++lifecycleEpoch;}
            changed();releaseOrphanAsync(value,held);
        }else{
            synchronized(stateLock){long tick=SystemClock.elapsedRealtime();if(tick-lastHandoffRefresh<5_000)return;lastHandoffRefresh=tick;}
            refreshRemoteAsync();
        }
    }
    private static boolean sameSession(JSONObject a,JSONObject b){
        DisplayCommandGuard.Session identity=DisplayCommandGuard.Session.read(a);return identity!=null&&identity.equals(DisplayCommandGuard.Session.read(b));
    }
    @Override public JSONArray listApps()throws Exception{if(!authorized())throw new DisplayExecutor.BackendException("EXECUTOR_UNAVAILABLE",false);return unpack(require().command("list_apps","{}",null)).getJSONArray("apps");}
    @Override public JSONObject effect(String op,JSONObject args,BooleanSupplier allowed)throws Exception{
        if(!authorized()||!allowed.getAsBoolean())throw new DisplayExecutor.BackendException("LOCALLY_PAUSED",false);
        final IShellDisplay value;final long epoch;final JSONObject s;
        synchronized(stateLock){value=require();epoch=lifecycleEpoch;s=session();}
        if(s==null)throw new DisplayExecutor.BackendException("SESSION_STALE",false);
        JSONObject request=copy(args).put("session",s);
        return unpack(value.command(op,request.toString(),permit(()->same(value,epoch)&&allowed.getAsBoolean())));
    }
    @Override public void recallStray()throws Exception{
        if(!authorized())return;
        final IShellDisplay value;final long epoch;final JSONObject s;
        synchronized(stateLock){value=require();epoch=lifecycleEpoch;s=session();}
        if(s==null)return;
        unpack(value.command("recall",new JSONObject().put("session",s).toString(),permit(()->same(value,epoch))));
    }
    @Override public void markContentChanged()throws Exception{
        if(!authorized())throw new DisplayExecutor.BackendException("EXECUTOR_UNAVAILABLE",false);
        JSONObject s=session();if(s==null)throw new DisplayExecutor.BackendException("SESSION_STALE",false);
        unpack(require().command("frame_barrier",new JSONObject().put("session",s).toString(),null));
    }
    @Override public JSONObject screenshot(int maxDimension)throws Exception{return screenshot(maxDimension,()->true);}
    @Override public JSONObject screenshot(int maxDimension,BooleanSupplier allowed)throws Exception{
        if(!allowed.getAsBoolean())throw new DisplayExecutor.BackendException("LOCALLY_PAUSED",false);
        if(!authorized())throw new DisplayExecutor.BackendException("EXECUTOR_UNAVAILABLE",false);
        final IShellDisplay value;final long epoch;final JSONObject s;
        synchronized(stateLock){value=require();epoch=lifecycleEpoch;s=session();}
        if(s==null)throw new DisplayExecutor.BackendException("SESSION_STALE",false);
        ParcelFileDescriptor pfd=value.capture(s.toString(),maxDimension,permit(()->same(value,epoch)&&allowed.getAsBoolean()));
        if(pfd==null)throw new DisplayExecutor.BackendException("NO_FRAME",false);
        try(ParcelFileDescriptor.AutoCloseInputStream in=new ParcelFileDescriptor.AutoCloseInputStream(pfd)){
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();byte[] buffer=new byte[8192];int n;
            while((n=in.read(buffer))!=-1){if(bytes.size()+n>5_000_000)throw new IllegalStateException("frame_too_large");bytes.write(buffer,0,n);}
            // The frame belongs to this session: a locked main screen only stales it when the session may not run locked.
            if(!same(value,epoch)||!authorized()||effectiveLocked(isLocked(),lockedExecutionAllowed,s))throw new DisplayExecutor.BackendException("SESSION_STALE",false);
            if(!allowed.getAsBoolean())throw new DisplayExecutor.BackendException("LOCALLY_PAUSED",false);
            if(bytes.size()==0)throw new DisplayExecutor.BackendException("NO_FRAME",false);
            return decodeCapturedFrame(new JSONObject(bytes.toString("UTF-8")));
        }
    }
    /** Shell failures carry no image or page content; keep revocation separate from missing output. */
    static JSONObject decodeCapturedFrame(JSONObject payload)throws DisplayExecutor.BackendException {
        JSONObject error=payload.optJSONObject("error");
        if(error!=null){
            String code=error.optString("code","NO_FRAME");
            if(!java.util.Set.of("NO_FRAME","SESSION_STALE","LOCKED","LOCALLY_PAUSED").contains(code))code="NO_FRAME";
            throw new DisplayExecutor.BackendException(code,false);
        }
        return payload;
    }
    public static final String CLOSE_REAR_ACTION=BuildConfig.APPLICATION_ID+".CLOSE_REAR_PROGRESS";
    public boolean isRearProgressEnabled(){return context.getSharedPreferences("display_backend",Context.MODE_PRIVATE).getBoolean("rear_progress_enabled",false);}
    public void setRearProgressEnabled(boolean enabled){
        context.getSharedPreferences("display_backend",Context.MODE_PRIVATE).edit().putBoolean("rear_progress_enabled",enabled).apply();
        if(!enabled)context.sendBroadcast(new android.content.Intent(CLOSE_REAR_ACTION).setPackage(context.getPackageName()));
        changed();
    }
    public void startRear()throws Exception{startRear(()->true);}
    static boolean rearLaunchAllowed(boolean enabled,boolean keyguardLocked,boolean backgroundAllowed,boolean callerAllowed){
        return enabled&&(!keyguardLocked||backgroundAllowed)&&callerAllowed;
    }
    public void startRear(BooleanSupplier allowed)throws Exception{
        final IShellDisplay value;final long epoch;
        synchronized(stateLock){value=require();epoch=lifecycleEpoch;}
        // Read the vendor permission outside stateLock; this never grants or changes it.
        if(RearLockscreenPermission.blocksRearLaunch(isLocked(),RearLockscreenPermission.read(context)))
            throw new DisplayExecutor.BackendException("REAR_LOCKSCREEN_PERMISSION_REQUIRED",false);
        // The shared permit re-reads Shizuku authorization. Background mode alone may
        // pass the keyguard check; the caller's opt-out/stop/epoch predicate still applies.
        unpack(value.command("rear","{}",permit(()->same(value,epoch)&&rearLaunchAllowed(isRearProgressEnabled(),isLocked(),lockedExecutionAllowed,allowed.getAsBoolean()))));
    }
    /** Fixed-purpose, short task lease; independent from slow display commands and am-start. */
    public void renewRearSleep(String id,long generation,long expiresAt,BooleanSupplier allowed)throws Exception{
        final IShellDisplay value;
        synchronized(stateLock){value=require();}
        BooleanSupplier live=()->sameRearOwner(value)&&isRearProgressEnabled()&&lockedExecutionAllowed&&showing
                &&SystemClock.elapsedRealtime()<expiresAt&&allowed.getAsBoolean();
        if(!live.getAsBoolean())throw new DisplayExecutor.BackendException("REAR_LEASE_REVOKED",false);
        unpack(value.command("rear_sleep_lease",new JSONObject().put("leaseId",id).put("generation",generation)
                .put("expiresAtElapsedMs",expiresAt).toString(),permit(live)));
    }
    public void releaseRearSleep(String id,long generation)throws Exception{
        IShellDisplay value=remote;
        if(value!=null)unpack(value.command("rear_sleep_release",new JSONObject().put("leaseId",id).put("generation",generation).toString(),null));
    }
    private boolean sameRearOwner(IShellDisplay value){synchronized(stateLock){return remote==value&&!closing;}}
    public void setRearShowing(boolean value){synchronized(this){showing=value;rearVisibilityRevision++;}changed();}
    private IShellDisplay require()throws DisplayExecutor.BackendException{
        IShellDisplay value=remote;if(value==null||!value.asBinder().isBinderAlive()||closing||!"running".equals(authorization.status()))throw new DisplayExecutor.BackendException("EXECUTOR_UNAVAILABLE",false);return value;
    }
    // No synchronized mutation lock may be held by this callback: the caller awaits this Binder reply.
    private IDisplayPermit permit(BooleanSupplier allowed){return new IDisplayPermit.Stub(){
        @Override public boolean permits(){return authorized()&&(!isLocked()||lockedExecutionAllowed)&&allowed.getAsBoolean();}
        @Override public boolean permitsWhileLocked(){return lockedExecutionAllowed&&authorized()&&allowed.getAsBoolean();}
    };}
    private JSONObject unpack(String raw)throws Exception{
        JSONObject response=new JSONObject(raw);
        if(!response.optBoolean("ok"))throw new DisplayExecutor.BackendException(response.optString("code","DISPLAY_BACKEND_ERROR"),response.optBoolean("started",true));
        return response.getJSONObject("value");
    }
    private static JSONObject copy(JSONObject value){try{return value==null?new JSONObject():new JSONObject(value.toString());}catch(Exception e){return new JSONObject();}}
}
