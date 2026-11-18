package dev.boujoy.personalagent;

import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

/** Actual executor, accessibility collection and node actions; only the shell backend is simulated. */
@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class DisplayNodeEffectBarrierTest {
    private static class Memory implements ControlState.Storage {
        long epoch;boolean paused;
        public long epoch(){return epoch;}public boolean paused(){return paused;}
        public void save(long value,boolean flag){epoch=value;paused=flag;}
    }
    private final List<String> order=new ArrayList<>();
    private class Backend implements DisplayExecutor.Backend {
        volatile JSONObject session;
        int barriers,nodeActions,captures;boolean failBarrier,blockCapture;
        Runnable duringBarrier;
        final CountDownLatch captureEntered=new CountDownLatch(1),captureRelease=new CountDownLatch(1);
        public JSONObject status(){return Tunnel.json("shizuku","running","userService",true);}
        public JSONObject session(){return session;}
        public JSONObject open(JSONObject args){return session=Tunnel.json("sessionId","node-session","generation",1,"displayId",7,"width",720,"height",1280,"densityDpi",320);}
        public void close(){session=null;}
        public JSONArray listApps(){return new JSONArray();}
        public JSONObject effect(String op,JSONObject args,BooleanSupplier allowed){throw new AssertionError("node actions must use AccessibilityNodeInfo");}
        public void markContentChanged()throws Exception {
            barriers++;order.add("barrier");
            if(failBarrier)throw new java.io.IOException("fixture barrier unavailable");
            if(duringBarrier!=null)duringBarrier.run();
        }
        public JSONObject screenshot(int max){
            captures++;long now=System.currentTimeMillis();
            return Tunnel.json("available",true,"started_at_ms",now,"finished_at_ms",now,"width",720,"height",1280,
                    "scale_x",1,"scale_y",1,"offset_x",0,"offset_y",0,"mime_type","image/jpeg","data_base64","/9j/2Q==");
        }
        public JSONObject screenshot(int max,BooleanSupplier allowed)throws Exception {
            assertTrue("capture initially admitted",allowed.getAsBoolean());captureEntered.countDown();
            if(blockCapture&&!captureRelease.await(3,TimeUnit.SECONDS))throw new AssertionError("capture fixture timed out");
            if(!allowed.getAsBoolean())throw new DisplayExecutor.BackendException("LOCALLY_PAUSED",false);
            return screenshot(max);
        }
    }
    private BoujoyDisplayService service;
    private AccessibilityNodeInfo node;
    private Backend backend;
    private DisplayExecutor executor;
    private ControlState gate;
    private int sequence;
    @Before public void setup()throws Exception {
        BoujoyDisplayService.setLifecycleListener(null);
        service=DisplayAlgorithmFixture.connectedAccessibility();
        AccessibilityWindowInfo window=AccessibilityWindowInfo.obtain();
        Shadows.shadowOf(window).setDisplayId(7);Shadows.shadowOf(window).setId(123);
        Shadows.shadowOf(window).setType(AccessibilityWindowInfo.TYPE_APPLICATION);Shadows.shadowOf(window).setLayer(1);
        Shadows.shadowOf(window).setBoundsInScreen(new Rect(0,0,720,1280));
        Shadows.shadowOf(window).setActive(true);Shadows.shadowOf(window).setFocused(true);
        node=AccessibilityNodeInfo.obtain();node.setPackageName("test.app");node.setClassName("android.widget.EditText");
        node.setText("fixture");node.setEnabled(true);node.setVisibleToUser(true);node.setEditable(true);node.setScrollable(true);
        node.setBoundsInScreen(new Rect(0,0,720,1280));
        node.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_TEXT);
        node.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD);
        Shadows.shadowOf(node).setAccessibilityWindowInfo(window);Shadows.shadowOf(window).setRoot(node);
        Shadows.shadowOf(service).setWindowsOnDisplay(7,List.of(window));
        backend=new Backend();gate=new ControlState(new Memory());
        executor=new DisplayExecutor(gate,backend,()->"bound-device",System::currentTimeMillis,()->false);
        Shadows.shadowOf(node).setOnPerformActionListener((action,args)->{
            backend.nodeActions++;order.add("node:"+action);
            if(action==AccessibilityNodeInfo.ACTION_SET_TEXT)assertEquals("replacement",args.getCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE));
            return true;
        });
        assertTrue(executor.execute(command("session_open",new JSONObject())).has("session"));
    }
    @After public void cleanup(){backend.captureRelease.countDown();executor.close();service.onDestroy();BoujoyDisplayService.setLifecycleListener(null);}
    private JSONObject command(String op,JSONObject args){return Tunnel.json("id","node-"+(++sequence),"op",op,"controlEpoch",gate.epoch(),"deadlineAtMs",System.currentTimeMillis()+10000,"session",backend.session,"args",args);}
    private JSONObject nodeCommand(String op)throws Exception {
        JSONObject observed=executor.execute(command("observe",Tunnel.json("mode","tree"))).getJSONObject("observation");
        assertEquals("complete",observed.getString("observation_status"));
        return command(op,Tunnel.json("observation_id",observed.getString("observation_id"),"expected_window_id",123,
                "element_id","0","text","replacement","mode","replace","direction","forward"));
    }
    private void assertExecutedAfterBarrier(String op,int action)throws Exception {
        JSONObject result=executor.execute(nodeCommand(op)).getJSONObject("request");
        assertEquals("executed",result.getString("state"));assertTrue(result.getBoolean("action_executed"));
        assertEquals(List.of("barrier","node:"+action),order);assertEquals(1,backend.nodeActions);assertEquals(1,backend.barriers);
    }
    private void assertBarrierFailure(String op)throws Exception {
        JSONObject command=nodeCommand(op);backend.failBarrier=true;
        assertNotExecuted(executor.execute(command),"FRAME_BARRIER_UNAVAILABLE");
        assertEquals(List.of("barrier"),order);assertEquals(0,backend.nodeActions);
    }
    private void assertStopDuringBarrier(String op)throws Exception {
        JSONObject command=nodeCommand(op);backend.duringBarrier=()->{gate.pause("rear_stop");executor.invalidate("rear_stop");};
        assertNotExecuted(executor.execute(command),"LOCALLY_PAUSED");
        assertEquals(List.of("barrier"),order);assertEquals(0,backend.nodeActions);
    }
    private static void assertNotExecuted(JSONObject result,String code)throws Exception {
        JSONObject request=result.getJSONObject("request");assertEquals("failed",request.getString("state"));
        assertFalse(request.getBoolean("action_executed"));assertEquals(code,request.getJSONObject("error").getString("code"));
    }
    @Test public void textBarrierPrecedesActualNodeAction()throws Exception {assertExecutedAfterBarrier("input_text",AccessibilityNodeInfo.ACTION_SET_TEXT);}
    @Test public void scrollBarrierPrecedesActualNodeAction()throws Exception {assertExecutedAfterBarrier("scroll",AccessibilityNodeInfo.ACTION_SCROLL_FORWARD);}
    @Test public void textBarrierFailureNeverReachesNode()throws Exception {assertBarrierFailure("input_text");}
    @Test public void scrollBarrierFailureNeverReachesNode()throws Exception {assertBarrierFailure("scroll");}
    @Test public void textStopDuringBarrierNeverReachesNode()throws Exception {assertStopDuringBarrier("input_text");}
    @Test public void scrollStopDuringBarrierNeverReachesNode()throws Exception {assertStopDuringBarrier("scroll");}
    @Test public void captureStopRevokesPermitWithoutWaitingForCapture()throws Exception {
        backend.blockCapture=true;JSONObject command=command("observe",Tunnel.json("mode","screenshot"));
        AtomicReference<JSONObject> result=new AtomicReference<>();Thread capture=new Thread(()->result.set(executor.execute(command)));
        capture.start();
        try {
            assertTrue(backend.captureEntered.await(2,TimeUnit.SECONDS));long start=System.nanoTime();
            gate.pause("rear_stop");executor.invalidate("rear_stop");
            assertTrue("stop cannot wait behind screenshot",TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-start)<500);
        }finally{backend.captureRelease.countDown();capture.join(3000);}
        assertFalse("capture thread finished",capture.isAlive());assertNotNull(result.get());
        JSONObject observed=result.get().getJSONObject("observation");assertEquals("failed",observed.getString("observation_status"));
        assertEquals("LOCALLY_PAUSED",observed.getJSONObject("error").getString("code"));assertEquals(0,backend.captures);
    }
    @Test public void captureSessionReplacementRevokesPermit()throws Exception {
        backend.blockCapture=true;JSONObject command=command("observe",Tunnel.json("mode","screenshot"));
        AtomicReference<JSONObject> result=new AtomicReference<>();Thread capture=new Thread(()->result.set(executor.execute(command)));
        capture.start();
        try {
            assertTrue(backend.captureEntered.await(2,TimeUnit.SECONDS));
            backend.session=new JSONObject(backend.session.toString()).put("generation",2);
        }finally{backend.captureRelease.countDown();capture.join(3000);}
        assertFalse(capture.isAlive());assertNotNull(result.get());
        assertEquals("LOCALLY_PAUSED",result.get().getJSONObject("observation").getJSONObject("error").getString("code"));
        assertEquals(0,backend.captures);
    }
}
