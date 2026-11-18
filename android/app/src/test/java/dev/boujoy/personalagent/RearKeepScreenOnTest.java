package dev.boujoy.personalagent;

import android.app.KeyguardManager;
import android.content.Context;
import android.hardware.display.DisplayManager;
import android.os.PowerManager;
import android.view.Display;
import org.junit.Before;
import org.robolectric.shadows.ShadowDisplayManager;
import android.graphics.Insets;
import android.graphics.Rect;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.ScrollView;
import org.robolectric.util.ReflectionHelpers;
import android.content.Intent;
import android.os.Looper;
import android.view.WindowManager;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import static org.robolectric.Shadows.shadowOf;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public class RearKeepScreenOnTest {
    @Before public void isolateBridgeContextAndPreferences() {
        org.junit.Assume.assumeTrue("Xiaomi display integration is not part of the Phone Use edition",BuildConfig.BACKGROUND_SUPPORTED);
        // The production singleton otherwise retains the preceding Robolectric Application.
        ReflectionHelpers.setStaticField(DisplayBridge.class, "instance", null);
        ConnectionService.current = null;
        RuntimeEnvironment.getApplication().getSharedPreferences("display_backend", Context.MODE_PRIVATE).edit().clear().commit();
    }
    private ActivityController<RearStatusActivity> rearController(boolean enabled) throws Exception {
        int rear = ShadowDisplayManager.addDisplay("w347dp-h212dp-450dpi", "Rear fixture");
        return controllerOnDisplay(rear, rear, enabled);
    }
    private ActivityController<RearStatusActivity> controllerOnDisplay(int actual, int rear, boolean enabled) throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        DisplayBridge bridge = DisplayBridge.get(context);
        ReflectionHelpers.setField(bridge, "rear", new JSONObject().put("available", true).put("displayId", rear));
        bridge.setRearProgressEnabled(enabled);
        ActivityController<RearStatusActivity> controller = Robolectric.buildActivity(RearStatusActivity.class);
        setDisplayContext(controller.get(), actual);
        shadowOf(controller.get().getSystemService(KeyguardManager.class)).setIsDeviceLocked(false);
        shadowOf(controller.get().getSystemService(KeyguardManager.class)).setKeyguardLocked(false);
        shadowOf(controller.get().getSystemService(PowerManager.class)).setIsInteractive(true);
        return controller;
    }
    private void setDisplayContext(RearStatusActivity activity, int id) {
        Display display = RuntimeEnvironment.getApplication().getSystemService(DisplayManager.class).getDisplay(id);
        assertNotNull(display);
        ReflectionHelpers.setField(activity, "mBase", activity.getBaseContext().createDisplayContext(display));
    }
    private JSONObject snapshot(String status) throws Exception {
        JSONObject task = new JSONObject().put("id", "current").put("status", status).put("updatedAt", "2026-11-14T10:00:00Z");
        return new JSONObject().put("online", true).put("paused", false).put("locked", false)
                .put("stateSyncedAtElapsedMs", 1_000)
                .put("displayBackend", new JSONObject().put("rear", new JSONObject().put("available", true).put("displayId", 7)))
                .put("state", new JSONObject().put("tasks", new JSONArray().put(task)));
    }
    private boolean keep(JSONObject snapshot, long now, boolean visible, boolean locked, int displayId) {
        return RearStatusActivity.shouldKeepScreenOn(snapshot, RearStatus.from(snapshot, now, locked), visible, displayId);
    }
    @Test public void currentExecutingQueuedAndApprovalTasksKeepVisibleRearLit() throws Exception {
        for (String status : new String[]{"running", "queued", "waiting_children", "waiting_approval", "waiting_consent"})
            assertTrue(status, keep(snapshot(status), 1_500, true, false, 7));
    }
    @Test public void completedStoppedAndUnresolvedHistoricalWorkReleaseKeepOn() throws Exception {
        for (String status : new String[]{"completed", "succeeded", "failed", "expired", "stopped", "cancelled", "paused", "unknown_result", "blocked", "needs_input", "ready_for_user", "waiting_setup", "waiting_user", "unrecognized"})
            assertFalse(status, keep(snapshot(status), 1_500, true, false, 7));
    }
    @Test public void localStopClearsKeepOnBeforeMacTaskStatusChanges() throws Exception {
        JSONObject data = snapshot("running");
        assertTrue(keep(data, 1_500, true, false, 7));
        data.put("paused", true);
        assertEquals("running", data.getJSONObject("state").getJSONArray("tasks").getJSONObject(0).getString("status"));
        assertFalse(keep(data, 1_500, true, false, 7));
    }
    @Test public void pauseLockDisconnectAndExpiredSyncReleaseKeepOn() throws Exception {
        JSONObject data = snapshot("running");
        assertFalse(keep(data, 1_500, false, false, 7));
        assertFalse(keep(data, 1_500, true, true, 7));
        data.put("locked", true); assertFalse(keep(data, 1_500, true, false, 7));
        data.put("locked", false); assertTrue(keep(data, 31_000, true, false, 7));
        assertFalse(keep(data, 31_001, true, false, 7));
        assertFalse(keep(data, 999, true, false, 7));
        data.put("online", false); assertFalse(keep(data, 1_500, true, false, 7));
        data.put("online", true).remove("stateSyncedAtElapsedMs");
        assertFalse(keep(data, 1_500, true, false, 7));
    }
    @Test public void defaultUnknownOrWrongDisplayNeverKeepsMainScreenOn() throws Exception {
        JSONObject data = snapshot("running");
        for (int id : new int[]{-1, 0, 1, 8}) assertFalse(keep(data, 1_500, true, false, id));
        JSONObject rear = data.getJSONObject("displayBackend").getJSONObject("rear");
        rear.put("displayId", 0); assertFalse(keep(data, 1_500, true, false, 0));
        rear.put("displayId", 7).put("available", false); assertFalse(keep(data, 1_500, true, false, 7));
        data.remove("displayBackend"); assertFalse(keep(data, 1_500, true, false, 7));
    }
    @Test public void terminalTaskWinsOverOldUnknownAndEmptySnapshotDoesNotKeepLit() throws Exception {
        JSONObject data = snapshot("completed");
        data.getJSONObject("state").getJSONArray("tasks").put(new JSONObject().put("id", "old").put("status", "unknown_result").put("updatedAt", "2026-11-13T10:00:00Z"));
        assertEquals("current", RearStatus.from(data, 1_500, false).taskId());
        assertFalse(keep(data, 1_500, true, false, 7));
        data.getJSONObject("state").put("tasks", new JSONArray());
        assertFalse(keep(data, 1_500, true, false, 7));
        assertFalse(keep(null, 1_500, true, false, 7));
    }
    @Test public void pausedActivityStillReceivesCloseAndReleasesKeepOn() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        ActivityController<RearStatusActivity> controller = rearController(true).create().start().resume().visible();
        RearStatusActivity activity = controller.get();
        try {
            assertFalse(activity.isFinishing());
            assertTrue(shadowOf(activity).getTurnScreenOn());
            activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            controller.pause();
            assertFalse(shadowOf(activity).getTurnScreenOn());
            assertEquals(0, activity.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            // This real same-package broadcast must reach the receiver even after onPause.
            context.sendBroadcast(new Intent(DisplayBridge.CLOSE_REAR_ACTION).setPackage(context.getPackageName()));
            shadowOf(Looper.getMainLooper()).idle();
            assertTrue(activity.isFinishing());
            assertEquals(0, activity.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } finally { controller.stop().destroy(); }
    }
    @Test public void disabledOrLateLaunchFinishesWithoutKeepingScreenOn() throws Exception {
        assertFalse(DisplayBridge.get(RuntimeEnvironment.getApplication()).isRearProgressEnabled());
        ActivityController<RearStatusActivity> controller = rearController(false).create().start().resume();
        try {
            assertTrue(controller.get().isFinishing());
            assertFalse(shadowOf(controller.get()).getTurnScreenOn());
            assertNull(ReflectionHelpers.getField(controller.get(), "title"));
            assertEquals(0, controller.get().getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } finally { controller.pause().stop().destroy(); }
    }

    @Test @Config(sdk=35, qualifiers="w347dp-h212dp-450dpi")
    public void stopRemainsFullyVisibleOnPhysicalRearViewportWhileTextScrolls() throws Exception {
        RuntimeEnvironment.setFontScale(1.3f);
        ActivityController<RearStatusActivity> controller = rearController(true).create();
        RearStatusActivity activity = controller.get();
        try {
            assertEquals(2.8125f, activity.getResources().getDisplayMetrics().density, 0.0001f);
            JSONObject data = snapshot("running").put("stateSyncedAtElapsedMs", Math.max(1, SystemClock.elapsedRealtime()));
            data.getJSONObject("state").getJSONArray("tasks").getJSONObject(0)
                    .put("title", "这是正在执行的很长任务标题，需要完整显示停止按钮并保持随时可操作")
                    .put("phase", "正在查看当前页面并核实真实任务状态，这段较长的阶段说明会占用两行显示空间")
                    .put("phaseAt", "2026-11-14T10:00:00Z");
            ReflectionHelpers.callInstanceMethod(activity, "renderSnapshot",
                    ReflectionHelpers.ClassParameter.from(JSONObject.class, data),
                    ReflectionHelpers.ClassParameter.from(boolean.class, false));
            ViewGroup content = activity.findViewById(android.R.id.content);
            ViewGroup root = (ViewGroup) content.getChildAt(0);
            root.dispatchApplyWindowInsets(new WindowInsets.Builder()
                    .setInsets(WindowInsets.Type.systemBars(), Insets.of(0, 24, 0, 16)).build());
            root.measure(View.MeasureSpec.makeMeasureSpec(976, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(596, View.MeasureSpec.EXACTLY));
            root.layout(0, 0, 976, 596);
            Button stop = ReflectionHelpers.getField(activity, "stop");
            assertEquals(View.VISIBLE, stop.getVisibility());
            Rect before = new Rect(0, 0, stop.getWidth(), stop.getHeight()); root.offsetDescendantRectToMyCoords(stop, before);
            assertTrue(before.top >= root.getPaddingTop());
            assertTrue(before.bottom <= 596 - root.getPaddingBottom());
            assertTrue(before.left >= root.getPaddingLeft());
            assertTrue(before.right <= 976 - root.getPaddingRight());
            assertTrue(stop.getHeight() >= Math.round(40 * 2.8125f));
            ScrollView scroll = (ScrollView) root.getChildAt(0);
            scroll.scrollTo(0, 10_000);
            Rect after = new Rect(0, 0, stop.getWidth(), stop.getHeight()); root.offsetDescendantRectToMyCoords(stop, after);
            assertEquals("Scrolling task text must not move Stop", before, after);
        } finally { controller.destroy(); }
    }

    @Test public void wrongAndUnknownDisplayFinishBeforeConstructingTaskUiOrWaking() throws Exception {
        int rear = ShadowDisplayManager.addDisplay("w347dp-h212dp-450dpi", "Rear fixture");
        int other = ShadowDisplayManager.addDisplay("w400dp-h600dp-mdpi", "Other fixture");
        for (int actual : new int[]{Display.DEFAULT_DISPLAY, other}) {
            ActivityController<RearStatusActivity> controller = controllerOnDisplay(actual, rear, true).create();
            try {
                assertTrue(controller.get().isFinishing());
                assertFalse(shadowOf(controller.get()).getTurnScreenOn());
                assertNull(ReflectionHelpers.getField(controller.get(), "title"));
                assertFalse(DisplayBridge.get(controller.get()).rearVisibility().showing());
            } finally { controller.destroy(); }
        }
        // Default Robolectric base context has no display; production lookup must fail closed, not crash.
        ActivityController<RearStatusActivity> unknown = Robolectric.buildActivity(RearStatusActivity.class).create();
        try { assertTrue(unknown.get().isFinishing()); assertFalse(shadowOf(unknown.get()).getTurnScreenOn()); }
        finally { unknown.destroy(); }
    }
    @Test public void movedActivityClearsExistingTaskUiAndVisibilityOnNextRender() throws Exception {
        ActivityController<RearStatusActivity> controller = rearController(true).create().start().resume();
        RearStatusActivity activity = controller.get();
        try {
            JSONObject data = snapshot("running").put("stateSyncedAtElapsedMs", Math.max(1, SystemClock.elapsedRealtime()));
            data.getJSONObject("state").getJSONArray("tasks").getJSONObject(0).put("title", "不可留在主屏的任务详情");
            ReflectionHelpers.callInstanceMethod(activity, "renderSnapshot", ReflectionHelpers.ClassParameter.from(JSONObject.class, data), ReflectionHelpers.ClassParameter.from(boolean.class, false));
            setDisplayContext(activity, Display.DEFAULT_DISPLAY);
            ReflectionHelpers.callInstanceMethod(activity, "renderSnapshot", ReflectionHelpers.ClassParameter.from(JSONObject.class, data), ReflectionHelpers.ClassParameter.from(boolean.class, false));
            assertTrue(activity.isFinishing());
            assertEquals("", ((android.widget.TextView) ReflectionHelpers.getField(activity, "title")).getText().toString());
            assertEquals(View.GONE, ((Button) ReflectionHelpers.getField(activity, "stop")).getVisibility());
            assertFalse(shadowOf(activity).getTurnScreenOn());
            assertFalse(DisplayBridge.get(activity).rearVisibility().showing());
        } finally { controller.pause().stop().destroy(); }
    }
    @Test public void mainModeLockedRearNeverRequestsWakeOnCreateOrNewIntent() throws Exception {
        ActivityController<RearStatusActivity> controller = rearController(true);
        RearStatusActivity activity = controller.get();
        shadowOf(activity.getSystemService(KeyguardManager.class)).setKeyguardLocked(true);
        controller.create().start().resume();
        try {
            assertFalse(shadowOf(activity).getTurnScreenOn());
            activity.onNewIntent(new Intent());
            assertFalse(shadowOf(activity).getTurnScreenOn());
        } finally { controller.pause().stop().destroy(); }
    }
    @Test public void newExplicitIntentOnExistingRearRequestsWakeAndFreshVisibilityAck() throws Exception {
        ActivityController<RearStatusActivity> controller = rearController(true).create().start().resume();
        RearStatusActivity activity = controller.get();
        try {
            activity.setTurnScreenOn(false);
            DisplayBridge bridge = DisplayBridge.get(activity); long before = bridge.rearVisibility().revision();
            activity.onNewIntent(new Intent());
            assertTrue(shadowOf(activity).getTurnScreenOn());
            assertTrue(bridge.rearVisibility().showing());
            assertTrue(bridge.rearVisibility().revision() > before);
            setDisplayContext(activity, Display.DEFAULT_DISPLAY);
            activity.onNewIntent(new Intent());
            assertTrue(activity.isFinishing());
            assertFalse(shadowOf(activity).getTurnScreenOn());
            assertFalse(bridge.rearVisibility().showing());
        } finally { controller.pause().stop().destroy(); }
    }

    @Test public void screenOffAloneDoesNotMasqueradeAsKeyguardForRearWake() throws Exception {
        ActivityController<RearStatusActivity> controller = rearController(true);
        RearStatusActivity activity = controller.get();
        shadowOf(activity.getSystemService(PowerManager.class)).setIsInteractive(false);
        controller.create();
        try {
            assertFalse(activity.isFinishing());
            assertTrue(shadowOf(activity).getTurnScreenOn());
            assertEquals(0, activity.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } finally { controller.destroy(); }
    }

    @Test public void backgroundLockedRearRequestsWakeAndShowsTheCurrentStepButNotTheTaskTitle() throws Exception {
        ActivityController<RearStatusActivity> controller=rearController(true);
        RearStatusActivity activity=controller.get();DisplayBridge.get(activity).setLockedExecutionAllowed(true);
        shadowOf(activity.getSystemService(KeyguardManager.class)).setKeyguardLocked(true);
        shadowOf(activity.getSystemService(KeyguardManager.class)).setIsDeviceLocked(true);
        controller.create().start().resume();
        try {
            assertTrue(shadowOf(activity).getTurnScreenOn());
            JSONObject data=snapshot("running").put("locked",true).put("stateSyncedAtElapsedMs",Math.max(1,SystemClock.elapsedRealtime()));
            data.getJSONObject("state").getJSONArray("tasks").getJSONObject(0).put("title","不可泄露的任务标题").put("phase","正在打开应用");
            ReflectionHelpers.callInstanceMethod(activity,"renderSnapshot",ReflectionHelpers.ClassParameter.from(JSONObject.class,data),ReflectionHelpers.ClassParameter.from(boolean.class,true));
            assertEquals("正在处理",((android.widget.TextView)ReflectionHelpers.getField(activity,"status")).getText().toString());
            assertEquals("正在打开应用",((android.widget.TextView)ReflectionHelpers.getField(activity,"phase")).getText().toString());
            for(String field:new String[]{"title","updated"})assertEquals("",((android.widget.TextView)ReflectionHelpers.getField(activity,field)).getText().toString());
            assertEquals(View.VISIBLE,((Button)ReflectionHelpers.getField(activity,"stop")).getVisibility());
            assertEquals(View.GONE,((View)ReflectionHelpers.getField(activity,"handoffActions")).getVisibility());
            activity.setTurnScreenOn(false);activity.onNewIntent(new Intent());assertTrue(shadowOf(activity).getTurnScreenOn());
            DisplayBridge.get(activity).setLockedExecutionAllowed(false);
            ReflectionHelpers.callInstanceMethod(activity,"renderSnapshot",ReflectionHelpers.ClassParameter.from(JSONObject.class,data),ReflectionHelpers.ClassParameter.from(boolean.class,true));
            assertFalse(shadowOf(activity).getTurnScreenOn());
        } finally {controller.pause().stop().destroy();}
    }
    @Test public void backgroundPermissionNeverWakesWrongDisplayWhileLocked() throws Exception {
        int rear=ShadowDisplayManager.addDisplay("w347dp-h212dp-450dpi","Rear fixture");
        ActivityController<RearStatusActivity> controller=controllerOnDisplay(Display.DEFAULT_DISPLAY,rear,true);
        RearStatusActivity activity=controller.get();DisplayBridge.get(activity).setLockedExecutionAllowed(true);
        shadowOf(activity.getSystemService(KeyguardManager.class)).setKeyguardLocked(true);
        controller.create();
        try {assertTrue(activity.isFinishing());assertFalse(shadowOf(activity).getTurnScreenOn());assertNull(ReflectionHelpers.getField(activity,"title"));}
        finally {controller.destroy();}
    }

    @Test public void launchPauseResumeRestoresLockPresentationAndWakeOnlyInsideWindow() throws Exception {
        ActivityController<RearStatusActivity> controller=rearController(true).create().start().resume();
        RearStatusActivity activity=controller.get();
        try {
            assertTrue(shadowOf(activity).getShowWhenLocked());assertTrue(shadowOf(activity).getTurnScreenOn());
            controller.pause();assertFalse(shadowOf(activity).getTurnScreenOn());
            // Model an OEM losing the runtime property while switching the rear display on.
            activity.setShowWhenLocked(false);controller.resume();
            assertTrue(shadowOf(activity).getShowWhenLocked());assertTrue(shadowOf(activity).getTurnScreenOn());
            controller.pause();shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(RearStatusActivity.LAUNCH_WAKE_WINDOW_MS+1));
            activity.setShowWhenLocked(false);controller.resume();
            assertTrue(shadowOf(activity).getShowWhenLocked());assertFalse("A later ordinary resume must not request another wake",shadowOf(activity).getTurnScreenOn());
        } finally {controller.pause().stop().destroy();}
    }
    @Test public void oldSingleInstanceIntentReassertsShowWhenLockedAndCreatesFreshBoundedWake() throws Exception {
        ActivityController<RearStatusActivity> controller=rearController(true).create().start().resume();
        RearStatusActivity activity=controller.get();
        try {
            controller.pause();shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(RearStatusActivity.LAUNCH_WAKE_WINDOW_MS+1));
            activity.setShowWhenLocked(false);activity.onNewIntent(new Intent());
            assertTrue(shadowOf(activity).getShowWhenLocked());assertTrue(shadowOf(activity).getTurnScreenOn());
            controller.resume();assertTrue(shadowOf(activity).getTurnScreenOn());
            shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(RearStatusActivity.LAUNCH_WAKE_WINDOW_MS+1));
            assertFalse("The wake request must expire even without another pause",shadowOf(activity).getTurnScreenOn());
        } finally {controller.pause().stop().destroy();}
    }
    @Test public void backgroundModeRevocationWhilePausedCancelsWakeRecoveryPermanently() throws Exception {
        ActivityController<RearStatusActivity> controller=rearController(true);
        RearStatusActivity activity=controller.get();DisplayBridge bridge=DisplayBridge.get(activity);bridge.setLockedExecutionAllowed(true);
        shadowOf(activity.getSystemService(KeyguardManager.class)).setKeyguardLocked(true);
        controller.create().start().resume();
        try {
            assertTrue(shadowOf(activity).getTurnScreenOn());controller.pause();
            bridge.setLockedExecutionAllowed(false);shadowOf(Looper.getMainLooper()).idle();
            assertEquals(-1L,(long)ReflectionHelpers.getField(activity,"launchWakeUntil"));
            bridge.setLockedExecutionAllowed(true);controller.resume();
            assertFalse("Restoring mode cannot restore a revoked launch",shadowOf(activity).getTurnScreenOn());
        } finally {controller.pause().stop().destroy();}
    }
    @Test public void localStopWhilePausedCancelsLaunchWakeBeforeAnyResume() throws Exception {
        ActivityController<RearStatusActivity> controller=rearController(true);
        RearStatusActivity activity=controller.get();
        ConnectionService service=Robolectric.buildService(ConnectionService.class).get();
        ControlStateTest.Memory memory=new ControlStateTest.Memory();memory.paused=false;ControlState gate=new ControlState(memory);
        ReflectionHelpers.setField(service,"gate",gate);ReflectionHelpers.setField(service,"keyguard",activity.getSystemService(KeyguardManager.class));ConnectionService.current=service;
        controller.create().start().resume();
        try {
            assertTrue(shadowOf(activity).getTurnScreenOn());controller.pause();
            service.pauseLocal("rear_stop");shadowOf(Looper.getMainLooper()).idle();
            assertEquals(-1L,(long)ReflectionHelpers.getField(activity,"launchWakeUntil"));
            assertTrue(gate.paused());controller.resume();assertFalse(shadowOf(activity).getTurnScreenOn());
        } finally {ConnectionService.current=null;controller.pause().stop().destroy();service.onDestroy();}
    }
    @Test public void wrongDisplayOnResumeClearsManifestLockPresentationAndNeverWakes() throws Exception {
        ActivityController<RearStatusActivity> controller=rearController(true).create().start().resume();
        RearStatusActivity activity=controller.get();
        try {
            controller.pause();setDisplayContext(activity,Display.DEFAULT_DISPLAY);controller.resume();
            assertTrue(activity.isFinishing());assertFalse(shadowOf(activity).getTurnScreenOn());assertFalse(shadowOf(activity).getShowWhenLocked());
            assertNull(ReflectionHelpers.getField(activity,"current"));
        } finally {controller.pause().stop().destroy();}
    }

}
