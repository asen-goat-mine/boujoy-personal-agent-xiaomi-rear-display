package dev.boujoy.personalagent;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.net.*;
import android.hardware.display.DisplayManager;
import android.view.Display;
import android.os.*;
import org.json.*;
import java.time.Instant;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/** Long-lived user-enabled connection. A local stop never waits for the network worker. */
public final class ConnectionService extends Service {
    public static final String UPDATE=BuildConfig.APPLICATION_ID+".UPDATE",STOP=BuildConfig.APPLICATION_ID+".STOP",DEMO_STOP=BuildConfig.APPLICATION_ID+".DEMO_STOP";
    private static final String CHANNEL="boujoy-connection",TASK_CHANNEL="boujoy-task-updates";
    public static volatile ConnectionService current;
    public interface Outcome<T>{void done(T value,Exception error);}
    private final MobileWorkers workers=new MobileWorkers();
    private final ScheduledExecutorService worker=workers.connection;
    private final ExecutorService controlWorker=workers.control,voiceWorker=workers.voice,historyWorker=workers.history;
    private final ExecutorService persistenceWorker=workers.persistence,fileWorker=workers.files,messageWorker=workers.messages;
    private final RequestFlights messageFlights=new RequestFlights();
    private final RequestFlights taskActions=new RequestFlights();
    private final ApprovalRequests approvalRequests=new ApprovalRequests();
    private final TaskDetailCache taskDetailCache=new TaskDetailCache();
    private final Object dataLock=new Object();
    private SecureStore store;
    ShareFiles shareFiles;
    private volatile ControlState gate;
    private volatile Tunnel tunnel;
    private volatile GatewayClient gateway;
    private volatile Binding binding;
    private volatile boolean paired,destroyed,chatHistoryVisible;
    private volatile String focusedConversation="";
    private volatile long lastAuthenticatedAt,serverClockOffset,lastTelemetryAt,stateSyncedAtElapsedMs;
    private volatile DisplayExecutor displayExecutor;
    private RearProgressCoordinator rearProgress;
    private RearTaskLease rearTaskLease;
    private final ExecutorService rearLeaseWorker=Executors.newSingleThreadExecutor(r->new Thread(r,"Boujoy-rear-task-lease"));
    private DisplayBridge displayBridge;
    private final ExecutorService displayUserWorker=Executors.newSingleThreadExecutor(r->new Thread(r,"Boujoy-display-user-action"));
    private final AtomicLong handoffActionRevision=new AtomicLong();
    private final AtomicBoolean displayNoticeFlight=new AtomicBoolean();
    private final AvailabilityNotice displayAvailability=new AvailabilityNotice();
    private DisplayNotifications displayNotifications;
    private final Runnable displayLifecycle=this::displayCapabilitiesChanged;
    private final AtomicLong telemetryRevision=new AtomicLong();
    private final AtomicBoolean displayInvalidating=new AtomicBoolean();
    private volatile boolean lastDisplayLocked=true;
    private PowerManager.WakeLock backgroundCpu;
    /** The Mac's execution mode, as last synced. Background mode keeps the main screen entirely the user's. */
    boolean backgroundMode(){if(!BuildConfig.BACKGROUND_SUPPORTED)return false;JSONObject value;synchronized(dataLock){value=cachedState.optJSONObject("phoneExecution");}return value!=null&&"background".equals(value.optString("mode"));}
    private volatile String lastStateSyncAt="",lastFailedStep="",lastFailureAt="";
    private final AtomicLong stateFailures=new AtomicLong();
    private volatile JSONObject maintenanceRequest;
    private String persistedSnapshot="";
    private final AtomicLong lastSyncedEpoch=new AtomicLong(-1);
    private final AtomicLong stateRequests=new AtomicLong();
    private volatile long completedStateRequest;
    private final AtomicBoolean maintenanceFlight=new AtomicBoolean(),outboxFlight=new AtomicBoolean(),shareFlight=new AtomicBoolean(),telemetryFlight=new AtomicBoolean(),notificationsFlight=new AtomicBoolean(),cacheFlight=new AtomicBoolean();
    private volatile String status="尚未连接电脑",error="";
    private String reportedNotifications="";
    private JSONObject cachedState=new JSONObject(),outbox=new JSONObject(),notificationLedger=new JSONObject(),groupRequests=new JSONObject();
    private JSONObject snapshotSource;private String snapshotText="{}";
    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback networkCallback;
    private ScreenHold screenHold;
    private PowerManager power;
    private KeyguardManager keyguard;
    private BroadcastReceiver screenReceiver;
    private final Handler screenHandler=new Handler(Looper.getMainLooper());
    private final WirelessInputNotice wirelessNotice=new WirelessInputNotice();
    private final Runnable screenTick=new Runnable(){public void run(){if(!destroyed){refreshScreenHold();refreshDisplayLockState();refreshRearPresentation();wirelessInputNotice();refreshDisplayNotices();screenHandler.postDelayed(this,1000);}}};

