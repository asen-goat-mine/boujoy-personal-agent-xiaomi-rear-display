package dev.boujoy.personalagent;

import android.app.Activity;
import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Rect;
import android.view.ContextThemeWrapper;
import android.view.DisplayCutout;
import android.view.WindowInsets;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ScrollView;
import android.widget.FrameLayout;
import org.junit.Test;
import org.junit.After;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import java.util.List;
import java.util.ArrayList;
import static org.junit.Assert.*;

/** Renders the actual rear component off-device; fixtures never create real tasks. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, qualifiers = "w347dp-h212dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class RearDashboardVisualTest {
    private final List<ActivityController<Activity>> fixtures = new ArrayList<>();
    @After public void closeFixtures() { for (ActivityController<Activity> controller : fixtures) controller.pause().stop().destroy(); }
    private RearDashboardView dashboard(float fontScale) {
        ActivityController<Activity> controller = Robolectric.buildActivity(Activity.class).setup(); fixtures.add(controller);
        Activity activity = controller.get();
        Configuration config = new Configuration(activity.getResources().getConfiguration()); config.fontScale = fontScale;
        Context context = new ContextThemeWrapper(activity.createConfigurationContext(config), R.style.AppTheme);
        // Keep native drawable/TextView lifecycle attached, but give the child an
        // exact viewport independent of its host Activity's display width.
        RearDashboardView view = new RearDashboardView(context);
        FrameLayout host = new FrameLayout(activity); activity.setContentView(host);
        host.addView(view, new FrameLayout.LayoutParams(Math.round(347 * context.getResources().getDisplayMetrics().density), Math.round(212 * context.getResources().getDisplayMetrics().density)));
        view.status.setText("正在处理"); view.title.setText("帮我在淘宝闪购买纸巾"); view.phase.setText("正在比较可选商品");
        view.updated.setText("最近更新 16:49");
        return view;
    }
    private static Bitmap capture(RearDashboardView view, String name, int width, int height) throws Exception {
        view.setLayoutParams(new FrameLayout.LayoutParams(width, height));
        return NativeVisualTest.capture(view, name, width, height);
    }
    private static List<RearProgress.Step> running() {
        return List.of(new RearProgress.Step("one", "已打开应用", "completed"), new RearProgress.Step("two", "已读取页面", "completed"), new RearProgress.Step("three", "正在搜索纸巾", "running"));
    }
    private static void stopReachable(RearDashboardView view, int height) {
        assertTrue("Stop touch target must remain at least 40 dp", view.stop.getHeight() >= Math.round(40 * view.getResources().getDisplayMetrics().density));
        Rect bounds=NativeLayoutAuditTest.bounds(view,view.stop);
        assertTrue("Stop must stay inside the usable rear surface", bounds.top >= view.getPaddingTop());
        assertTrue("Stop must not be pushed below the rear screen", bounds.bottom <= height - view.getPaddingBottom());
        assertTrue(view.stop.getWidth() >= Math.round(40 * view.getResources().getDisplayMetrics().density));
    }
    private static ScrollView findScroll(View view) {
        if (view instanceof ScrollView scroll) return scroll;
        if (view instanceof ViewGroup group) for (int i = 0; i < group.getChildCount(); i++) { ScrollView found = findScroll(group.getChildAt(i)); if (found != null) return found; }
        return null;
    }
    @Test public void runningAndPausedProgressRenderWithPersistentStopTarget() throws Exception {
        RearDashboardView view = dashboard(1f); view.showSteps(running(), "violet", true);
        capture(view, "rear-01-running", 347, 212); stopReachable(view, 212);
        ScrollView scroll = findScroll(view); assertNotNull(scroll); assertFalse(scroll.isVerticalScrollBarEnabled());
        View rowBefore = ((ViewGroup) NativeVisualTest.field(view, "steps")).getChildAt(2);
        view.showSteps(running(), "violet", true);
        assertSame("An unchanged snapshot must not restart the current indicator", rowBefore, ((ViewGroup) NativeVisualTest.field(view, "steps")).getChildAt(2));
        view.status.setText("手机已暂停"); view.stop.setText("手机已暂停"); view.stop.setEnabled(false);
        view.showSteps(List.of(running().get(0), running().get(1), new RearProgress.Step("three", "等待继续处理", "waiting")), "violet", false);
        capture(view, "rear-02-paused", 347, 212); stopReachable(view, 212);
    }
    @Test public void longLabelsAndLargeFontCannotCoverTheStopButton() throws Exception {
        RearDashboardView view = dashboard(1.3f);
        view.title.setText("帮我找到合适的规格并比较不同商家的价格和配送时间");
        view.showSteps(List.of(new RearProgress.Step("one", "已读取当前应用中的商品页面", "completed"), new RearProgress.Step("two", "正在继续核对当前页面中的规格和配送信息", "running")), "teal", false);
        capture(view, "rear-03-large-font", 347, 212); stopReachable(view, 212);
        capture(view, "rear-04-compact", 320, 190); stopReachable(view, 190);
    }
    @Test public void handoffControlsFitBesideTheSameStopFooter() throws Exception {
        RearDashboardView view = dashboard(1f); view.showSteps(running(), "violet", true); view.clearSteps();
        view.status.setText("需要你接手"); view.title.setText("已为你停在当前页面"); view.phase.setText("确认后可以在主屏继续"); view.phase.setVisibility(View.VISIBLE); view.updated.setVisibility(View.GONE);
        view.handoffActions.setVisibility(View.VISIBLE); view.stop.setText("停止 / 接管");
        capture(view, "rear-05-handoff", 347, 212); stopReachable(view, 212);
        assertTrue(view.handoffTake.getHeight() >= 40); assertTrue(view.handoffDismiss.getHeight() >= 40);
        assertTrue(view.handoffActions.getBottom() <= view.stop.getTop());
    }
    private static void descendantsAvoidCamera(ViewGroup root, View child, int cameraRight, int displayWidth) {
        if (child.getVisibility() != View.VISIBLE) return;
        // offsetDescendantRectToMyCoords maps content coordinates, subtracting a
        // TextView's own text scroll offset. getDrawingRect includes that offset;
        // starting at (0,0) incorrectly shifts a centered Button's visible bounds.
        Rect rect = new Rect(); child.getDrawingRect(rect); root.offsetDescendantRectToMyCoords(child, rect);
        String geometry = child.getClass().getSimpleName() + " bounds=" + rect + " layout=" + child.getLeft() + "," + child.getTop() + "," + child.getRight() + "," + child.getBottom() + " ownScroll=" + child.getScrollX() + "," + child.getScrollY();
        assertTrue("UI enters the camera strip: " + geometry, rect.left >= cameraRight);
        assertTrue("UI extends beyond the display: " + geometry, rect.right <= displayWidth);
        if (child instanceof ViewGroup group) for (int i = 0; i < group.getChildCount(); i++) descendantsAvoidCamera(root, group.getChildAt(i), cameraRight, displayWidth);
    }
    @Test public void mdpiCachedArtworkRemainsVisibleOnThe450dpiRearDisplay() throws Exception {
        RuntimeEnvironment.setQualifiers("w347dp-h212dp-mdpi");
        android.util.SparseArray<Bitmap> artwork = org.robolectric.util.ReflectionHelpers.getStaticField(BotAvatar.class, "ART");
        // Force the production cache to begin with the main-screen-density asset,
        // then reuse that exact bitmap on a different-density rear canvas.
        artwork.remove(R.drawable.robot_violet);
        BotAvatar original = new BotAvatar(RuntimeEnvironment.getApplication(), "violet");
        Bitmap source = artwork.get(R.drawable.robot_violet); assertNotNull(source); assertEquals(160, source.getDensity());
        NativeVisualTest.capture(original, "rear-09-mdpi-cache-source", 96, 96);
        RuntimeEnvironment.setQualifiers("w347dp-h212dp-450dpi");
        RearDashboardView rear = dashboard(1f); rear.showSteps(running(), "violet", false);
        Bitmap target = capture(rear, "rear-10-cross-density-cached-robot", 680, 596);
        assertSame("The actual production bitmap cache is reused", source, artwork.get(R.drawable.robot_violet));
        assertEquals(450, target.getDensity()); robotVisible(rear, target); stopReachable(rear, 596);
        System.out.println("Same-fixture cached artwork source density=" + source.getDensity() + " rear canvas density=" + target.getDensity());
    }
    private static void robotVisible(RearDashboardView view, Bitmap image) throws Exception {
        View portrait = (View) NativeVisualTest.field(view, "portrait");
        Rect bounds = new Rect(); portrait.getDrawingRect(bounds); view.offsetDescendantRectToMyCoords(portrait, bounds);
        int x = bounds.left + portrait.getWidth() / 2, y = bounds.top + Math.round(portrait.getHeight() * .68f);
        assertTrue("Robot face must stay inside the rear image: " + bounds, x >= 0 && y >= 0 && x < image.getWidth() && y < image.getHeight());
        int face = image.getPixel(x, y);
        assertTrue("Original cream robot face is missing: pixel=" + Integer.toHexString(face) + " portrait=" + bounds,
                Color.alpha(face) > 240 && Color.red(face) > 170 && Color.green(face) > 160 && Color.blue(face) > 130);
    }
    @Test @Config(qualifiers = "w347dp-h212dp-450dpi")
    public void realRearCameraCutoutAndAlreadyCroppedWindowUseTheSameSafeLayout() throws Exception {
        RearDashboardView view = dashboard(1f);
        assertEquals(2.8125f, view.getResources().getDisplayMetrics().density, .0001f);
        view.showSteps(running(), "violet", false);
        DisplayCutout camera = new DisplayCutout(Insets.of(296, 0, 0, 0), new Rect(0, 0, 296, 596), null, null, null);
        view.dispatchApplyWindowInsets(new WindowInsets.Builder().setDisplayCutout(camera)
                .setInsets(WindowInsets.Type.displayCutout(), Insets.of(296, 0, 0, 0)).build());
        Bitmap full = capture(view, "rear-06-camera-safe-976x596", 976, 596);
        android.util.SparseArray<Bitmap> artwork = org.robolectric.util.ReflectionHelpers.getStaticField(BotAvatar.class, "ART");
        System.out.println("Rear artwork densities: target=" + full.getDensity() + " cached=" + artwork.get(R.drawable.robot_violet).getDensity() + " recycled=" + artwork.get(R.drawable.robot_violet).isRecycled());
        stopReachable(view, 596); robotVisible(view, full);
        int unsafePixels = 0;
        for (int y = 0; y < 596; y++) for (int x = 0; x < 296; x++) if (full.getPixel(x, y) != Color.BLACK) unsafePixels++;
        assertEquals("The physical camera strip must contain no text, icons or controls", 0, unsafePixels);
        for (int i = 0; i < view.getChildCount(); i++) descendantsAvoidCamera(view, view.getChildAt(i), 296, 976);
        assertEquals(View.GONE, view.updated.getVisibility());
        int fullPadding = view.getPaddingLeft(), fullStopWidth = view.stop.getWidth();
        view.dispatchApplyWindowInsets(new WindowInsets.Builder().setInsets(WindowInsets.Type.displayCutout(), Insets.NONE).build());
        Bitmap cropped = capture(view, "rear-07-already-cropped-680x596", 680, 596); robotVisible(view, cropped);
        stopReachable(view, 596);
        assertEquals("Do not reserve the camera twice in an already cropped window", 296, fullPadding - view.getPaddingLeft());
        assertEquals("Both window modes provide the same usable stop target", fullStopWidth, view.stop.getWidth());
        assertTrue(view.getPaddingLeft() < 40);
        for (int i = 0; i < view.getChildCount(); i++) descendantsAvoidCamera(view, view.getChildAt(i), 0, 680);
        view.handoffActions.setVisibility(View.VISIBLE); view.clearSteps(); view.status.setText("需要你接手");
        view.phase.setVisibility(View.VISIBLE); view.phase.setText("确认后可以在主屏继续");
        Bitmap handoff = capture(view, "rear-08-camera-safe-handoff", 680, 596); robotVisible(view, handoff); stopReachable(view, 596);
        View portrait = (View) NativeVisualTest.field(view, "portrait");
        ScrollView scroll = findScroll(view); Rect portraitBounds = new Rect(0, 0, portrait.getWidth(), portrait.getHeight()); view.offsetDescendantRectToMyCoords(portrait, portraitBounds);
        assertTrue("The whole robot remains within the short handoff body", portraitBounds.top >= scroll.getTop() && portraitBounds.bottom <= scroll.getBottom());
    }

    private static final RearDashboardView.ApprovalActions NO_APPROVAL_ACTIONS = new RearDashboardView.ApprovalActions() {
        public void decide(RearApproval.Scope scope, boolean allow) { }
        public void retryDetails(RearApproval.Scope scope) { }
    };
    @Test @Config(qualifiers = "w347dp-h212dp-450dpi")
    public void exactApprovalSummaryAndButtonsRenderWithoutChangingTheStopFooter() throws Exception {
        RearDashboardView view=dashboard(1f);view.title.setText("");view.title.setVisibility(View.GONE);
        RearApproval.Scope scope=new RearApproval.Scope("task-one","approval-one","a".repeat(64),7,System.currentTimeMillis()+60000);
        RearApproval.Card card=new RearApproval.Card(scope,"保存这份日程表","目标路径：Documents/Boujoy/日程表.md","",true,"");
        java.util.List<RearApproval.Scope> clicked=new java.util.ArrayList<>();android.widget.Button originalStop=view.stop;
        final int[] stopped={0};view.stop.setOnClickListener(v->stopped[0]++);
        RearDashboardView.ApprovalActions actions=new RearDashboardView.ApprovalActions(){
            public void decide(RearApproval.Scope value,boolean allow){assertTrue(allow);clicked.add(value);}
            public void retryDetails(RearApproval.Scope value){fail("not a retry");}
        };
        view.showApprovals(List.of(card),actions);
        Bitmap shortCard=capture(view,"rear-11-approval-short-680x596",680,596);assertEquals(View.GONE,view.stop.getVisibility());robotVisible(view,shortCard);
        View allow=NativeLayoutAuditTest.label(view,"允许"),deny=NativeLayoutAuditTest.label(view,"拒绝");
        assertTrue(allow.isEnabled());Rect stopBounds=NativeLayoutAuditTest.bounds(view,(View)NativeVisualTest.field(view,"approvalFooter"));
        for(View choice:new View[]{allow,deny}){Rect bounds=NativeLayoutAuditTest.bounds(view,choice);assertEquals(stopBounds.top,bounds.top);assertEquals(stopBounds.bottom,bounds.bottom);assertTrue(choice.getHeight()>=Math.round(40*view.getResources().getDisplayMetrics().density));}
        assertSame(originalStop,view.stop);assertEquals(View.GONE,view.stop.getVisibility());
        view.dispatchApplyWindowInsets(new WindowInsets.Builder().setDisplayCutout(new DisplayCutout(Insets.of(296,0,0,0),new Rect(0,0,296,596),null,null,null)).setInsets(WindowInsets.Type.displayCutout(),Insets.of(296,0,0,0)).build());
        Bitmap full=capture(view,"rear-12-approval-camera-976x596",976,596);assertEquals(View.GONE,view.stop.getVisibility());
        for(int y=0;y<596;y++)for(int x=0;x<296;x++)assertEquals("Approval content must avoid the physical camera",Color.BLACK,full.getPixel(x,y));
        allow.performClick();assertEquals(List.of(scope),clicked);assertFalse(allow.isEnabled());assertFalse(deny.isEnabled());
        view.showApprovals(List.of(new RearApproval.Card(scope,card.summary(),"","accepted",true,"")),actions);
        assertEquals(View.VISIBLE,view.stop.getVisibility());assertSame(originalStop,view.stop);view.stop.performClick();assertEquals(1,stopped[0]);
        capture(view,"rear-19-approval-accepted-stop-restored",680,596);stopReachable(view,596);
        view.clearApprovals();assertSame(originalStop,view.stop);assertSame(view,view.stop.getParent());
        assertFalse(NativeLayoutAuditTest.descendants(view).stream().anyMatch(child->child instanceof android.widget.TextView text&&"拒绝".contentEquals(text.getText())));
    }
    @Test @Config(qualifiers = "w347dp-h212dp-450dpi")
    public void completeLongApprovalCanScrollWhileAllDecisionsStayFixedAndBodyIsClipped() throws Exception {
        RearDashboardView view=dashboard(1f);view.title.setText("");view.title.setVisibility(View.GONE);
        String summary="将已核对的本周日程保存到指定的工作文件夹。确认后只创建这一份文件，不修改其他文件，也不会发送给任何人。";
        String details="目标路径：\nDocuments/Boujoy/每周计划.md\n\n写入内容：\n周一：整理资料\n周二：核对日程\n周三：保留休息时间\n周四：复查文件\n周五：完成归档\n最后一行也必须完整可读";
        RearApproval.Scope scope=new RearApproval.Scope("task-one","approval-long","b".repeat(64),7,System.currentTimeMillis()+60000);
        view.showApprovals(List.of(new RearApproval.Card(scope,summary,details,"",true,"")),NO_APPROVAL_ACTIONS);
        capture(view,"rear-13-approval-long-summary",680,596);NativeLayoutAuditTest.label(view,"查看内容").performClick();
        Bitmap expanded=capture(view,"rear-14-approval-detail-top",680,596);assertEquals(View.GONE,view.stop.getVisibility());
        android.widget.TextView summaryView=(android.widget.TextView)NativeLayoutAuditTest.label((View)NativeVisualTest.field(view,"approvalDetails"),summary);assertNull(summaryView.getEllipsize());assertTrue(summaryView.getMaxLines()>20);
        ScrollView scroll=findScroll(view);Rect viewport=NativeLayoutAuditTest.bounds(view,scroll),footer=NativeLayoutAuditTest.bounds(view,(View)NativeVisualTest.field(view,"approvalFooter"));
        scroll.setVisibility(View.INVISIBLE);Bitmap hidden=capture(view,"rear-16-approval-clip-baseline",680,596);scroll.setVisibility(View.VISIBLE);
        int leaked=0;for(int y=0;y<596;y++)for(int x=0;x<680;x++)if(!viewport.contains(x,y)&&expanded.getPixel(x,y)!=hidden.getPixel(x,y))leaked++;
        assertEquals("Body drawing cannot leak into any footer edge or camera area",0,leaked);
        scroll.scrollTo(0,scroll.getChildAt(0).getHeight());capture(view,"rear-15-approval-detail-end",680,596);assertEquals(View.GONE,view.stop.getVisibility());
        assertTrue(scroll.getScrollY()>0);assertEquals(footer,NativeLayoutAuditTest.bounds(view,(View)NativeVisualTest.field(view,"approvalFooter")));assertNotNull(NativeLayoutAuditTest.label(view,details));
        for(String label:new String[]{"允许","拒绝"})assertTrue(NativeLayoutAuditTest.label(view,label).isEnabled());
    }
    @Test @Config(qualifiers = "w347dp-h212dp-450dpi")
    public void aPressOnTheOldApprovalCannotClickTheReplacementCard() throws Exception {
        RearDashboardView view=dashboard(1f);java.util.List<RearApproval.Scope> clicked=new java.util.ArrayList<>();
        RearDashboardView.ApprovalActions actions=new RearDashboardView.ApprovalActions(){public void decide(RearApproval.Scope scope,boolean allow){clicked.add(scope);}public void retryDetails(RearApproval.Scope scope){}};
        RearApproval.Scope old=new RearApproval.Scope("task-one","old","a".repeat(64),7,System.currentTimeMillis()+60000),next=new RearApproval.Scope("task-one","next","b".repeat(64),7,System.currentTimeMillis()+60000);
        view.showApprovals(List.of(new RearApproval.Card(old,"旧操作","","",true,"")),actions);capture(view,"rear-17-approval-touch-before",680,596);
        Rect bounds=NativeLayoutAuditTest.bounds(view,NativeLayoutAuditTest.label(view,"允许"));long time=android.os.SystemClock.uptimeMillis();
        android.view.MotionEvent down=android.view.MotionEvent.obtain(time,time,android.view.MotionEvent.ACTION_DOWN,bounds.exactCenterX(),bounds.exactCenterY(),0);assertTrue(view.dispatchTouchEvent(down));down.recycle();
        view.showApprovals(List.of(new RearApproval.Card(next,"新的操作","","",true,"")),actions);capture(view,"rear-18-approval-touch-after",680,596);
        android.view.MotionEvent up=android.view.MotionEvent.obtain(time,time+10,android.view.MotionEvent.ACTION_UP,bounds.exactCenterX(),bounds.exactCenterY(),0);view.dispatchTouchEvent(up);up.recycle();org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();assertTrue(clicked.isEmpty());
        bounds=NativeLayoutAuditTest.bounds(view,NativeLayoutAuditTest.label(view,"允许"));time+=20;
        down=android.view.MotionEvent.obtain(time,time,android.view.MotionEvent.ACTION_DOWN,bounds.exactCenterX(),bounds.exactCenterY(),0);view.dispatchTouchEvent(down);down.recycle();
        up=android.view.MotionEvent.obtain(time,time+10,android.view.MotionEvent.ACTION_UP,bounds.exactCenterX(),bounds.exactCenterY(),0);view.dispatchTouchEvent(up);up.recycle();org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();assertEquals(List.of(next),clicked);
    }

    @Test @Config(qualifiers = "w347dp-h212dp-450dpi")
    public void approvalSendingWaitsWithTwoKeysAndFinishedOrUncertainResultsRestoreStop() throws Exception {
        RearDashboardView view=dashboard(1f);android.widget.Button original=view.stop;
        RearApproval.Scope scope=new RearApproval.Scope("task-one","first","a".repeat(64),7,System.currentTimeMillis()+60000);
        RearApproval.Scope other=new RearApproval.Scope("task-one","second","b".repeat(64),7,System.currentTimeMillis()+60000);
        RearApproval.Card pending=new RearApproval.Card(scope,"保存日程表","","",true,"");
        view.showApprovals(List.of(pending),NO_APPROVAL_ACTIONS);capture(view,"rear-20-approval-pending-two-keys",680,596);assertEquals(View.GONE,view.stop.getVisibility());
        // RearStatusActivity restores the ordinary stop state before each periodic render.
        // An unchanged card must still hide it rather than returning with three controls.
        view.stop.setVisibility(View.VISIBLE);view.showApprovals(List.of(pending),NO_APPROVAL_ACTIONS);
        assertEquals(View.GONE,view.stop.getVisibility());
        view.showApprovals(List.of(new RearApproval.Card(scope,pending.summary(),"","sending",true,"")),NO_APPROVAL_ACTIONS);
        assertEquals(View.GONE,view.stop.getVisibility());assertFalse(NativeLayoutAuditTest.label(view,"允许").isEnabled());assertFalse(NativeLayoutAuditTest.label(view,"拒绝").isEnabled());
        view.showApprovals(List.of(new RearApproval.Card(scope,pending.summary(),"","accepted",true,""),new RearApproval.Card(other,"另一项操作","","",true,"")),NO_APPROVAL_ACTIONS);
        assertEquals(View.GONE,view.stop.getVisibility());assertNotNull(NativeLayoutAuditTest.label(view,"另一项操作"));assertTrue(NativeLayoutAuditTest.label(view,"允许").isEnabled());
        for(String outcome:new String[]{"accepted","unconfirmed"}){
            view.showApprovals(List.of(pending),NO_APPROVAL_ACTIONS);
            view.showApprovals(List.of(new RearApproval.Card(scope,pending.summary(),"",outcome,true,"")),NO_APPROVAL_ACTIONS);
            assertEquals(View.VISIBLE,view.stop.getVisibility());assertSame(original,view.stop);assertTrue(view.stop.isEnabled());
        }
        view.showApprovals(List.of(pending),NO_APPROVAL_ACTIONS);view.showApprovals(List.of(),NO_APPROVAL_ACTIONS);assertEquals(View.VISIBLE,view.stop.getVisibility());
    }

}
