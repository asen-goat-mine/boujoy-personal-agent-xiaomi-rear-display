package dev.boujoy.personalagent;

import org.json.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** A durable endpoint ledger suppresses duplicate reminders from polling and reconnects. */
public final class TaskNotifications {
    public record Alert(String taskId,String title,String body,String fingerprint,String taskStatus,String notice) {}
    public record Update(JSONObject ledger,List<Alert> alerts) {}
    public static Update consume(JSONObject previous,JSONArray tasks)throws Exception{
        boolean initialized=previous.optBoolean("initialized");JSONObject seen=previous.optJSONObject("tasks");
        if(seen==null)seen=new JSONObject();else seen=new JSONObject(seen.toString());
        JSONObject delivery=previous.optJSONObject("delivery");delivery=delivery==null?new JSONObject():new JSONObject(delivery.toString());List<Alert> alerts=new ArrayList<>();
        for(int i=0;i<tasks.length();i++){
            JSONObject task=tasks.optJSONObject(i);if(task==null)continue;
            String id=task.optString("id"),status=task.optString("status");if(id.isBlank())continue;
            JSONArray fingerprintFields=new JSONArray().put(status).put(task.optString("result")).put(task.optString("blockedReason"));
            String legacyFingerprint=fingerprint(fingerprintFields),notice=task.optString("notice");
            if(!notice.isBlank())fingerprintFields.put(notice);
            String fingerprint=fingerprint(fingerprintFields);
            String title=switch(notice){case "watch"->"跟进有新消息";case "routine"->"例行事务结果";case "dispatch"->"有一条新通知";default->title(status);};
            JSONObject record=delivery.optJSONObject(id);
            // Upgrade a previously delivered/historical notice in place. Quiet-deferred
            // notices remain eligible, since they were never actually shown.
            if(!previous.optBoolean("noticeAware")&&record!=null&&legacyFingerprint.equals(record.optString("fingerprint"))&&Set.of("posted","historical").contains(record.optString("status")))record.put("fingerprint",fingerprint);
            if(record==null||!fingerprint.equals(record.optString("fingerprint"))){record=new JSONObject().put("taskId",id).put("fingerprint",fingerprint).put("taskStatus",status).put("status",initialized?"pending":"historical").put("attempts",0);delivery.put(id,record);}
            if(initialized&&!title.isBlank()&&!Set.of("posted","historical").contains(record.optString("status"))){
                String body=(!notice.isBlank()&&!task.optString("result").isBlank()?task.optString("result"):task.optString("title","打开 Boujoy 查看任务")).replaceAll("[\\p{Cntrl}]"," ");
                alerts.add(new Alert(id,title,body.length()>100?body.substring(0,100):body,fingerprint,status,notice));
            }
            seen.put(id,fingerprint);
        }
        // Prune only old task IDs; the current snapshot remains represented across recreation.
        if(seen.length()>2000){JSONObject compact=new JSONObject();for(int i=0;i<tasks.length();i++){JSONObject task=tasks.optJSONObject(i);if(task!=null){String id=task.optString("id");if(seen.has(id))compact.put(id,seen.get(id));}}seen=compact;}
        if(delivery.length()>2000){JSONObject compact=new JSONObject();for(int i=0;i<tasks.length();i++){String id=tasks.optJSONObject(i).optString("id");if(delivery.has(id))compact.put(id,delivery.get(id));}delivery=compact;}
        return new Update(new JSONObject().put("initialized",true).put("noticeAware",true).put("tasks",seen).put("delivery",delivery),alerts);
    }
    private static String fingerprint(JSONArray fields)throws Exception{return Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(fields.toString().getBytes(StandardCharsets.UTF_8)));}
    public static JSONObject outcome(JSONObject ledger,Alert alert,String status,long at)throws Exception{
        if(!Set.of("posted","permission_denied","deferred_quiet","retry").contains(status))throw new IllegalArgumentException("Unknown notification outcome");
        JSONObject next=new JSONObject(ledger.toString()),record=next.getJSONObject("delivery").optJSONObject(alert.taskId());
        if(record==null||!record.optString("fingerprint").equals(alert.fingerprint()))return next;
        if(!status.equals(record.optString("status"))||status.equals("retry")){record.put("status",status).put("updatedAt",at);if(status.equals("posted")||status.equals("retry"))record.put("attempts",record.optInt("attempts")+1);}return next;
    }
    public static boolean quietSuppresses(Alert alert){return !Set.of("watch","routine","dispatch").contains(alert.notice())&&Set.of("completed","succeeded","stopped","cancelled","paused").contains(alert.taskStatus());}
    public static JSONArray report(JSONObject ledger)throws Exception{
        JSONObject records=ledger.optJSONObject("delivery");JSONArray result=new JSONArray();if(records==null)return result;
        List<String> keys=new ArrayList<>();records.keys().forEachRemaining(keys::add);keys.sort(Comparator.comparingLong((String id)->records.optJSONObject(id).optLong("updatedAt")).reversed());
        for(String id:keys.subList(0,Math.min(keys.size(),200))){JSONObject row=records.getJSONObject(id);if(!"historical".equals(row.optString("status")))result.put(new JSONObject(row.toString()));}return result;
    }
    static String title(String status){return switch(status){
        case "ready_for_user"->"已准备好，请你接着付款";
        case "completed","succeeded"->"任务已完成";
        case "unknown_result"->"操作结果需要核实";
        case "waiting_approval","waiting_consent"->"有一项操作需要你确认";
        case "waiting_setup","waiting_user","blocked"->"任务需要你接着处理";
        case "failed"->"任务未完成";
        case "expired"->"任务已到时限";
        case "stopped","cancelled","paused"->"任务已停止";
        default->"";
    };}
}
