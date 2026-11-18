package dev.boujoy.personalagent;

import org.json.JSONArray;
import org.json.JSONObject;
import java.time.Instant;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executor;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/** Opt-in rear presentation, admitted only by a fresh successful task sync. */
final class RearProgressCoordinator implements AutoCloseable {
    static final long RETRY_AFTER_MS = 10_000;
    static final long REOPEN_AFTER_MS = 15_000;
    static final long RECOVERY_AFTER_MS = 2_000;
    private static final Set<String> ACTIVE = Set.of("queued", "running", "waiting_children", "waiting_approval", "waiting_consent");
    record State(String taskId, long controlEpoch, long syncedAtElapsedMs,
                 boolean enabled, boolean online, boolean paused, boolean locked,
                 boolean backgroundAllowed, boolean rearShowing, String phaseKey, boolean mainScreenOff) {
        State { phaseKey = phaseKey == null ? "" : phaseKey; }
        State(String taskId,long epoch,long synced,boolean enabled,boolean online,boolean paused,boolean locked,
              boolean backgroundAllowed,boolean rearShowing,String phaseKey) {
            this(taskId,epoch,synced,enabled,online,paused,locked,backgroundAllowed,rearShowing,phaseKey,false);
        }
        // Existing fixtures and callers default to the original unlocked, one-presentation policy.
        State(String taskId,long epoch,long synced,boolean enabled,boolean online,boolean paused,boolean locked) {
            this(taskId,epoch,synced,enabled,online,paused,locked,false,false,"",false);
        }
    }
    interface Launcher { void start(BooleanSupplier allowed) throws Exception; }
    private record Scope(String taskId,long controlEpoch) {}
    private record Attempt(String taskId,long controlEpoch,String phaseKey,long phaseSequence,boolean reopen,boolean recovery) {
        Scope scope(){return new Scope(taskId,controlEpoch);}
    }
    private record Decision(String reason,long retryAfter,Attempt attempt) {
        Decision(String reason){this(reason,0,null);}
    }
    private final Object lock = new Object(), reportLock = new Object();
    private final Executor worker;
    private final Supplier<State> current;
    private final LongSupplier clock;
    private final Launcher launcher;
    private final Consumer<JSONObject> reporter;
    private final Set<String> shown = new HashSet<>();
    // Only onStateSynced can insert an admission. Cached lifecycle/tick events cannot.
    private final Set<Scope> admitted = new HashSet<>();
    private final Map<Scope,Long> lastRecoveryAt = new HashMap<>();
    private final Map<String,String> observedPhase = new HashMap<>();
    private final Map<String,Long> phaseSequence = new HashMap<>(), lastVisibleSequence = new HashMap<>(), lastReopenSequence = new HashMap<>();
    private final Map<String,Long> failedAt = new HashMap<>(), lastLaunchAt = new HashMap<>();
    private Attempt pending;
    private boolean closed;
    private long admissionGeneration;
    private String lastReport = "";
    private long lastReportAt = Long.MIN_VALUE;