    @Override public void onCreate(){
        super.onCreate();current=this;createChannel();
        if(Build.VERSION.SDK_INT>=34)startForeground(1,notification(),ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(1,notification());
        store=new SecureStore(this);displayNotifications=new DisplayNotifications(this);
        try {gate=store.controlState();gate.pause("phone_restart");outbox=store.read("outbox");notificationLedger=store.read("task-notifications");groupRequests=store.read("group-requests");}
        catch(Exception e){error="本地状态无法核实，请打开 Boujoy 检查";status="已暂停";changed();return;}
        try{shareFiles=new ShareFiles(this,store);}catch(Exception e){fail("附件交接记录无法读取",e);return;}
        try{cachedState=store.read("last-state");taskDetailCache.update(cachedState.optJSONArray("tasks"));}catch(Exception e){recordSyncFailure("cache_publish",e);}
        setupScreenHold();
        if(BuildConfig.BACKGROUND_SUPPORTED){
        displayBridge=DisplayBridge.get(this);
        rearTaskLease=new RearTaskLease(rearLeaseWorker,this::rearProgressState,SystemClock::elapsedRealtime,new RearTaskLease.Backend(){
            public void renew(String id,long generation,long expiresAt,BooleanSupplier allowed)throws Exception{
                DisplayBridge bridge=displayBridge;
                if(bridge==null)throw new IllegalStateException("rear_backend_unavailable");
                bridge.renewRearSleep(id,generation,expiresAt,allowed);
            }
            public void release(String id,long generation)throws Exception{
                DisplayBridge bridge=displayBridge;if(bridge!=null)bridge.releaseRearSleep(id,generation);
            }
        });
        displayExecutor=new DisplayExecutor(gate,displayBridge,()->{Binding active=binding;return active==null?"":active.deviceId;},this::serverNow,()->keyguard==null||displayBridge.effectiveLocked());
        rearProgress=new RearProgressCoordinator(workers.rearProgress,this::rearProgressState,SystemClock::elapsedRealtime,this::launchRearProgress,diagnostic->android.util.Log.i("BoujoyRear",diagnostic.toString()));
        displayBridge.addLifecycleListener(displayLifecycle);
        BoujoyDisplayService.setLifecycleListener(displayLifecycle);
        displayBridge.refresh();
        }
        connectivity=getSystemService(ConnectivityManager.class);
        networkCallback=new ConnectivityManager.NetworkCallback(){
            @Override public void onAvailable(Network network){Tunnel t=tunnel;if(t!=null)t.reconnect();}
            @Override public void onLost(Network network){lastAuthenticatedAt=0;lastTelemetryAt=0;if(rearTaskLease!=null)rearTaskLease.invalidate();if(shareFiles!=null)shareFiles.invalidate();changed();}
        };
        connectivity.registerDefaultNetworkCallback(networkCallback);
        worker.execute(this::loadBinding);
        worker.scheduleWithFixedDelay(this::tick,2,4,TimeUnit.SECONDS);
        workers.typing.execute(this::typingLoop);
        if(BuildConfig.BACKGROUND_SUPPORTED)workers.display.execute(this::displayLoop);
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        if(intent!=null&&STOP.equals(intent.getAction()))pauseLocal("notification_stop");
        if(intent!=null&&DisplayNotifications.DISMISS.equals(intent.getAction()))dismissHandoff(intent.getStringExtra(DisplayNotifications.HANDOFF_EXTRA));
        if(intent!=null&&DEMO_STOP.equals(intent.getAction())){JSONObject demo; synchronized(dataLock){demo=cachedState.optJSONObject("demonstration");}if(demo!=null)stopDemonstration(demo.optString("id"),(result,error)->{});}
        return START_STICKY;
    }
    @Override public IBinder onBind(Intent intent){return null;}
    @SuppressWarnings("deprecation")
    private void setupScreenHold(){
        power=getSystemService(PowerManager.class);keyguard=getSystemService(KeyguardManager.class);
        // No ACQUIRE_CAUSES_WAKEUP, ON_AFTER_RELEASE, lockscreen dismissal or timeout setting changes.
        PowerManager.WakeLock wake=power.newWakeLock(PowerManager.SCREEN_DIM_WAKE_LOCK,"Boujoy:ExplicitPhoneTask");wake.setReferenceCounted(false);
        screenHold=new ScreenHold(new ScreenHold.Actuator(){
            public void acquire(long timeout){if(!power.isInteractive()||keyguard.isDeviceLocked())throw new IllegalStateException("请先解锁并保持亮屏");wake.acquire(timeout);}
            public void release(){if(wake.isHeld())wake.release();}
        },SystemClock::elapsedRealtime);
        screenReceiver=new BroadcastReceiver(){@Override public void onReceive(Context context,Intent intent){if(Intent.ACTION_SCREEN_OFF.equals(intent.getAction())){ControlState state=gate;if(state!=null&&state.screenOffPauses()&&!backgroundMode())pauseLocal("screen_off");}else if(Intent.ACTION_USER_PRESENT.equals(intent.getAction()))resumeAfterUnlock();refreshRearPresentation();}};
        IntentFilter screenEvents=new IntentFilter(Intent.ACTION_SCREEN_OFF);screenEvents.addAction(Intent.ACTION_USER_PRESENT);screenEvents.addAction(Intent.ACTION_SCREEN_ON);
        registerReceiver(screenReceiver,screenEvents,Context.RECEIVER_NOT_EXPORTED);screenHandler.post(screenTick);
    }
    private void beginScreenHold(long epoch){
        if(screenHold==null||gate==null||backgroundMode())return;
        synchronized(gate){if(!gate.matches(new ControlState.Snapshot(epoch,false)))return;
            try{screenHold.begin(epoch,!keyguard.isDeviceLocked(),power.isInteractive(),authenticatedOnline());}
            catch(RuntimeException e){error="本次未能保持屏幕常亮，请保持手机亮屏";}
        }
    }
    private void refreshScreenHold(){
        if(screenHold==null)return;ControlState currentGate=gate;if(destroyed||currentGate==null||backgroundMode()){screenHold.release();return;}
        JSONArray tasks;long snapshotSerial;synchronized(dataLock){tasks=cachedState.optJSONArray("tasks");snapshotSerial=completedStateRequest;}
        synchronized(currentGate){screenHold.update(currentGate.epoch(),currentGate.paused(),authenticatedOnline(),!keyguard.isDeviceLocked(),power.isInteractive(),tasks,snapshotSerial);}
    }
    private void screenAccepted(long epoch,JSONObject reply){if(screenHold!=null)screenHold.accepted(epoch,reply.optString("taskId"),reply.optString("status"),stateRequests.get());}
    private void loadBinding(){try{JSONObject value=store.read("binding");if(value.has("relayUrl"))connect(value);}catch(Exception e){fail("绑定信息无法读取",e);}}
    private void connect(JSONObject value)throws Exception{
        Binding next=new Binding(value,false);
        invalidateDisplay("binding_changed");
        if(rearProgress!=null)rearProgress.invalidate();
        if(tunnel!=null)tunnel.close();taskDetailCache.clear();lastAuthenticatedAt=0;lastTelemetryAt=0;stateSyncedAtElapsedMs=0;
        binding=next;paired=value.optBoolean("paired",false);
        tunnel=new Tunnel(next,gate,this::changed);gateway=new GatewayClient(tunnel,next);tunnel.start();status="正在连接电脑";error="";changed();
    }
    /** User-requested transport retry; pairing, local pause and task history stay intact. */
    public void reconnectTransport(){
        Tunnel active=tunnel;if(destroyed||active==null)return;
        lastAuthenticatedAt=0;stateSyncedAtElapsedMs=0;lastTelemetryAt=0;
        telemetryRevision.incrementAndGet();
        active.reconnect();changed();
    }
    /** Called only by the user-visible main-display trampoline; never resumes the phone gate. */
    public void takeHandoff(String id,BooleanSupplier allowed,Outcome<JSONObject> callback){
        final String requested;try{requested=safeId(id);}catch(Exception invalid){screenHandler.post(()->callback.done(null,invalid));return;}
        DisplayBridge bridge=displayBridge;long revision=handoffActionRevision.incrementAndGet();
        BooleanSupplier permit=()->!destroyed&&displayBridge==bridge&&bridge!=null&&handoffActionRevision.get()==revision
                &&keyguard!=null&&!keyguard.isKeyguardLocked()&&allowed!=null&&allowed.getAsBoolean()
                &&handoffMatches(bridge.handoff(),requested,System.currentTimeMillis());
        try{displayUserWorker.execute(()->{
            JSONObject result=null;Exception error=null;
            try{if(!permit.getAsBoolean())throw new IllegalStateException("接手请求已失效，请重新打开");result=bridge.takeHandoff(requested,permit);}
            catch(Exception failure){error=failure;}
            finally{displayCapabilitiesChanged();}
            JSONObject done=result;Exception failure=error;screenHandler.post(()->callback.done(done,failure));
        });}catch(RejectedExecutionException closed){screenHandler.post(()->callback.done(null,closed));}
    }
    static boolean handoffMatches(JSONObject value,String id,long now){return id!=null&&DisplayNotifications.actionable(value,now)&&id.equals(value.optString("handoffId"));}
    /** Explicit local dismissal only; the exported surface never accepts a take action. */
    public void dismissHandoff(String id){
        final String requested;try{requested=safeId(id);}catch(Exception invalid){return;}
        DisplayBridge bridge=displayBridge;if(bridge==null||!handoffMatches(bridge.handoff(),requested,System.currentTimeMillis()))return;
        handoffActionRevision.incrementAndGet();
        // Revoke locally before any queued or in-flight take can perform another step.
        // Bridge clears the matching lease synchronously; generation-specific cleanup is asynchronous.
        if(!destroyed&&displayBridge==bridge&&bridge.abandonHandoff(requested,"user_dismissed"))displayCapabilitiesChanged();
    }
    public void importBinding(String source){worker.execute(()->{
        try{
            JSONObject value=new JSONObject(source.trim());new Binding(value,true);
            value.put("paired",false);value.put("identityAlias",DeviceIdentity.preparePairing());store.write("binding",value);
            pauseLocal("new_binding");connect(value);
        }catch(Exception e){fail("连接码无效",e);}
    });}
    static String decodeTypingOperation(JSONObject job) {
        if (job == null) return null;
        if (!job.has("operation")) return "type"; // Original wire format omitted this field.
        Object operation = job.opt("operation");
        if ("type".equals(operation) || "verify_replace".equals(operation)) return (String) operation;
        return null;
    }
    private boolean sameTypingContext(GatewayClient client,Tunnel active,ControlState state,Binding requestedBinding){
        return !destroyed&&paired&&requestedBinding!=null&&client==gateway&&active==tunnel&&state==gate&&requestedBinding==binding;
    }
    private boolean typingAllowed(GatewayClient client,Tunnel active,ControlState state,Binding requestedBinding,ControlState.Snapshot admitted){
        return sameTypingContext(client,active,state,requestedBinding)&&active.connected()&&!admitted.paused()&&state.matches(admitted);
    }
    private void typingLoop(){
        while(!destroyed){
            GatewayClient client=gateway;Tunnel current=tunnel;ControlState state=gate;Binding requestedBinding=binding;
            try{
                if(client==null||current==null||state==null||requestedBinding==null){Thread.sleep(1000);continue;}
                // The control-lane poll may outlive a stop and a later explicit resume.
                // Its reply belongs to the admission at poll start, never the new epoch.
                ControlState.Snapshot admitted=state.snapshot();
                if(!typingAllowed(client,current,state,requestedBinding,admitted)){Thread.sleep(1000);continue;}
                JSONObject reply=client.pollTyping();
                if(!typingAllowed(client,current,state,requestedBinding,admitted))continue;
                JSONObject job=reply.optJSONObject("job");if(job==null){Thread.sleep(200);continue;}
                long typingEpoch=job.has("controlEpoch")?job.optLong("controlEpoch",-1):admitted.epoch();
                if(typingEpoch!=admitted.epoch())continue;
                BoujoyTypingService.Outcome typingResult=BoujoyTypingService.perform(decodeTypingOperation(job),job.optString("text"),job.optString("mode"),job.optString("packageName"),job.optString("referenceId"),typingEpoch,
                        ()->typingAllowed(client,current,state,requestedBinding,admitted));
                for(int attempt=0;attempt<2;attempt++){
                    // A same-binding receipt can still report an in-flight outcome after stop;
                    // reconnecting/rebinding must not send this old job into another context.
                    if(!sameTypingContext(client,current,state,requestedBinding))break;
                    try{client.json("POST","/v1/device/typing",Tunnel.json("messageId",Protocol.id(),"id",job.getString("id"),"status",typingResult.status(),"diagnostic",typingResult.diagnostic(),"proof",typingResult.proof()),true);break;}
                    catch(GatewayClient.GatewayError error){if("typing_expired".equals(error.code)||attempt==1)break;Thread.sleep(300);}
                }
            }catch(InterruptedException error){Thread.currentThread().interrupt();return;}
            catch(Exception error){try{Thread.sleep(2000);}catch(InterruptedException interrupted){Thread.currentThread().interrupt();return;}}
        }
    }
    /** Commands and receipts never replay after an uncertain transport result. */
    private void displayLoop(){
        if(!BuildConfig.BACKGROUND_SUPPORTED)return;
        while(!destroyed){
            GatewayClient client=gateway;Tunnel activeTunnel=tunnel;ControlState state=gate;Binding activeBinding=binding;
            DisplayExecutor executor=displayExecutor;
            try{
                if(executor!=null)executor.idleTick();
                if(executor==null||client==null||activeTunnel==null||!activeTunnel.connected()||!paired||state==null||state.paused()){Thread.sleep(1000);continue;}
                JSONObject response=client.pollDisplay();
                if(destroyed||client!=gateway||state!=gate||activeBinding!=binding||!paired)continue;
                observeServer(response);
                JSONObject command=response.optJSONObject("command");
                if(command==null){Thread.sleep(200);continue;}
                // A response from a revoked/replaced binding cannot reach the new device session.
                if(destroyed||client!=gateway||state!=gate||activeBinding!=binding||!paired)continue;
                JSONObject result=executor.execute(command);
                if(destroyed||client!=gateway||activeBinding!=binding)continue;
                // Exactly one attempt, on the data lane. display_expired and lost replies are terminal.
                client.json("POST","/v1/device/display",Tunnel.json("messageId",Protocol.id(),"id",command.getString("id"),"result",result),false);
            }catch(InterruptedException error){Thread.currentThread().interrupt();return;}
            catch(Exception error){
                recordSyncFailure("display",error);
                try{Thread.sleep(1000);}catch(InterruptedException interrupted){Thread.currentThread().interrupt();return;}
            }
        }
    }
    /** Applies the Mac's execution mode to the executor gate as soon as a state sync lands; the screen tick is only a fallback. */
    private void applyExecutionMode(){
        DisplayBridge bridge=displayBridge;if(bridge!=null)bridge.setLockedExecutionAllowed(backgroundMode());
        screenHandler.post(()->{if(!destroyed)refreshDisplayLockState();});
    }
    private void refreshDisplayLockState(){
        DisplayBridge bridge=displayBridge;boolean background=backgroundMode();
        if(bridge!=null)bridge.setLockedExecutionAllowed(background);
        holdBackgroundCpu(background&&bridge!=null&&bridge.session()!=null&&gate!=null&&!gate.paused());
        boolean lockedNow=keyguard==null||(bridge==null?keyguard.isKeyguardLocked():bridge.effectiveLocked());
        if(lockedNow!=lastDisplayLocked){lastDisplayLocked=lockedNow;displayCapabilitiesChanged();}
    }
    /** Keeps the CPU (not the screen) running for an active background session; released as soon as it ends. */
    private void holdBackgroundCpu(boolean wanted){
        try{
            if(backgroundCpu==null){if(!wanted||power==null)return;backgroundCpu=power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"Boujoy:BackgroundDisplay");backgroundCpu.setReferenceCounted(false);}
            if(wanted)backgroundCpu.acquire(120_000);else if(backgroundCpu.isHeld())backgroundCpu.release();
        }catch(RuntimeException ignored){}
    }
    /** Called for local capability changes, independent of the 15-second heartbeat. */
    public void displayCapabilitiesChanged(){
        if(!BuildConfig.BACKGROUND_SUPPORTED||destroyed)return;
        DisplayExecutor executor=displayExecutor;
        DisplayBridge bridge=displayBridge;
        if(executor!=null){
            if(!BoujoyDisplayService.isConnected()||bridge==null||!bridge.status().optBoolean("userService"))invalidateDisplay("executor_unavailable");
            else executor.reconcileLifecycle();
        }
        telemetryRevision.incrementAndGet();lastTelemetryAt=0;
        changed();reportTelemetry();refreshRearPresentation();
    }
    private void invalidateDisplay(String reason){
        if(rearTaskLease!=null)rearTaskLease.invalidate();
        handoffActionRevision.incrementAndGet();
        DisplayExecutor executor=displayExecutor;
        if(executor==null||!displayInvalidating.compareAndSet(false,true))return;
        try{executor.invalidate(reason);}finally{displayInvalidating.set(false);}
    }
    private JSONObject displayBackendStatus(){DisplayExecutor executor=displayExecutor;return executor==null?Tunnel.json("protocol",1,"ready",false,"reason",BuildConfig.BACKGROUND_SUPPORTED?"user_service_unavailable":"background_not_supported","shizuku","not_running","executorService",false,"userService",false,"session",JSONObject.NULL,"rear",Tunnel.json("available",false,"displayId",JSONObject.NULL,"showing",false)):executor.status();}
    private void reportTelemetry(){
        if(destroyed||!paired||gateway==null||tunnel==null||!tunnel.connected()||!telemetryFlight.compareAndSet(false,true))return;
        try{workers.telemetry.execute(()->{
            long revision=telemetryRevision.get();boolean succeeded=false;GatewayClient client=gateway;
            try{
                if(client==null||destroyed)return;
                observeServer(client.json("POST","/v1/device/status",deviceBuildStatus(),true));
                if(client==gateway){lastTelemetryAt=SystemClock.elapsedRealtime();succeeded=true;}
            }catch(Exception e){recordSyncFailure("telemetry",e);}
            finally{
                telemetryFlight.set(false);
                // Preserve a capability change that arrived while the earlier report was in flight.
                if(revision!=telemetryRevision.get()){lastTelemetryAt=0;if(succeeded)reportTelemetry();}
            }
        });}catch(RejectedExecutionException e){telemetryFlight.set(false);if(!destroyed)throw e;}
    }
    private void tick(){
        if(destroyed||gateway==null||tunnel==null||!tunnel.connected())return;
        String step="pair";boolean authenticated=false;
        try{
            if(!paired){
                JSONObject pair=gateway.pair(binding);
                observeServer(pair);observeControl(pair);
                JSONObject saved=store.read("binding");saved.put("paired",true);saved.remove("pairToken");store.write("binding",saved);paired=true;
                syncControl("paired");
            }
            step="state";long stateRequest=stateRequests.incrementAndGet();JSONObject next=gateway.json("GET","/v1/state",null,false);
            authenticated=true;observeServer(next);
            // This is the connection signal. Auxiliary I/O cannot revoke it.
            synchronized(dataLock){cachedState=next;completedStateRequest=stateRequest;}
            applyExecutionMode();
            lastAuthenticatedAt=SystemClock.elapsedRealtime();stateSyncedAtElapsedMs=lastAuthenticatedAt;lastStateSyncAt=Instant.now().toString();status="电脑已连接";error="";
            try{observeControl(next.optJSONObject("device"));}catch(Exception e){recordSyncFailure("observe_control",e);pauseLocal("control_state_unavailable");}
            try{taskDetailCache.update(next.optJSONArray("tasks"));refreshTaskHistory();}catch(Exception e){recordSyncFailure("history",e);}
            changed();persistSnapshot();backgroundSync();
            if(rearTaskLease!=null)rearTaskLease.onStateSynced();
            if(rearProgress!=null)rearProgress.onStateSynced();
        }catch(Exception e){if(!authenticated){lastAuthenticatedAt=0;recordSyncFailure(step,e);fail("正在连接电脑…",e);}else recordSyncFailure("cache_publish",e);}
    }
    /** An am-start receipt is not proof that HyperOS kept the rear Activity visible. */
    private void launchRearProgress(BooleanSupplier allowed)throws Exception{
        DisplayBridge bridge=displayBridge;
        if(bridge==null||!allowed.getAsBoolean())throw new IllegalStateException("rear_launch_revoked");
        long before=bridge.rearVisibility().revision();
        bridge.startRear(allowed);
        awaitRearVisible(before,bridge::rearVisibility,allowed,SystemClock::elapsedRealtime,Thread::sleep);
    }
    interface RearVisibilitySleeper {void sleep(long milliseconds)throws InterruptedException;}
    static void awaitRearVisible(long before,Supplier<DisplayBridge.RearVisibility> visibility,BooleanSupplier allowed,
                                 LongSupplier clock,RearVisibilitySleeper sleeper)throws Exception{
        long started=clock.getAsLong(),stableAt=-1,stableRevision=-1;
        while(true){
            if(Thread.currentThread().isInterrupted())throw new InterruptedException("rear_visibility_interrupted");
            if(!allowed.getAsBoolean())throw new IllegalStateException("rear_launch_revoked");
            long now=clock.getAsLong();
            if(now<started||now-started>=2000)throw new IllegalStateException("rear_not_visible");
            DisplayBridge.RearVisibility observed=visibility.get();
            // A local Activity lifecycle revision is required. An old showing=true
            // from before this start cannot acknowledge the new presentation.
            if(observed!=null&&observed.revision()>before&&observed.showing()){
                if(stableRevision!=observed.revision()){stableAt=now;stableRevision=observed.revision();}
                if(now-stableAt>=200){
                    if(!allowed.getAsBoolean())throw new IllegalStateException("rear_launch_revoked");
                    return;
                }
            }else{stableAt=-1;stableRevision=-1;}
            try{sleeper.sleep(Math.min(50,2000-(now-started)));}
            catch(InterruptedException interrupted){Thread.currentThread().interrupt();throw interrupted;}
        }
    }
    /** Re-read all admission facts on the rear worker and at the shell launch barrier. */
    private RearProgressCoordinator.State rearProgressState(){
        ControlState state=gate;ControlState.Snapshot control=state==null?new ControlState.Snapshot(-1,true):state.snapshot();
        JSONArray tasks;long syncedControlEpoch;boolean syncedPaused;
        synchronized(dataLock){
            tasks=cachedState.optJSONArray("tasks");JSONObject device=cachedState.optJSONObject("device");
            syncedControlEpoch=device==null?-1:device.optLong("controlEpoch",-1);
            syncedPaused=device==null||device.optBoolean("paused",true);
        }
        // Screen/lifecycle ticks may read the last snapshot, but may not promote it
        // into a newer local resume epoch. Wait for a matching authenticated sync.
        long presentationEpoch=syncedControlEpoch==control.epoch()&&syncedPaused==control.paused()?control.epoch():-1;
        DisplayBridge bridge=displayBridge;
        DisplayExecutor executor=displayExecutor;String preferred=executor==null?"":executor.activeTaskId();
        JSONObject handoff=bridge==null?null:bridge.handoff();
        String candidate=DisplayNotifications.rearCandidate(handoff,RearProgressCoordinator.selectActiveTask(tasks,preferred),System.currentTimeMillis());
        String phase=candidate.startsWith("handoff:")&&handoff!=null?handoff.optString("state",""):RearProgressCoordinator.phaseKey(tasks,candidate);
        return new RearProgressCoordinator.State(candidate,presentationEpoch,stateSyncedAtElapsedMs,
                bridge!=null&&bridge.isRearProgressEnabled(),!destroyed&&paired&&authenticatedOnline(),control.paused(),keyguard==null||keyguard.isKeyguardLocked(),
                bridge!=null&&backgroundMode()&&bridge.lockedExecutionAllowed(),bridge!=null&&bridge.rearVisibility().showing(),phase,mainScreenOff(getSystemService(DisplayManager.class)));
    }
    /** A local presentation event never refreshes task/authentication timestamps. */
    private void refreshRearPresentation(){
        RearProgressCoordinator coordinator=rearProgress;
        if(!destroyed&&coordinator!=null)coordinator.onPresentationChanged();
        if(!destroyed&&rearTaskLease!=null)rearTaskLease.onPresentationChanged();
    }
    /** The rear can be ON while the main display sleeps; global interactive is insufficient. */
    static boolean mainScreenOff(DisplayManager displays){
        try{
            Display main=displays==null?null:displays.getDisplay(Display.DEFAULT_DISPLAY);
            if(main==null)return false;
            int state=main.getState();
            return state==Display.STATE_OFF||state==Display.STATE_DOZE||state==Display.STATE_DOZE_SUSPEND;
        }catch(RuntimeException unavailable){return false;}
    }
    private void recordSyncFailure(String step,Exception error){
        lastFailedStep=step;lastFailureAt=Instant.now().toString();if("state".equals(step)||"pair".equals(step))stateFailures.incrementAndGet();
        android.util.Log.w("BoujoyConnection",step+":"+ConnectionProblem.classify(error,0)+" "+ConnectionProblem.diagnostic(error));
    }
    private void persistSnapshot(){
        if(!cacheFlight.compareAndSet(false,true))return;
        persistenceWorker.execute(()->{try{
            JSONObject value; synchronized(dataLock){value=new JSONObject(cachedState.toString());}
            // The server clock ticks on every sync; alone it is no reason to encrypt and rewrite the cache.
            JSONObject comparable=new JSONObject(value.toString());comparable.remove("serverTime");
            String serialized=comparable.toString();if(!serialized.equals(persistedSnapshot)){store.write("last-state",value);persistedSnapshot=serialized;}
        }catch(Exception e){recordSyncFailure("cache_publish",e);}finally{cacheFlight.set(false);}});
    }
    /** Independent lanes preserve state freshness and explicit user actions during slow reports. */
    /** A pause that only came from the screen turning off ends when the user unlocks the phone (also catches an unlock while offline). */
    void resumeAfterUnlock(){
        ControlState state=gate;
        if(state==null||power==null||keyguard==null||!power.isInteractive()||keyguard.isDeviceLocked())return;
        long epoch;synchronized(state){if(!state.pausedByScreenOff())return;epoch=state.epoch();}
        resumeControl(epoch);
    }
    private void backgroundSync(){
        resumeAfterUnlock();
        if(maintenanceFlight.compareAndSet(false,true))workers.maintenance.execute(()->{try{
            JSONObject device;synchronized(dataLock){device=cachedState.optJSONObject("device");}
            if(!resumeAfterMaintenance(device)&&lastSyncedEpoch.get()!=gate.epoch())syncControl("reconnected_local_state");
        }catch(Exception e){recordSyncFailure("control_sync",e);}finally{maintenanceFlight.set(false);}});
        if(lastTelemetryAt==0||SystemClock.elapsedRealtime()-lastTelemetryAt>=15000)reportTelemetry();
        if(notificationsFlight.compareAndSet(false,true))workers.notifications.execute(()->{try{
            JSONArray tasks;synchronized(dataLock){tasks=cachedState.optJSONArray("tasks");}taskNotifications(tasks);
        }catch(Exception e){recordSyncFailure("notifications",e);}finally{notificationsFlight.set(false);}});
        if(outboxFlight.compareAndSet(false,true))workers.receipts.execute(()->{try{drainOutbox();}finally{outboxFlight.set(false);}});
        if(shareFlight.compareAndSet(false,true))fileWorker.execute(()->{try{pollShare();}catch(Exception e){recordSyncFailure("files",e);}finally{shareFlight.set(false);}});
    }
    private boolean resumeAfterMaintenance(JSONObject device)throws Exception{
        if(device==null||!"maintenance".equals(device.optString("reason")))return false;
        long epoch=device.optLong("controlEpoch",-1),origin=device.optLong("maintenanceResumeEpoch",-1);
        if(!gate.canResumeMaintenance(epoch,origin))return false;
        // Background mode keeps running with the screen off; canResumeMaintenance already refuses any user stop.
        if(!backgroundMode()&&(power==null||keyguard==null||!power.isInteractive()||keyguard.isDeviceLocked())){pauseLocal("screen_off");return true;}
        ControlState.Snapshot expected=new ControlState.Snapshot(epoch,true);
        JSONObject request=maintenanceRequest;
        if(request==null||request.optLong("maintenanceEpoch",-1)!=epoch){
            request=Tunnel.json("messageId",Protocol.id(),"controlEpoch",Math.addExact(epoch,1),"paused",false,"reason","maintenance_reconnected","maintenanceEpoch",epoch,"origin",origin);maintenanceRequest=request;
        }
        if(!gate.matches(expected))return true;
        JSONObject payload=new JSONObject(request.toString());payload.remove("origin");
        JSONObject reply=gateway.json("POST","/v1/device/control",payload,true);observeServer(reply);
        if(gate.acknowledgeMaintenance(expected,origin,reply.optLong("controlEpoch",-1),reply.optBoolean("paused",true))){
            lastSyncedEpoch.accumulateAndGet(reply.optLong("controlEpoch"),Math::max);maintenanceRequest=null;status="电脑已连接";changed();
        }
        return true;
    }

