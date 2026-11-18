package dev.boujoy.personalagent;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;
import java.util.function.LongFunction;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public class RearVisibilityTest {
    private static DisplayBridge.RearVisibility rear(long revision, boolean showing) {
        return new DisplayBridge.RearVisibility(revision,showing);
    }
    private static long await(LongFunction<DisplayBridge.RearVisibility> source, BooleanSupplier allowed, AtomicLong clock) throws Exception {
        ConnectionService.awaitRearVisible(7,()->source.apply(clock.get()),allowed,clock::get,clock::addAndGet);
        return clock.get();
    }
    @Test public void oldShowingTrueCannotAcknowledgeANewLaunch() {
        AtomicLong clock=new AtomicLong(1000);
        assertThrows(IllegalStateException.class,()->await(now->rear(7,true),()->true,clock));
        assertEquals(3000,clock.get());
    }
    @Test public void freshResumeMustStayVisibleForTwoHundredMilliseconds() throws Exception {
        AtomicLong clock=new AtomicLong(1000);
        assertEquals(1250,await(now->rear(now<1050?7:8,now>=1050),()->true,clock));
    }
    @Test public void immediatePauseAfterSuccessfulAmStartRemainsAFailure() {
        AtomicLong clock=new AtomicLong(1000);
        assertThrows(IllegalStateException.class,()->await(now->rear(now<1150?8:9,now<1150),()->true,clock));
        assertEquals(3000,clock.get());
    }
    @Test public void aLaterResumeRestartsTheStabilityWindow() throws Exception {
        AtomicLong clock=new AtomicLong(1000);
        assertEquals(1400,await(now->now<1100?rear(8,true):now<1200?rear(9,false):rear(10,true),()->true,clock));
    }
    @Test public void stopOrOptOutDuringVisibilityWaitRejectsWithoutFinishingWait() {
        AtomicLong clock=new AtomicLong(1000);
        assertThrows(IllegalStateException.class,()->await(now->rear(8,true),()->clock.get()<1150,clock));
        assertEquals(1150,clock.get());
    }
    @Test public void unobservedLifecycleAndLateFlickerCannotAcknowledge() {
        AtomicLong clock=new AtomicLong(1000);
        assertThrows(IllegalStateException.class,()->await(now->null,()->true,clock));
        clock.set(1000);
        assertThrows(IllegalStateException.class,()->await(now->rear(now<2900?7:8,now>=2900),()->true,clock));
        assertEquals(3000,clock.get());
    }
    @Test public void visibilityTimeoutUsesCoordinatorFailureBackoffInsteadOfShown() {
        AtomicLong clock=new AtomicLong(1000);AtomicInteger starts=new AtomicInteger();
        var state=new RearProgressCoordinator.State("task",4,1000,true,true,false,false);
        try(RearProgressCoordinator coordinator=new RearProgressCoordinator(Runnable::run,()->state,clock::get,allowed->{starts.incrementAndGet();await(now->rear(7,true),allowed,clock);})) {
            coordinator.onStateSynced();assertEquals(1,starts.get());assertEquals(3000,clock.get());
            clock.set(12999);coordinator.onStateSynced();assertEquals(1,starts.get());
            clock.set(13000);coordinator.onStateSynced();assertEquals(2,starts.get());
        }
    }
}
