package dev.boujoy.personalagent;

import android.app.KeyguardManager;
import android.os.PowerManager;
import android.os.SystemClock;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLContext;
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

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,shadows={DisplayConnectionTest.OnlineTunnel.class,DisplayConnectionTest.Mac.class})
public class DisplayConnectionTest {
    @Implements(value=Tunnel.class,isInAndroidSdk=false)
    public static class OnlineTunnel {@Implementation protected boolean connected(){return true;}}
    @Implements(value=GatewayClient.class,isInAndroidSdk=false)
    public static class Mac {
        final List<String> paths=new ArrayList<>();
        @Implementation protected JSONObject json(String method,String path,JSONObject request,boolean control)throws Exception{
            paths.add(path);assertTrue("rear stop uses the existing control lane",control);
            return new JSONObject().put("controlEpoch",request.getLong("controlEpoch")).put("paused",true);
        }
    }
    private ConnectionService service;
    private MaintenanceRecoveryTest.Memory storage;
    private ControlState gate;
    private MobileWorkers workers;
    private Mac mac;
    @Before public void setup(){
        service=Robolectric.buildService(ConnectionService.class).get();
        storage=new MaintenanceRecoveryTest.Memory();gate=new ControlState(storage);gate.resumeExplicitly();
        Tunnel tunnel=new Tunnel(null,gate,()->{});GatewayClient gateway=new GatewayClient(tunnel,(SSLContext)null);mac=Shadow.extract(gateway);
        ReflectionHelpers.setField(service,"gate",gate);ReflectionHelpers.setField(service,"tunnel",tunnel);ReflectionHelpers.setField(service,"gateway",gateway);ReflectionHelpers.setField(service,"paired",true);
        ReflectionHelpers.setField(service,"lastAuthenticatedAt",Math.max(1L,SystemClock.elapsedRealtime()));
        PowerManager power=service.getSystemService(PowerManager.class);Shadows.shadowOf(power).setIsInteractive(true);
        KeyguardManager keyguard=service.getSystemService(KeyguardManager.class);Shadows.shadowOf(keyguard).setIsDeviceLocked(false);
        ReflectionHelpers.setField(service,"power",power);ReflectionHelpers.setField(service,"keyguard",keyguard);
        workers=ReflectionHelpers.getField(service,"workers");
    }
    @After public void cleanup(){service.onDestroy();}
    @Test public void rearStopRevokesAndPersistsBeforeNetworkAndUnlockCannotUndoIt()throws Exception{
        long oldEpoch=gate.epoch();CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);
        workers.control.execute(()->{entered.countDown();try{release.await();}catch(InterruptedException e){Thread.currentThread().interrupt();}});
        assertTrue(entered.await(2,TimeUnit.SECONDS));
        try{
            service.stopTaskFromRear("test-task");
            assertTrue(gate.paused());assertFalse(gate.permitsData(oldEpoch));assertEquals("rear_stop",storage.reason());assertTrue(mac.paths.isEmpty());
            service.resumeAfterUnlock();assertTrue(gate.paused());assertEquals("rear_stop",storage.reason());
            ControlState recreated=new ControlState(storage);assertTrue(recreated.paused());assertFalse(recreated.pausedByScreenOff());
            recreated.observeRemote(recreated.epoch()+1,false);assertTrue(recreated.paused());assertFalse(recreated.permitsData(recreated.epoch()));
        }finally{release.countDown();}
        workers.control.submit(()->{}).get(5,TimeUnit.SECONDS);
        assertEquals(List.of("/v1/device/control","/v1/tasks/test-task/stop"),mac.paths);
    }
    @Test public void noTaskOnRearStillStopsLocallyWithoutInventingATask()throws Exception{
        service.stopTaskFromRear("");workers.control.submit(()->{}).get(5,TimeUnit.SECONDS);
        assertTrue(gate.paused());assertEquals("rear_stop",storage.reason());assertEquals(List.of("/v1/device/control"),mac.paths);
    }
    @Test public void swipeKeyguardStillHidesRearDetailsWithoutASecureDeviceLock()throws Exception{
        KeyguardManager keyguard=service.getSystemService(KeyguardManager.class);
        Shadows.shadowOf(keyguard).setIsDeviceLocked(false);
        Shadows.shadowOf(keyguard).setKeyguardLocked(true);
        assertTrue(service.snapshot().getBoolean("locked"));
    }
    @Test public void cachedStateAndConnectivityDoNotInventASuccessfulSyncTimestamp()throws Exception{
        ReflectionHelpers.setField(service,"cachedState",new JSONObject().put("tasks",new org.json.JSONArray().put(new JSONObject().put("status","running"))));
        assertEquals(0,service.snapshot().getLong("stateSyncedAtElapsedMs"));
        assertTrue(service.snapshot().getBoolean("online"));assertFalse(service.snapshot().getBoolean("locked"));
    }
}
