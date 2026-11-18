package dev.boujoy.personalagent;

import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;
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

/** Real Android serializer output is consumed by the repository's real Node validator. */
@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class DisplayObservationInteropTest {
    private BoujoyDisplayService service;
    private AccessibilityWindowInfo window;
    private AccessibilityNodeInfo root;
    private DisplayExecutor executor;
    private Backend backend;
    private ControlState gate;
    private int command;
    private static class Memory implements ControlState.Storage {
        long epoch;boolean paused;public long epoch(){return epoch;}public boolean paused(){return paused;}
        public void save(long value,boolean flag){epoch=value;paused=flag;}
    }
    private static class Backend implements DisplayExecutor.Backend {
        JSONObject session;boolean noFrame;int effects;Runnable duringScreenshot;
        public JSONObject status(){return Tunnel.json("shizuku","running","userService",true);}
        public JSONObject session(){return session;}
        public JSONObject open(JSONObject args){return session=Tunnel.json("sessionId","session-wire","generation",1,"displayId",7,"width",720,"height",1280,"densityDpi",320);}
        public void close(){session=null;}
        public JSONArray listApps(){return new JSONArray();}
        public JSONObject effect(String op,JSONObject args,BooleanSupplier allowed){effects++;return new JSONObject();}
        public JSONObject screenshot(int max)throws Exception {
            if(noFrame)throw new DisplayExecutor.BackendException("NO_FRAME",false);
            if(duringScreenshot!=null)duringScreenshot.run();
            long now=System.currentTimeMillis();
            return Tunnel.json("available",true,"started_at_ms",now,"finished_at_ms",now,"width",720,"height",1280,
                    "scale_x",1,"scale_y",1,"offset_x",0,"offset_y",0,"mime_type","image/jpeg","data_base64","/9j/2Q==");
        }
    }
    @Before public void setup()throws Exception {
        BoujoyDisplayService.setLifecycleListener(null);
        service=DisplayAlgorithmFixture.connectedAccessibility();
        window=AccessibilityWindowInfo.obtain();
        Shadows.shadowOf(window).setDisplayId(7);Shadows.shadowOf(window).setId(123);Shadows.shadowOf(window).setType(AccessibilityWindowInfo.TYPE_APPLICATION);
        Shadows.shadowOf(window).setLayer(5);Shadows.shadowOf(window).setActive(true);Shadows.shadowOf(window).setFocused(true);
        Shadows.shadowOf(window).setBoundsInScreen(new Rect(0,0,720,1280));
        root=node("android.widget.LinearLayout","Background content");Shadows.shadowOf(window).setRoot(root);
        Shadows.shadowOf(service).setWindowsOnDisplay(7,List.of(window));
        // The primary display exists and has content; the production serializer must not include it.
        AccessibilityWindowInfo primary=AccessibilityWindowInfo.obtain();Shadows.shadowOf(primary).setDisplayId(0);Shadows.shadowOf(primary).setId(999);
        AccessibilityNodeInfo secret=AccessibilityNodeInfo.obtain();secret.setText("MAIN_DISPLAY_PRIVATE");Shadows.shadowOf(primary).setRoot(secret);
        Shadows.shadowOf(service).setWindowsOnDisplay(0,List.of(primary));
        backend=new Backend();gate=new ControlState(new Memory());executor=new DisplayExecutor(gate,backend,()->"bound-boujoy-device",System::currentTimeMillis,()->false);
        assertTrue(executor.execute(cmd("session_open",new JSONObject())).has("session"));
    }
    @After public void cleanup(){executor.close();service.onDestroy();BoujoyDisplayService.setLifecycleListener(null);}
    private AccessibilityNodeInfo node(String className,String text){
        AccessibilityNodeInfo node=AccessibilityNodeInfo.obtain();node.setClassName(className);node.setText(text);node.setPackageName("test.app");
        node.setEnabled(true);node.setVisibleToUser(true);node.setBoundsInScreen(new Rect(0,0,720,1280));
        Shadows.shadowOf(node).setAccessibilityWindowInfo(window);return node;
    }
    private JSONObject cmd(String op,JSONObject args){return Tunnel.json("id","wire-"+(++command),"op",op,"controlEpoch",gate.epoch(),"deadlineAtMs",System.currentTimeMillis()+10000,"session",backend.session,"args",args);}
    private JSONObject observe(String mode)throws Exception{return executor.execute(cmd("observe",Tunnel.json("mode",mode,"max_dimension",1440))).getJSONObject("observation");}
    @Test public void androidWireOutputPassesActualNodeValidator()throws Exception {
        AccessibilityNodeInfo unknown=node("","unknown native type");Shadows.shadowOf(root).addChild(unknown);
        AccessibilityNodeInfo edit=node("android.widget.EditText","fixture text");edit.setEditable(true);edit.setFocused(true);edit.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_TEXT);Shadows.shadowOf(root).addChild(edit);
        JSONObject observation=observe("both");assertEquals("complete",observation.getString("observation_status"));
        assertEquals(1,observation.getJSONArray("windows").getJSONObject(0).getInt("type"));
        assertTrue(observation.getJSONObject("tree").getJSONArray("elements").getJSONObject(1).isNull("class"));
        assertFalse(observation.toString().contains("MAIN_DISPLAY_PRIVATE"));
        assertNodeAccepts(observation,3,false);
    }
    private void assertNodeAccepts(JSONObject observation,int expectedNodes,boolean partial)throws Exception {
        Path repo=Path.of(System.getProperty("user.dir")).toAbsolutePath();while(repo!=null&&!Files.exists(repo.resolve("src/adapters/phoneuse-state.mjs")))repo=repo.getParent();
        assertNotNull("real Node source required",repo);
        String script="""
                import {readFileSync} from 'node:fs';
                import {pathToFileURL} from 'node:url';
                const {normalizePhoneUseObservation}=await import(pathToFileURL(process.argv[1]).href);
                const raw=JSON.parse(readFileSync(0,'utf8'));
                const result=normalizePhoneUseObservation(raw,{displaySession:raw.display_session,now:raw.captured_at_ms,requireScreenshot:raw.screenshot.available===true});
                if(result.native.elements.length!==Number(process.argv[2])||result.native.windows[0].type!==1||result.native.treePartial!==(process.argv[3]==='true'))throw Error('Android wire mismatch');
                console.log(JSON.stringify({accepted:true,nodes:result.native.elements.length,displayId:result.native.display.id,treePartial:result.native.treePartial}));
                """;
        Process process=new ProcessBuilder(System.getenv().getOrDefault("BOUJOY_NODE_BINARY","node"),"--input-type=module","-e",script,repo.resolve("src/adapters/phoneuse-state.mjs").toString(),String.valueOf(expectedNodes),String.valueOf(partial)).redirectErrorStream(true).start();
        try(OutputStream input=process.getOutputStream()){input.write(observation.toString().getBytes(StandardCharsets.UTF_8));}
        assertTrue("Node validator timed out",process.waitFor(15,TimeUnit.SECONDS));String output=new String(process.getInputStream().readAllBytes(),StandardCharsets.UTF_8);
        assertEquals(output,0,process.exitValue());assertTrue(output,output.contains("\"accepted\":true"));
        String outputDirectory=System.getProperty("boujoy.visual.output");
        if(outputDirectory!=null){Path artifact=Path.of(outputDirectory,partial?"display-partial-wire-fixture.json":"display-wire-fixture.json");Files.createDirectories(artifact.getParent());Files.write(artifact,observation.toString(2).getBytes(StandardCharsets.UTF_8));Files.write(artifact.resolveSibling(partial?"display-partial-wire-validator-result.json":"display-wire-validator-result.json"),output.getBytes(StandardCharsets.UTF_8));}
    }
    @Test public void nodeLimitIs1500AndTruncatedTreeCannotBecomeAnObservation()throws Exception {
        for(int i=0;i<1500;i++)Shadows.shadowOf(root).addChild(node("android.widget.TextView","row "+i));
        try(BoujoyDisplayService.Frame frame=BoujoyDisplayService.snapshot(7,true)){
            assertEquals(1500,frame.tree.getInt("output_nodes"));assertEquals(1500,frame.tree.getInt("collected_nodes"));
            assertTrue(frame.tree.getBoolean("collection_truncated"));assertTrue(frame.tree.getBoolean("truncated"));assertFalse(frame.tree.getBoolean("collection_complete"));
            assertEquals(1,frame.tree.getJSONObject("diagnostics").getInt("node_limit_hits"));
            assertEquals(0,frame.tree.getJSONObject("diagnostics").getInt("depth_limit_hits"));
        }
        JSONObject result=observe("tree");assertEquals("failed",result.getString("observation_status"));assertEquals("OBSERVATION_INCONSISTENT",result.getJSONObject("error").getString("code"));
        assertEquals(1,result.getJSONObject("diagnostics").getJSONObject("tree").getJSONObject("collection_counters").getInt("node_limit_hits"));
    }
    @Test public void inaccessibleChildIsIncompleteWithoutPretendingOutputWasTruncated()throws Exception {
        AccessibilityNodeInfo child=node("android.widget.TextView","external embedded content");child.setPackageName("other.app");Shadows.shadowOf(root).addChild(child);
        try(BoujoyDisplayService.Frame frame=BoujoyDisplayService.snapshot(7,true)){
            assertFalse(frame.tree.getBoolean("collection_complete"));assertFalse(frame.tree.getBoolean("collection_truncated"));assertFalse(frame.tree.getBoolean("truncated"));
            assertEquals(1,frame.tree.getJSONObject("diagnostics").getInt("foreign_package_nodes"));
            assertEquals(0,frame.tree.getJSONObject("diagnostics").getInt("foreign_window_nodes"));
            assertEquals(0,frame.tree.getJSONObject("diagnostics").getInt("missing_children"));
        }
        JSONObject observed=observe("both");assertEquals("complete",observed.getString("observation_status"));
        assertFalse(observed.getJSONObject("tree").getBoolean("collection_complete"));
        assertFalse(observed.toString().contains("external embedded content"));
        assertEquals(123,observed.getJSONObject("diagnostics").getJSONArray("captures").getJSONObject(0).getInt("after_window_id"));
        assertEquals(1,observed.getJSONObject("diagnostics").getJSONObject("tree").getJSONObject("collection_counters").getInt("foreign_package_nodes"));
        assertNodeAccepts(observed,1,true);
    }
    @Test public void noFrameAndStaleSessionUseProtocolObservationFailureEnvelope()throws Exception {
        backend.noFrame=true;assertEquals("FRAME_UNAVAILABLE",observe("both").getJSONObject("error").getString("code"));
        JSONObject stale=cmd("observe",Tunnel.json("mode","tree"));stale.getJSONObject("session").put("generation",2);
        executor.invalidate("removed");JSONObject result=executor.execute(stale);assertTrue(result.has("observation"));
        assertEquals("SESSION_STALE",result.getJSONObject("observation").getJSONObject("error").getString("code"));assertFalse(result.has("request"));
    }
    @Test public void passwordDescendantsNeverLeakThroughOtherTextChannels()throws Exception {
        AccessibilityNodeInfo password=node("android.widget.EditText","SECRET_PARENT");password.setPassword(true);password.setContentDescription("SECRET_DESCRIPTION");
        AccessibilityNodeInfo child=node("android.widget.TextView","SECRET_CHILD");child.setHintText("SECRET_HINT");
        Shadows.shadowOf(password).addChild(child);Shadows.shadowOf(root).addChild(password);
        JSONObject result=observe("tree");assertEquals("complete",result.getString("observation_status"));assertFalse(result.toString().contains("SECRET_"));
    }
    private void contentEvent(int windowId){contentEvent(windowId,android.view.accessibility.AccessibilityEvent.CONTENT_CHANGE_TYPE_TEXT);}
    private void contentEvent(int windowId,int changeType){
        android.view.accessibility.AccessibilityEvent e=android.view.accessibility.AccessibilityEvent.obtain((changeType & android.view.accessibility.AccessibilityEvent.CONTENT_CHANGE_TYPE_PANE_APPEARED)!=0 ? android.view.accessibility.AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED : android.view.accessibility.AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED);
        Shadows.shadowOf(e).setWindowId(windowId);
        e.setContentChangeTypes(changeType);
        service.onAccessibilityEvent(e);e.recycle();
    }
    private JSONObject tapFrom(JSONObject observed)throws Exception {
        return executor.execute(cmd("tap",Tunnel.json("observation_id",observed.getString("observation_id"),"expected_window_id",123,"x",30,"y",30))).getJSONObject("request");
    }
    @Test public void screenshotOnlyCanStillTapWhenContentDidNotChange()throws Exception{
        JSONObject observed=observe("screenshot");assertEquals("executed",tapFrom(observed).getString("state"));assertEquals(1,backend.effects);
    }
    @Test public void sameWindowContentChangeDoesNotExpireScreenshot()throws Exception{
        JSONObject observed=observe("screenshot");contentEvent(123);
        assertEquals("executed",tapFrom(observed).getString("state"));assertEquals(1,backend.effects);
    }
    @Test public void unrelatedWindowContentDoesNotInvalidateScreenshot()throws Exception{
        JSONObject observed=observe("screenshot");contentEvent(999);
        assertEquals("executed",tapFrom(observed).getString("state"));assertEquals(1,backend.effects);
    }
    @Test public void newPaneDuringScreenshotCaptureRejectsObservation()throws Exception{
        backend.duringScreenshot=()->contentEvent(123,android.view.accessibility.AccessibilityEvent.CONTENT_CHANGE_TYPE_PANE_APPEARED);
        assertEquals("OBSERVATION_INCONSISTENT",observe("screenshot").getJSONObject("error").getString("code"));assertEquals(0,backend.effects);
    }
    @Test public void sameWindowTextAndBoundsRefreshDoesNotRejectCurrentObservation()throws Exception{
        JSONObject observed=observe("both");root.setText("Updated animated label");root.setBoundsInScreen(new Rect(0,0,719,1279));contentEvent(123);
        assertEquals("executed",tapFrom(observed).getString("state"));assertEquals(1,backend.effects);
    }
    @Test public void newPaneIsLoggedWithoutPageContentAndDoesNotExpireTheAction()throws Exception{
        org.robolectric.shadows.ShadowLog.clear();JSONObject observed=observe("both");
        contentEvent(123,android.view.accessibility.AccessibilityEvent.CONTENT_CHANGE_TYPE_PANE_APPEARED);
        contentEvent(123,android.view.accessibility.AccessibilityEvent.CONTENT_CHANGE_TYPE_PANE_APPEARED);
        assertEquals("executed",tapFrom(observed).getString("state"));assertEquals(1,backend.effects);
        var logs=org.robolectric.shadows.ShadowLog.getLogsForTag("BoujoyObservation");assertEquals(1,logs.size());
        JSONObject detail=new JSONObject(logs.get(0).msg);assertEquals("pane_appeared",detail.getString("reason"));assertEquals(123,detail.getInt("windowId"));assertFalse(detail.has("text"));
    }
    @Test public void newerObservationStillRejectsOldId()throws Exception{
        JSONObject old=observe("both");observe("both");assertEquals("STALE_OBSERVATION",tapFrom(old).getJSONObject("error").getString("code"));assertEquals(0,backend.effects);
    }
    @Test public void screenshotContentRefreshDuringCaptureRemainsUsable()throws Exception{
        backend.duringScreenshot=()->contentEvent(123);JSONObject observed=observe("screenshot");
        assertEquals("complete",observed.getString("observation_status"));assertEquals("executed",tapFrom(observed).getString("state"));
    }
    @Test public void rawSwipeStillRejectsProtectedStartAfterTargetComparisonRemoved()throws Exception{
        root.setPassword(true);JSONObject observed=observe("both");
        JSONObject result=executor.execute(cmd("swipe",Tunnel.json("observation_id",observed.getString("observation_id"),"expected_window_id",123,
                "points",new JSONArray().put(Tunnel.json("x",30,"y",30)).put(Tunnel.json("x",30,"y",90)),"duration_ms",200))).getJSONObject("request");
        assertEquals("PROTECTED_INPUT",result.getJSONObject("error").getString("code"));assertEquals(0,backend.effects);
    }
    @Test public void depthLimitStillFailsInsteadOfBeingCertifiedAsPartial()throws Exception {
        AccessibilityNodeInfo parent=root;
        for(int i=0;i<42;i++){AccessibilityNodeInfo child=node("android.widget.LinearLayout","level");Shadows.shadowOf(parent).addChild(child);parent=child;}
        JSONObject observed=observe("tree");assertEquals("failed",observed.getString("observation_status"));
        assertEquals("OBSERVATION_INCONSISTENT",observed.getJSONObject("error").getString("code"));
        assertTrue(observed.getJSONObject("diagnostics").getJSONObject("tree").getBoolean("collection_truncated"));
        assertEquals(41,observed.getJSONObject("diagnostics").getJSONObject("tree").getInt("output_nodes"));
        JSONObject counters=observed.getJSONObject("diagnostics").getJSONObject("tree").getJSONObject("collection_counters");
        assertEquals(1,counters.getInt("depth_limit_hits"));assertEquals(0,counters.getInt("node_limit_hits"));
    }
    @Test public void incompleteTreeStillRejectsChangedWindowBeforeCertification()throws Exception {
        AccessibilityNodeInfo excluded=node("android.widget.TextView","EXCLUDED_WINDOW");excluded.setPackageName("other.app");Shadows.shadowOf(root).addChild(excluded);
        backend.duringScreenshot=()->{
            AccessibilityWindowInfo next=AccessibilityWindowInfo.obtain();Shadows.shadowOf(next).setDisplayId(7);Shadows.shadowOf(next).setId(124);
            Shadows.shadowOf(next).setType(AccessibilityWindowInfo.TYPE_APPLICATION);Shadows.shadowOf(next).setLayer(6);
            AccessibilityNodeInfo nextRoot=node("android.widget.LinearLayout","NEW_WINDOW");Shadows.shadowOf(nextRoot).setAccessibilityWindowInfo(next);Shadows.shadowOf(next).setRoot(nextRoot);
            Shadows.shadowOf(service).setWindowsOnDisplay(7,List.of(next));
        };
        JSONObject observed=observe("both");assertEquals("OBSERVATION_INCONSISTENT",observed.getJSONObject("error").getString("code"));
        assertFalse(observed.toString().contains("EXCLUDED_WINDOW"));assertFalse(observed.toString().contains("NEW_WINDOW"));
        assertFalse(observed.getJSONObject("diagnostics").has("captures"));
    }
    @Test public void incompleteTreeStillRejectsChangedPackageBeforeCertification()throws Exception {
        AccessibilityNodeInfo excluded=node("android.widget.TextView","EXCLUDED_PACKAGE");excluded.setPackageName("other.app");Shadows.shadowOf(root).addChild(excluded);
        backend.duringScreenshot=()->root.setPackageName("replacement.app");
        JSONObject observed=observe("both");assertEquals("OBSERVATION_INCONSISTENT",observed.getJSONObject("error").getString("code"));
        assertFalse(observed.getJSONObject("diagnostics").has("captures"));
    }
    @Test public void partialPasswordTreeRemainsRedactedThroughActualNodeValidator()throws Exception {
        AccessibilityNodeInfo password=node("android.widget.EditText","SECRET_PARTIAL");password.setPassword(true);password.setContentDescription("SECRET_DESCRIPTION");password.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_TEXT);
        AccessibilityNodeInfo child=node("android.widget.TextView","SECRET_DESCENDANT");child.setHintText("SECRET_HINT");Shadows.shadowOf(password).addChild(child);Shadows.shadowOf(root).addChild(password);
        AccessibilityNodeInfo foreign=node("android.widget.TextView","FOREIGN_SECRET");foreign.setPackageName("other.app");Shadows.shadowOf(root).addChild(foreign);
        JSONObject observed=observe("both");assertEquals("complete",observed.getString("observation_status"));assertFalse(observed.toString().contains("SECRET"));
        assertFalse(observed.getJSONObject("tree").getJSONArray("elements").getJSONObject(1).getJSONArray("actions").toString().contains("set_text"));
        assertNodeAccepts(observed,3,true);
    }
    @Test public void eitherTruncationFlagOverridesClaimedCompleteness()throws Exception {
        JSONObject valid=Tunnel.json("available",true,"collection_complete",false,"collection_truncated",false,"truncated",false);
        assertTrue(DisplayExecutor.usableTree(valid));
        assertFalse(DisplayExecutor.usableTree(new JSONObject(valid.toString()).put("collection_complete",true).put("collection_truncated",true)));
        assertFalse(DisplayExecutor.usableTree(new JSONObject(valid.toString()).put("collection_complete",true).put("truncated",true)));
        assertFalse(DisplayExecutor.usableTree(new JSONObject(valid.toString()).put("available",false)));
        valid.remove("truncated");assertFalse(DisplayExecutor.usableTree(valid));
    }
    @Test public void partialAndTruncatedDiagnosticsNeverIncludePageText()throws Exception {
        org.robolectric.shadows.ShadowLog.clear();AccessibilityNodeInfo child=node("android.widget.TextView","FOREIGN_PRIVATE");child.setPackageName("other.app");Shadows.shadowOf(root).addChild(child);
        JSONObject observed=observe("tree");assertEquals("complete",observed.getString("observation_status"));
        JSONObject tree=observed.getJSONObject("diagnostics").getJSONObject("tree");assertFalse(tree.getBoolean("collection_complete"));assertEquals(1,tree.getInt("output_nodes"));
        var logs=org.robolectric.shadows.ShadowLog.getLogsForTag("BoujoyDisplayTiming");assertEquals(1,logs.size());
        JSONObject detail=new JSONObject(logs.get(0).msg);assertTrue(detail.getBoolean("success"));assertEquals(1,detail.getJSONObject("tree_diagnostics").getInt("output_nodes"));
        assertEquals(1,detail.getJSONObject("tree_diagnostics").getJSONObject("collection_counters").getInt("foreign_package_nodes"));
        assertFalse(logs.get(0).msg.contains("FOREIGN_PRIVATE"));assertFalse(logs.get(0).msg.contains("Background content"));
    }

    @Test public void foreignWindowCounterRecordsOnlyTheRejectedWindowBranch()throws Exception {
        AccessibilityWindowInfo other=AccessibilityWindowInfo.obtain();Shadows.shadowOf(other).setId(321);Shadows.shadowOf(other).setDisplayId(7);
        AccessibilityNodeInfo child=node("android.widget.TextView","FOREIGN_WINDOW_PRIVATE");Shadows.shadowOf(child).setAccessibilityWindowInfo(other);Shadows.shadowOf(root).addChild(child);
        JSONObject observed=observe("tree");assertEquals("complete",observed.getString("observation_status"));
        assertFalse(observed.toString().contains("FOREIGN_WINDOW_PRIVATE"));
        JSONObject counters=observed.getJSONObject("tree").getJSONObject("diagnostics");
        assertEquals(1,counters.getInt("foreign_window_nodes"));assertEquals(0,counters.getInt("foreign_package_nodes"));
        assertEquals(0,counters.getInt("missing_children"));assertEquals(0,counters.getInt("node_limit_hits"));assertEquals(0,counters.getInt("depth_limit_hits"));
        assertNodeAccepts(observed,1,true);
    }

    @Test public void missingChildReturnsPartialObservationAcceptedByActualNodeValidator()throws Exception {
        // Robolectric's addChild(null) dereferences the child. Populate its backing list
        // to represent an advertised child that disappeared before getChild could resolve it.
        org.robolectric.util.ReflectionHelpers.setField(Shadows.shadowOf(root),"children",
                new java.util.ArrayList<AccessibilityNodeInfo>(java.util.Arrays.asList((AccessibilityNodeInfo)null)));
        assertEquals(1,root.getChildCount());assertNull(root.getChild(0));
        JSONObject observed=observe("both");assertEquals("complete",observed.getString("observation_status"));
        JSONObject tree=observed.getJSONObject("tree"),counters=tree.getJSONObject("diagnostics");
        assertFalse(tree.getBoolean("collection_complete"));assertFalse(tree.getBoolean("collection_truncated"));assertFalse(tree.getBoolean("truncated"));
        assertEquals(1,tree.getInt("output_nodes"));assertEquals(1,counters.getInt("missing_children"));
        for(String key:new String[]{"foreign_package_nodes","foreign_window_nodes","node_limit_hits","depth_limit_hits"})assertEquals(key,0,counters.getInt(key));
        assertEquals(1,observed.getJSONObject("diagnostics").getJSONObject("tree").getJSONObject("collection_counters").getInt("missing_children"));
        assertNodeAccepts(observed,1,true);
    }

}
