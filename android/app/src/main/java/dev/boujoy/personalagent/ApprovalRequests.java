package dev.boujoy.personalagent;

import org.json.JSONObject;
import java.util.*;

/** An exact approval cannot be submitted twice while its receipt is pending or accepted. */
final class ApprovalRequests {
    private final Map<String,JSONObject> rows=new LinkedHashMap<>();
    synchronized boolean begin(String id,String fingerprint){
        JSONObject row=rows.get(id);
        if(row!=null&&fingerprint.equals(row.optString("fingerprint"))&&Set.of("sending","accepted").contains(row.optString("status")))return false;
        rows.put(id,Tunnel.json("fingerprint",fingerprint,"status","sending"));return true;
    }
    synchronized void finish(String id,String fingerprint,boolean accepted){
        JSONObject row=rows.get(id);if(row==null||!fingerprint.equals(row.optString("fingerprint")))return;
        rows.put(id,Tunnel.json("fingerprint",fingerprint,"status",accepted?"accepted":"unconfirmed"));
        if(rows.size()>128){Iterator<String> it=rows.keySet().iterator();while(rows.size()>128&&it.hasNext()){String key=it.next();if(!"sending".equals(rows.get(key).optString("status")))it.remove();}}
    }
    synchronized JSONObject snapshot(){return new JSONObject(rows);}
    static String status(JSONObject snapshot,JSONObject approval){
        JSONObject all=snapshot.optJSONObject("approvalRequests"),row=all==null?null:all.optJSONObject(approval.optString("id"));
        return row!=null&&row.optString("fingerprint").equals(approval.optString("fingerprint"))?row.optString("status"):"";
    }
}
