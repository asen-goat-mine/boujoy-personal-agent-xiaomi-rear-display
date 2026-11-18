package dev.boujoy.personalagent;

import org.junit.Test;
import java.util.concurrent.atomic.AtomicLong;
import static org.junit.Assert.*;

public class ClosedStreamsTest {
    @Test public void onlyKnownOpenedOrOneLocallyInitiatedLateOpenedCanDiscardBytes(){
        ClosedStreams ids=new ClosedStreams();
        assertFalse(ids.ignoreBinary(99));assertFalse(ids.acceptLateOpened(99));assertFalse(ids.contains(99));
        ids.remember(1,true,true);assertTrue(ids.ignoreBinary(1));assertFalse(ids.acceptLateOpened(1));
        ids.remember(3,false,true);assertFalse(ids.ignoreBinary(3));assertTrue(ids.acceptLateOpened(3));assertTrue(ids.ignoreBinary(3));assertFalse(ids.acceptLateOpened(3));
        ids.remember(2,false,false);assertFalse(ids.acceptLateOpened(2));assertFalse(ids.ignoreBinary(2));
    }
    @Test public void ttlAndCapacityAreBoundedAndLateFramesCannotRenewEntries(){
        AtomicLong now=new AtomicLong();ClosedStreams ids=new ClosedStreams(now::get,30,2);
        ids.remember(1,true,true);now.set(10);ids.remember(3,false,true);now.set(20);assertTrue(ids.acceptLateOpened(3));ids.remember(5,true,true);
        assertFalse(ids.contains(1));assertTrue(ids.contains(3));assertTrue(ids.contains(5));
        now.set(39);ids.remember(3,true,true);assertTrue(ids.ignoreBinary(3));now.set(40);assertFalse(ids.contains(3));assertFalse(ids.ignoreBinary(3));
        ids.clear();assertFalse(ids.contains(5));assertFalse(ids.ignoreBinary(5));
    }
}
