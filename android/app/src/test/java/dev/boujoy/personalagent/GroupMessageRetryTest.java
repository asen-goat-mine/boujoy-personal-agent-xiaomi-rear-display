package dev.boujoy.personalagent;
import org.junit.Test;
import org.json.JSONObject;
import static org.junit.Assert.*;

public class GroupMessageRetryTest {
    private JSONObject original()throws Exception{return new JSONObject().put("messageId","same-id").put("controlEpoch",7).put("expiresAt","2026-11-02T12:05:00Z").put("content","查资料");}
    private JSONObject missing()throws Exception{return new JSONObject().put("received",false).put("status","not_received");}
    @Test public void confirmedMissingWithinOriginalBoundsRetriesWithoutChangingTheEnvelope()throws Exception{
        JSONObject body=original();String before=body.toString();long now=java.time.Instant.parse("2026-11-02T12:04:59Z").toEpochMilli();
        assertEquals(GroupMessageRetry.Decision.RETRY_ORIGINAL,GroupMessageRetry.decide(missing(),body,true,now));assertEquals(before,body.toString());
    }
    @Test public void confirmedMissingAfterDeadlineOrControlChangeReleasesPendingForExplicitNewSubmission()throws Exception{
        JSONObject body=original();long expires=java.time.Instant.parse(body.getString("expiresAt")).toEpochMilli();
        assertEquals(GroupMessageRetry.Decision.NOT_RECEIVED_EXPIRED,GroupMessageRetry.decide(missing(),body,true,expires));
        assertEquals(GroupMessageRetry.Decision.NOT_RECEIVED_PAUSED,GroupMessageRetry.decide(missing(),body,false,expires-1));
    }
    @Test public void acceptedReceiptSurvivesEpochChangesButUncertainReceiptNeverResends()throws Exception{
        JSONObject body=original();assertEquals(GroupMessageRetry.Decision.RECEIVED,GroupMessageRetry.decide(new JSONObject().put("received",true),body,false,Long.MAX_VALUE));
        assertEquals(GroupMessageRetry.Decision.UNKNOWN,GroupMessageRetry.decide(new JSONObject(),body,true,0));
        assertEquals(GroupMessageRetry.Decision.UNKNOWN,GroupMessageRetry.decide(new JSONObject().put("received",false),body,true,0));
    }
}
