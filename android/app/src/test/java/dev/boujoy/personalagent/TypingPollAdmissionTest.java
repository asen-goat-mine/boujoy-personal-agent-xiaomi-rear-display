package dev.boujoy.personalagent;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import javax.net.ssl.SSLContext;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadow.api.Shadow;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;

/** Real ConnectionService typing loop; the IME boundary records permits without entering text. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,shadows={TypingPollAdmissionTest.OnlineTunnel.class,TypingPollAdmissionTest.Mac.class,TypingPollAdmissionTest.Editor.class})
public class TypingPollAdmissionTest {
    @Implements(value=Tunnel.class,isInAndroidSdk=false)
    public static class OnlineTunnel {
        boolean online=true;
        @Implementation protected boolean connected(){return online;}
    }
    interface Hook {void run()throws Exception;}
    @Implements(value=GatewayClient.class,isInAndroidSdk=false)
    public static class Mac {
        static final AtomicInteger polls=new AtomicInteger();
        static JSONObject job;
        static Hook beforeReply=()->{};
        final List<JSONObject> receipts=new ArrayList<>();
        @Implementation protected JSONObject pollTyping()throws Exception {
            if(polls.incrementAndGet()>1)throw new InterruptedException("one-poll fixture complete");
            beforeReply.run();return new JSONObject().put("job",job);
        }
        @Implementation protected JSONObject json(String method,String path,JSONObject request,boolean control) {
            assertEquals("POST",method);assertEquals("/v1/device/typing",path);assertTrue(control);
            receipts.add(request);return new JSONObject();
        }
    }
    @Implements(value=BoujoyTypingService.class,isInAndroidSdk=false)
    public static class Editor {
        record Call(String operation,long epoch,BooleanSupplier allowed,boolean wouldCommit){}
        static final List<Call> calls=new ArrayList<>();
        static Runnable beforeCommit=()->{};
        @Implementation protected static BoujoyTypingService.Outcome perform(String operation,String text,String mode,String pkg,String reference,long epoch,BooleanSupplier allowed) {
            beforeCommit.run();boolean accepted=allowed.getAsBoolean();calls.add(new Call(operation,epoch,allowed,accepted));
            return new BoujoyTypingService.Outcome(accepted?"typed":"failed",accepted?"isolated_boundary":"control_paused");
        }
    }
    private ConnectionService service;
    private ControlStateTest.Memory storage;
    private ControlState gate;
    private Tunnel tunnel;
    private GatewayClient gateway;
    private Mac mac;
    @Before public void setup()throws Exception {
        service=Robolectric.buildService(ConnectionService.class).get();
        storage=new ControlStateTest.Memory();gate=new ControlState(storage);gate.resumeExplicitly();
        tunnel=new Tunnel(null,gate,()->{});gateway=new GatewayClient(tunnel,(SSLContext)null);mac=Shadow.extract(gateway);
        ReflectionHelpers.setField(service,"gate",gate);ReflectionHelpers.setField(service,"tunnel",tunnel);
        ReflectionHelpers.setField(service,"gateway",gateway);ReflectionHelpers.setField(service,"binding",binding("device-a"));
        ReflectionHelpers.setField(service,"paired",true);
        Mac.polls.set(0);Mac.beforeReply=()->{};
        Mac.job=new JSONObject().put("id","typing-a").put("text","isolated test only").put("mode","replace").put("packageName","dev.boujoy.test");
        Editor.calls.clear();Editor.beforeCommit=()->{};
    }
    private Binding binding(String id)throws Exception {
        return new Binding(new JSONObject().put("edition",BuildConfig.EDITION).put("androidApplicationId",BuildConfig.APPLICATION_ID).put("relayUrl","wss://relay.example.test/v1/tunnel").put("deviceId",id)
                .put("routeToken","x".repeat(32)).put("gatewayPin","sha256/"+"a".repeat(43)+"="),false);
    }
    private void runOnePoll()throws Exception {
        AtomicReference<Throwable> error=new AtomicReference<>();
        Thread loop=new Thread(()->{
            try{ReflectionHelpers.callInstanceMethod(service,"typingLoop");}catch(Throwable failure){error.set(failure);}
        },"typing-admission-fixture");
        loop.start();loop.join(1_000);
        // A rejected paused/disconnected reply reaches the loop's normal one-second idle
        // wait. Interrupt that wait only; no test marks the service destroyed before admission.
        if(loop.isAlive()){loop.interrupt();loop.join(3_000);}
        assertFalse("The one-poll fixture must exit",loop.isAlive());
        if(error.get()!=null)throw new AssertionError("typing loop failed",error.get());
        assertTrue("The actual polling path must have run",Mac.polls.get()>=1);
    }
    @After public void cleanup(){service.onDestroy();}

    @Test public void ordinaryEpochlessJobUsesThePollStartAdmission()throws Exception {
        long admitted=gate.epoch();assertFalse(Mac.job.has("controlEpoch"));runOnePoll();
        assertEquals(1,Editor.calls.size());Editor.Call call=Editor.calls.get(0);
        assertEquals("type",call.operation());assertEquals(admitted,call.epoch());assertTrue(call.wouldCommit());
        assertEquals(1,mac.receipts.size());assertEquals("typed",mac.receipts.get(0).getString("status"));
    }
    @Test public void oldEpochlessPollCannotBorrowAResumeWhichOccurredWhileItWasWaiting()throws Exception {
        long before=gate.epoch();Mac.beforeReply=()->{gate.pause("explicit_stop");gate.resumeExplicitly();};runOnePoll();
        assertTrue(gate.epoch()>before);assertFalse(gate.paused());
        assertTrue("A stale poll must not reach the IME boundary",Editor.calls.isEmpty());assertTrue(mac.receipts.isEmpty());
    }
    @Test public void replacementBindingCannotReceiveTheOldPollEvenAtTheSameControlEpoch()throws Exception {
        Binding replacement=binding("device-b");long before=gate.epoch();
        Mac.beforeReply=()->ReflectionHelpers.setField(service,"binding",replacement);runOnePoll();
        assertEquals(before,gate.epoch());assertTrue(Editor.calls.isEmpty());assertTrue(mac.receipts.isEmpty());
    }
    @Test public void replacementTransportCannotReceiveTheOldPoll()throws Exception {
        Tunnel replacement=new Tunnel(null,gate,()->{});GatewayClient client=new GatewayClient(replacement,(SSLContext)null);
        Mac.beforeReply=()->{ReflectionHelpers.setField(service,"tunnel",replacement);ReflectionHelpers.setField(service,"gateway",client);};
        runOnePoll();assertTrue(Editor.calls.isEmpty());assertTrue(mac.receipts.isEmpty());
    }
    @Test public void explicitMismatchingOrMalformedEpochDoesNotReachTheIme()throws Exception {
        for(Object epoch:new Object[]{gate.epoch()-1,gate.epoch()+1,"invalid",JSONObject.NULL}) {
            Mac.polls.set(0);Mac.job.put("controlEpoch",epoch);runOnePoll();
            assertTrue(Editor.calls.isEmpty());assertTrue(mac.receipts.isEmpty());
        }
    }
    @Test public void delayedImePermitKeepsBothItsEpochAndBindingIdentity()throws Exception {
        runOnePoll();BooleanSupplier allowed=Editor.calls.get(0).allowed();assertTrue(allowed.getAsBoolean());
        ReflectionHelpers.setField(service,"binding",binding("device-b"));
        assertFalse("A queued editor callback cannot follow a changed binding",allowed.getAsBoolean());
    }
    @Test public void delayedImePermitCannotReviveAfterStopAndResume()throws Exception {
        runOnePoll();BooleanSupplier allowed=Editor.calls.get(0).allowed();
        gate.pause("rear_stop");assertFalse(allowed.getAsBoolean());gate.resumeExplicitly();assertFalse(allowed.getAsBoolean());
    }
    @Test public void stopWriteFailureStillRevokesTheQueuedImePermit()throws Exception {
        runOnePoll();BooleanSupplier allowed=Editor.calls.get(0).allowed();storage.fail=true;
        assertThrows(IllegalStateException.class,()->gate.pause("explicit_stop"));
        assertTrue(gate.paused());assertFalse(allowed.getAsBoolean());
    }
    @Test public void bindingChangeInsideDelayedEditorDeliveryBlocksCommitAndOldReceipt()throws Exception {
        Binding replacement=binding("device-b");
        Editor.beforeCommit=()->ReflectionHelpers.setField(service,"binding",replacement);
        runOnePoll();assertEquals(1,Editor.calls.size());assertFalse(Editor.calls.get(0).wouldCommit());assertTrue(mac.receipts.isEmpty());
    }
    @Test public void disconnectBeforeDelayedEditorDeliveryRevokesThePermit()throws Exception {
        runOnePoll();BooleanSupplier allowed=Editor.calls.get(0).allowed();
        OnlineTunnel state=Shadow.extract(tunnel);state.online=false;assertFalse(allowed.getAsBoolean());
    }
}