    public long pauseLocal(String reason){
        return pauseLocal(reason,null);
    }
    private long pauseLocal(String reason,Long expectedEpoch){
        ControlState state=gate;if(state==null)return -1;
        final ControlState.Snapshot requested;
        try{
            synchronized(state){
                if(expectedEpoch!=null&&state.epoch()!=expectedEpoch)return -1;
                requested=new ControlState.Snapshot(state.pause(reason),true);maintenanceRequest=null;
                status="screen_off".equals(reason)?"手机已锁屏；解锁后自动继续":"你已接管手机";
            }
        }catch(Exception e){invalidateDisplay("pause_persistence_failed");if(tunnel!=null)tunnel.close();fail("停止状态保存失败，连接已关闭",e);return -1;}
        // Stream, share and UI callbacks can themselves read the gate. Never hold it here.
        invalidateDisplay(reason);
        if(screenHold!=null)screenHold.release();if(shareFiles!=null)shareFiles.invalidate();
        Tunnel t=tunnel;if(t!=null)t.pausePhoneData();
        changed();
        try{controlWorker.execute(()->{
            if(gateway==null||!paired||!state.matches(requested))return;
            String message;
            try{syncControl(reason,requested);message="screen_off".equals(reason)?"手机已锁屏；解锁后自动继续":"已禁止后续操作，正在核实在途结果";}
            catch(Exception e){message="已在手机暂停；电脑确认待恢复连接";}
            synchronized(state){if(!state.matches(requested))return;status=message;}
            changed();
        });}catch(RejectedExecutionException e){if(!destroyed)throw e;} // Already paused on disk.
        return requested.epoch();
    }
    private void syncControl(String reason)throws Exception{
        syncControl(reason,gate.snapshot());
    }
    private void syncControl(String reason,ControlState.Snapshot local)throws Exception{
        if(!gate.matches(local))throw new IOException("这次控制请求已被更新的操作替代");
        JSONObject reply=gateway.json("POST","/v1/device/control",Tunnel.json("messageId",Protocol.id(),"controlEpoch",local.epoch(),"paused",local.paused(),"reason",reason),true);
        observeServer(reply);observeControl(reply);
        if(!gate.matches(local))throw new IOException("这次控制请求已被更新的操作替代");
        if(reply.getLong("controlEpoch")!=local.epoch()||!Boolean.valueOf(local.paused()).equals(reply.opt("paused")))
            throw new IOException("电脑未确认本次控制状态");
        lastSyncedEpoch.accumulateAndGet(local.epoch(),Math::max);
    }
    private long pauseIfCurrent(long epoch,String reason){return pauseLocal(reason,epoch);}
    private void reportControlFailure(long epoch,String reason,String message,Exception cause){
        long stopped=pauseIfCurrent(epoch,reason);
        if(stopped<0)return;
        synchronized(gate){
            if(!gate.matches(new ControlState.Snapshot(stopped,true)))return;
            status=message;error=cause.getMessage()==null?message:cause.getMessage();
        }
        changed();
    }
    private void observeServer(JSONObject response){
        long time=Binding.parseTime(response.opt("serverTime"));if(time>0)serverClockOffset=time-System.currentTimeMillis();
    }
    private void observeControl(JSONObject response){
        if(response==null||!response.has("controlEpoch")||!response.has("paused"))return;
        long epoch=response.optLong("controlEpoch",-1);boolean paused=response.optBoolean("paused",true);
        // A lost POST reply may be recovered only for this exact attempted maintenance handoff.
        JSONObject pending=maintenanceRequest;
        if(pending!=null&&gate.acknowledgeMaintenance(new ControlState.Snapshot(pending.optLong("maintenanceEpoch",-1),true),pending.optLong("origin",-1),epoch,paused)){
            lastSyncedEpoch.accumulateAndGet(epoch,Math::max);maintenanceRequest=null;return;
        }
        boolean changed=paused&&"maintenance".equals(response.optString("reason"))
            ?gate.observeMaintenance(epoch,response.optLong("maintenanceResumeEpoch",-1)):gate.observeRemote(epoch,paused);
        if(changed){
            invalidateDisplay("remote_control_changed");
            Tunnel currentTunnel=tunnel;if(currentTunnel!=null)currentTunnel.pausePhoneData();if(shareFiles!=null)shareFiles.invalidate();
            status="已同步电脑状态，手机保持暂停";
        }
    }
    private long serverNow(){return System.currentTimeMillis()+serverClockOffset;}
    public void submit(String text,String conversationId,JSONArray attachments,Outcome<String> saved){submit(text,conversationId,attachments,Protocol.id(),saved);}
    public void submit(String text,String conversationId,JSONArray attachments,String messageId,Outcome<String> saved){submit(text,conversationId,attachments,messageId,"concierge",saved);}
    public void submit(String text,String conversationId,JSONArray attachments,String messageId,String roleId,Outcome<String> saved){
        if(text.isBlank()&&attachments.length()==0)return;
        boolean local=false;for(int i=0;i<attachments.length();i++)if(attachments.optJSONObject(i)!=null&&attachments.optJSONObject(i).has("localId"))local=true;
        if(local){final long before=gate.epoch();fileWorker.execute(()->{try{
            GatewayClient client=gateway;if(client==null||!paired)throw new IOException("电脑暂不可用，附件和文字仍在草稿里");
            JSONArray uploaded=new JSONArray();for(int i=0;i<attachments.length();i++){JSONObject row=attachments.getJSONObject(i);
                if(row.has("localId")){File file=AttachmentDrafts.file(this,row);JSONObject receipt=client.upload(file,row.getString("name"),row.getString("mime"));uploaded.put(Tunnel.json("uploadId",receipt.getString("uploadId"),"name",row.getString("name"),"mime",row.getString("mime")));}else uploaded.put(row);
            }
            if(gateway!=client||!paired||gate.epoch()!=before)throw new IOException("控制状态已变化，消息未发送，草稿已保留");
            submit(text,conversationId,uploaded,messageId,roleId,saved);
        }catch(Exception e){saved.done(null,e);}});return;}

        final long requestedEpoch;
        final JSONObject message;
        try{
            if(!paired||gateway==null)throw new IllegalStateException("请先连接你的电脑");
            safeId(messageId);
            long now=serverNow();requestedEpoch=gate.admitRequest();
            beginScreenHold(requestedEpoch);
            message=Tunnel.json("messageId",messageId,"text",text.isBlank()?"（附件）":text.trim(),"createdAt",Instant.ofEpochMilli(now).toString(),
                    "expiresAt",Instant.ofEpochMilli(now+300000).toString(),"controlEpoch",requestedEpoch,"attachments",attachments,"roleId",roleId);
            if(conversationId!=null&&!conversationId.isBlank())message.put("conversationId",conversationId);
        }catch(Exception e){saved.done(null,e);return;}
        persistenceWorker.execute(()->{
            try{
                JSONObject row=Tunnel.json("message",message,"status","queued","everSent",false);
                synchronized(dataLock){OutboxWrite.insert(outbox,message.getString("messageId"),row,rows->store.write("outbox",rows));}
            }catch(Exception e){pauseIfCurrent(requestedEpoch,"message_persistence_failed");saved.done(null,e);return;}
            saved.done(message.optString("messageId"),null);changed();
            messageWorker.execute(()->{
                try{syncControl("explicit_new_request",new ControlState.Snapshot(requestedEpoch,false));deliverMessage(message.optString("messageId"));}
                catch(Exception e){
                    if(gate.epoch()==requestedEpoch){if(screenHold!=null)screenHold.releaseIfEpoch(requestedEpoch);fail("消息尚未确认接收",e);}
                    else{
                        try{synchronized(dataLock){JSONObject row=outbox.optJSONObject(message.optString("messageId"));if(row!=null&&!row.optBoolean("everSent")){row.put("status","cancelled_local");store.write("outbox",outbox);}}changed();}
                        catch(Exception persistenceError){fail("本地消息状态需要检查",persistenceError);}
                    }
                }
            });
        });
    }

