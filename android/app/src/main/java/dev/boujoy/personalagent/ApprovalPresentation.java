package dev.boujoy.personalagent;

import org.json.JSONArray;
import org.json.JSONObject;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Iterator;

/** Display-only deadline state; the gateway remains the authorization authority. */
final class ApprovalPresentation {
    static boolean expired(JSONObject approval,long now) {
        long deadline=Binding.parseTime(approval.opt("expiresAt"));
        return deadline>0&&deadline<=now;
    }
    static String label(JSONObject approval,long now) {
        if(expired(approval,now))return "确认已过期 · 请重新核实";
        long deadline=Binding.parseTime(approval.opt("expiresAt"));
        if(deadline<=0)return "需要你的确认";
        String time=DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(deadline));
        return "需要你的确认 · "+time+" 前有效";
    }
    // Only a deadline crossing invalidates the cached rows, not every clock tick.
    static String revision(JSONObject snapshot,long now) {
        JSONObject details=snapshot.optJSONObject("taskDetails");if(details==null)details=new JSONObject();
        StringBuilder key=new StringBuilder();Iterator<String> ids=details.keys();
        while(ids.hasNext()) {
            String id=ids.next();JSONObject cached=details.optJSONObject(id);
            JSONObject detail=cached==null?null:cached.optJSONObject("detail");
            JSONArray approvals=detail==null?null:detail.optJSONArray("approvals");
            if(approvals==null)continue;
            for(int i=0;i<approvals.length();i++) {
                JSONObject approval=approvals.optJSONObject(i);
                if(approval!=null&&"pending".equals(approval.optString("status","pending")))key.append(id).append(':').append(i).append(':').append(expired(approval,now)).append(';');
            }
        }
        JSONArray tasks=ConversationIdentity.tasks(snapshot);for(int i=0;i<tasks.length();i++){JSONObject task=tasks.optJSONObject(i);JSONArray approvals=task==null?null:task.optJSONArray("approvals");if(approvals!=null)for(int n=0;n<approvals.length();n++){JSONObject a=approvals.optJSONObject(n);if(a!=null)key.append(a.optString("id")).append(':').append(expired(a,now));}}
        return key.toString();
    }
    static String details(JSONObject approval) {
        StringBuilder text=new StringBuilder(approval.optString("summary",approval.optString("tool","待执行操作")));
        JSONArray fields=approval.optJSONArray("details");
        if(fields!=null)for(int i=0;i<fields.length();i++){JSONObject field=fields.optJSONObject(i);if(field!=null)text.append("\n\n").append(field.optString("label")).append("：\n").append(field.optString("value"));}
        return text.toString();
    }
    private ApprovalPresentation(){}
}
