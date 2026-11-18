package dev.boujoy.personalagent;

import android.app.KeyguardManager;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import javax.net.ssl.SSLContext;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadow.api.Shadow;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;

/** Real service sync, stop and bridge lifecycle; only the remote power effect is replaced. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,shadows={DisplayConnectionTest.OnlineTunnel.class,RearTaskLeaseIntegrationTest.Mac.class})
public class RearTaskLeaseIntegrationTest {
    @Implements(value=GatewayClient.class,isInAndroidSdk=false)
    public static class Mac {
        volatile JSONObject next;
        final List<String> paths=new CopyOnWriteArrayList<>();
        @Implementation protected JSONObject json(String method,String path,JSONObject request,boolean control)throws Exception {
            paths.add(path);
            if("/v1/state".equals(path))return new JSONObject(next.toString());
            JSONObject reply=new JSONObject();
            if(request!=null&&request.has("controlEpoch"))reply.put("controlEpoch",request.getLong("controlEpoch"))
                    .put("paused",request.optBoolean("paused",true));
            return reply;
        }
    }
    private static final class Queue implements Executor {
        final ArrayDeque<Runnable> jobs=new ArrayDeque<>();
        public synchronized void execute(Runnable job){jobs.addLast(job);}
        void drain(){for(int i=0;i<100;i++){Runnable job;synchronized(this){job=jobs.pollFirst();}if(job==null)return;job.run();}fail("Unexpected lease worker loop");}
    }
    private record Hold(String id,long generation,long expiresAt,BooleanSupplier allowed) {}
    private static final class PowerBoundary implements RearTaskLease.Backend {
        final List<Hold> renewals=new ArrayList<>();
        Hold active;
        int releases;
        public void renew(String id,long generation,long expiresAt,BooleanSupplier allowed) {
            assertTrue("The service permit must still be current at the remote barrier",allowed.getAsBoolean());
            active=new Hold(id,generation,expiresAt,allowed);renewals.add(active);
        }
        public void release(String id,long generation) {
            releases++;
            if(active!=null&&active.id().equals(id)&&active.generation()==generation)active=null;
        }
    }
    private ConnectionService service;
    private DisplayBridge bridge;
    private ControlState gate;
    private MaintenanceRecoveryTest.Memory storage;
    private MobileWorkers workers;
    private Mac mac;
    private RearTaskLease lease;
    private final Queue queue=new Queue();
    private final PowerBoundary powerBoundary=new PowerBoundary();

    @Before public void setup()throws Exception {
        org.junit.Assume.assumeTrue("Xiaomi display integration is not part of the Phone Use edition",BuildConfig.BACKGROUND_SUPPORTED);
        service=Robolectric.buildService(ConnectionService.class).get();
        storage=new MaintenanceRecoveryTest.Memory();gate=new ControlState(storage);gate.resumeExplicitly();
        PowerManager power=service.getSystemService(PowerManager.class);Shadows.shadowOf(power).setIsInteractive(true);
        KeyguardManager keyguard=service.getSystemService(KeyguardManager.class);
        Shadows.shadowOf(keyguard).setIsDeviceLocked(false);Shadows.shadowOf(keyguard).setKeyguardLocked(false);
        bridge=ReflectionHelpers.callConstructor(DisplayBridge.class,
                ReflectionHelpers.ClassParameter.from(Context.class,service.getApplicationContext()));
        bridge.setRearProgressEnabled(true);bridge.setLockedExecutionAllowed(true);
        ((Handler)ReflectionHelpers.getField(bridge,"main")).removeCallbacksAndMessages(null);
        Tunnel tunnel=new Tunnel(null,gate,()->{});
        GatewayClient gateway=new GatewayClient(tunnel,(SSLContext)null);mac=Shadow.extract(gateway);
        mac.next=new JSONObject().put("device",new JSONObject().put("controlEpoch",gate.epoch()).put("paused",false))
                .put("phoneExecution",new JSONObject().put("mode","background"))
                .put("tasks",new JSONArray().put(new JSONObject().put("id","rear-task").put("status","running")
                        .put("phase","读取页面").put("updatedAt","2026-11-15T11:00:00Z")));
        ReflectionHelpers.setField(service,"gate",gate);ReflectionHelpers.setField(service,"power",power);
        ReflectionHelpers.setField(service,"keyguard",keyguard);ReflectionHelpers.setField(service,"displayBridge",bridge);
        ReflectionHelpers.setField(service,"tunnel",tunnel);ReflectionHelpers.setField(service,"gateway",gateway);
        ReflectionHelpers.setField(service,"paired",true);ReflectionHelpers.setField(service,"lastDisplayLocked",false);
        ReflectionHelpers.setField(service,"cachedState",new JSONObject(mac.next.toString()));
        workers=ReflectionHelpers.getField(service,"workers");
        lease=new RearTaskLease(queue,()->ReflectionHelpers.callInstanceMethod(service,"rearProgressState"),
                ()->Math.max(1L,SystemClock.elapsedRealtime()),powerBoundary);
        ReflectionHelpers.setField(service,"rearTaskLease",lease);
        bridge.addLifecycleListener(ReflectionHelpers.getField(service,"displayLifecycle"));
        // Ensure the successful-sync timestamp is positive without starting periodic service jobs.
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(10));
    }
    @After public void cleanup(){
        if(service!=null)service.onDestroy();queue.drain();
        if(bridge!=null)((Handler)ReflectionHelpers.getField(bridge,"main")).removeCallbacksAndMessages(null);
    }
    private void sync(){ReflectionHelpers.callInstanceMethod(service,"tick");}
    private void present(boolean visible){bridge.setRearShowing(visible);Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1));}
    private void tickPresentation(){
        Runnable tick=ReflectionHelpers.getField(service,"screenTick");tick.run();
        ((Handler)ReflectionHelpers.getField(service,"screenHandler")).removeCallbacks(tick);
    }
    private void admitVisible(){present(true);sync();queue.drain();assertNotNull(powerBoundary.active);}
    private JSONObject cached(){return ReflectionHelpers.getField(service,"cachedState");}

    @Test public void successfulSyncThenRealVisibilityEventAcquiresBeforeMainScreenTurnsOff() {
        // Cached tasks, connectivity and a visible page are insufficient until the real GET succeeds.
        present(true);tickPresentation();queue.drain();assertTrue(powerBoundary.renewals.isEmpty());
        present(false);sync();queue.drain();assertTrue(powerBoundary.renewals.isEmpty());
        long synced=ReflectionHelpers.getField(service,"stateSyncedAtElapsedMs");assertTrue(synced>0);
        present(true);queue.drain();
        assertEquals(1,powerBoundary.renewals.size());assertNotNull(powerBoundary.active);
        assertFalse(((RearProgressCoordinator.State)ReflectionHelpers.callInstanceMethod(service,"rearProgressState")).mainScreenOff());
        assertEquals("Visibility cannot manufacture a newer authenticated sync",synced,
                (long)ReflectionHelpers.getField(service,"stateSyncedAtElapsedMs"));
    }
    @Test public void realRearStopPersistsBeforeNetworkAndRevokesAnAlreadyIssuedPermit()throws Exception {
        admitVisible();Hold old=powerBoundary.active;long oldEpoch=gate.epoch();
        CountDownLatch entered=new CountDownLatch(1),resume=new CountDownLatch(1);
        workers.control.execute(()->{entered.countDown();try{resume.await();}catch(InterruptedException error){Thread.currentThread().interrupt();}});
        assertTrue(entered.await(2,TimeUnit.SECONDS));
        try {
            service.stopTaskFromRear("rear-task");
            assertTrue(gate.paused());assertFalse(gate.permitsData(oldEpoch));assertEquals("rear_stop",storage.reason());
            assertFalse("Stop invalidates the permit before queued remote cleanup",old.allowed().getAsBoolean());
            assertFalse(mac.paths.contains("/v1/tasks/rear-task/stop"));
            queue.drain();assertNull(powerBoundary.active);assertTrue(powerBoundary.releases>0);
            service.resumeAfterUnlock();tickPresentation();present(true);queue.drain();
            assertTrue(gate.paused());assertEquals(1,powerBoundary.renewals.size());
            ControlState recreated=new ControlState(storage);assertTrue(recreated.paused());assertFalse(recreated.pausedByScreenOff());
        } finally {resume.countDown();}
        workers.control.submit(()->{}).get(5,TimeUnit.SECONDS);
    }
    @Test public void actualRearOptOutLifecycleReleasesAndOptInAloneCannotReadmitCache() {
        admitVisible();Hold old=powerBoundary.active;
        bridge.setRearProgressEnabled(false);Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1));
        assertFalse(old.allowed().getAsBoolean());queue.drain();assertNull(powerBoundary.active);
        bridge.setRearProgressEnabled(true);Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1));
        tickPresentation();queue.drain();assertEquals(1,powerBoundary.renewals.size());
    }
    @Test public void authenticationLossAndExecutionModeChangeReleaseThroughTheServiceTick()throws Exception {
        admitVisible();ReflectionHelpers.setField(service,"lastAuthenticatedAt",0L);
        tickPresentation();queue.drain();assertNull(powerBoundary.active);
        ReflectionHelpers.setField(service,"lastAuthenticatedAt",Math.max(1L,SystemClock.elapsedRealtime()));
        tickPresentation();queue.drain();assertEquals("Cached connectivity cannot re-admit a task",1,powerBoundary.renewals.size());
        sync();queue.drain();assertEquals(2,powerBoundary.renewals.size());
        cached().getJSONObject("phoneExecution").put("mode","main");
        ReflectionHelpers.callInstanceMethod(service,"applyExecutionMode");tickPresentation();queue.drain();
        assertNull(powerBoundary.active);assertFalse(bridge.lockedExecutionAllowed());
    }
    @Test public void bindingInvalidationAndStaleControlCannotRenewWithoutAnotherSuccessfulSync()throws Exception {
        admitVisible();Hold old=powerBoundary.active;
        ReflectionHelpers.callInstanceMethod(service,"invalidateDisplay",ReflectionHelpers.ClassParameter.from(String.class,"binding_changed"));
        assertFalse(old.allowed().getAsBoolean());queue.drain();assertNull(powerBoundary.active);
        present(true);tickPresentation();queue.drain();assertEquals(1,powerBoundary.renewals.size());
        gate.resumeExplicitly();sync();queue.drain();assertEquals("Old remote control cannot be promoted to the new local epoch",1,powerBoundary.renewals.size());
        mac.next.getJSONObject("device").put("controlEpoch",gate.epoch()).put("paused",false);
        sync();queue.drain();assertEquals(2,powerBoundary.renewals.size());
    }
    @Test public void serviceDestructionRevokesQueuedRenewalBeforeItCanReachThePowerBoundary() {
        present(true);sync();assertTrue(powerBoundary.renewals.isEmpty());
        service.onDestroy();service=null;queue.drain();
        assertTrue(powerBoundary.renewals.isEmpty());assertNull(powerBoundary.active);
        lease.onPresentationChanged();lease.onStateSynced();queue.drain();assertTrue(powerBoundary.renewals.isEmpty());
    }
}
