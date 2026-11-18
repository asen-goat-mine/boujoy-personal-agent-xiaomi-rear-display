package dev.boujoy.personalagent;

import org.junit.Test;
import static org.junit.Assert.*;

public class AvailabilityNoticeTest {
    @Test public void unavailableNoticesAreOnlyForBackgroundAndRecoverAutomatically(){
        AvailabilityNotice notice=new AvailabilityNotice();
        assertFalse(notice.step(false,"not_running",false).showShizuku());
        AvailabilityNotice.Update missing=notice.step(true,"not_running",false);
        assertTrue(missing.showShizuku());assertTrue(missing.showExecutor());
        AvailabilityNotice.Update restored=notice.step(true,"running",true);
        assertFalse(restored.showShizuku());assertFalse(restored.showExecutor());
        assertFalse(notice.step(false,"not_running",false).showExecutor());
    }
    @Test public void disconnectMetadataIsOncePerRealTransitionNotEveryTick(){
        AvailabilityNotice notice=new AvailabilityNotice();
        assertFalse(notice.step(true,"not_running",false).executorDisconnected());
        notice.step(true,"running",true);
        AvailabilityNotice.Update lost=notice.step(true,"not_running",false);
        assertTrue(lost.executorDisconnected());assertTrue(lost.shizukuStopped());
        AvailabilityNotice.Update repeated=notice.step(true,"not_running",false);
        assertFalse(repeated.executorDisconnected());assertFalse(repeated.shizukuStopped());
        notice.step(true,"running",true);
        assertTrue(notice.step(true,"running",false).executorDisconnected());
    }
    @Test public void permissionRevocationIsNotMisreportedAsShizukuNotRunning(){
        AvailabilityNotice notice=new AvailabilityNotice();notice.step(true,"running",true);
        AvailabilityNotice.Update update=notice.step(true,"permission_required",true);
        assertFalse(update.showShizuku());assertFalse(update.shizukuStopped());
    }
}
