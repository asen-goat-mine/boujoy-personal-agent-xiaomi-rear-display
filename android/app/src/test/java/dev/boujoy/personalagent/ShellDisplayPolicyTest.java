package dev.boujoy.personalagent;

import org.junit.Test;
import static org.junit.Assert.*;

/** Pure policies used by the real shell service before publishing frames or injecting input. */
public class ShellDisplayPolicyTest {
    private static final long NOW=10_000_000_000L;
    @Test public void frameMustFollowLastEffectBarrier(){
        assertTrue(ShellDisplayService.frameCurrent(NOW-10,NOW,NOW-20,NOW,1,1,true));
        assertTrue(ShellDisplayService.frameCurrent(NOW,NOW,NOW,NOW,1,1,true));
        assertFalse(ShellDisplayService.frameCurrent(NOW-30,NOW,NOW-20,NOW,1,1,true));
    }
    @Test public void timestampMustUsePlausibleMonotonicClockAtReception(){
        for(long timestamp:new long[]{0,-1,NOW+1,1})assertFalse(ShellDisplayService.frameCurrent(timestamp,NOW,0,NOW,1,1,true));
        assertTrue(ShellDisplayService.validFrameClock(NOW-5_000_000_000L,NOW));
        assertFalse(ShellDisplayService.validFrameClock(NOW-5_000_000_001L,NOW));
        assertFalse(ShellDisplayService.frameCurrent(NOW,NOW,0,NOW-1,1,1,true));
    }
    @Test public void unchangedLatestFrameStillRepresentsLiveSurfaceAfterEightSeconds(){
        long received=NOW-8_000_000_000L,timestamp=received-100_000_000L;
        assertTrue(ShellDisplayService.frameCurrent(timestamp,received,timestamp-1,NOW,4,4,true));
        // The old output cannot cross an action barrier merely because its source is still live.
        assertFalse(ShellDisplayService.frameCurrent(timestamp,received,timestamp+1,NOW,4,4,true));
    }
    @Test public void cachedFrameCannotMigrateToNewOrReleasedReader(){
        long received=NOW-8_000_000_000L,timestamp=received-10;
        assertFalse(ShellDisplayService.frameCurrent(timestamp,received,1,NOW,4,5,true));
        assertFalse(ShellDisplayService.frameCurrent(timestamp,received,1,NOW,4,4,false));
        assertFalse(ShellDisplayService.frameCurrent(timestamp,received,1,NOW,0,0,true));
    }
    @Test public void fixedReaderRequiresExactLogicalDimensions(){
        assertTrue(ShellDisplayService.displayGeometryMatches(1080,2348,1080,2348,0));
        assertFalse(ShellDisplayService.displayGeometryMatches(1080,2348,2348,1080,0));
        assertFalse(ShellDisplayService.displayGeometryMatches(1080,2348,720,1565,0));
        assertFalse(ShellDisplayService.displayGeometryMatches(1080,2348,1080,2347,0));
        assertFalse(ShellDisplayService.displayGeometryMatches(0,2348,0,2348,0));
    }
    @Test public void rotationCannotReuseRotationZeroCoordinatesEvenAtSameSize(){
        for(int rotation:new int[]{1,2,3,-1})assertFalse(ShellDisplayService.displayGeometryMatches(1080,2348,1080,2348,rotation));
    }
    @Test public void workspaceLaunchIsFixedAndCannotTargetMainOrAnotherPackage(){
        String session="712fb1a1-f8de-4201-af36-f745235a8901";
        String[] command=ShellDisplayService.workspaceLaunchCommand(BuildConfig.APPLICATION_ID,7,session);
        assertArrayEquals(new String[]{"/system/bin/am","start","-W","--display","7","-n",
                BuildConfig.APPLICATION_ID+"/dev.boujoy.personalagent.DisplayWorkspaceActivity","-f","0x18000000","--ei","expectedDisplayId","7","--es","sessionId",session},command);
        assertEquals("Boujoy session "+session,ShellDisplayService.sessionDisplayName(session));
        assertThrows(IllegalArgumentException.class,()->ShellDisplayService.workspaceLaunchCommand(BuildConfig.APPLICATION_ID,0,session));
        assertThrows(IllegalArgumentException.class,()->ShellDisplayService.workspaceLaunchCommand(BuildConfig.APPLICATION_ID,-1,session));
        assertThrows(IllegalArgumentException.class,()->ShellDisplayService.workspaceLaunchCommand("other.app",7,session));
        assertThrows(IllegalArgumentException.class,()->ShellDisplayService.workspaceLaunchCommand(BuildConfig.APPLICATION_ID,7,"1-1-1-1-1"));
    }

