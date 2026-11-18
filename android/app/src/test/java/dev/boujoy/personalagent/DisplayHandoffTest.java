package dev.boujoy.personalagent;
import org.junit.Test;
import static org.junit.Assert.*;
public class DisplayHandoffTest {
    private DisplayHandoff pending(){DisplayHandoff h=new DisplayHandoff();h.begin("id","task","title","summary",1000,500);return h;}
    @Test public void failedRetryRetainsOriginalDeadlineUntilTaken(){
        DisplayHandoff h=pending();long deadline=h.snapshot().optLong("expiresAtMs");
        h.transition("id","failed","move_failed","HANDOFF_MOVE_UNCONFIRMED",2000);
        assertTrue(h.retaining());assertEquals(deadline,h.snapshot().optLong("expiresAtMs"));
        h.transition("id","taken","user_take","",3000);assertFalse(h.retaining());assertEquals("taken",h.snapshot().optString("state"));
        assertFalse(h.snapshot().has("errorCode"));assertThrows(IllegalStateException.class,()->h.transition("id","failed","","",4000));
    }
    @Test public void eitherMonotonicOrWallDeadlineExpiresWithoutExtension(){
        DisplayHandoff h=pending();assertFalse(h.due(1001,501));
        assertTrue(h.due(1000+DisplayHandoff.RETENTION_MS,500));
        assertTrue(h.due(0,500+DisplayHandoff.RETENTION_MS));
        h.transition("id","expired","timeout","",1000+DisplayHandoff.RETENTION_MS);assertFalse(h.retaining());
    }
    @Test public void newSessionDismissalHasReasonAndCannotBeTaken(){
        DisplayHandoff h=pending();h.transition("id","dismissed","new_session","",2000);
        assertEquals("new_session",h.snapshot().optString("reason"));
        assertThrows(IllegalStateException.class,()->h.transition("id","taken","","",2001));
    }
    @Test public void staleIdAndOversizedMetadataAreRejected(){
        DisplayHandoff h=pending();assertThrows(IllegalStateException.class,()->h.transition("other","taken","","",2000));
        assertThrows(IllegalArgumentException.class,()->h.begin("id","task","x".repeat(41),"",1,1));
        assertThrows(IllegalArgumentException.class,()->h.begin("id","task","","x".repeat(161),1,1));
        assertThrows(IllegalArgumentException.class,()->h.begin("id"," ","","",1,1));
    }
    @Test public void snapshotsAreDetachedAndUnicodeLimitsCountCharacters()throws Exception{
        DisplayHandoff h=pending();h.snapshot().put("state","taken");assertEquals("pending",h.snapshot().optString("state"));
        h.begin("id","task","😀".repeat(40),"",1000,500);assertEquals(80,h.snapshot().getString("title").length());
    }
}
