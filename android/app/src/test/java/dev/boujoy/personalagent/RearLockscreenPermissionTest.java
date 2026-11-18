package dev.boujoy.personalagent;

import android.app.AppOpsManager;
import android.app.KeyguardManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.ParcelFileDescriptor;
import android.provider.Settings;
import android.view.View;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;
import static dev.boujoy.personalagent.RearLockscreenPermission.State.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,shadows=RearLockscreenPermissionTest.ReadOnlyAppOps.class)
public class RearLockscreenPermissionTest {
    @Implements(AppOpsManager.class)
    public static class ReadOnlyAppOps {
        static int mode=AppOpsManager.MODE_DEFAULT;
        @Implementation protected int checkOpNoThrow(int op,int uid,String packageName) {
            return op==RearLockscreenPermission.SHOW_WHEN_LOCKED?mode:AppOpsManager.MODE_DEFAULT;
        }
    }
    public static class RecordingOps {
        int operation=-1,uid=-1;String packageName;
        public int checkOpNoThrow(int op,int who,String pkg){operation=op;uid=who;packageName=pkg;return AppOpsManager.MODE_ALLOWED;}
    }
    private static class Shell extends IShellDisplay.Stub {
        int commands;
        @Override public void attach(IBinder client) {}
        @Override public String command(String op,String args,IDisplayPermit permit){commands++;return "{\"ok\":true,\"value\":{}}";}
        @Override public ParcelFileDescriptor capture(String session,int maxDimension,IDisplayPermit permit){return null;}
        @Override public void revoke() {}
        @Override public void destroy() {}
    }
    @Before public void reset() {
        ReflectionHelpers.setStaticField(DisplayBridge.class,"instance",null);ConnectionService.current=null;
        ReflectionHelpers.setStaticField(Build.class,"MANUFACTURER","Xiaomi");
        ReflectionHelpers.setStaticField(Build.class,"BRAND","Xiaomi");
        ReadOnlyAppOps.mode=AppOpsManager.MODE_DEFAULT;
    }
    @Test public void onlyXiaomiFamilyOrKnownMiuiPropertyUsesVendorOp() {
        assertTrue(RearLockscreenPermission.isSupportedDevice("Xiaomi","unknown",""));
        assertTrue(RearLockscreenPermission.isSupportedDevice("unknown"," POCO ",""));
        assertTrue(RearLockscreenPermission.isSupportedDevice("unknown","redmi",""));
        assertTrue(RearLockscreenPermission.isSupportedDevice("unknown","unknown","V150"));
        assertFalse(RearLockscreenPermission.isSupportedDevice("samsung","samsung",""));
        assertFalse(RearLockscreenPermission.isSupportedDevice(null,null,null));
    }
    @Test public void unrelatedDevicesNeverProbeVendorCode() {
        AtomicInteger reads=new AtomicInteger();
        assertEquals(NOT_APPLICABLE,RearLockscreenPermission.probe(false,()->{reads.incrementAndGet();return 1;}));
        assertEquals(0,reads.get());
    }
    @Test public void defaultForegroundAndUnrecognizedModesAreNotReportedAsDenial() {
        assertEquals(ALLOWED,RearLockscreenPermission.probe(true,()->AppOpsManager.MODE_ALLOWED));
        assertEquals(DENIED,RearLockscreenPermission.probe(true,()->AppOpsManager.MODE_IGNORED));
        assertEquals(DENIED,RearLockscreenPermission.probe(true,()->AppOpsManager.MODE_ERRORED));
        for(int mode:new int[]{AppOpsManager.MODE_DEFAULT,AppOpsManager.MODE_FOREGROUND,-1,100})
            assertEquals(UNKNOWN,RearLockscreenPermission.probe(true,()->mode));
        assertEquals(UNKNOWN,RearLockscreenPermission.probe(true,()->null));
        assertFalse(RearLockscreenPermission.statusText(UNKNOWN).contains("未允许"));
    }
    @Test public void failedFreshCheckDoesNotRetainAnOldGrantOrDenial() {
        assertEquals(ALLOWED,RearLockscreenPermission.probe(true,()->0));
        assertEquals(UNKNOWN,RearLockscreenPermission.probe(true,()->{throw new SecurityException();}));
        assertEquals(DENIED,RearLockscreenPermission.probe(true,()->1));
        assertEquals(UNKNOWN,RearLockscreenPermission.probe(true,()->{throw new NoSuchMethodException();}));
    }
    @Test public void reflectiveCheckUsesOnlyOwnIdentityAndReadOnlyOperation() throws Exception {
        RecordingOps ops=new RecordingOps();
        assertEquals(Integer.valueOf(0),RearLockscreenPermission.readMode(ops,10353,"dev.boujoy.personalagent"));
        assertEquals(10020,ops.operation);assertEquals(10353,ops.uid);assertEquals("dev.boujoy.personalagent",ops.packageName);
    }
    @Test public void missingServiceOrUnsupportedReflectionStaysUnknown() {
        assertEquals(UNKNOWN,RearLockscreenPermission.probe(true,()->RearLockscreenPermission.readMode(null,1,"own.app")));
        assertEquals(UNKNOWN,RearLockscreenPermission.probe(true,()->RearLockscreenPermission.readMode(new Object(),1,"own.app")));
    }
    @Test public void onlyExplicitDenialWhileLockedBlocksRearLaunch() {
        for(RearLockscreenPermission.State state:RearLockscreenPermission.State.values()) {
            assertFalse(RearLockscreenPermission.blocksRearLaunch(false,state));
            assertEquals(state==DENIED,RearLockscreenPermission.blocksRearLaunch(true,state));
        }
    }
    @Test public void userSettingsActionTargetsVerifiedEditorForOwnPackage() {
        List<Intent> opened=new ArrayList<>();
        assertTrue(RearLockscreenPermission.openSettings("dev.boujoy.personalagent",true,opened::add));
        assertEquals(1,opened.size());Intent intent=opened.get(0);
        assertEquals("miui.intent.action.APP_PERM_EDITOR",intent.getAction());
        assertEquals("com.miui.securitycenter",intent.getComponent().getPackageName());
        assertEquals("com.miui.permcenter.permissions.PermissionsEditorActivity",intent.getComponent().getClassName());
        assertEquals("dev.boujoy.personalagent",intent.getStringExtra("extra_pkgname"));
        assertEquals(1,intent.getExtras().size());
    }
    @Test public void unavailableVendorEditorFallsBackToOwnAppDetails() {
        List<Intent> opened=new ArrayList<>();
        assertTrue(RearLockscreenPermission.openSettings("dev.boujoy.personalagent",true,intent->{
            opened.add(intent);if(opened.size()==1)throw new ActivityNotFoundException();
        }));
        assertEquals(2,opened.size());assertEquals(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,opened.get(1).getAction());
        assertEquals("package:dev.boujoy.personalagent",opened.get(1).getDataString());
    }
    @Test public void otherDevicesOnlyOpenAppDetails() {
        List<Intent> opened=new ArrayList<>();
        assertTrue(RearLockscreenPermission.openSettings("own.app",false,opened::add));
        assertEquals(1,opened.size());assertEquals(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,opened.get(0).getAction());
    }
    @Test public void noAvailableSettingsSurfaceReturnsFailureWithoutClaimingAuthorization() {
        assertFalse(RearLockscreenPermission.openSettings("own.app",true,intent->{throw new SecurityException();}));
        assertEquals(UNKNOWN,RearLockscreenPermission.probe(true,()->AppOpsManager.MODE_DEFAULT));
    }
    @Test public void knownLockedDenialStopsBeforeShellWhileUnknownRemainsEligible() throws Exception {
        org.junit.Assume.assumeTrue("Xiaomi display integration is not part of the Phone Use edition",BuildConfig.BACKGROUND_SUPPORTED);
        Context context=RuntimeEnvironment.getApplication();DisplayBridge bridge=DisplayBridge.get(context);Shell shell=new Shell();
        ReflectionHelpers.setField(bridge,"remote",shell);
        DisplayBridge.AuthorizationState auth=ReflectionHelpers.getField(bridge,"authorization");auth.probe(()->"running");
        shadowOf(context.getSystemService(KeyguardManager.class)).setKeyguardLocked(true);
        ReadOnlyAppOps.mode=AppOpsManager.MODE_IGNORED;
        try {bridge.startRear();fail("Known lockscreen denial must be surfaced before shell launch");}
        catch(DisplayExecutor.BackendException error){assertEquals("REAR_LOCKSCREEN_PERMISSION_REQUIRED",error.code);assertFalse(error.started);}
        assertEquals(0,shell.commands);
        ReadOnlyAppOps.mode=AppOpsManager.MODE_DEFAULT;bridge.startRear();assertEquals(1,shell.commands);
        ReadOnlyAppOps.mode=AppOpsManager.MODE_IGNORED;shadowOf(context.getSystemService(KeyguardManager.class)).setKeyguardLocked(false);
        bridge.startRear();assertEquals(2,shell.commands);
    }
    @Test public void settingsSheetIsPassiveUntilTapAndRefreshesReturnedPermission() throws Exception {
        org.junit.Assume.assumeTrue("Xiaomi display integration is not part of the Phone Use edition",BuildConfig.BACKGROUND_SUPPORTED);
        MainActivity activity=Robolectric.buildActivity(MainActivity.class).create().get();
        NativeVisualTest.invoke(activity,"showConnection",new Class[]{String.class,org.json.JSONObject.class},"",new org.json.JSONObject());
        UiSheet dialog=(UiSheet)NativeVisualTest.field(activity,"connectionDialog");
        TextView status=(TextView)NativeVisualTest.field(activity,"rearLockscreenStatus");
        assertNotNull(status);assertTrue(status.getText().toString().contains("确认"));
        assertNull("Reading/showing permission status must not launch settings",shadowOf(activity).getNextStartedActivity());
        ReadOnlyAppOps.mode=AppOpsManager.MODE_ALLOWED;
        NativeVisualTest.invoke(activity,"refreshBackgroundStatus",new Class[]{});
        assertTrue(status.getText().toString().startsWith("已允许"));
        ReadOnlyAppOps.mode=AppOpsManager.MODE_IGNORED;
        NativeVisualTest.invoke(activity,"refreshBackgroundStatus",new Class[]{});
        assertTrue(status.getText().toString().startsWith("尚未允许"));
        View row=(View)status.getParent();while(!row.isClickable())row=(View)row.getParent();row.performClick();
        Intent opened=shadowOf(activity).getNextStartedActivity();assertNotNull(opened);
        assertEquals("miui.intent.action.APP_PERM_EDITOR",opened.getAction());
        assertEquals(activity.getPackageName(),opened.getStringExtra("extra_pkgname"));
        dialog.dismiss();activity.finish();
    }
}
