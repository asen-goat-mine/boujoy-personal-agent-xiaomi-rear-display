package dev.boujoy.personalagent;

import org.json.JSONObject;
import java.io.IOException;
import java.security.MessageDigest;
import java.util.Set;

/** Pure protocol policy shared by the Android bridge and cross-language tests. */
public final class ShareJob {
    private static final Set<String> TARGETS=Set.of("com.tencent.mm","com.tencent.mobileqq","org.telegram.messenger","com.whatsapp","com.google.android.gm","com.microsoft.office.outlook","com.samsung.android.email.provider","com.xingin.xhs","com.ss.android.ugc.aweme","tv.danmaku.bili");
    public static boolean permitsTarget(String pkg) { return pkg != null && TARGETS.contains(pkg); }
    public static void validate(JSONObject value,long epoch,long now)throws Exception{
        if(!value.optString("jobId").matches("[a-f0-9-]{36}")||!value.optString("ticket").matches("[A-Za-z0-9_-]{40,60}")||!permitsTarget(value.optString("targetPackage"))
                ||value.optLong("controlEpoch",-1)!=epoch||Binding.parseTime(value.opt("expiresAt"))<=now||Binding.parseTime(value.opt("expiresAt"))>now+120000
                ||!value.optString("sha256").matches("[a-f0-9]{64}")||value.optLong("size")<1||value.optLong("size")>8*1024*1024
                ||!value.optString("mime").matches("[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+")||value.optString("name").isBlank()||value.optString("name").length()>160||value.optString("name").matches(".*[\\\\/\\x00-\\x1f].*"))throw new IOException("附件交接参数已失效");
        if(!value.optString("buttonText").equals("准备附件 "+value.getString("jobId").substring(0,8)))throw new IOException("附件按钮不匹配");
    }
    public static void verifyBytes(JSONObject job,byte[] bytes)throws Exception{
        StringBuilder digest=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))digest.append(String.format(java.util.Locale.ROOT,"%02x",b&255));
        if(bytes.length!=job.getLong("size")||!digest.toString().equals(job.getString("sha256")))throw new IOException("附件内容校验失败");
    }
    public static JSONObject receipt(JSONObject job,String state)throws Exception{
        JSONObject body=Tunnel.json("messageId",Protocol.id(),"ticket",job.getString("ticket"),"controlEpoch",job.getLong("controlEpoch"),"sha256",job.getString("sha256"),"status",state);
        if(job.has("dispatchAttemptId"))body.put("dispatchAttemptId",job.getString("dispatchAttemptId"));return body;
    }
    private ShareJob(){}
}
