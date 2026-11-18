package dev.boujoy.personalagent;

import android.app.KeyguardManager;
import android.content.Context;
import android.os.SystemClock;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLContext;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadow.api.Shadow;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;

/** Actual service workers and guards with synthetic gateway replies; no device input. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,shadows={RearApprovalInteractionTest.Online.class,RearApprovalInteractionTest.Mac.class})
public class RearApprovalInteractionTest {
    @Implements(value=Tunnel.class,isInAndroidSdk=false) public static class Online { @Implementation protected boolean connected(){return true;} }
    @Implements(value=GatewayClient.class,isInAndroidSdk=false) public static class Mac {
        final List<JSONObject> decisions=Collections.synchronizedList(new ArrayList<>());final List<String> paths=Collections.synchronizedList(new ArrayList<>());
        JSONObject detail;boolean loseReply;Runnable duringRead=()->{};
        @Implementation protected JSONObject json(String method,String path,JSONObject request,boolean control)throws Exception{
            paths.add(path);
            if(path.startsWith("/v1/approvals/")){assertTrue(control);decisions.add(new JSONObject(request.toString()));if(loseReply)throw new IOException("receipt lost");return Tunnel.json("resolved",true,"taskId","task-one");}
            if(path.startsWith("/v1/tasks/")){assertEquals("GET",method);assertFalse(control);duringRead.run();return detail;}
            if(path.equals("/v1/device/control"))return Tunnel.json("controlEpoch",request.getLong("controlEpoch"),"paused",request.getBoolean("paused"));
            throw new AssertionError("unexpected fixture endpoint: "+path);
        }
    }
    record Result(JSONObject value,Exception error) {}
    static final class Fixture implements AutoCloseable {
        final ConnectionService service;final ControlState gate;final MobileWorkers workers;final DisplayBridge bridge;final Mac mac;
        final RearApproval.Scope scope;final JSONObject snapshot;final GatewayClient client;final Tunnel tunnel;final CountDownLatch freezeTick=new CountDownLatch(1);
        Fixture()throws Exception{
            org.junit.Assume.assumeTrue("Xiaomi display integration is not part of the Phone Use edition",BuildConfig.BACKGROUND_SUPPORTED);
            ReflectionHelpers.setStaticField(DisplayBridge.class,"instance",null);Context context=RuntimeEnvironment.getApplication();
            context.getSharedPreferences("display_backend",Context.MODE_PRIVATE).edit().clear().commit();
            service=Robolectric.buildService(ConnectionService.class).get();gate=new ControlState(new ControlStateTest.Memory());long epoch=gate.resumeExplicitly();
            bridge=DisplayBridge.get(context);ReflectionHelpers.setField(bridge,"rear",Tunnel.json("available",true,"displayId",7));bridge.setRearProgressEnabled(true);bridge.setRearShowing(true);bridge.setLockedExecutionAllowed(true);
            tunnel=new Tunnel(null,gate,()->{});client=new GatewayClient(tunnel,(SSLContext)null);mac=Shadow.extract(client);
            long elapsed=SystemClock.elapsedRealtime();assertTrue(elapsed>0);snapshot=RearApprovalTest.snapshot(elapsed,System.currentTimeMillis(),epoch);
            scope=RearApprovalTest.card(snapshot,elapsed,System.currentTimeMillis()).scope();mac.detail=RearApprovalTest.detail(scope);
            ReflectionHelpers.setField(service,"gate",gate);ReflectionHelpers.setField(service,"gateway",client);ReflectionHelpers.setField(service,"tunnel",tunnel);
            ReflectionHelpers.setField(service,"paired",true);ReflectionHelpers.setField(service,"displayBridge",bridge);
            ReflectionHelpers.setField(service,"displayExecutor",new DisplayExecutor(gate,bridge,()->"fixture-device",System::currentTimeMillis,()->false));
            ReflectionHelpers.setField(service,"cachedState",snapshot.getJSONObject("state"));ReflectionHelpers.setField(service,"lastAuthenticatedAt",elapsed);ReflectionHelpers.setField(service,"stateSyncedAtElapsedMs",elapsed);
            KeyguardManager keyguard=service.getSystemService(KeyguardManager.class);Shadows.shadowOf(keyguard).setKeyguardLocked(false);ReflectionHelpers.setField(service,"keyguard",keyguard);
            workers=ReflectionHelpers.getField(service,"workers");workers.connection.execute(()->{try{freezeTick.await();}catch(InterruptedException e){Thread.currentThread().interrupt();}});
        }
        CompletableFuture<Result> decide(boolean allow){CompletableFuture<Result> result=new CompletableFuture<>();service.approvalFromRear(scope,allow,(value,error)->result.complete(new Result(value,error)));return result;}
        Result details()throws Exception{CompletableFuture<Result> result=new CompletableFuture<>();service.rearApprovalDetails(scope,(value,error)->result.complete(new Result(value,error)));return result.get(5,TimeUnit.SECONDS);}
        @Override public void close(){service.onDestroy();freezeTick.countDown();ReflectionHelpers.setStaticField(DisplayBridge.class,"instance",null);}
    }
    static CountDownLatch block(ExecutorService worker)throws Exception{CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);worker.execute(()->{entered.countDown();try{release.await();}catch(InterruptedException e){Thread.currentThread().interrupt();}});assertTrue(entered.await(5,TimeUnit.SECONDS));return release;}
    @Test public void allowAndRejectEachSendOneExactDecisionWithoutResuming()throws Exception{
        for(boolean allow:new boolean[]{true,false})try(Fixture f=new Fixture()){
            assertNull(f.details().error());CompletableFuture<Result> first=f.decide(allow),duplicate=f.decide(!allow);
            assertNull(first.get(5,TimeUnit.SECONDS).error());assertNotNull(duplicate.get(5,TimeUnit.SECONDS).error());
            assertEquals(1,f.mac.decisions.size());JSONObject sent=f.mac.decisions.get(0);
            assertEquals(allow,sent.getBoolean("allow"));assertEquals(f.scope.fingerprint(),sent.getString("fingerprint"));assertEquals(f.scope.controlEpoch(),sent.getLong("controlEpoch"));
            assertEquals(f.scope.controlEpoch(),f.gate.epoch());assertFalse(f.gate.paused());assertFalse(f.mac.paths.contains("/v1/device/control"));
        }
    }
    @Test public void queuedDecisionCannotBorrowAResumeAfterStop()throws Exception{
        try(Fixture f=new Fixture()){
            CountDownLatch release=block(f.workers.control);CompletableFuture<Result> reply=f.decide(true);
            f.gate.pause("rear_stop");long resumed=f.gate.resumeExplicitly();release.countDown();
            assertNotNull(reply.get(5,TimeUnit.SECONDS).error());assertTrue(f.mac.decisions.isEmpty());assertTrue(f.gate.permitsData(resumed));
        }
    }
    @Test public void queuedDecisionCannotSurviveConnectionOrRearVisibilityReplacement()throws Exception{
        for(String change:new String[]{"gateway","tunnel","binding","unpaired","hidden","disabled"})try(Fixture f=new Fixture()){
            CountDownLatch release=block(f.workers.control);CompletableFuture<Result> reply=f.decide(false);
            switch(change){
                case "gateway"->ReflectionHelpers.setField(f.service,"gateway",new GatewayClient(f.tunnel,(SSLContext)null));
                case "tunnel"->ReflectionHelpers.setField(f.service,"tunnel",new Tunnel(null,f.gate,()->{}));
                case "binding"->ReflectionHelpers.setField(f.service,"binding",new Binding(new BindingTest().good(),false));
                case "unpaired"->ReflectionHelpers.setField(f.service,"paired",false);
                case "hidden"->{f.bridge.setRearShowing(false);f.bridge.setRearShowing(true);}
                case "disabled"->f.bridge.setRearProgressEnabled(false);
            }
            release.countDown();assertNotNull(change,reply.get(5,TimeUnit.SECONDS).error());assertTrue(change,f.mac.decisions.isEmpty());
        }
    }
    @Test public void pausedOrOfflineRequestDoesNotEnterTheControlQueue()throws Exception{
        for(boolean pause:new boolean[]{true,false})try(Fixture f=new Fixture()){
            if(pause)f.gate.pause("rear_stop");else ReflectionHelpers.setField(f.service,"lastAuthenticatedAt",0L);
            long epoch=f.gate.epoch();assertNotNull(f.decide(true).get(5,TimeUnit.SECONDS).error());assertEquals(epoch,f.gate.epoch());assertTrue(f.mac.decisions.isEmpty());
        }
    }
    @Test public void detailsFromChangedRequestOrLateHiddenReadAreRejected()throws Exception{
        try(Fixture f=new Fixture()){
            f.mac.detail.getJSONArray("approvals").getJSONObject(0).put("fingerprint","b".repeat(64));assertNotNull(f.details().error());
            f.mac.detail=RearApprovalTest.detail(f.scope);f.mac.duringRead=()->{f.bridge.setRearShowing(false);f.bridge.setRearShowing(true);};assertNotNull(f.details().error());
        }
    }
    @Test public void lostAllowReceiptPausesAndIsNeverAutomaticallyRetried()throws Exception{
        try(Fixture f=new Fixture()){
            f.mac.loseReply=true;assertNotNull(f.decide(true).get(5,TimeUnit.SECONDS).error());
            f.workers.control.submit(()->{}).get(5,TimeUnit.SECONDS);
            assertTrue(f.gate.paused());assertTrue(f.gate.epoch()>f.scope.controlEpoch());assertEquals(1,f.mac.decisions.size());
            assertNotNull(f.decide(true).get(5,TimeUnit.SECONDS).error());assertEquals(1,f.mac.decisions.size());
        }
    }
    @Test public void lockedBackgroundApprovalWorksButLockedMainModeDoesNot()throws Exception{
        for(boolean background:new boolean[]{true,false})try(Fixture f=new Fixture()){
            Shadows.shadowOf(f.service.getSystemService(KeyguardManager.class)).setKeyguardLocked(true);f.bridge.setLockedExecutionAllowed(background);
            Result result=f.decide(false).get(5,TimeUnit.SECONDS);
            assertEquals(background,result.error()==null);assertEquals(background?1:0,f.mac.decisions.size());
        }
    }
    @Test public void acceptedReceiptCannotBecomeFailureWhenFollowupRefreshIsShuttingDown()throws Exception{
        try(Fixture f=new Fixture()){
            f.workers.connection.shutdown();java.util.concurrent.atomic.AtomicInteger callbacks=new java.util.concurrent.atomic.AtomicInteger();
            CompletableFuture<Result> reply=new CompletableFuture<>();
            f.service.approvalFromRear(f.scope,true,(value,error)->{callbacks.incrementAndGet();reply.complete(new Result(value,error));});
            assertNull(reply.get(5,TimeUnit.SECONDS).error());f.workers.control.submit(()->{}).get(5,TimeUnit.SECONDS);
            assertEquals(1,callbacks.get());assertFalse(f.gate.paused());assertEquals(1,f.mac.decisions.size());
            assertEquals("accepted",f.service.snapshot().getJSONObject("approvalRequests").getJSONObject(f.scope.approvalId()).getString("status"));
        }
    }

}
