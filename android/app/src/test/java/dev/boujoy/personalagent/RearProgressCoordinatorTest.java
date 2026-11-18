package dev.boujoy.personalagent;

import java.util.ArrayDeque;
import java.util.Queue;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class RearProgressCoordinatorTest {
    private static RearProgressCoordinator.State state(String task,long epoch,long sync,boolean enabled,boolean online,boolean paused,boolean locked) {
        return new RearProgressCoordinator.State(task,epoch,sync,enabled,online,paused,locked);
    }
    private static final class QueueWorker implements Executor {
        final Queue<Runnable> queue=new ArrayDeque<>();
        public void execute(Runnable work){queue.add(work);}
        void drain(){while(!queue.isEmpty())queue.remove().run();}
    }
    @Test public void successfulPresentationOccursOncePerNewTask() {
        QueueWorker worker=new QueueWorker();AtomicLong now=new AtomicLong(1000);AtomicInteger launches=new AtomicInteger();
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(state("one",4,1000,true,true,false,false));
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,now::get,allowed->{assertTrue(allowed.getAsBoolean());launches.incrementAndGet();})) {
            coordinator.onStateSynced();coordinator.onStateSynced();assertEquals(1,worker.queue.size());worker.drain();
            coordinator.onStateSynced();worker.drain();assertEquals(1,launches.get());
            current.set(state("two",4,1000,true,true,false,false));coordinator.onStateSynced();worker.drain();assertEquals(2,launches.get());
            current.set(state("one",4,1000,true,true,false,false));coordinator.onStateSynced();worker.drain();assertEquals(2,launches.get());
        }
    }
    @Test public void optInFreshnessOnlineGateAndKeyguardAreAllRequired() {
        QueueWorker worker=new QueueWorker();AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>();
        RearProgressCoordinator.State[] forbidden={state("t",4,40_000,false,true,false,false),state("t",4,40_000,true,false,false,false),state("t",4,40_000,true,true,true,false),state("t",4,40_000,true,true,false,true),state("t",4,0,true,true,false,false),state("t",4,40_001,true,true,false,false),state("t",4,9_999,true,true,false,false),state("",4,40_000,true,true,false,false)};
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,()->40_000,allowed->fail("ineligible state launched"))) {
            for(var value:forbidden){current.set(value);coordinator.onStateSynced();worker.drain();}
            assertTrue(worker.queue.isEmpty());
        }
    }
    @Test public void queuedWorkRechecksStopChangedTaskOptOutAndDisconnect() {
        QueueWorker worker=new QueueWorker();AtomicInteger launches=new AtomicInteger();AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>();
        RearProgressCoordinator.State[] changed={state("t",5,1000,true,true,true,false),state("other",4,1000,true,true,false,false),state("t",4,1000,false,true,false,false),state("t",4,1000,true,false,false,false),state("t",4,1000,true,true,false,true),state("t",5,1000,true,true,false,false)};
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,()->1000,allowed->launches.incrementAndGet())) {
            for(var value:changed){current.set(state("t",4,1000,true,true,false,false));coordinator.onStateSynced();current.set(value);worker.drain();}
            assertEquals(0,launches.get());
        }
    }
    @Test public void shellPermissionCallbackRejectsStopWhileLaunchIsWaiting() {
        QueueWorker worker=new QueueWorker();AtomicInteger injected=new AtomicInteger();AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(state("t",4,1000,true,true,false,false));
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,()->1000,allowed->{assertTrue(allowed.getAsBoolean());current.set(state("t",5,1000,true,true,true,false));if(allowed.getAsBoolean())injected.incrementAndGet();else throw new IllegalStateException("stopped");})) {
            coordinator.onStateSynced();worker.drain();assertEquals(0,injected.get());
        }
    }
    @Test public void failuresAreNotMarkedShownAndRetryAtMostEveryTenSeconds() {
        QueueWorker worker=new QueueWorker();AtomicLong now=new AtomicLong(1000);AtomicInteger attempts=new AtomicInteger();AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(state("t",4,1000,true,true,false,false));
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,now::get,allowed->{if(attempts.incrementAndGet()==1)throw new IllegalStateException("rear unavailable");})) {
            coordinator.onStateSynced();worker.drain();now.set(10_999);coordinator.onStateSynced();worker.drain();assertEquals(1,attempts.get());
            now.set(11_000);coordinator.onStateSynced();worker.drain();assertEquals(2,attempts.get());
            now.set(12_000);coordinator.onStateSynced();worker.drain();assertEquals(2,attempts.get());
        }
    }
    @Test public void bindingInvalidationAndDestroyCancelPendingLaunch() {
        QueueWorker worker=new QueueWorker();AtomicInteger launches=new AtomicInteger();var current=state("t",4,1000,true,true,false,false);
        RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,()->current,()->1000,allowed->launches.incrementAndGet());
        coordinator.onStateSynced();coordinator.invalidate();worker.drain();assertEquals(0,launches.get());
        coordinator.onStateSynced();coordinator.close();worker.drain();coordinator.onStateSynced();worker.drain();assertEquals(0,launches.get());
    }
    @Test public void rejectedSubmissionDoesNotStrandTheTask() {
        AtomicInteger attempts=new AtomicInteger(),launches=new AtomicInteger();Executor worker=work->{if(attempts.incrementAndGet()==1)throw new RejectedExecutionException();work.run();};
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,()->state("t",4,1000,true,true,false,false),()->1000,allowed->launches.incrementAndGet())) {
            coordinator.onStateSynced();coordinator.onStateSynced();assertEquals(1,launches.get());
        }
    }
    @Test public void selectionMatchesRearPriorityButNeverWakesForOldPendingWork() throws Exception {
        JSONArray tasks=new JSONArray();
        for(String status:new String[]{"blocked","needs_input","ready_for_user","unknown_result","waiting_setup","waiting_user","paused","completed"})tasks.put(new JSONObject().put("id",status).put("status",status).put("updatedAt","2026-11-14T11:00:00Z"));
        assertEquals("",RearProgressCoordinator.selectActiveTask(tasks));
        tasks.put(new JSONObject().put("id","running").put("status","running").put("updatedAt","2026-11-14T10:00:00Z"));
        tasks.put(new JSONObject().put("id","approval").put("status","waiting_approval").put("updatedAt","2026-11-14T10:01:00Z"));
        JSONObject snapshot=new JSONObject().put("online",true).put("stateSyncedAtElapsedMs",1000).put("state",new JSONObject().put("tasks",tasks));
        assertEquals("approval",RearProgressCoordinator.selectActiveTask(tasks));
        assertEquals(RearStatus.from(snapshot,1000,false).taskId(),RearProgressCoordinator.selectActiveTask(tasks));
    }
    @Test public void actualDisplayTaskWinsOnlyWhileItIsActive() throws Exception {
        JSONArray tasks=new JSONArray()
                .put(new JSONObject().put("id","background").put("status","running").put("updatedAt","2026-11-14T10:00:00Z"))
                .put(new JSONObject().put("id","newer").put("status","running").put("updatedAt","2026-11-14T10:01:00Z"))
                .put(new JSONObject().put("id","old-pending").put("status","blocked").put("updatedAt","2026-11-14T11:00:00Z"));
        assertEquals("background",RearProgressCoordinator.selectActiveTask(tasks,"background"));
        assertEquals("newer",RearProgressCoordinator.selectActiveTask(tasks,"old-pending"));
        assertEquals("newer",RearProgressCoordinator.selectActiveTask(tasks,"unknown"));
        tasks.getJSONObject(0).put("status","completed");
        assertEquals("newer",RearProgressCoordinator.selectActiveTask(tasks,"background"));
    }
    private static RearProgressCoordinator.State phaseState(String phase,long sync,boolean showing,boolean locked,boolean background) {
        return new RearProgressCoordinator.State("task-secret",4,sync,true,true,false,locked,background,showing,phase);
    }
    @Test public void backgroundModeAllowsLockedRearButMainModeAndStopStillBlock() {
        QueueWorker worker=new QueueWorker();AtomicInteger launches=new AtomicInteger();
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(phaseState("读取页面",1000,false,true,false));
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,()->1000,allowed->{assertTrue(allowed.getAsBoolean());launches.incrementAndGet();})) {
            assertEquals("locked_main_mode",RearProgressCoordinator.gateReason(current.get(),1000));coordinator.onStateSynced();worker.drain();assertEquals(0,launches.get());
            current.set(phaseState("读取页面",1000,false,true,true));assertEquals("eligible",RearProgressCoordinator.gateReason(current.get(),1000));
            coordinator.onStateSynced();worker.drain();assertEquals(1,launches.get());
            var stopped=new RearProgressCoordinator.State("task-secret",5,1000,true,true,true,true,true,false,"核对结果");
            assertEquals("paused",RearProgressCoordinator.gateReason(stopped,1000));
        }
    }
    @Test public void visibleRearNeverRelaunchesAndSameOccurrenceCannotWakeItAgain() {
        QueueWorker worker=new QueueWorker();AtomicLong now=new AtomicLong(1000);AtomicInteger launches=new AtomicInteger();
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(phaseState("读取页面",1000,true,false,true));
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,now::get,allowed->launches.incrementAndGet())) {
            coordinator.onStateSynced();worker.drain();assertEquals(0,launches.get());
            current.set(phaseState("核对结果",1000,true,false,true));coordinator.onStateSynced();worker.drain();
            now.set(20_000);current.set(phaseState("核对结果",20_000,false,false,true));coordinator.onStateSynced();worker.drain();assertEquals(0,launches.get());
            current.set(phaseState("准备交接",20_000,false,false,true));coordinator.onStateSynced();worker.drain();assertEquals(1,launches.get());
            now.set(40_000);current.set(phaseState("读取页面",40_000,false,false,true));coordinator.onStateSynced();worker.drain();assertEquals("A later transition back to earlier text is a new occurrence",2,launches.get());
        }
    }
    @Test public void hiddenRearReopensOnlyForNewPhaseAtLeastFifteenSecondsApart() {
        QueueWorker worker=new QueueWorker();AtomicLong now=new AtomicLong(1000);AtomicInteger launches=new AtomicInteger();
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(phaseState("读取页面",1000,false,false,true));
        java.util.List<JSONObject> logs=new java.util.ArrayList<>();
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,now::get,allowed->launches.incrementAndGet(),logs::add)) {
            coordinator.onStateSynced();worker.drain();assertEquals(1,launches.get());
            now.set(2000);current.set(phaseState("核对结果",2000,false,false,true));coordinator.onStateSynced();worker.drain();assertEquals(1,launches.get());
            assertEquals("phase_throttled",logs.get(logs.size()-1).optString("gateReason"));
            now.set(16_000);current.set(phaseState("核对结果",16_000,false,false,true));coordinator.onStateSynced();worker.drain();assertEquals(2,launches.get());
            now.set(40_000);current.set(phaseState("核对结果",40_000,false,false,true));coordinator.onStateSynced();worker.drain();assertEquals(2,launches.get());
            current.set(phaseState("准备交接",40_000,false,false,true));coordinator.onStateSynced();worker.drain();assertEquals(3,launches.get());
        }
    }
    @Test public void failedPhaseReopenGetsOneAttemptAndReportsVisibilityFailure() {
        QueueWorker worker=new QueueWorker();AtomicLong now=new AtomicLong(1000);AtomicInteger launches=new AtomicInteger();
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(phaseState("读取页面",1000,false,false,true));
        java.util.List<JSONObject> logs=new java.util.ArrayList<>();
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,now::get,allowed->{if(launches.incrementAndGet()>1)throw new IllegalStateException("rear_not_visible");},logs::add)) {
            coordinator.onStateSynced();worker.drain();now.set(16_000);current.set(phaseState("核对结果",16_000,false,false,true));coordinator.onStateSynced();worker.drain();
            assertEquals(2,launches.get());assertEquals("rear_not_visible",logs.get(logs.size()-1).optString("gateReason"));
            now.set(40_000);current.set(phaseState("核对结果",40_000,false,false,true));coordinator.onStateSynced();worker.drain();assertEquals(2,launches.get());
            assertEquals("phase_already_attempted",logs.get(logs.size()-1).optString("gateReason"));
            current.set(phaseState("准备交接",40_000,false,false,true));coordinator.onStateSynced();worker.drain();assertEquals(3,launches.get());
        }
    }
    @Test public void queuedLaunchRechecksVisibilityPhaseAndBackgroundPermission() {
        QueueWorker worker=new QueueWorker();AtomicInteger launches=new AtomicInteger();
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>();
        for(var changed:new RearProgressCoordinator.State[]{phaseState("读取页面",1000,true,true,true),phaseState("新阶段",1000,false,true,true),phaseState("读取页面",1000,false,true,false)}) {
            current.set(phaseState("读取页面",1000,false,true,true));
            try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,()->1000,allowed->launches.incrementAndGet())) {
                coordinator.onStateSynced();current.set(changed);worker.drain();
            }
        }
        assertEquals(0,launches.get());
    }
    @Test public void phaseTimestampRefreshDoesNotBecomeNewPhase() throws Exception {
        JSONObject task=new JSONObject().put("id","one").put("phase","读取当前页面").put("phaseAt","2026-11-14T10:00:00Z");
        JSONArray tasks=new JSONArray().put(task);String first=RearProgressCoordinator.phaseKey(tasks,"one");
        task.put("phaseAt","2026-11-14T10:00:05Z").put("updatedAt","2026-11-14T10:00:05Z");
        assertEquals(first,RearProgressCoordinator.phaseKey(tasks,"one"));assertEquals("",RearProgressCoordinator.phaseKey(tasks,"missing"));
    }
    @Test public void gateDiagnosticsAreThrottledAndContainNoTaskOrPhaseContent() {
        QueueWorker worker=new QueueWorker();AtomicLong now=new AtomicLong(1000);java.util.List<JSONObject> logs=new java.util.ArrayList<>();
        var current=phaseState("用户私密页面内容",1000,false,true,false);
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,()->current,now::get,allowed->fail(),logs::add)) {
            for(int i=0;i<100;i++)coordinator.onStateSynced();assertEquals(1,logs.size());
            JSONObject log=logs.get(0);assertEquals("locked_main_mode",log.optString("gateReason"));assertTrue(log.optBoolean("locked"));assertFalse(log.optBoolean("backgroundAllowed"));
            assertFalse(log.toString().contains("task-secret"));assertFalse(log.toString().contains("用户私密"));assertFalse(log.has("phaseKey"));assertFalse(log.has("taskId"));
            now.set(16_000);coordinator.onStateSynced();assertEquals(2,logs.size());
        }
    }

    @Test public void hiddenAtoBtoAReopensForEachNewTransitionButNotRepeatedSync() {
        QueueWorker worker=new QueueWorker();AtomicLong now=new AtomicLong(1000);AtomicInteger launches=new AtomicInteger();
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(phaseState("正在思考",1000,false,false,true));
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,now::get,allowed->launches.incrementAndGet())) {
            coordinator.onStateSynced();worker.drain();assertEquals(1,launches.get());
            now.set(16_000);current.set(phaseState("操作手机",16_000,false,false,true));coordinator.onStateSynced();worker.drain();assertEquals(2,launches.get());
            now.set(31_000);current.set(phaseState("正在思考",31_000,false,false,true));coordinator.onStateSynced();worker.drain();assertEquals(3,launches.get());
            for(int i=0;i<10;i++){now.addAndGet(4000);current.set(phaseState("正在思考",now.get(),false,false,true));coordinator.onStateSynced();worker.drain();}
            assertEquals("Same text refresh is not another transition",3,launches.get());
        }
    }
    @Test public void queuedOldOccurrenceIsRevokedEvenIfPhaseTextComesBack() {
        QueueWorker worker=new QueueWorker();AtomicInteger launches=new AtomicInteger();
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(phaseState("A",1000,false,false,true));
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,()->1000,allowed->launches.incrementAndGet())) {
            coordinator.onStateSynced();current.set(phaseState("B",1000,false,false,true));coordinator.onStateSynced();
            current.set(phaseState("A",1000,false,false,true));coordinator.onStateSynced();worker.drain();assertEquals(0,launches.get());
            coordinator.onStateSynced();worker.drain();assertEquals(1,launches.get());
        }
    }


    private static RearProgressCoordinator.State offState(String phase,long sync,boolean showing) {
        return new RearProgressCoordinator.State("task-secret",4,sync,true,true,false,true,true,showing,phase,true);
    }
    @Test public void existingStateConstructorsDoNotAssumeTheMainDisplayIsOff() {
        assertFalse(state("t",4,1000,true,true,false,true).mainScreenOff());
        assertFalse(phaseState("A",1000,false,true,true).mainScreenOff());
    }
    @Test public void samePhaseLostPresentationRestoresImmediatelyOnceThenRateLimitsRepeatedLoss() {
        QueueWorker worker=new QueueWorker();AtomicLong now=new AtomicLong(1000);AtomicInteger launches=new AtomicInteger();
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(offState("读取页面",1000,false));
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,now::get,allowed->{
            assertTrue(allowed.getAsBoolean());launches.incrementAndGet();current.set(offState("读取页面",1000,true));assertTrue(allowed.getAsBoolean());
        })) {
            coordinator.onStateSynced();worker.drain();assertEquals(1,launches.get());
            now.set(1001);current.set(offState("读取页面",1000,false));
            coordinator.onPresentationChanged();coordinator.onPresentationChanged();assertEquals(1,worker.queue.size());worker.drain();assertEquals(2,launches.get());
            for(int i=0;i<20;i++){coordinator.onPresentationChanged();coordinator.onStateSynced();worker.drain();}assertEquals("Visible rear is never relaunched",2,launches.get());
            now.set(1002);current.set(offState("读取页面",1000,false));coordinator.onPresentationChanged();worker.drain();assertEquals(2,launches.get());
            now.set(3000);coordinator.onPresentationChanged();worker.drain();assertEquals(2,launches.get());
            now.set(3001);coordinator.onPresentationChanged();worker.drain();assertEquals(3,launches.get());
        }
    }
    @Test public void failedScreenOffLaunchRetriesTheSamePhaseEveryTwoSecondsWithoutAnotherSync() {
        QueueWorker worker=new QueueWorker();AtomicLong now=new AtomicLong(1000);AtomicInteger attempts=new AtomicInteger();
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(offState("A",1000,false));
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,now::get,allowed->{assertTrue(allowed.getAsBoolean());attempts.incrementAndGet();throw new IllegalStateException("rear_not_visible");})) {
            coordinator.onStateSynced();worker.drain();assertEquals(1,attempts.get());
            now.set(2999);coordinator.onPresentationChanged();worker.drain();assertEquals(1,attempts.get());
            now.set(3000);coordinator.onPresentationChanged();worker.drain();assertEquals(2,attempts.get());
            now.set(5000);coordinator.onPresentationChanged();worker.drain();assertEquals(3,attempts.get());
        }
    }
    @Test public void aFailedRecoveryDoesNotPermanentlyConsumeThePhase() {
        QueueWorker worker=new QueueWorker();AtomicLong now=new AtomicLong(1000);AtomicInteger attempts=new AtomicInteger();
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(offState("A",1000,true));
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,now::get,allowed->{if(attempts.incrementAndGet()==1)throw new IllegalStateException("rear_not_visible");})) {
            coordinator.onStateSynced();current.set(offState("A",1000,false));coordinator.onPresentationChanged();worker.drain();assertEquals(1,attempts.get());
            now.set(3000);coordinator.onStateSynced();worker.drain();assertEquals(2,attempts.get());
        }
    }
    @Test public void mainScreenLightingRevokesQueuedRecoveryPermanentlyEvenIfItTurnsOffBeforeDispatch() {
        QueueWorker worker=new QueueWorker();AtomicInteger launches=new AtomicInteger();
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(offState("A",1000,true));
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,()->1000,allowed->launches.incrementAndGet())) {
            coordinator.onStateSynced();current.set(offState("A",1000,false));coordinator.onPresentationChanged();assertEquals(1,worker.queue.size());
            current.set(phaseState("A",1000,false,true,true));coordinator.onPresentationChanged();
            current.set(offState("A",1000,false));worker.drain();assertEquals(0,launches.get());
            coordinator.onPresentationChanged();worker.drain();assertEquals("A new recovery can be admitted separately",1,launches.get());
        }
    }
    @Test public void recoveryCallbacksRecheckScreenStateRatherThanTreatingKeyguardAsScreenOff() {
        QueueWorker worker=new QueueWorker();AtomicInteger dispatched=new AtomicInteger();
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(offState("A",1000,true));
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,()->1000,allowed->{
            assertTrue(allowed.getAsBoolean());current.set(phaseState("A",1000,false,true,true));
            assertFalse(allowed.getAsBoolean());if(allowed.getAsBoolean())dispatched.incrementAndGet();
        })) {
            coordinator.onStateSynced();current.set(offState("A",1000,false));coordinator.onPresentationChanged();worker.drain();assertEquals(0,dispatched.get());
        }
    }
    @Test public void stopDisconnectOptOutEndedTaskEpochAndFreshnessRevokeRecoveryAdmission() {
        QueueWorker worker=new QueueWorker();AtomicInteger launches=new AtomicInteger();
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>();
        RearProgressCoordinator.State[] invalid={
            new RearProgressCoordinator.State("task-secret",4,1000,false,true,false,true,true,false,"A",true),
            new RearProgressCoordinator.State("task-secret",4,1000,true,false,false,true,true,false,"A",true),
            new RearProgressCoordinator.State("task-secret",4,1000,true,true,true,true,true,false,"A",true),
            new RearProgressCoordinator.State("",4,1000,true,true,false,true,true,false,"A",true),
            new RearProgressCoordinator.State("task-secret",5,1000,true,true,false,true,true,false,"A",true),
            new RearProgressCoordinator.State("other-task",4,1000,true,true,false,true,true,false,"A",true),
            new RearProgressCoordinator.State("task-secret",-1,1000,true,true,false,true,true,false,"A",true),
            new RearProgressCoordinator.State("task-secret",4,0,true,true,false,true,true,false,"A",true),
            new RearProgressCoordinator.State("task-secret",4,1001,true,true,false,true,true,false,"A",true)
        };
        for(var blocked:invalid)try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,()->1000,allowed->launches.incrementAndGet())) {
            current.set(offState("A",1000,true));coordinator.onStateSynced();
            current.set(offState("A",1000,false));coordinator.onPresentationChanged();
            current.set(blocked);coordinator.onPresentationChanged();current.set(offState("A",1000,false));worker.drain();
            coordinator.onPresentationChanged();worker.drain();assertEquals("Cached state cannot undo a revoked admission",0,launches.get());
        }
    }
    @Test public void expiredSyncCannotRecoverAndOnlyANewSuccessfulSyncCanReadmit() {
        QueueWorker worker=new QueueWorker();AtomicLong now=new AtomicLong(1000);AtomicInteger launches=new AtomicInteger();
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(offState("A",1000,true));
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,now::get,allowed->launches.incrementAndGet())) {
            coordinator.onStateSynced();now.set(31_001);current.set(offState("A",1000,false));coordinator.onPresentationChanged();worker.drain();assertEquals(0,launches.get());
            current.set(offState("A",31_001,false));coordinator.onPresentationChanged();worker.drain();assertEquals(0,launches.get());
            coordinator.onStateSynced();worker.drain();assertEquals(1,launches.get());
        }
    }
    @Test public void freshCachedTaskNeverStartsWithoutSuccessfulSyncAdmissionAndInvalidateClearsAdmission() {
        QueueWorker worker=new QueueWorker();AtomicInteger launches=new AtomicInteger();
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(offState("A",1000,false));
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,()->1000,allowed->launches.incrementAndGet())) {
            for(int i=0;i<10;i++)coordinator.onPresentationChanged();worker.drain();assertEquals(0,launches.get());
            coordinator.onStateSynced();worker.drain();assertEquals(1,launches.get());
            coordinator.invalidate();coordinator.onPresentationChanged();worker.drain();assertEquals(1,launches.get());
            coordinator.onStateSynced();worker.drain();assertEquals(2,launches.get());
        }
    }
    @Test public void phaseTransitionsDoNotCancelScreenOffRecoveryOrItsVisibleAcknowledgement() {
        QueueWorker worker=new QueueWorker();AtomicInteger launches=new AtomicInteger();
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(offState("A",1000,true));
        AtomicReference<RearProgressCoordinator> reference=new AtomicReference<>();
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,()->1000,allowed->{
            assertTrue(allowed.getAsBoolean());current.set(offState("B",1000,false));reference.get().onStateSynced();assertTrue(allowed.getAsBoolean());
            current.set(offState("A",1000,true));reference.get().onPresentationChanged();assertTrue(allowed.getAsBoolean());launches.incrementAndGet();
        })) {
            reference.set(coordinator);coordinator.onStateSynced();current.set(offState("A",1000,false));coordinator.onPresentationChanged();
            current.set(offState("B",1000,false));coordinator.onStateSynced();worker.drain();assertEquals(1,launches.get());
            coordinator.onPresentationChanged();worker.drain();assertEquals(1,launches.get());
        }
    }
    @Test public void handoffAndMainScreenOnKeepTheOriginalPhasePolicyInsteadOfPersistentRecovery() {
        QueueWorker worker=new QueueWorker();AtomicInteger launches=new AtomicInteger();
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>();
        for(String task:new String[]{"handoff:held","normal"})try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,current::get,()->1000,allowed->launches.incrementAndGet())) {
            boolean mainOff=task.startsWith("handoff:");
            current.set(new RearProgressCoordinator.State(task,4,1000,true,true,false,true,true,true,"A",mainOff));coordinator.onStateSynced();
            current.set(new RearProgressCoordinator.State(task,4,1000,true,true,false,true,true,false,"A",mainOff));
            coordinator.onPresentationChanged();coordinator.onStateSynced();worker.drain();assertEquals(0,launches.get());
        }
    }
    @Test public void stateSupplierLauncherAndReporterAreNeverCalledWithTheGateLockHeld() throws Exception {
        QueueWorker worker=new QueueWorker();AtomicReference<Object> gateLock=new AtomicReference<>();
        AtomicReference<RearProgressCoordinator> reference=new AtomicReference<>();AtomicInteger launches=new AtomicInteger();
        var value=offState("A",1000,false);
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,()->{assertFalse(Thread.holdsLock(gateLock.get()));return value;},()->1000,allowed->{
            assertFalse(Thread.holdsLock(gateLock.get()));assertTrue(allowed.getAsBoolean());launches.incrementAndGet();
            Thread revoker=new Thread(()->reference.get().invalidate());revoker.start();revoker.join(500);
            assertFalse("Stop/invalidation cannot wait behind Binder launch",revoker.isAlive());assertFalse(allowed.getAsBoolean());
        },ignored->assertFalse(Thread.holdsLock(gateLock.get())))) {
            java.lang.reflect.Field field=RearProgressCoordinator.class.getDeclaredField("lock");field.setAccessible(true);gateLock.set(field.get(coordinator));reference.set(coordinator);
            coordinator.onStateSynced();worker.drain();assertEquals(1,launches.get());
        }
    }
    @Test public void bindingInvalidationDuringStateReadCannotReAdmitTheOldSnapshot() {
        QueueWorker worker=new QueueWorker();AtomicReference<RearProgressCoordinator> reference=new AtomicReference<>();
        java.util.concurrent.atomic.AtomicBoolean invalidate=new java.util.concurrent.atomic.AtomicBoolean(true);AtomicInteger launches=new AtomicInteger();
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(worker,()->{
            if(invalidate.getAndSet(false))reference.get().invalidate();return offState("A",1000,false);
        },()->1000,allowed->launches.incrementAndGet())) {
            reference.set(coordinator);coordinator.onStateSynced();coordinator.onPresentationChanged();worker.drain();assertEquals(0,launches.get());
            coordinator.onStateSynced();worker.drain();assertEquals(1,launches.get());
        }
    }
}
