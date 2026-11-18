package dev.boujoy.personalagent;

import android.accessibilityservice.AccessibilityService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.net.Uri;
import android.view.View;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowAccessibilityService;
import org.robolectric.shadows.ShadowProcess;
import org.robolectric.util.ReflectionHelpers;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.*;

/** Runs in each release edition. These assertions inspect the merged manifest and actual entry gates. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public class EditionIsolationTest {
    @Implements(AccessibilityService.class)
    public static class DisableRecorder extends ShadowAccessibilityService {
        static int disabled;
        @Implementation protected void disableSelf(){disabled++;}
    }
    @Test @Config(shadows=DisableRecorder.class)
    public void realAccessibilityAdmissionMatchesEditionAndDisconnects()throws Exception {
        DisableRecorder.disabled=0;
        BoujoyDisplayService.setLifecycleListener(null);
        ReflectionHelpers.setStaticField(BoujoyDisplayService.class,"connected",null);
        BoujoyDisplayService.setSessionDisplay(-1);
        var controller=Robolectric.buildService(BoujoyDisplayService.class).create();
        BoujoyDisplayService service=controller.get();
        try{
            // Invoke the actual product admission; only the Android disableSelf IPC is recorded.
            service.onServiceConnected();
            assertEquals(BuildConfig.BACKGROUND_SUPPORTED,BoujoyDisplayService.ready());
            assertEquals(BuildConfig.BACKGROUND_SUPPORTED?0:1,DisableRecorder.disabled);
            if(!BuildConfig.BACKGROUND_SUPPORTED){
                BoujoyDisplayService.setSessionDisplay(7);
                DisplayExecutor.BackendException rejected=assertThrows(DisplayExecutor.BackendException.class,()->BoujoyDisplayService.snapshot(7,true));
                assertEquals("EXECUTOR_UNAVAILABLE",rejected.getMessage());
            }
        }finally{controller.destroy();BoujoyDisplayService.setSessionDisplay(-1);}
        assertFalse(BoujoyDisplayService.ready());
    }
    @Test public void realShellConstructorRejectsGenericEvenWithShellUid()throws Exception {
        Context context=RuntimeEnvironment.getApplication();
        ShadowProcess.setUid(2000);
        if(!BuildConfig.BACKGROUND_SUPPORTED){
            SecurityException rejected=assertThrows(SecurityException.class,()->new ShellDisplayService(context));
            assertEquals("background_not_supported",rejected.getMessage());
        }else{
            // Xiaomi still enforces the independent shell identity boundary.
            ShadowProcess.setUid(context.getApplicationInfo().uid);
            SecurityException rejected=assertThrows(SecurityException.class,()->new ShellDisplayService(context));
            assertEquals("shell_identity_required",rejected.getMessage());
        }
    }
    @Test public void manifestIdentityAuthoritiesAndBackgroundComponentsMatchEdition()throws Exception{
        Context context=RuntimeEnvironment.getApplication();PackageManager pm=context.getPackageManager();
        assertEquals("dev.boujoy."+BuildConfig.EDITION,context.getPackageName());
        assertEquals(BuildConfig.APPLICATION_ID,context.getPackageName());
        assertEquals("xiaomi".equals(BuildConfig.EDITION),BuildConfig.BACKGROUND_SUPPORTED);
        ProviderInfo attachment=pm.getProviderInfo(new ComponentName(context,AttachmentProvider.class),0);
        assertEquals(BuildConfig.APPLICATION_ID+".attachments",attachment.authority);
        for(Class<?> type:new Class<?>[]{DisplayWorkspaceActivity.class,RearStatusActivity.class,DisplayServiceSettingsActivity.class,HandoffActivity.class}){
            assertEquals(type.getSimpleName(),BuildConfig.BACKGROUND_SUPPORTED,pm.getActivityInfo(new ComponentName(context,type),PackageManager.MATCH_DISABLED_COMPONENTS).enabled);
        }
        assertEquals(BuildConfig.BACKGROUND_SUPPORTED,pm.getServiceInfo(new ComponentName(context,BoujoyDisplayService.class),PackageManager.MATCH_DISABLED_COMPONENTS).enabled);
        assertEquals(BuildConfig.BACKGROUND_SUPPORTED,pm.getProviderInfo(new ComponentName(context,"rikka.shizuku.ShizukuProvider"),PackageManager.MATCH_DISABLED_COMPONENTS).enabled);
        assertEquals(BuildConfig.APPLICATION_ID+".display.workspace",pm.getActivityInfo(new ComponentName(context,DisplayWorkspaceActivity.class),PackageManager.MATCH_DISABLED_COMPONENTS).taskAffinity);
    }
    @Test public void imeUsesEditionPackageAndExistingJavaClass(){
        ComponentName ime=ComponentName.unflattenFromString(BoujoyInputMethod.ID);
        assertNotNull(ime);assertEquals(BuildConfig.APPLICATION_ID,ime.getPackageName());
        assertEquals(BoujoyInputMethod.class.getName(),ime.getClassName());
        assertTrue(ConnectionService.STOP.startsWith(BuildConfig.APPLICATION_ID+"."));
    }
    @Test public void pairingSchemeDoesNotClaimPrivateOrOtherEdition(){
        Context context=RuntimeEnvironment.getApplication();PackageManager pm=context.getPackageManager();
        String other="phoneuse".equals(BuildConfig.EDITION)?"boujoy-xiaomi":"boujoy-phoneuse";
        for(String scheme:new String[]{BuildConfig.BIND_SCHEME,"boujoy",other}){
            Intent intent=new Intent(Intent.ACTION_VIEW,Uri.parse(scheme+"://bind?data=test"));
            intent.addCategory(Intent.CATEGORY_BROWSABLE).addCategory(Intent.CATEGORY_DEFAULT);
            boolean claims=pm.queryIntentActivities(intent,PackageManager.MATCH_DEFAULT_ONLY).stream().anyMatch(info->BuildConfig.APPLICATION_ID.equals(info.activityInfo.packageName));
            assertEquals(scheme,BuildConfig.BIND_SCHEME.equals(scheme),claims);
        }
    }
    @Test public void genericCannotCreateBridgePollDisplayOrReviveStoredBackgroundMode()throws Exception{
        ConnectionService service=Robolectric.buildService(ConnectionService.class).get();
        try{
            ReflectionHelpers.setField(service,"cachedState",new JSONObject().put("phoneExecution",new JSONObject().put("mode","background")));
            assertEquals(BuildConfig.BACKGROUND_SUPPORTED,service.backgroundMode());
            if(BuildConfig.BACKGROUND_SUPPORTED)return;
            ReflectionHelpers.setStaticField(DisplayBridge.class,"instance",null);
            assertThrows(IllegalStateException.class,()->DisplayBridge.get(service));
            assertNull(ReflectionHelpers.getStaticField(DisplayBridge.class,"instance"));
            var worker=Executors.newSingleThreadExecutor();
            try{worker.submit(()->ReflectionHelpers.callInstanceMethod(service,"displayLoop")).get(1,TimeUnit.SECONDS);}
            finally{worker.shutdownNow();}
            assertNull(ReflectionHelpers.getField(service,"displayBridge"));
            assertNull(ReflectionHelpers.getField(service,"displayExecutor"));
        }finally{service.onDestroy();}
    }
    @Test public void genericMainScreenAndSettingsNeverConstructDisplayBridge()throws Exception{
        if(BuildConfig.BACKGROUND_SUPPORTED)return;
        ReflectionHelpers.setStaticField(DisplayBridge.class,"instance",null);ConnectionService.current=null;
        var controller=Robolectric.buildActivity(MainActivity.class).create();MainActivity activity=controller.get();
        try{
            ReflectionHelpers.callInstanceMethod(activity,"renderHandoff",ReflectionHelpers.ClassParameter.from(boolean.class,false));
            ReflectionHelpers.callInstanceMethod(activity,"showConnection");
            assertNull(ReflectionHelpers.getStaticField(DisplayBridge.class,"instance"));
            assertNull(ReflectionHelpers.getField(activity,"shizukuStatus"));
            assertEquals(View.GONE,((View)ReflectionHelpers.getField(activity,"handoffCard")).getVisibility());
        }finally{controller.destroy();}
    }
}
