package dev.boujoy.personalagent;

import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.ComponentName;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class DisplayWorkspaceActivityTest {
    private static final String SESSION="712fb1a1-f8de-4201-af36-f745235a8901";
    private static final String NAME="Boujoy session "+SESSION;
    @Test public void destinationRequiresExactNonPrimaryOwnedSessionDisplay(){
        assertTrue(DisplayWorkspaceActivity.acceptsDisplay(7,7,SESSION,NAME));
        assertFalse(DisplayWorkspaceActivity.acceptsDisplay(0,0,SESSION,NAME));assertFalse(DisplayWorkspaceActivity.acceptsDisplay(-1,-1,SESSION,NAME));
        assertFalse(DisplayWorkspaceActivity.acceptsDisplay(7,0,SESSION,NAME));assertFalse(DisplayWorkspaceActivity.acceptsDisplay(7,8,SESSION,NAME));
    }
    @Test public void rearOrAnotherSessionNameIsRejectedEvenWithMatchingDisplayId(){
        assertFalse(DisplayWorkspaceActivity.acceptsDisplay(1,1,SESSION,"Xiaomi rear display"));
        assertFalse(DisplayWorkspaceActivity.acceptsDisplay(7,7,SESSION,"Boujoy session 712fb1a1-f8de-4201-af36-f745235a8902"));
        assertFalse(DisplayWorkspaceActivity.acceptsDisplay(7,7,SESSION,null));
    }
    @Test public void missingMalformedAndNonCanonicalSessionIdsCannotNameAWorkspace(){
        for(String invalid:new String[]{null,"","not-a-uuid","1-1-1-1-1","zzzzzzzz-ffff-ffff-ffff-ffffffffffff"})
            assertFalse(DisplayWorkspaceActivity.acceptsDisplay(7,7,invalid,"Boujoy session "+invalid));
    }
    @Test public void lockedPhoneOnlyAllowsADisplayTheSystemKeepsUnlocked(){
        assertTrue(DisplayWorkspaceActivity.keyguardAllows(false,false,0));
        assertFalse(DisplayWorkspaceActivity.keyguardAllows(true,true,0));
        assertFalse(DisplayWorkspaceActivity.keyguardAllows(false,true,0));
        assertFalse("other display flags do not count",DisplayWorkspaceActivity.keyguardAllows(true,true,(1<<8)|(1<<10)));
        assertTrue(DisplayWorkspaceActivity.keyguardAllows(true,true,DisplayWorkspaceActivity.DISPLAY_FLAG_ALWAYS_UNLOCKED));
        assertEquals(1<<9,DisplayWorkspaceActivity.DISPLAY_FLAG_ALWAYS_UNLOCKED);
    }
    @Test public void missingDestinationFinishesBeforeCreatingContent(){
        DisplayWorkspaceActivity activity=Robolectric.buildActivity(DisplayWorkspaceActivity.class).create().get();
        assertTrue(activity.isFinishing());
    }
    @Test public void explicitVirtualDestinationCannotFallBackToPrimary(){
        Intent intent=new Intent().putExtra(DisplayWorkspaceActivity.EXPECTED_DISPLAY_ID,7).putExtra(DisplayWorkspaceActivity.EXPECTED_SESSION_ID,SESSION);
        DisplayWorkspaceActivity activity=Robolectric.buildActivity(DisplayWorkspaceActivity.class,intent).create().get();
        assertTrue(activity.isFinishing());
    }
    @Test public void manifestRequiresShellPermissionAndSeparateTask()throws Exception {
        ActivityInfo info=RuntimeEnvironment.getApplication().getPackageManager().getActivityInfo(new ComponentName(RuntimeEnvironment.getApplication(),DisplayWorkspaceActivity.class),android.content.pm.PackageManager.MATCH_DISABLED_COMPONENTS);
        assertTrue(info.exported);assertEquals("android.permission.DUMP",info.permission);
        assertEquals(BuildConfig.APPLICATION_ID+".display.workspace",info.taskAffinity);
        assertEquals(BuildConfig.BACKGROUND_SUPPORTED,info.enabled);
        assertTrue((info.flags&ActivityInfo.FLAG_EXCLUDE_FROM_RECENTS)!=0);
    }
}