    @Test public void windowManagerDestroyModeMustNotBeConfusedWithDisplayInfoRemoveMode(){
        assertTrue(ShellDisplayService.displayDestroyModeConfirmed(1));
        assertFalse(ShellDisplayService.displayDestroyModeConfirmed(0));
        assertFalse(ShellDisplayService.displayDestroyModeConfirmed(2));
        assertTrue(ShellDisplayService.destroyModeConfirmed(2));
        assertFalse(ShellDisplayService.destroyModeConfirmed(1));
        assertFalse(ShellDisplayService.destroyModeConfirmed(0));
        assertFalse(ShellDisplayService.destroyModeConfirmed(-1));
    }

    @Test public void rearCanStartLockedOnlyWithFreshBackgroundPermitWithoutVirtualSession(){
        assertNull(ShellDisplayService.rearPermissionFailure(true,7,7,true,true,true));
        assertEquals("LOCKED",ShellDisplayService.rearPermissionFailure(true,7,7,true,false,true));
        assertNull(ShellDisplayService.rearPermissionFailure(true,7,7,false,false,true));
    }
    @Test public void rearStopDisconnectOrChangedEpochAlwaysRejectsEvenWhenLockAllowed(){
        assertEquals("LOCALLY_PAUSED",ShellDisplayService.rearPermissionFailure(true,7,7,true,true,false));
        assertEquals("LOCALLY_PAUSED",ShellDisplayService.rearPermissionFailure(false,7,7,true,true,true));
        assertEquals("LOCALLY_PAUSED",ShellDisplayService.rearPermissionFailure(true,7,8,true,true,true));
    }
    @Test public void rearLaunchHasOnlyTheVerifiedPhysicalDestinationAndFixedActivity(){
        assertArrayEquals(new String[]{"/system/bin/am","start","-W","--display","1","-n",
                BuildConfig.APPLICATION_ID+"/dev.boujoy.personalagent.RearStatusActivity","-f","0x18000000"},
                ShellDisplayService.rearLaunchCommand(BuildConfig.APPLICATION_ID,1,1));
        assertThrows(IllegalArgumentException.class,()->ShellDisplayService.rearLaunchCommand(BuildConfig.APPLICATION_ID,0,0));
        assertThrows(IllegalArgumentException.class,()->ShellDisplayService.rearLaunchCommand(BuildConfig.APPLICATION_ID,7,1));
        assertThrows(IllegalArgumentException.class,()->ShellDisplayService.rearLaunchCommand("other.app",1,1));
    }
    @Test public void rearAmStartMustActuallyConfirmSuccess(){
        assertTrue(ShellDisplayService.rearStartConfirmed("Starting: Intent\nStatus: ok\nComplete"));
        assertFalse(ShellDisplayService.rearStartConfirmed("Starting: Intent\nComplete"));
        assertFalse(ShellDisplayService.rearStartConfirmed("Error: launch refused"));
        assertFalse(ShellDisplayService.rearStartConfirmed("Status: ok\nSecurityException"));
        assertFalse(ShellDisplayService.rearStartConfirmed(null));
    }

}
