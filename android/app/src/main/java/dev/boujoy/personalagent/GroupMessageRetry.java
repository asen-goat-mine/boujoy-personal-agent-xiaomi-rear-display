package dev.boujoy.personalagent;

import org.json.JSONObject;
import java.time.Instant;

/** Interprets an authenticated receipt; never creates IDs, control epochs or deadlines. */
final class GroupMessageRetry {
    enum Decision {RECEIVED,RETRY_ORIGINAL,NOT_RECEIVED_EXPIRED,NOT_RECEIVED_PAUSED,UNKNOWN}
    static Decision decide(JSONObject receipt,JSONObject original,boolean originalEpochPermitted,long now){
        if(Boolean.TRUE.equals(receipt.opt("received")))return Decision.RECEIVED;
        if(!Boolean.FALSE.equals(receipt.opt("received"))||!"not_received".equals(receipt.optString("status")))return Decision.UNKNOWN;
        long expiry;try{expiry=Instant.parse(original.getString("expiresAt")).toEpochMilli();}catch(Exception error){return Decision.NOT_RECEIVED_EXPIRED;}
        if(expiry<=now)return Decision.NOT_RECEIVED_EXPIRED;
        return originalEpochPermitted?Decision.RETRY_ORIGINAL:Decision.NOT_RECEIVED_PAUSED;
    }
}
