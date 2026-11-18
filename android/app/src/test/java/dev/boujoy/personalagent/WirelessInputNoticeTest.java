package dev.boujoy.personalagent;

import org.junit.Test;
import static org.junit.Assert.*;

public class WirelessInputNoticeTest {
    @Test public void postsOnceAfterGraceAndClearsWhenServiceReturns(){
        WirelessInputNotice notice=new WirelessInputNotice();
        assertEquals(WirelessInputNotice.Action.NONE,notice.step(true,false,0));
        assertEquals("the service binds shortly after start",WirelessInputNotice.Action.NONE,notice.step(true,false,9_000));
        assertEquals(WirelessInputNotice.Action.POST,notice.step(true,false,10_000));
        assertEquals("never repeats while still off",WirelessInputNotice.Action.NONE,notice.step(true,false,60_000));
        assertEquals(WirelessInputNotice.Action.CANCEL,notice.step(true,true,61_000));
        assertEquals(WirelessInputNotice.Action.NONE,notice.step(true,true,62_000));
        assertEquals(WirelessInputNotice.Action.NONE,notice.step(true,false,70_000));
        assertEquals("a new off period posts again",WirelessInputNotice.Action.POST,notice.step(true,false,80_000));
    }
    @Test public void staysQuietBeforePairing(){
        WirelessInputNotice notice=new WirelessInputNotice();
        assertEquals(WirelessInputNotice.Action.NONE,notice.step(false,false,0));
        assertEquals(WirelessInputNotice.Action.NONE,notice.step(false,false,60_000));
    }
}