    public void readState(Outcome<JSONObject> callback){worker.execute(()->{tick();callback.done(snapshot(),lastAuthenticatedAt==0?new IOException("正在连接电脑，请稍后重试"):null);});}
    /** Role edits use the same authenticated, idempotent gateway as chat. */
    public void roleRequest(String id,String action,JSONObject changes,Outcome<JSONObject> callback){
        final String path="/v1/roles"+(id.isBlank()?"":"/"+id)+("brief".equals(action)?"/brief":"");
        if(!id.isBlank()&&!id.matches("[A-Za-z0-9_-]{1,80}")){callback.done(null,new IOException("助理编号无效"));return;}
        final JSONObject payload;
        try{payload=new JSONObject(changes.toString()).put("messageId",Protocol.id());}catch(Exception e){callback.done(null,e);return;}
        messageWorker.execute(()->{try{GatewayClient client=gateway;if(client==null||!paired)throw new IOException("请先连接电脑");JSONObject result=client.json("POST",path,payload,true);callback.done(result,null);}catch(Exception e){callback.done(null,e);}});
    }
    /** Group writes are saved before dispatch. Retrying uses the original envelope and receipt ID. */
    public void groupRead(String id,Outcome<JSONObject> callback){
        final String path;try{path="/v1/groups"+(id.isBlank()?"":"/"+safeId(id));}catch(Exception e){callback.done(null,e);return;}
        historyWorker.execute(()->{try{if(gateway==null||!paired)throw new IOException("请先连接电脑");callback.done(gateway.json("GET",path,null,false),null);}catch(Exception e){android.util.Log.w("BoujoyConnection","group_read:"+ConnectionProblem.classify(e,0)+" "+ConnectionProblem.diagnostic(e));callback.done(null,e);}});
    }
    public void groupRequest(String path,JSONObject input,Outcome<JSONObject> callback){
        if(!path.matches("/v1/groups(?:/[A-Za-z0-9_-]{1,128}(?:/(?:members|messages|tasks/[A-Za-z0-9_-]{1,128}/(?:pause|resume)))?)?")){callback.done(null,new IOException("群请求无效"));return;}
        final JSONObject proposed;try{proposed=new JSONObject(input.toString());safeId(proposed.getString("messageId"));}catch(Exception e){callback.done(null,e);return;}
        messageWorker.execute(()->{
            String id=proposed.optString("messageId");if(!messageFlights.begin("group:"+id)){callback.done(null,new IOException("请求正在确认"));return;}
            try{
                if(gateway==null||!paired||gate==null)throw new IOException("请先连接电脑");
                JSONObject envelope;boolean fresh;
                synchronized(dataLock){envelope=groupRequests.optJSONObject(id);fresh=envelope==null;if(!fresh&&!path.equals(envelope.optString("path")))throw new IOException("群请求编号冲突");}
                boolean starts=path.endsWith("/messages")||path.endsWith("/resume");
                if(fresh){
                    if(starts){long now=serverNow(),epoch=gate.admitRequest();beginScreenHold(epoch);proposed.put("controlEpoch",epoch);if(path.endsWith("/messages")){proposed.put("createdAt",Instant.ofEpochMilli(now).toString());proposed.put("expiresAt",Instant.ofEpochMilli(now+300000).toString());}}
                    else proposed.put("controlEpoch",gate.epoch());
                    envelope=Tunnel.json("path",path,"body",proposed);
                    synchronized(dataLock){JSONObject next=new JSONObject(groupRequests.toString()).put(id,envelope);store.write("group-requests",next);groupRequests=next;}
                    changed();
                }
                JSONObject payload=envelope.getJSONObject("body");
                JSONObject result=null;
                boolean postOriginal=true;
                if(path.endsWith("/messages")&&envelope.optBoolean("everSent")){
                    JSONObject receipt=gateway.json("GET",path+"/"+safeId(id),null,true);
                    GroupMessageRetry.Decision decision=GroupMessageRetry.decide(receipt,payload,gate.permitsData(payload.optLong("controlEpoch")),serverNow());
                    if(decision==GroupMessageRetry.Decision.RECEIVED){result=receipt;postOriginal=false;}
                    else if(decision==GroupMessageRetry.Decision.UNKNOWN)throw new IOException("这条群消息的接收结果待核实，请保留原请求");
                    else if(decision!=GroupMessageRetry.Decision.RETRY_ORIGINAL){
                        String reason=decision==GroupMessageRetry.Decision.NOT_RECEIVED_EXPIRED?"已确认原请求未接收，发送期限已过；原稿保留，可以重新发送。":"已确认原请求未接收，原控制授权已失效；原稿保留，可以重新发送。";
                        synchronized(dataLock){JSONObject next=new JSONObject(groupRequests.toString());next.getJSONObject(id).put("rejected",true).put("error",reason);store.write("group-requests",next);groupRequests=next;}
                        throw new IOException(reason);
                    }
                }
                if(postOriginal){
                    // An already dispatched resume may have succeeded. Let the server's
                    // durable messageId receipt resolve it before checking the old epoch.
                    boolean lookupResume=path.endsWith("/resume")&&envelope.optBoolean("everSent");
                    if(starts&&!lookupResume){if(!gate.permitsData(payload.optLong("controlEpoch")))throw new IOException("手机已暂停，未发送旧请求");syncControl("explicit_group_request",new ControlState.Snapshot(payload.getLong("controlEpoch"),false));}
                    synchronized(dataLock){JSONObject next=new JSONObject(groupRequests.toString());next.getJSONObject(id).put("everSent",true);store.write("group-requests",next);groupRequests=next;}
                    result=gateway.json("POST",path,payload,true);
                }
                synchronized(dataLock){JSONObject next=new JSONObject(groupRequests.toString());next.remove(id);store.write("group-requests",next);groupRequests=next;}
                if(starts)screenAccepted(payload.optLong("controlEpoch"),result);
                callback.done(result,null);changed();
            }catch(Exception e){
                if(e instanceof GatewayClient.GatewayError rejected&&Set.of(400,403,404,410,422).contains(rejected.status))try{synchronized(dataLock){JSONObject next=new JSONObject(groupRequests.toString()),row=next.optJSONObject(id);if(row!=null){row.put("rejected",true).put("error",rejected.getMessage());store.write("group-requests",next);groupRequests=next;}}}catch(Exception persistence){e.addSuppressed(persistence);}
                callback.done(null,e);changed();
            }finally{messageFlights.end("group:"+id);}
        });
    }
    private void drainOutbox(){
        List<String> ids=new ArrayList<>();synchronized(dataLock){outbox.keys().forEachRemaining(ids::add);}
        for(String id:ids){try{deliverMessage(id);}catch(Exception e){recordSyncFailure("outbox",e);}}
    }
    private void deliverMessage(String id)throws Exception{
        if(!messageFlights.begin(id))return;
        GatewayClient client=gateway;
        try{
            if(client==null)return;
            JSONObject row,message;synchronized(dataLock){row=outbox.optJSONObject(id);if(row==null)return;message=row.getJSONObject("message");}
            String state=row.optString("status");if(Set.of("received","not_received","cancelled_local").contains(state))return;
            if(row.optBoolean("everSent")){
                JSONObject known=client.json("GET","/v1/messages/"+id,null,true);
                if(known.optBoolean("received")){received(id,known);return;}
                setRow(id,MessageDelivery.statusAfterLookup(known,message,serverNow()),null);return; // Never replay an ambiguous request.
            }
            if(Binding.parseTime(message.opt("expiresAt"))<=serverNow()){setRow(id,"not_received",null);return;}
            if(!gate.permitsData(message.optLong("controlEpoch"))){setRow(id,"cancelled_local",null);return;}
            // Polling may see the persisted row before the explicit resume POST completes.
            if(!gate.permitsSubmission(message.optLong("controlEpoch"),lastSyncedEpoch.get()))return;
            synchronized(dataLock){row.put("everSent",true);row.put("status","sending");store.write("outbox",outbox);}
            try{JSONObject result=client.json("POST","/v1/messages",message,false);received(id,result);}
            catch(Exception e){setRow(id,MessageDelivery.statusAfterFailure(e),null);throw e;}
        }finally{messageFlights.end(id);}
    }
    private void received(String id,JSONObject result)throws Exception{long epoch;synchronized(dataLock){epoch=outbox.getJSONObject(id).getJSONObject("message").optLong("controlEpoch",-1);}screenAccepted(epoch,result);setRow(id,"received",result);}
    private void setRow(String id,String status,JSONObject result)throws Exception{
        synchronized(dataLock){JSONObject row=outbox.getJSONObject(id);row.put("status",status);if(result!=null)row.put("receipt",result);store.write("outbox",outbox);}changed();
    }
    public void stopTask(String taskId){stopTask(taskId,"explicit_stop");}
    /** Persist the rear stop before any network I/O; unlocking or reconnecting cannot resume it. */
    public void stopTaskFromRear(String taskId){stopTask(taskId,"rear_stop");}
    private void stopTask(String taskId,String reason){
        long stopEpoch=pauseLocal(reason);if(stopEpoch<0)return;
        if(taskId==null||taskId.isBlank())return;
        controlWorker.execute(()->{
            try{gateway.json("POST","/v1/tasks/"+safeId(taskId)+"/stop",Tunnel.json("messageId",Protocol.id(),"controlEpoch",stopEpoch),true);changed();}
            catch(Exception e){if(gate.epoch()==stopEpoch)fail("手机已暂停，任务取消结果待核实",e);}
        });
    }
    public void continueTask(String taskId){taskCommand(taskId,"continue",null,(reply,error)->{});}
    public void reconcileTask(String taskId){taskCommand(taskId,"reconcile",null,(reply,error)->{});}
    public void restartTask(String taskId,String restartKey){taskCommand(taskId,"restart",restartKey,(reply,error)->{});}
    /** Per-task consent never changes the global model or memory setting. */
    public void consentTask(String taskId,Outcome<JSONObject> callback){taskCommand(taskId,"consent",null,callback);}
    private void taskCommand(String taskId,String action,String restartKey,Outcome<JSONObject> callback){
        try{safeId(taskId);if("restart".equals(action)&&(restartKey==null||!restartKey.matches("[a-f0-9]{64}")))throw new IllegalArgumentException("请先刷新任务再重新执行");}
        catch(Exception e){callback.done(null,e);return;}
        if(!taskActions.begin(taskId)){callback.done(null,new IllegalStateException("这项请求正在确认，请稍候"));return;}
        final long epoch;
        try{epoch=gate.admitRequest();beginScreenHold(epoch);changed();}
        catch(Exception e){taskActions.end(taskId);fail("无法保存控制请求",e);callback.done(null,e);return;}
        controlWorker.execute(()->{
            try{
                syncControl("explicit_task_"+action,new ControlState.Snapshot(epoch,false));
                JSONObject body=Tunnel.json("messageId",Protocol.id(),"controlEpoch",epoch);
                if("consent".equals(action))body.put("cloudConsent",true);
                if("restart".equals(action))body.put("restartKey",restartKey);
                JSONObject reply=gateway.json("POST","/v1/tasks/"+safeId(taskId)+"/"+action,body,true);
                observeServer(reply);screenAccepted(epoch,reply);
                if(gate.epoch()==epoch){status="reconcile".equals(action)?"现场已核实，请查看任务状态":"restart".equals(action)?"已重新开始这项任务":"正在继续任务";error="";}
                callback.done(reply,null);
            }catch(Exception e){reportControlFailure(epoch,"task_command_unconfirmed","任务请求未完成",e);callback.done(null,e);}
            finally{taskActions.end(taskId);changed();}
        });
    }
    /** The user's own "继续" while the phone is paused: hands control back under a
     *  new epoch. Nothing is resumed or replayed by itself; the Mac only accepts new
     *  work under the new epoch, and unknown actions stay as they were. */
    public void resumeControl(long displayedEpoch){
        ControlState state=gate;
        if(state==null)return;
        final ControlState.Snapshot requested;
        try{
            synchronized(state){
                if(destroyed||!authenticatedOnline()||!state.matches(new ControlState.Snapshot(displayedEpoch,true)))return;
                requested=new ControlState.Snapshot(state.resumeExplicitly(),false);
            }
        }catch(Exception e){fail("无法保存控制请求",e);return;}
        try{
            controlWorker.execute(()->{
                try{
                    syncControl("explicit_user_resume",requested);
                    synchronized(state){
                        if(!state.matches(requested))return;
                        status="已交还控制，可以在电脑或手机上继续";error="";
                    }
                    changed();
                }catch(Exception e){reportControlFailure(requested.epoch(),"resume_unconfirmed","交还控制未完成",e);}
            });
        }catch(RejectedExecutionException e){reportControlFailure(requested.epoch(),"resume_unconfirmed","交还控制未完成",e);}
        changed();
    }
    public long taskActionNow(){return serverNow();}
    private volatile String installedApkSha256;
    private JSONObject deviceBuildStatus() throws Exception {
        if(installedApkSha256==null){
            java.security.MessageDigest digest=java.security.MessageDigest.getInstance("SHA-256");
            try(java.io.InputStream input=new java.io.FileInputStream(getApplicationInfo().sourceDir)){
                byte[] buffer=new byte[65536];int count;while((count=input.read(buffer))!=-1)digest.update(buffer,0,count);
            }
            StringBuilder hex=new StringBuilder();for(byte value:digest.digest())hex.append(String.format(java.util.Locale.ROOT,"%02x",value&255));installedApkSha256=hex.toString();
        }
        return Tunnel.json("timezone",TimeZone.getDefault().getID(),"observedAt",Instant.now().toString(),"apkSha256",installedApkSha256,"edition",BuildConfig.EDITION,"androidApplicationId",BuildConfig.APPLICATION_ID,"versionName",BuildConfig.VERSION_NAME,"versionCode",BuildConfig.VERSION_CODE,"typingProtocol",2,"displayBackend",displayBackendStatus(),"syncDiagnostics",Tunnel.json("lastStateSyncAt",lastStateSyncAt,"lastFailedStep",lastFailedStep,"lastFailureAt",lastFailureAt,"stateFailures",stateFailures.get()));
    }
    public void taskDetails(String taskId,Outcome<JSONObject> callback){historyWorker.execute(()->{
        try{JSONObject detail=gateway.json("GET","/v1/tasks/"+safeId(taskId),null,false);observeServer(detail);callback.done(detail,null);}
        catch(Exception e){callback.done(null,e);}
    });}
    /** Read-only history work cannot block the single writer or independent stop/control lane. */
    public void chatHistoryVisible(boolean visible){chatHistoryVisible(visible,focusedConversation);}
    public void chatHistoryVisible(boolean visible,String taskId){boolean changed=chatHistoryVisible!=visible||!Objects.equals(focusedConversation,taskId);chatHistoryVisible=visible;focusedConversation=taskId;taskDetailCache.focus(taskId);if(visible&&changed)refreshTaskHistory();}
    private void refreshTaskHistory(){
        GatewayClient client=gateway;if(destroyed||!chatHistoryVisible||!paired||client==null||tunnel==null||!tunnel.connected())return;
        for(TaskDetailCache.Request request:taskDetailCache.requests(SystemClock.elapsedRealtime(),2)){
            try{historyWorker.execute(()->{
                try{JSONObject detail=client.json("GET","/v1/tasks/"+safeId(request.id()),null,false);
                    if(client==gateway&&!destroyed){taskDetailCache.complete(request,detail,SystemClock.elapsedRealtime());changed();}
                }catch(Exception e){if(client==gateway&&!destroyed){taskDetailCache.failed(request,SystemClock.elapsedRealtime());recordSyncFailure("history",e);changed();}}
                finally{if(client==gateway&&!destroyed)refreshTaskHistory();}
            });}catch(RejectedExecutionException ignored){taskDetailCache.failed(request,SystemClock.elapsedRealtime());}
        }
    }
    long shareNow(){return serverNow();}
    long shareEpoch(){return gate==null?-1:gate.epoch();}
    boolean sharePermitted(JSONObject job){
        if(!ShareJob.permitsTarget(job.optString("targetPackage")))return false;
        if(!authenticatedOnline()||gate==null||!gate.permitsData(job.optLong("controlEpoch",-1))||keyguard==null||keyguard.isDeviceLocked()||!power.isInteractive()||Binding.parseTime(job.opt("expiresAt"))<=serverNow()||binding==null||!binding.deviceId.equals(job.optString("deviceId")))return false;
        synchronized(dataLock){JSONArray tasks=cachedState.optJSONArray("tasks");if(tasks==null)return false;for(int i=0;i<tasks.length();i++){JSONObject task=tasks.optJSONObject(i);if(task!=null&&task.optString("id").equals(job.optString("taskId")))return Set.of("running","waiting_approval").contains(task.optString("status"));}}return false;
    }
    private JSONObject shareReceipt(JSONObject job,String state)throws Exception{return gateway.json("POST","/v1/device/files/"+safeId(job.getString("jobId"))+"/status",ShareJob.receipt(job,state),true);}
    private void pollShare()throws Exception{
        if(shareFiles==null)return;if(gate==null||gate.paused()){shareFiles.invalidate();return;}JSONObject remote=gateway.json("GET","/v1/device/files/next",null,true).optJSONObject("job");
        if(remote==null){shareFiles.invalidate();return;}
        if(!sharePermitted(remote)){shareFiles.invalidate();return;}
        JSONObject local=shareFiles.active();
        if(local==null){
            if(shareFiles.known(remote.getString("jobId"))||!Set.of("queued","prepared").contains(remote.optString("status")))return;
            GatewayClient.Response response=gateway.request("GET","/v1/device/files/"+safeId(remote.getString("jobId"))+"/bytes",null,false);
            if(response.status()!=200)throw new IOException("附件尚未传到手机");shareFiles.stage(remote,response.body());local=shareFiles.active();
        }
        if(local==null)return;
        if("prepared".equals(local.optString("status")))shareReceipt(local,"prepared");
        if("intent_dispatched".equals(local.optString("status")))shareReceipt(local,"intent_dispatched");
        if(local.optBoolean("contentOpened"))gateway.json("POST","/v1/device/files/"+safeId(local.getString("jobId"))+"/status",ShareJob.receipt(local,"content_opened").put("targetPackage",local.getString("targetPackage")),true);
    }
    public JSONObject pendingShare()throws Exception{return shareFiles==null?null:shareFiles.active();}
    public void reserveShare(String jobId,Outcome<JSONObject> callback){
        final JSONObject job;try{job=shareFiles.reserve(jobId);}catch(Exception e){callback.done(null,e);return;}
        controlWorker.execute(()->{try{shareReceipt(job,"dispatching");if(!sharePermitted(job))throw new IOException("手机已接管，未继续分发附件");callback.done(job,null);}catch(Exception e){callback.done(null,e);}});
    }
    public void shareDispatched(JSONObject job)throws Exception{shareFiles.dispatched(job);controlWorker.execute(()->{try{shareReceipt(job,"intent_dispatched");}catch(Exception ignored){/* Poll retries the receipt; the Intent is never retried. */}});}
    public void shareContentOpened(JSONObject job){
        try{shareFiles.opened(job);}catch(Exception ignored){return;}
        controlWorker.execute(()->{try{gateway.json("POST","/v1/device/files/"+safeId(job.getString("jobId"))+"/status",ShareJob.receipt(job,"content_opened").put("targetPackage",job.getString("targetPackage")),true);}catch(Exception ignored){/* Read receipt may be retried while this ticket remains live. */}});
    }
    public void shareFailed(JSONObject job,String failure){controlWorker.execute(()->{try{gateway.json("POST","/v1/device/files/"+safeId(job.getString("jobId"))+"/status",ShareJob.receipt(job,"failed").put("failure",failure),true);}catch(Exception ignored){}finally{shareFiles.invalidate();}});}
    public void startDemonstration(String taskId,Outcome<JSONObject> callback){
        long epoch=pauseLocal("explicit_demonstration");if(epoch<0){callback.done(null,new IOException("无法保存接管状态"));return;}
        controlWorker.execute(()->{try{ControlState.Snapshot requested=new ControlState.Snapshot(epoch,true);syncControl("explicit_demonstration",requested);JSONObject result=gateway.json("POST","/v1/demonstrations/start",Tunnel.json("messageId",Protocol.id(),"taskId",safeId(taskId),"controlEpoch",epoch),true);if(!gate.matches(requested))throw new IOException("示范请求已被更新操作替代");synchronized(dataLock){cachedState.put("demonstration",result);}callback.done(result,null);changed();}catch(Exception e){callback.done(null,e);}});
    }
    public void stopDemonstration(String sessionId,Outcome<JSONObject> callback){controlWorker.execute(()->{try{JSONObject result=gateway.json("POST","/v1/demonstrations/stop",Tunnel.json("messageId",Protocol.id(),"sessionId",safeId(sessionId)),true);synchronized(dataLock){cachedState.put("demonstration",result);}callback.done(result,null);changed();}catch(Exception e){pauseLocal("demonstration_stop_unconfirmed");callback.done(null,e);}});}
    public void transcribeVoice(byte[] bytes,Outcome<JSONObject> callback){voiceWorker.execute(()->{
        try{
            if(bytes.length<45||bytes.length>8*1024*1024)throw new IOException("录音大小无效");
            StringBuilder hex=new StringBuilder();for(byte value:java.security.MessageDigest.getInstance("SHA-256").digest(bytes))hex.append(String.format(java.util.Locale.ROOT,"%02x",value&255));String digest=hex.toString();
            JSONObject draft=gateway.json("POST","/v1/voice/transcribe",Tunnel.json("messageId",Protocol.id(),"bytesBase64",Base64.getEncoder().encodeToString(bytes),"sha256",digest,"mime","audio/mp4","language","zh"),false);
            callback.done(draft,null);
        }catch(Exception e){callback.done(null,e);}
    });}
    public void speech(String taskId,String messageId,Outcome<byte[]> callback){voiceWorker.execute(()->{
        try{
            JSONObject artifact=gateway.json("POST","/v1/tasks/"+safeId(taskId)+"/messages/"+safeId(messageId)+"/speech",Tunnel.json("messageId",Protocol.id()),false);
            GatewayClient.Response response=gateway.request("GET","/v1/artifacts/"+safeId(artifact.getString("id")),null,false);
            if(response.status()!=200||!response.contentType().startsWith("audio/"))throw new IOException("朗读音频未能读取");callback.done(response.body(),null);
        }catch(Exception e){callback.done(null,e);}
    });}
    public void browserBegin(String taskId,Outcome<JSONObject> callback){
        long epoch=pauseLocal("browser_workspace_takeover");if(epoch<0){callback.done(null,new IOException("接管状态未能保存"));return;}
        worker.execute(()->{try{
            ControlState.Snapshot requested=new ControlState.Snapshot(epoch,true);syncControl("browser_workspace_takeover",requested);
            JSONObject result=gateway.json("POST","/v1/tasks/"+safeId(taskId)+"/browser/begin",Tunnel.json("messageId",Protocol.id(),"controlEpoch",epoch),true);
            if(!gate.matches(requested))throw new IOException("接管请求已被更新操作替代");callback.done(result,null);
        }catch(Exception e){callback.done(null,e);}});
    }
    public void browserRequest(String taskId,JSONObject session,String operation,JSONObject args,Outcome<JSONObject> callback){
        final ControlState.Snapshot requested=new ControlState.Snapshot(session.optLong("controlEpoch",-1),true);
        worker.execute(()->{try{
            if(!Set.of("frame","act").contains(operation)||!gate.matches(requested)||!authenticatedOnline())throw new IOException("工作页已暂停或连接失效，请重新接管");
            JSONObject body=new JSONObject(args.toString()).put("messageId",Protocol.id()).put("sessionId",session.getString("sessionId")).put("controlEpoch",requested.epoch());
            JSONObject reply=gateway.json("POST","/v1/tasks/"+safeId(taskId)+"/browser/"+operation,body,false);
            if(!gate.matches(requested))throw new IOException("工作页接管已失效");callback.done(reply,null);
        }catch(Exception e){callback.done(null,e);}});
    }
    public void browserFinish(String taskId,JSONObject session,boolean resume,Outcome<JSONObject> callback){
        final ControlState.Snapshot requested=new ControlState.Snapshot(session.optLong("controlEpoch",-1),true);
        worker.execute(()->{try{
            if(!gate.matches(requested))throw new IOException("工作页已停止接受操作，请刷新任务核实");
            JSONObject reply=gateway.json("POST","/v1/tasks/"+safeId(taskId)+"/browser/end",Tunnel.json("messageId",Protocol.id(),"sessionId",session.getString("sessionId"),"controlEpoch",requested.epoch()),true);
            if(resume){
                final long epoch;synchronized(gate){if(!gate.matches(requested))throw new IOException("你已更新控制状态，未继续原任务");epoch=gate.resumeExplicitly();}
                try{beginScreenHold(epoch);syncControl("explicit_browser_handoff",new ControlState.Snapshot(epoch,false));reply=gateway.json("POST","/v1/tasks/"+safeId(taskId)+"/continue",Tunnel.json("messageId",Protocol.id(),"controlEpoch",epoch),true);screenAccepted(epoch,reply);}
                catch(Exception e){pauseIfCurrent(epoch,"browser_handoff_unconfirmed");throw e;}
            }
            callback.done(reply,null);changed();
        }catch(Exception e){callback.done(null,e);}});
    }
    private record RearApprovalConnection(GatewayClient client, Tunnel tunnel, Binding binding, ControlState gate,
                                          DisplayBridge bridge, long rearRevision) {}
    private RearApprovalConnection rearApprovalConnection() {
        DisplayBridge bridge=displayBridge;
        return new RearApprovalConnection(gateway,tunnel,binding,gate,bridge,bridge==null?-1:bridge.rearVisibility().revision());
    }
    private boolean rearApprovalAllowed(RearApproval.Scope scope,RearApprovalConnection connection) {
        DisplayBridge bridge=connection.bridge();
        if(destroyed||!paired||connection.client()==null||connection.client()!=gateway||connection.tunnel()!=tunnel
                ||connection.binding()!=binding||connection.gate()==null||connection.gate()!=gate||bridge==null||bridge!=displayBridge
                ||!bridge.isRearProgressEnabled()||!authenticatedOnline())return false;
        DisplayBridge.RearVisibility visibility=bridge.rearVisibility();
        if(!visibility.showing()||visibility.revision()!=connection.rearRevision()
                ||(keyguard==null||keyguard.isKeyguardLocked())&&!bridge.lockedExecutionAllowed())return false;
        JSONObject snapshot=snapshot(),backend=snapshot.optJSONObject("displayBackend"),rear=backend==null?null:backend.optJSONObject("rear");
        return rear!=null&&rear.optBoolean("available")&&rear.optInt("displayId",-1)>Display.DEFAULT_DISPLAY
                &&RearApproval.matches(snapshot,scope,SystemClock.elapsedRealtime(),serverNow());
    }
    /** Read only the server's approval projection; never pass arbitrary task arguments to rear UI. */
    public void rearApprovalDetails(RearApproval.Scope scope,Outcome<JSONObject> callback) {
        RearApprovalConnection connection=rearApprovalConnection();
        try{historyWorker.execute(()->{
            try{
                if(!rearApprovalAllowed(scope,connection))throw new IOException("这项确认已失效，请重新查看任务");
                JSONObject task=connection.client().json("GET","/v1/tasks/"+safeId(scope.taskId()),null,false);
                if(!rearApprovalAllowed(scope,connection))throw new IOException("任务或连接已变化，未展示旧确认");
                JSONObject approval=RearApproval.detail(scope,task);
                if(approval==null)throw new IOException("确认内容已变化，请等待新的确认项");
                observeServer(task);callback.done(new JSONObject(approval.toString()),null);
            }catch(Exception error){callback.done(null,error);}
        });}catch(RejectedExecutionException closed){callback.done(null,new IOException("连接服务已停止",closed));}
    }
    /** Rear buttons decide exactly the displayed live request; they never resume a stopped gate. */
    public void approvalFromRear(RearApproval.Scope scope,boolean allow,Outcome<JSONObject> callback) {
        RearApprovalConnection connection=rearApprovalConnection();
        if(!rearApprovalAllowed(scope,connection)){callback.done(null,new IOException("这项确认已失效，请重新查看任务"));return;}
        if(!approvalRequests.begin(scope.approvalId(),scope.fingerprint())){callback.done(null,new IOException("这项决定已提交，请等待电脑回执"));return;}
        changed();
        try{controlWorker.execute(()->{
            boolean attempted=false;
            try{
                if(!rearApprovalAllowed(scope,connection))throw new IOException("任务或控制状态已变化，未提交旧确认");
                attempted=true;
                JSONObject reply=connection.client().json("POST","/v1/approvals/"+safeId(scope.approvalId()),
                        Tunnel.json("messageId",Protocol.id(),"controlEpoch",scope.controlEpoch(),"allow",allow,"fingerprint",scope.fingerprint()),true);
                if(connection.client()!=gateway||connection.binding()!=binding||connection.gate()!=gate||destroyed)throw new IOException("连接已变化，请核实决定结果");
                observeServer(reply);approvalRequests.finish(scope.approvalId(),scope.fingerprint(),true);callback.done(reply,null);changed();
                try{worker.execute(this::tick);}catch(RejectedExecutionException closed){ /* An accepted decision remains accepted during shutdown. */ }
            }catch(Exception error){
                if(allow&&attempted&&connection.client()==gateway&&connection.binding()==binding&&connection.gate()==gate)
                    pauseIfCurrent(scope.controlEpoch(),"approval_result_unconfirmed");
                approvalRequests.finish(scope.approvalId(),scope.fingerprint(),false);callback.done(null,error);changed();
            }
        });}catch(RejectedExecutionException closed){approvalRequests.finish(scope.approvalId(),scope.fingerprint(),false);callback.done(null,new IOException("连接服务已停止",closed));changed();}
    }
    /** Called only by the user's individual approval button. The exact fingerprint is mandatory. */
    public void approval(String approvalId,String fingerprint,boolean allow,Outcome<JSONObject> callback){
        if(fingerprint==null||fingerprint.isBlank()){callback.done(null,new IllegalArgumentException("确认内容缺少校验标识，请刷新任务"));return;}
        if(!approvalRequests.begin(approvalId,fingerprint)){callback.done(null,new IOException("这项决定已提交，请等待电脑回执"));return;}
        final ControlState.Snapshot requested=gate==null?null:gate.snapshot();
        controlWorker.execute(()->{
            long decisionEpoch=-1;
            try{
                if(requested==null||gateway==null)throw new IOException("电脑连接尚未就绪");
                synchronized(gate){if(!gate.matches(requested))throw new IOException("控制状态已经变化，请重新核实");decisionEpoch=allow?gate.admitRequest():gate.epoch();}
                if(allow){beginScreenHold(decisionEpoch);syncControl("user_resume",new ControlState.Snapshot(decisionEpoch,false));}
                JSONObject reply=gateway.json("POST","/v1/approvals/"+safeId(approvalId),Tunnel.json("messageId",Protocol.id(),"controlEpoch",decisionEpoch,"allow",allow,"fingerprint",fingerprint),true);
                observeServer(reply);if(allow)screenAccepted(decisionEpoch,reply);approvalRequests.finish(approvalId,fingerprint,true);callback.done(reply,null);changed();worker.execute(this::tick);
            }catch(Exception e){if(allow&&decisionEpoch>=0)pauseIfCurrent(decisionEpoch,"approval_result_unconfirmed");approvalRequests.finish(approvalId,fingerprint,false);callback.done(null,e);changed();}
        });
    }
    public void downloadArtifact(String artifactId,Outcome<File> callback){downloadArtifact(artifactId,false,callback);}
    public void downloadPreview(String artifactId,Outcome<File> callback){downloadArtifact(artifactId,true,callback);}
    private void downloadArtifact(String artifactId,boolean preview,Outcome<File> callback){downloadArtifact(artifactId,preview,(received,total)->{},callback);}
    private void downloadArtifact(String artifactId,boolean preview,GatewayClient.Progress progress,Outcome<File> callback){fileWorker.execute(()->{
        File file=null;try{GatewayClient client=gateway;if(client==null||!paired)throw new IOException("请先连接电脑");
            file=File.createTempFile("boujoy-preview-",".media",getCacheDir());if(preview)client.downloadPreview(safeId(artifactId),file);else client.download(safeId(artifactId),file,progress);
            if(client!=gateway||!paired)throw new IOException("连接已变化，请重新打开文件");callback.done(file,null);
        }catch(Exception e){if(file!=null)file.delete();android.util.Log.w("BoujoyConnection","artifact_download:"+ConnectionProblem.diagnostic(e));callback.done(null,e);}
    });}
    public void saveArtifact(String artifactId,Uri destination,GatewayClient.Progress progress,Outcome<Long> callback){boolean empty=SaveDestination.isEmpty(getContentResolver(),destination);downloadArtifact(artifactId,false,progress,(file,error)->{
        if(error!=null){SaveDestination.cleanup(getContentResolver(),destination,empty);callback.done(null,error);return;}
        try(InputStream input=new FileInputStream(file);OutputStream output=getContentResolver().openOutputStream(destination,"wt")){
            if(output==null)throw new IOException("无法写入所选保存位置");byte[] buffer=new byte[32768];int count;while((count=input.read(buffer))!=-1)output.write(buffer,0,count);output.flush();
        }catch(Exception e){SaveDestination.cleanup(getContentResolver(),destination,empty);file.delete();callback.done(null,e);return;}
        long bytes=file.length();file.delete();callback.done(bytes,null);
    });}
    private String safeId(String id){if(id==null||!id.matches("[A-Za-z0-9_-]{1,128}"))throw new IllegalArgumentException("Invalid task");return id;}
    String pairedDeviceId(){Binding active=binding;return !destroyed&&paired&&active!=null?active.deviceId:"";}
    String approvalStatus(JSONObject approval){return ApprovalRequests.status(Tunnel.json("approvalRequests",approvalRequests.snapshot()),approval);}
    public JSONObject snapshot(){
        ControlState state=gate;
        ControlState.Snapshot control=state==null?new ControlState.Snapshot(-1,true):state.snapshot();
        Tunnel active=tunnel;
        boolean online=authenticatedOnline();
        String stage=online?"online":binding==null?"unconfigured":active==null?"relay_connecting":active.connectionStage();
        JSONObject backend=displayBackendStatus();JSONObject handoff=displayBridge==null?null:displayBridge.handoff();
        DisplayExecutor executor=displayExecutor;String displayTaskId=executor==null?"":executor.activeTaskId();
        // The state object is replaced, never edited, so its text is built once per sync rather than on every read.
        try{synchronized(dataLock){if(snapshotSource!=cachedState){snapshotText=cachedState.toString();snapshotSource=cachedState;}return Tunnel.json("state",new JSONObject(snapshotText),"outbox",new JSONObject(outbox.toString()),"taskDetails",taskDetailCache.snapshot(),"groupRequests",new JSONObject(groupRequests.toString()),
                "paired",paired,"pairedDeviceId",pairedDeviceId(),"online",online,"connectionStage",stage,"stateSyncedAtElapsedMs",stateSyncedAtElapsedMs,"locked",keyguard==null||keyguard.isKeyguardLocked(),"displayBackend",backend,"displayTaskId",displayTaskId,"displayHandoff",handoff==null?JSONObject.NULL:handoff,
                "approvalRequests",approvalRequests.snapshot(),"pendingTaskActions",new JSONArray(taskActions.snapshot()),"paused",control.paused(),"controlEpoch",control.epoch(),"status",displayStatus(),"error",error);}}
        catch(Exception e){return Tunnel.json("status","本地状态无法读取","error",e.getClass().getSimpleName());}
    }
    private boolean authenticatedOnline(){Tunnel active=tunnel;return active!=null&&active.connected()&&lastAuthenticatedAt>0&&SystemClock.elapsedRealtime()-lastAuthenticatedAt<20000;}
    private String displayStatus(){
        if(binding!=null&&!authenticatedOnline())return (gate!=null&&gate.paused()?"手机已暂停 · ":"")+(tunnel==null?"正在连接电脑…":tunnel.connected()?status:tunnel.status());
        return status;
    }
    private void fail(String message,Exception e){error=e.getMessage()==null?message:e.getMessage();status=message;changed();}
    private void changed(){
        if(destroyed)return;
        try{if(shareFiles!=null)shareFiles.active();}catch(Exception e){shareFiles.invalidate();}
        refreshScreenHold();
        queueDisplayNotices();
        getSystemService(NotificationManager.class).notify(1,notification());
        sendBroadcast(new Intent(UPDATE).setPackage(getPackageName()));
    }
    private void queueDisplayNotices(){
        if(destroyed||!displayNoticeFlight.compareAndSet(false,true))return;
        screenHandler.post(()->{try{refreshDisplayNotices();}finally{displayNoticeFlight.set(false);}});
    }
    /** Main-thread notification refresh; system probes and persistence never run in the display command loop. */
    private void refreshDisplayNotices(){
        if(destroyed||displayNotifications==null)return;
        JSONObject backend=displayBackendStatus();
        AvailabilityNotice.Update availability=displayAvailability.step(backgroundMode(),backend.optString("shizuku","not_running"),backend.optBoolean("executorService"));
        if(availability.executorDisconnected())recordDisplayAvailability("executor_disconnected",backend);
        if(availability.shizukuStopped())recordDisplayAvailability("shizuku_stopped",backend);
        displayNotifications.refresh(displayBridge==null?null:displayBridge.handoff(),availability,System.currentTimeMillis());
    }
    /** Bounded encrypted local metadata, deliberately without task IDs, titles, summaries, nodes or screenshots. */
    private void recordDisplayAvailability(String event,JSONObject backend){
        JSONObject entry=Tunnel.json("event",event,"at",Instant.now().toString(),"elapsedRealtimeMs",SystemClock.elapsedRealtime(),
                "shizuku",backend.optString("shizuku"),"executorService",backend.optBoolean("executorService"),"background",backgroundMode());
        try{
            ActivityManager manager=getSystemService(ActivityManager.class);ActivityManager.MemoryInfo memory=new ActivityManager.MemoryInfo();manager.getMemoryInfo(memory);
            entry.put("lowMemory",memory.lowMemory).put("availableMemoryBytes",memory.availMem).put("memoryThresholdBytes",memory.threshold)
                    .put("ignoringBatteryOptimizations",power!=null&&power.isIgnoringBatteryOptimizations(getPackageName()))
                    .put("powerSaveMode",power!=null&&power.isPowerSaveMode());
        }catch(Exception unavailable){try{entry.put("systemMetadataUnavailable",true);}catch(JSONException ignored){}}
        android.util.Log.w("BoujoyConnection","display_availability:"+entry);
        try{persistenceWorker.execute(()->{try{
            JSONObject previous=store.read("display-diagnostics");JSONArray old=previous.optJSONArray("events"),events=new JSONArray();
            if(old!=null)for(int i=Math.max(0,old.length()-63);i<old.length();i++)events.put(old.opt(i));
            events.put(entry);store.write("display-diagnostics",Tunnel.json("events",events));
        }catch(Exception error){android.util.Log.w("BoujoyConnection","display_diagnostics_unavailable:"+error.getClass().getSimpleName());}});}catch(RejectedExecutionException ignored){}
    }
    /** One tap from the notice to Accessibility settings, where Boujoy 无线输入 is switched back on. */
    private void wirelessInputNotice(){
        WirelessInputNotice.Action action=wirelessNotice.step(paired,BoujoyTypingService.ready(),SystemClock.elapsedRealtime());
        if(action==WirelessInputNotice.Action.NONE)return;
        NotificationManager manager=getSystemService(NotificationManager.class);
        try{
            if(action==WirelessInputNotice.Action.CANCEL){manager.cancel("wireless-input",7);return;}
            PendingIntent open=PendingIntent.getActivity(this,7,new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
            manager.notify("wireless-input",7,new Notification.Builder(this,TASK_CHANNEL).setSmallIcon(R.drawable.ic_boujoy)
                .setContentTitle("Boujoy 无线输入已关闭").setContentText("手机任务需要打字时要用到它，点这里去「无障碍」里打开")
                .setContentIntent(open).setAutoCancel(true).setOnlyAlertOnce(true).build());
        }catch(RuntimeException ignored){} // No notification permission: the settings sheet still shows the state.
    }
    private void createChannel(){
        NotificationManager manager=getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL,"Boujoy 后台连接",NotificationManager.IMPORTANCE_LOW));
        manager.createNotificationChannel(new NotificationChannel(TASK_CHANNEL,"任务结果与需要你处理",NotificationManager.IMPORTANCE_DEFAULT));
    }
    private void taskNotifications(JSONArray tasks)throws Exception{
        if(tasks==null)return;
        TaskNotifications.Update update=TaskNotifications.consume(notificationLedger,tasks);notificationLedger=update.ledger();
        NotificationManager manager=getSystemService(NotificationManager.class);
        boolean quiet; synchronized(dataLock){JSONObject prefs=cachedState.optJSONObject("notificationPreferences");quiet=prefs==null||prefs.optBoolean("quiet",true);}
        for(TaskNotifications.Alert alert:update.alerts()){
            String outcome;
            NotificationChannel channel=manager.getNotificationChannel(TASK_CHANNEL);
            if(!manager.areNotificationsEnabled()||channel==null||channel.getImportance()==NotificationManager.IMPORTANCE_NONE)outcome="permission_denied";
            else if(quiet&&TaskNotifications.quietSuppresses(alert))outcome="deferred_quiet";
            else try{
                PendingIntent show=PendingIntent.getActivity(this,alert.taskId().hashCode(),new Intent(this,MainActivity.class).setData(Uri.parse(BuildConfig.BIND_SCHEME+"://task/"+alert.taskId())).putExtra("taskId",alert.taskId()).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
                Notification publicVersion=new Notification.Builder(this,TASK_CHANNEL).setSmallIcon(R.drawable.ic_boujoy).setContentTitle("Boujoy 有任务更新").setContentText("解锁后查看").build();
                Notification notification=new Notification.Builder(this,TASK_CHANNEL).setSmallIcon(R.drawable.ic_boujoy)
                        .setContentTitle(alert.title()).setContentText(alert.body()).setContentIntent(show).setAutoCancel(true).setOnlyAlertOnce(true)
                        .setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(publicVersion).build();
                int notificationId=alert.fingerprint().hashCode();for(android.service.notification.StatusBarNotification old:manager.getActiveNotifications())if(alert.taskId().equals(old.getTag())&&old.getId()!=notificationId)manager.cancel(old.getTag(),old.getId());
                manager.notify(alert.taskId(),notificationId,notification);outcome="posted";
                // Android accepted the notification. This is not proof that the person saw it.
            }catch(SecurityException e){outcome="permission_denied";}catch(RuntimeException e){outcome="retry";}
            notificationLedger=TaskNotifications.outcome(notificationLedger,alert,outcome,System.currentTimeMillis());
        }
        store.write("task-notifications",notificationLedger);
        JSONArray report=TaskNotifications.report(notificationLedger);String digest=report.toString();
        if(!digest.equals(reportedNotifications)){
            gateway.json("POST","/v1/notifications/delivery",Tunnel.json("messageId",Protocol.id(),"deliveries",report),true);reportedNotifications=digest;
        }
    }
    public void reasoningSettings(String value,Outcome<JSONObject> callback){controlWorker.execute(()->{try{
        if(gateway==null)throw new IllegalStateException("电脑尚未连接");
        JSONObject result=value==null?gateway.json("GET","/v1/settings/reasoning",null,false):gateway.json("POST","/v1/settings/reasoning",Tunnel.json("messageId",Protocol.id(),"modelReasoning",value),true);
        callback.done(result,null);
    }catch(Exception e){callback.done(null,e);}});}
    public void notificationQuiet(boolean quiet,Outcome<JSONObject> callback){controlWorker.execute(()->{try{
        JSONObject result=gateway.json("POST","/v1/notifications/preferences",Tunnel.json("messageId",Protocol.id(),"quiet",quiet),true);callback.done(result,null);
    }catch(Exception e){callback.done(null,e);}});}
    private Notification notification(){
        PendingIntent show=PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop=PendingIntent.getService(this,1,new Intent(this,ConnectionService.class).setAction(STOP),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        JSONObject demo; synchronized(dataLock){demo=cachedState.optJSONObject("demonstration");}
        if(demo!=null&&"recording".equals(demo.optString("status"))){PendingIntent end=PendingIntent.getService(this,3,new Intent(this,ConnectionService.class).setAction(DEMO_STOP),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);return new Notification.Builder(this,CHANNEL).setSmallIcon(R.drawable.ic_boujoy).setContentTitle("Boujoy 正在记录示范页面").setContentText("最多两分钟 · 不自动操作").setOngoing(true).setOnlyAlertOnce(true).addAction(new Notification.Action.Builder(null,"结束示范",end).build()).addAction(new Notification.Action.Builder(null,"停止 / 接管",stop).build()).build();}
        return new Notification.Builder(this,CHANNEL).setSmallIcon(R.drawable.ic_boujoy).setContentTitle(BuildConfig.PRODUCT_NAME)
                .setContentText(displayStatus()).setContentIntent(show).setOngoing(true).setOnlyAlertOnce(true)
                .addAction(new Notification.Action.Builder(null,"停止 / 接管",stop).build()).build();
    }
    @Override public void onDestroy(){
        holdBackgroundCpu(false);
        destroyed=true;current=null;handoffActionRevision.incrementAndGet();displayUserWorker.shutdownNow();
        if(displayNotifications!=null)displayNotifications.close();
        if(rearTaskLease!=null)rearTaskLease.close();
        rearLeaseWorker.shutdown();
        if(rearProgress!=null)rearProgress.close();
        if(displayBridge!=null)displayBridge.removeLifecycleListener(displayLifecycle);
        BoujoyDisplayService.setLifecycleListener(null);
        DisplayExecutor executor=displayExecutor;displayExecutor=null;if(executor!=null)executor.close();
        if(shareFiles!=null)shareFiles.invalidate();screenHandler.removeCallbacks(screenTick);if(screenHold!=null)screenHold.release();if(screenReceiver!=null)try{unregisterReceiver(screenReceiver);}catch(Exception ignored){}if(tunnel!=null)tunnel.close();workers.close();taskDetailCache.clear();
        if(connectivity!=null&&networkCallback!=null)try{connectivity.unregisterNetworkCallback(networkCallback);}catch(Exception ignored){}
        super.onDestroy();
    }
}
