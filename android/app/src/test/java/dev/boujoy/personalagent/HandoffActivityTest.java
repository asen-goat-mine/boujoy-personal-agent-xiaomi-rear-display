package dev.boujoy.personalagent;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.hardware.display.DisplayManager;
import android.os.Bundle;
import android.os.PowerManager;
import android.view.Display;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.TextView;
import java.util.function.BooleanSupplier;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowDisplayManager;
import org.robolectric.util.ReflectionHelpers;
import static org.robolectric.Shadows.shadowOf;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35, qualifiers="w390dp-h844dp-mdpi", shadows={HandoffActivityTest.HeldBridge.class,HandoffActivityTest.HandoffConnection.class})
public class HandoffActivityTest {
    private static JSONObject held;
    private static int takes;
    private static String dismissed, stopped;
    private static BooleanSupplier permit;
    private ActivityController<? extends Activity> controller;

    @Implements(value=DisplayBridge.class,isInAndroidSdk=false)
    public static class HeldBridge {
        @Implementation protected JSONObject handoff() { return held; }
    }
    @Implements(value=ConnectionService.class,isInAndroidSdk=false)
    public static class HandoffConnection {
        @Implementation protected void takeHandoff(String id, BooleanSupplier allowed, ConnectionService.Outcome<JSONObject> callback) {
            assertEquals("handoff-one", id); takes++; permit=allowed;
        }
        @Implementation protected void dismissHandoff(String id) { dismissed=id; }
        @Implementation protected void stopTaskFromRear(String id) { stopped=id; }
    }
    @Before public void reset() throws Exception {
        ReflectionHelpers.setStaticField(DisplayBridge.class,"instance",null);
        ConnectionService.current=null; takes=0; dismissed=null; stopped=null; permit=null;
        held=new JSONObject().put("handoffId","handoff-one").put("state","pending").put("taskId","task-one")
                .put("title","订单核对").put("summary","请核对收货信息后自行付款").put("expiresAtMs",System.currentTimeMillis()+60_000);
        Context context=RuntimeEnvironment.getApplication();
        context.getSharedPreferences("display_backend",0).edit().clear().commit();
        shadowOf(context.getSystemService(KeyguardManager.class)).setKeyguardLocked(false);
        shadowOf(context.getSystemService(KeyguardManager.class)).setIsDeviceLocked(false);
        shadowOf(context.getSystemService(PowerManager.class)).setIsInteractive(true);
    }
    @After public void close() {
        ConnectionService.current=null;
        if(controller!=null)controller.pause().stop().destroy();
    }
    private void attachService() { ConnectionService.current=Robolectric.buildService(ConnectionService.class).get(); }
    private void onDisplay(Activity activity,int id) {
        Display display=RuntimeEnvironment.getApplication().getSystemService(DisplayManager.class).getDisplay(id);
        ReflectionHelpers.setField(activity,"mBase",activity.getBaseContext().createDisplayContext(display));
    }
    private ActivityController<HandoffActivity> trampoline(int display,Intent intent) {
        ActivityController<HandoffActivity> value=Robolectric.buildActivity(HandoffActivity.class,intent);controller=value;onDisplay(value.get(),display);return value;
    }
    @Test public void manifestEntryIsNotExternallyExported() throws Exception {
        Context context=RuntimeEnvironment.getApplication();
        ActivityInfo info=context.getPackageManager().getActivityInfo(new android.content.ComponentName(context,HandoffActivity.class),android.content.pm.PackageManager.MATCH_DISABLED_COMPONENTS);
        assertFalse(info.exported);assertEquals(BuildConfig.BACKGROUND_SUPPORTED,info.enabled);
    }
    @Test public void explicitIntentWaitsForMainFocusAndPauseRevokesQueuedMove() {
        org.junit.Assume.assumeTrue("Xiaomi display integration is not part of the Phone Use edition",BuildConfig.BACKGROUND_SUPPORTED);
        attachService();ActivityController<HandoffActivity> value=trampoline(0,HandoffActivity.intent(RuntimeEnvironment.getApplication(),"handoff-one")).create().start().resume();
        assertEquals(0,takes);value.get().onWindowFocusChanged(true);
        assertEquals(1,takes);assertTrue(permit.getAsBoolean());
        value.get().onWindowFocusChanged(true);assertEquals("Repeated focus must not replay the transfer",1,takes);
        value.pause();assertFalse(permit.getAsBoolean());
    }
    @Test public void secondaryDisplayAndUnrecognizedIntentNeverMoveOrWake() {
        org.junit.Assume.assumeTrue("Xiaomi display integration is not part of the Phone Use edition",BuildConfig.BACKGROUND_SUPPORTED);
        attachService();int rear=ShadowDisplayManager.addDisplay("w347dp-h212dp-450dpi","Rear fixture");
        ActivityController<HandoffActivity> value=trampoline(rear,HandoffActivity.intent(RuntimeEnvironment.getApplication(),"handoff-one")).create().start().resume();
        value.get().onWindowFocusChanged(true);assertTrue(value.get().isFinishing());assertEquals(0,takes);assertFalse(shadowOf(value.get()).getTurnScreenOn());
        value.pause().stop().destroy();controller=null;
        value=trampoline(0,new Intent(RuntimeEnvironment.getApplication(),HandoffActivity.class).putExtra("handoffId","handoff-one")).create().start().resume();
        value.get().onWindowFocusChanged(true);assertTrue(value.get().isFinishing());assertEquals(0,takes);
    }
    @Test public void lockedExplicitIntentDoesNotMoveBeforeSystemAuthentication() {
        org.junit.Assume.assumeTrue("Xiaomi display integration is not part of the Phone Use edition",BuildConfig.BACKGROUND_SUPPORTED);
        attachService();ActivityController<HandoffActivity> value=trampoline(0,HandoffActivity.intent(RuntimeEnvironment.getApplication(),"handoff-one"));
        shadowOf(value.get().getSystemService(KeyguardManager.class)).setKeyguardLocked(true);
        shadowOf(value.get().getSystemService(KeyguardManager.class)).setIsDeviceLocked(true);
        value.create().start().resume();value.get().onWindowFocusChanged(true);assertEquals(0,takes);
        assertFalse(text(value.get().getWindow().getDecorView()).contains("订单核对"));
    }
    @Test public void recreationAndExpiredIntentCannotReplayTransfer() throws Exception {
        org.junit.Assume.assumeTrue("Xiaomi display integration is not part of the Phone Use edition",BuildConfig.BACKGROUND_SUPPORTED);
        attachService();ActivityController<HandoffActivity> value=trampoline(0,HandoffActivity.intent(RuntimeEnvironment.getApplication(),"handoff-one")).create(new Bundle()).start().resume();
        value.get().onWindowFocusChanged(true);assertEquals(0,takes);assertTrue(value.get().isFinishing());
        value.pause().stop().destroy();controller=null;held.put("expiresAtMs",System.currentTimeMillis()-1);
        value=trampoline(0,HandoffActivity.intent(RuntimeEnvironment.getApplication(),"handoff-one")).create().start().resume();value.get().onWindowFocusChanged(true);
        assertEquals(0,takes);assertTrue(value.get().isFinishing());
    }
    @Test public void chatCardOnlyLaunchesTrampolineAfterTapAndHidesDetailsOnPause() {
        org.junit.Assume.assumeTrue("Xiaomi display integration is not part of the Phone Use edition",BuildConfig.BACKGROUND_SUPPORTED);
        ActivityController<MainActivity> value=Robolectric.buildActivity(MainActivity.class).create().start().resume();controller=value;
        MainActivity activity=value.get();ReflectionHelpers.callInstanceMethod(activity,"showAssistantList",ReflectionHelpers.ClassParameter.from(boolean.class,false));attachService();
        ReflectionHelpers.callInstanceMethod(activity,"renderHandoff",ReflectionHelpers.ClassParameter.from(boolean.class,false));
        View card=ReflectionHelpers.getField(activity,"handoffCard");assertEquals(View.VISIBLE,card.getVisibility());assertTrue(text(card).contains("订单核对"));assertEquals(0,takes);
        ((Button)ReflectionHelpers.getField(activity,"handoffTake")).performClick();
        Intent launch=shadowOf(activity).getNextStartedActivity();assertNotNull(launch);assertEquals(HandoffActivity.class.getName(),launch.getComponent().getClassName());assertEquals(0,takes);
        ((Button)ReflectionHelpers.getField(activity,"handoffDismiss")).performClick();assertEquals("handoff-one",dismissed);
        value.pause();assertFalse(text(card).contains("订单核对"));assertFalse(text(card).contains("收货信息"));
    }
    @Test @Config(qualifiers="w347dp-h212dp-450dpi") public void rearHandoffControlsStayInsideViewportAndStopTargetsHeldTask() throws Exception {
        org.junit.Assume.assumeTrue("Xiaomi display integration is not part of the Phone Use edition",BuildConfig.BACKGROUND_SUPPORTED);
        int rear=ShadowDisplayManager.addDisplay("w347dp-h212dp-450dpi","Rear fixture");Context context=RuntimeEnvironment.getApplication();
        DisplayBridge bridge=DisplayBridge.get(context);ReflectionHelpers.setField(bridge,"rear",new JSONObject().put("available",true).put("displayId",rear));bridge.setRearProgressEnabled(true);
        ActivityController<RearStatusActivity> value=Robolectric.buildActivity(RearStatusActivity.class);controller=value;onDisplay(value.get(),rear);value.create().start().resume();
        attachService();RearStatusActivity activity=value.get();
        ReflectionHelpers.callInstanceMethod(activity,"renderSnapshot",ReflectionHelpers.ClassParameter.from(JSONObject.class,new JSONObject()),ReflectionHelpers.ClassParameter.from(boolean.class,false));
        View root=activity.findViewById(android.R.id.content);root.measure(View.MeasureSpec.makeMeasureSpec(976,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(596,View.MeasureSpec.EXACTLY));root.layout(0,0,976,596);
        for(String field:new String[]{"handoffTake","handoffDismiss","stop"}){
            View button=ReflectionHelpers.getField(activity,field);android.graphics.Rect bounds=new android.graphics.Rect(0,0,button.getWidth(),button.getHeight());((ViewGroup)root).offsetDescendantRectToMyCoords(button,bounds);
            assertEquals(View.VISIBLE,button.getVisibility());assertTrue(field+" has height",bounds.height()>0);assertTrue(field+" fits",bounds.top>=0&&bounds.bottom<=596);
        }
        assertEquals(0,takes);((Button)ReflectionHelpers.getField(activity,"stop")).performClick();assertEquals("task-one",stopped);
        ReflectionHelpers.callInstanceMethod(activity,"renderSnapshot",ReflectionHelpers.ClassParameter.from(JSONObject.class,new JSONObject()),ReflectionHelpers.ClassParameter.from(boolean.class,true));
        assertTrue(text(root).contains("Boujoy 正在处理"));assertFalse(text(root).contains("订单核对"));assertFalse(text(root).contains("收货信息"));
        assertEquals(View.GONE,((View)ReflectionHelpers.getField(activity,"handoffActions")).getVisibility());
    }
    private static String text(View view) {
        StringBuilder result=new StringBuilder();if(view instanceof TextView label)result.append(label.getText());
        if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++)result.append(text(group.getChildAt(i)));
        return result.toString();
    }
}