    RearProgressCoordinator(Executor worker,Supplier<State> current,LongSupplier clock,Launcher launcher) {
        this(worker,current,clock,launcher,ignored->{});
    }
    RearProgressCoordinator(Executor worker,Supplier<State> current,LongSupplier clock,Launcher launcher,Consumer<JSONObject> reporter) {
        this.worker=worker;this.current=current;this.clock=clock;this.launcher=launcher;this.reporter=reporter;
    }
    /** Called only after /v1/state succeeded; cached/UI refreshes do not admit work. */
    void onStateSynced() { consider(true); }
    /** Lifecycle and screen-state changes can only restore a task already admitted by a successful sync. */
    void onPresentationChanged() { consider(false); }
    private void consider(boolean synced) {
        // The supplier can consult display/binding state. Never call it under the gate lock.
        long generation;synchronized(lock){generation=admissionGeneration;}
        State state=read();long now=clock.getAsLong();String reason=gateReason(state,now);
        Decision decision;
        synchronized(lock) {
            if(closed)decision=new Decision("closed");
            else if(generation!=admissionGeneration)decision=new Decision("admission_changed");
            else if(!"eligible".equals(reason)) {
                pending=null;admitted.clear();lastRecoveryAt.clear();admissionGeneration++;decision=new Decision(reason);
            } else {
                // A queued recovery is revoked permanently when its scope ends. A later
                // screen-off event must enqueue a new attempt, not revive this callback.
                if(pending!=null&&pending.recovery()&&(!recoveryScope(state)||!matches(pending,state))){pending=null;admissionGeneration++;}
                Scope scope=scope(state);
                if(!synced&&!admitted.isEmpty()&&!admitted.contains(scope)) {
                    admitted.clear();lastRecoveryAt.clear();admissionGeneration++;
                }
                if(synced) {
                    // Retire a previous task/epoch so a cached old snapshot cannot re-admit it.
                    admitted.removeIf(value->!value.equals(scope));
                    lastRecoveryAt.keySet().removeIf(value->!value.equals(scope));
                    decision=decideSynced(state,scope,now);
                } else if(!recoveryScope(state))decision=new Decision("recovery_inactive");
                else if(!admitted.contains(scope))decision=new Decision("recovery_not_admitted");
                else decision=decideRecovery(state,scope,now,true);
            }
        }
        report(decision.reason(),state,decision.retryAfter());
        if(decision.attempt()!=null)submit(decision.attempt(),state);
    }
    /** Caller holds only the internal gate lock; no callbacks or Binder calls occur here. */
    private Decision decideSynced(State state,Scope scope,long now) {
        long sequence=observePhase(state);
        if(pending!=null)return new Decision("launch_pending");
        if(state.rearShowing()) {
            admitted.add(scope);rememberVisible(state,now);return new Decision("already_visible");
        }
        if(recoveryScope(state)) {
            boolean previouslyAdmitted=admitted.contains(scope);
            // This first attempt is authorized by this successful sync. Later lifecycle
            // refreshes may restore it, but never introduce another task or epoch.
            admitted.add(scope);
            return decideRecovery(state,scope,now,previouslyAdmitted);
        }
        boolean reopen=shown.contains(state.taskId());
        if(reopen) {
            if(sequence==lastVisibleSequence.getOrDefault(state.taskId(),0L))return new Decision("phase_unchanged");
            if(sequence==lastReopenSequence.getOrDefault(state.taskId(),0L))return new Decision("phase_already_attempted");
            long wait=remaining(lastLaunchAt.get(state.taskId()),now,REOPEN_AFTER_MS);
            if(wait>0)return new Decision("phase_throttled",wait,null);
        }
        long wait=remaining(failedAt.get(state.taskId()),now,RETRY_AFTER_MS);
        if(wait>0)return new Decision("retry_throttled",wait,null);
        Attempt attempt=new Attempt(state.taskId(),state.controlEpoch(),state.phaseKey(),sequence,reopen,false);
        pending=attempt;admitted.add(scope);
        return new Decision("launch_queued",0,attempt);
    }
    private Decision decideRecovery(State state,Scope scope,long now,boolean restoring) {
        if(pending!=null)return new Decision("launch_pending");
        if(state.rearShowing()){rememberVisible(state,now);return new Decision("already_visible");}
        long wait=remaining(lastRecoveryAt.get(scope),now,RECOVERY_AFTER_MS);
        if(wait>0)return new Decision("recovery_throttled",wait,null);
        Attempt attempt=new Attempt(state.taskId(),state.controlEpoch(),state.phaseKey(),observePhase(state),restoring,true);
        pending=attempt;return new Decision(restoring?"recovery_queued":"launch_queued",0,attempt);
    }
    private void submit(Attempt attempt,State state) {
        try{worker.execute(()->launch(attempt));}
        catch(RuntimeException rejected) {
            long now=clock.getAsLong();
            synchronized(lock){if(pending==attempt){pending=null;if(attempt.recovery())lastRecoveryAt.put(attempt.scope(),now);}}
            report("worker_rejected",state,attempt.recovery()?RECOVERY_AFTER_MS:0);
        }
    }
    private static long remaining(Long previous,long now,long interval) {
        return previous==null?0:now<previous?interval:Math.max(0,interval-(now-previous));
    }
    private static Scope scope(State state){return new Scope(state.taskId(),state.controlEpoch());}
    private static boolean recoveryScope(State state) {
        return state!=null&&state.backgroundAllowed()&&state.mainScreenOff()
                &&state.taskId()!=null&&!state.taskId().isBlank()&&!state.taskId().startsWith("handoff:");
    }
    private static boolean matches(Attempt attempt,State state) {
        return state!=null&&attempt.taskId().equals(state.taskId())&&attempt.controlEpoch()==state.controlEpoch();
    }
    /** Count observed transitions, not distinct text: A -> B -> A is a new phase occurrence. */
    private long observePhase(State state) {
        String previous=observedPhase.put(state.taskId(),state.phaseKey());
        long sequence=phaseSequence.getOrDefault(state.taskId(),0L);
        if(previous==null||!previous.equals(state.phaseKey()))phaseSequence.put(state.taskId(),++sequence);
        return sequence;
    }
    private void rememberVisible(State state,long now) {
        shown.add(state.taskId());lastVisibleSequence.put(state.taskId(),observePhase(state));
        lastLaunchAt.putIfAbsent(state.taskId(),now);
    }
    private void launch(Attempt attempt) {
        try {
            if(!allowed(attempt))return;
            State state=read();long now=clock.getAsLong();boolean visible=false;
            synchronized(lock) {
                if(closed||pending!=attempt)return;
                if(matches(attempt,state)&&state.rearShowing()){rememberVisible(state,now);visible=true;}
                else {
                    if(attempt.recovery()) {
                        // An initial successful presentation does not delay its first loss
                        // recovery; subsequent recoveries are at least two seconds apart.
                        if(attempt.reopen())lastRecoveryAt.put(attempt.scope(),now);
                    } else if(attempt.reopen())lastReopenSequence.put(attempt.taskId(),attempt.phaseSequence());
                    lastLaunchAt.put(attempt.taskId(),now);
                }
            }
            if(visible){report("already_visible",state,0);return;}
            if(!allowed(attempt))return;
            report(attempt.recovery()&&attempt.reopen()?"recovering":attempt.reopen()?"phase_reopening":"launching",state,0);
            // No gate lock crosses Binder. Visibility becoming true is an acknowledgement,
            // not a revocation: the launcher's stability check must remain allowed.
            launcher.start(()->allowed(attempt));
            if(allowed(attempt)) {
                State latest=read();long finished=clock.getAsLong();boolean accepted=false;
                String blocked=attemptBlockReason(attempt,latest,finished);
                synchronized(lock) {
                    if("eligible".equals(blocked)&&pending==attempt&&!closed
                            &&(!attempt.recovery()||admitted.contains(attempt.scope()))
                            &&(attempt.recovery()||attempt.phaseSequence()==phaseSequence.getOrDefault(attempt.taskId(),0L))) {
                        rememberVisible(latest,finished);failedAt.remove(attempt.taskId());accepted=true;
                    }
                }
                if(accepted)report("visible",latest,0);
            }
        } catch(Exception failure) {
            long now=clock.getAsLong();
            synchronized(lock) {
                if(pending==attempt&&!closed) {
                    failedAt.put(attempt.taskId(),now);
                    // Also rate-limit the first failure before it has ever become visible.
                    if(admitted.contains(attempt.scope()))lastRecoveryAt.put(attempt.scope(),now);
                }
            }
            report(failureReason(failure),read(),attempt.recovery()?RECOVERY_AFTER_MS:attempt.reopen()?0:RETRY_AFTER_MS);
        } finally {synchronized(lock){if(pending==attempt)pending=null;}}
    }
    private String attemptBlockReason(Attempt attempt,State state,long now) {
        String reason=gateReason(state,now);if(!"eligible".equals(reason))return reason;
        if(!attempt.taskId().equals(state.taskId()))return "task_changed";
        if(attempt.controlEpoch()!=state.controlEpoch())return "control_changed";
        if(attempt.recovery())return recoveryScope(state)?"eligible":"recovery_inactive";
        return attempt.phaseKey().equals(state.phaseKey())?"eligible":"phase_changed";
    }
    private boolean allowed(Attempt attempt) {
        boolean cancelled;synchronized(lock){cancelled=closed||pending!=attempt;}
        State state=read();String reason=cancelled?"launch_cancelled":attemptBlockReason(attempt,state,clock.getAsLong());
        if("eligible".equals(reason))synchronized(lock) {
            if(closed||pending!=attempt)reason="launch_cancelled";
            else if(attempt.recovery()&&!admitted.contains(attempt.scope()))reason="recovery_not_admitted";
            else if(!attempt.recovery()&&attempt.phaseSequence()!=phaseSequence.getOrDefault(attempt.taskId(),0L))reason="phase_changed";
        }
        if(!"eligible".equals(reason)){report(reason,state,0);return false;}
        return true;
    }
    private State read(){try{return current.get();}catch(RuntimeException unavailable){return null;}}
    static String gateReason(State state,long now) {
        if(state==null)return "state_unavailable";
        if(!state.enabled())return "disabled";
        if(!state.online())return "offline";
        if(state.paused())return "paused";
        if(state.locked()&&!state.backgroundAllowed())return "locked_main_mode";
        if(state.taskId()==null||state.taskId().isBlank())return "no_active_task";
        if(state.controlEpoch()<0)return "invalid_control_epoch";
        if(state.syncedAtElapsedMs()<=0)return "state_not_synced";
        if(now<state.syncedAtElapsedMs()||now-state.syncedAtElapsedMs()>RearStatus.FRESH_FOR_MS)return "state_stale";
        return "eligible";
    }
    private static String failureReason(Exception failure) {
        if("rear_not_visible".equals(failure.getMessage()))return "rear_not_visible";
        if("rear_launch_revoked".equals(failure.getMessage()))return "rear_launch_revoked";
        if(failure instanceof DisplayExecutor.BackendException){String code=((DisplayExecutor.BackendException)failure).code;
            if(code!=null&&code.matches("[A-Z_]{1,64}"))return "backend_"+code.toLowerCase(java.util.Locale.ROOT);}
        return failure instanceof InterruptedException?"launch_interrupted":"launch_failed";
    }
    /** Metadata only: no task identity, phase text, title, summary, package, or page contents. */
    private void report(String reason,State state,long retryAfter) {
        long now=clock.getAsLong();String key=reason+"|"+(state==null?"missing":state.enabled()+":"+state.online()+":"+state.paused()+":"+state.locked()+":"+state.backgroundAllowed()+":"+state.rearShowing()+":"+state.mainScreenOff());
        synchronized(reportLock){if(key.equals(lastReport)&&now>=lastReportAt&&now-lastReportAt<REOPEN_AFTER_MS)return;lastReport=key;lastReportAt=now;}
        JSONObject value=Tunnel.json("event","rear_progress","gateReason",reason,"atElapsedMs",now,"retryAfterMs",retryAfter);
        if(state!=null)try{value.put("enabled",state.enabled()).put("online",state.online()).put("paused",state.paused())
                .put("locked",state.locked()).put("backgroundAllowed",state.backgroundAllowed()).put("rearShowing",state.rearShowing()).put("mainScreenOff",state.mainScreenOff())
                .put("hasCandidate",state.taskId()!=null&&!state.taskId().isBlank()).put("controlEpoch",state.controlEpoch())
                .put("stateAgeMs",state.syncedAtElapsedMs()>0?now-state.syncedAtElapsedMs():-1);}catch(Exception ignored){}
        try{reporter.accept(value);}catch(RuntimeException ignored){}
    }
    /** A changed binding cannot retain admissions or queued work for the previous phone. */
    void invalidate() {
        synchronized(lock) {
            pending=null;admitted.clear();lastRecoveryAt.clear();admissionGeneration++;shown.clear();observedPhase.clear();phaseSequence.clear();
            lastVisibleSequence.clear();lastReopenSequence.clear();failedAt.clear();lastLaunchAt.clear();
        }
    }
    @Override public void close(){synchronized(lock){closed=true;pending=null;admitted.clear();lastRecoveryAt.clear();admissionGeneration++;}}
    /** Stable phase text only; repeated phaseAt/updatedAt changes do not request another wake. */
    static String phaseKey(JSONArray tasks,String taskId) {
        if(tasks==null||taskId==null)return "";
        for(int i=0;i<tasks.length();i++){JSONObject task=tasks.optJSONObject(i);if(task!=null&&taskId.equals(task.optString("id")))return task.optString("phase","");}
        return "";
    }
    static String selectActiveTask(JSONArray tasks){return selectActiveTask(tasks,"");}
    static String selectActiveTask(JSONArray tasks,String preferredId) {
        String selected="";long selectedAt=Long.MIN_VALUE;if(tasks==null)return selected;
        for(int i=0;i<tasks.length();i++) {
            JSONObject task=tasks.optJSONObject(i);if(task==null||!ACTIVE.contains(task.optString("status","")))continue;
            String id=task.optString("id","");if(id.isBlank())continue;if(id.equals(preferredId))return id;
            long at;try{at=Instant.parse(task.optString("updatedAt","")).toEpochMilli();}catch(Exception invalid){at=0;}
            if(selected.isEmpty()||at>selectedAt){selected=id;selectedAt=at;}
        }
        return selected;
    }
}
