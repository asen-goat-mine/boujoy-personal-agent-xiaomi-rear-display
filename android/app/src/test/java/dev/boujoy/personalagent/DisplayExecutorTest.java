package dev.boujoy.personalagent;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class DisplayExecutorTest {
    private static class Memory implements ControlState.Storage {
        long epoch;boolean paused;
        public long epoch(){return epoch;}public boolean paused(){return paused;}public void save(long e,boolean p){epoch=e;paused=p;}
    }
    private static class Backend implements DisplayExecutor.Backend {
        volatile JSONObject session,held,handoff;int opens,effects,abandons,idleHandoffs;String failure;boolean started;volatile boolean live=true;
        public JSONObject status(){return Tunnel.json("userService",live,"shizuku","running","features",new JSONArray().put("session_handoff"),"handoff",handoff);}
        public JSONObject session(){return session;}
        public JSONObject open(JSONObject args){if(held!=null){held=null;handoff=Tunnel.json("state","dismissed","reason","new_session");}opens++;session=Tunnel.json("sessionId","session-"+opens,"generation",opens,"displayId",7,"width",720,"height",1280,"densityDpi",320);return session;}
        public void close(){session=null;held=null;}
        public JSONObject handoff(JSONObject expected,JSONObject args,BooleanSupplier allowed)throws Exception {
            if(!allowed.getAsBoolean())throw new DisplayExecutor.BackendException("LOCALLY_PAUSED",false);
            held=session;session=null;handoff=Tunnel.json("handoffId","held-id","state","pending","taskId",args.getString("task_id"),"expiresAtMs",1801000);return handoff;
        }
        public void abandonHandoff(String reason){if(held!=null){held=null;handoff=Tunnel.json("state","dismissed","reason",reason);abandons++;}}
        public void idleHandoff(){idleHandoffs++;}
        public JSONObject screenshot(int max){return Tunnel.json("available",false);}
        public JSONArray listApps(){return new JSONArray();}
        public JSONObject effect(String op,JSONObject args,BooleanSupplier allowed)throws Exception {
            if(!allowed.getAsBoolean())throw new DisplayExecutor.BackendException("LOCALLY_PAUSED",false);
            effects++;if(failure!=null)throw new DisplayExecutor.BackendException(failure,started);return new JSONObject();
        }
    }
    private ControlState gate;private Backend backend;private DisplayExecutor executor;private BoujoyDisplayService service;private AtomicBoolean locked;
    @Before public void setup(){
        BoujoyDisplayService.setLifecycleListener(null);service=DisplayAlgorithmFixture.connectedAccessibility();
        gate=new ControlState(new Memory());backend=new Backend();locked=new AtomicBoolean();executor=new DisplayExecutor(gate,backend,()->"device",()->1000,locked::get);
    }
    @After public void cleanup(){executor.close();service.onDestroy();BoujoyDisplayService.setLifecycleListener(null);}
    private JSONObject command(String id,String op){return Tunnel.json("id",id,"op",op,"controlEpoch",gate.epoch(),"deadlineAtMs",2000,"session",backend.session,"args",new JSONObject());}
    private JSONObject open(){return executor.execute(command("open","session_open"));}
    private String error(JSONObject result)throws Exception {return result.getJSONObject("request").getJSONObject("error").getString("code");}
    @Test public void localPausePreventsCreationAndReconnectNeverReopens()throws Exception {
        gate.pause("rear_stop");assertEquals("LOCALLY_PAUSED",error(open()));gate.observeRemote(20,false);
        assertEquals("LOCALLY_PAUSED",error(executor.execute(command("another","session_open"))));assertEquals(0,backend.opens);
    }
    @Test public void expiredAndLockedCommandsNeverCreateDisplay()throws Exception {
        JSONObject expired=command("expired","session_open").put("deadlineAtMs",1000);assertEquals("EXPIRED",error(executor.execute(expired)));
        locked.set(true);assertEquals("LOCKED",error(open()));assertEquals(0,backend.opens);
    }
    @Test public void missingEpochIsNotBorrowedFromCurrentGate()throws Exception {
        JSONObject cmd=command("missing","session_open");cmd.remove("controlEpoch");assertEquals("LOCALLY_PAUSED",error(executor.execute(cmd)));assertEquals(0,backend.opens);
    }
    @Test public void duplicateLaunchIdCannotReplayAnEffect()throws Exception {
        assertTrue(open().has("session"));JSONObject launch=command("launch","launch_app").put("args",Tunnel.json("package_name","test.app"));
        assertEquals("executed",executor.execute(launch).getJSONObject("request").getString("state"));
        assertEquals("DUPLICATE_COMMAND",error(executor.execute(launch)));assertEquals(1,backend.effects);
    }
    @Test public void injectionUncertaintyIsNeverReportedFailedOrReplayed()throws Exception {
        open();backend.failure="INJECTION_TIMEOUT";backend.started=true;JSONObject launch=command("launch","launch_app").put("args",Tunnel.json("package_name","test.app"));
        JSONObject result=executor.execute(launch);assertEquals("unknown",result.getJSONObject("request").getString("state"));assertTrue(result.getJSONObject("request").getBoolean("action_executed"));
        executor.execute(launch);assertEquals(1,backend.effects);
    }
    @Test public void provenPreInjectionFailureMayReportNotExecuted()throws Exception {
        open();backend.failure="PACKAGE_MISSING";backend.started=false;
        JSONObject result=executor.execute(command("launch","launch_app").put("args",Tunnel.json("package_name","test.app")));
        assertEquals("failed",result.getJSONObject("request").getString("state"));assertFalse(result.getJSONObject("request").getBoolean("action_executed"));
    }
    @Test public void invalidatedSessionRejectsAlreadyFetchedCommand()throws Exception {
        open();JSONObject launch=command("launch","launch_app").put("args",Tunnel.json("package_name","test.app"));executor.invalidate("service_disconnected");
        assertEquals("SESSION_STALE",error(executor.execute(launch)));assertEquals(0,backend.effects);
    }
    @Test public void mainDisplayIsNeverAcceptedAsASession()throws Exception {
        open();JSONObject cmd=command("launch","launch_app").put("session",Tunnel.json("sessionId","session-1","generation",1,"displayId",0)).put("args",Tunnel.json("package_name","test.app"));
        assertEquals("SESSION_STALE",error(executor.execute(cmd)));assertEquals(0,backend.effects);
    }
    @Test public void homeAndRecentsAreExplicitlyUnsupported()throws Exception {
        open();assertEquals("UNSUPPORTED_ON_DISPLAY",error(executor.execute(command("home","home"))));
        assertEquals("UNSUPPORTED_ON_DISPLAY",error(executor.execute(command("recents","recents"))));assertEquals(0,backend.effects);
    }
    @Test public void invalidationDoesNotWaitBehindAnInFlightBinderCall()throws Exception {
        executor.close();CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);AtomicBoolean permittedAfterStop=new AtomicBoolean(true),blockSession=new AtomicBoolean();
        backend=new Backend(){
            @Override public JSONObject session(){if(blockSession.get())try{release.await(3,TimeUnit.SECONDS);}catch(InterruptedException e){Thread.currentThread().interrupt();}return session;}
            @Override public JSONObject effect(String op,JSONObject args,BooleanSupplier allowed)throws Exception {
            blockSession.set(true);entered.countDown();release.await(3,TimeUnit.SECONDS);permittedAfterStop.set(allowed.getAsBoolean());throw new DisplayExecutor.BackendException("ACTION_UNCONFIRMED",true);
        }};
        executor=new DisplayExecutor(gate,backend,()->"device",()->1000,locked::get);open();
        JSONObject cmd=command("launch","launch_app").put("args",Tunnel.json("package_name","test.app"));Thread work=new Thread(()->executor.execute(cmd));work.start();
        assertTrue(entered.await(2,TimeUnit.SECONDS));long start=System.nanoTime();gate.pause("rear_stop");executor.invalidate("rear_stop");
        assertTrue("invalidation must not wait for binder",TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-start)<500);release.countDown();work.join(3000);assertFalse(permittedAfterStop.get());
    }
    @Test public void lifecycleLossRevokesIdentityEvenIfSameCachedSessionReappears()throws Exception {
        executor.reconcileLifecycle();assertTrue(open().has("session"));
        JSONObject original=backend.session;JSONObject launch=command("launch-after-loss","launch_app").put("args",Tunnel.json("package_name","test.app"));
        backend.session=null;executor.reconcileLifecycle();backend.session=original;
        assertEquals("SESSION_STALE",error(executor.execute(launch)));assertEquals(0,backend.effects);
    }

    @Test public void activeTaskOnlyComesFromAdmittedSessionCommands()throws Exception {
        assertEquals("",executor.activeTaskId());
        assertTrue(executor.execute(command("task-open","session_open").put("taskId","task-a")).has("session"));
        assertEquals("task-a",executor.activeTaskId());
        executor.execute(command("status","status").put("taskId","unrelated-status"));
        executor.execute(command("expired-observe","observe").put("taskId","expired").put("deadlineAtMs",1000));
        executor.execute(command("stale-observe","observe").put("taskId","stale")
                .put("session",Tunnel.json("sessionId","other","generation",1,"displayId",7)));
        executor.execute(command("unsupported","home").put("taskId","unsupported"));
        executor.execute(command("bad-observe","observe").put("taskId","bad-args").put("args",Tunnel.json("mode","invalid")));
        assertEquals("task-a",executor.activeTaskId());
        backend.failure="PACKAGE_MISSING";backend.started=false;
        executor.execute(command("accepted-launch","launch_app").put("taskId","task-b").put("args",Tunnel.json("package_name","test.app")));
        assertEquals("task-b",executor.activeTaskId());
    }
    @Test public void activeTaskIsBoundToAllSessionIdentityFieldsAndNeverRevivesFromCache()throws Exception {
        for(String field:new String[]{"sessionId","generation","displayId"}){
            executor.execute(command("open-"+field,"session_open").put("taskId","task-"+field));
            assertEquals("task-"+field,executor.activeTaskId());
            JSONObject original=backend.session;
            backend.session=new JSONObject(original.toString()).put(field,"sessionId".equals(field)?"replacement":original.getInt(field)+1);
            assertEquals("",executor.activeTaskId());
            backend.session=original;assertEquals("",executor.activeTaskId());
        }
    }
    @Test public void tasklessSessionCommandsClearAssociationAndCloseOrInvalidateCannotRetainIt()throws Exception {
        executor.execute(command("open-a","session_open").put("taskId","task-a"));
        executor.execute(command("taskless-observe","observe").put("taskId",JSONObject.NULL));
        assertEquals("",executor.activeTaskId());
        executor.execute(command("open-b","session_open").put("taskId","task-b"));
        executor.execute(command("close-b","session_close"));assertEquals("",executor.activeTaskId());
        executor.execute(command("open-c","session_open").put("taskId","task-c"));
        assertEquals("task-c",executor.activeTaskId());
        executor.invalidate("rear_stop");assertEquals("",executor.activeTaskId());
    }
    @Test public void localPauseHidesActiveTaskBeforeLifecycleCleanup()throws Exception {
        executor.execute(command("open-a","session_open").put("taskId","task-a"));
        gate.pause("rear_stop");assertEquals("",executor.activeTaskId());
    }

    private JSONObject handoffCommand(String id)throws Exception {
        return command(id,"session_handoff").put("args",Tunnel.json("task_id","task-a","title","请处理","summary","页面已准备好"));
    }
    @Test public void handoffImmediatelyRevokesMacSessionAndRetainsDisplayWithoutEffects()throws Exception {
        open();JSONObject old=backend.session;JSONObject stale=command("old-launch","launch_app").put("args",Tunnel.json("package_name","test.app"));
        JSONObject result=executor.execute(handoffCommand("handoff"));assertEquals("pending",result.getJSONObject("handoff").getString("state"));
        assertNull(backend.session);assertSame(old,backend.held);assertEquals(0,backend.effects);assertEquals("",executor.activeTaskId());
        assertEquals("SESSION_STALE",error(executor.execute(stale)));
        JSONObject observation=executor.execute(command("old-observe","observe").put("session",old));
        assertEquals("SESSION_STALE",observation.getJSONObject("observation").getJSONObject("error").getString("code"));
        assertTrue(executor.status().isNull("session"));assertEquals("session_handoff",executor.status().getJSONArray("features").getString(0));
    }
    @Test public void explicitStopClosesHeldPageEvenWithoutAnActiveMacSession()throws Exception {
        open();executor.execute(handoffCommand("handoff"));gate.pause("rear_stop");executor.invalidate("rear_stop");
        assertNull(backend.held);assertEquals(1,backend.abandons);assertEquals("rear_stop",backend.handoff.getString("reason"));
    }
    @Test public void newOpenDismissesHeldPageAndUsesNewGeneration()throws Exception {
        open();JSONObject old=backend.session;executor.execute(handoffCommand("handoff"));
        JSONObject next=executor.execute(command("new-open","session_open")).getJSONObject("session");
        assertTrue(next.getLong("generation")>old.getLong("generation"));assertNull(backend.held);
        assertEquals("new_session",backend.handoff.getString("reason"));
    }
    @Test public void invalidHandoffDoesNotRevokeValidSession()throws Exception {
        open();JSONObject old=backend.session;
        JSONObject bad=handoffCommand("invalid");bad.getJSONObject("args").put("title","x".repeat(41));
        assertEquals("INVALID_ARGUMENT",error(executor.execute(bad)));assertSame(old,backend.session);assertNull(backend.held);
    }
    @Test public void heldMaintenanceRunsWithoutAMacSession()throws Exception {
        open();executor.execute(handoffCommand("handoff"));executor.idleTick();assertEquals(1,backend.idleHandoffs);assertNotNull(backend.held);
    }

}
