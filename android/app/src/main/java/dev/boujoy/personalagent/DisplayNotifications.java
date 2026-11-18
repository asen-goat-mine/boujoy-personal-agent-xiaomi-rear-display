package dev.boujoy.personalagent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import org.json.JSONObject;

/** Local, immutable notification destinations. A notification never moves an application itself. */
final class DisplayNotifications {
    static final String CHANNEL="boujoy-display-attention";
    static final String ACCESSIBILITY_DETAILS="android.settings.ACCESSIBILITY_DETAILS_SETTINGS";
    static final String DISMISS=BuildConfig.APPLICATION_ID+".DISMISS_DISPLAY_HANDOFF";
    static final String HANDOFF_EXTRA="handoffId";
    private static final String TAG="display-attention";
    private static final int HANDOFF=21,SHIZUKU=22,EXECUTOR=23;
    private final Context context;
    private final NotificationManager manager;
    private String handoffFingerprint="";
    private boolean shizukuPosted,executorPosted;
    DisplayNotifications(Context context) {
        this.context=context.getApplicationContext();manager=context.getSystemService(NotificationManager.class);
        NotificationChannel channel=new NotificationChannel(CHANNEL,"后台执行与页面接手",NotificationManager.IMPORTANCE_DEFAULT);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);manager.createNotificationChannel(channel);
    }
    static boolean actionable(JSONObject handoff,long now) {
        if(handoff==null||handoff.optString("handoffId").isBlank())return false;
        String state=handoff.optString("state");
        return ("pending".equals(state)||"failed".equals(state))&&handoff.optLong("expiresAtMs",0)>now;
    }
    /** Separate presentation identity: never becomes a Mac command or DisplayExecutor.activeTaskId. */
    static String rearCandidate(JSONObject handoff,String activeTask,long now) {
        return actionable(handoff,now)?"handoff:"+handoff.optString("handoffId"):activeTask;
    }
    private static String bounded(String value,int limit) {
        if(value==null)return "";
        String cleaned=value.replaceAll("[\\p{Cntrl}]"," ").trim();
        int count=cleaned.codePointCount(0,cleaned.length());
        return count<=limit?cleaned:cleaned.substring(0,cleaned.offsetByCodePoints(0,limit));
    }
    static Notification handoffNotification(Context context,JSONObject value,PendingIntent take,PendingIntent dismiss) {
        String title=bounded(value.optString("title"),40);
        if(title.isBlank())title="这个页面";
        String heading="failed".equals(value.optString("state"))?"没能移到主屏，请稍后重试":title+" 需要你接手";
        Notification publicVersion=new Notification.Builder(context,CHANNEL).setSmallIcon(R.drawable.ic_boujoy)
                .setContentTitle("Boujoy 需要你接手").setContentText("解锁后查看").build();
        return new Notification.Builder(context,CHANNEL).setSmallIcon(R.drawable.ic_boujoy)
                .setContentTitle(heading).setContentText(bounded(value.optString("summary"),160))
                .setContentIntent(take).setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(publicVersion)
                .setOnlyAlertOnce(true).setOngoing(true)
                .addAction(new Notification.Action.Builder(null,"在主屏接手",take).build())
                .addAction(new Notification.Action.Builder(null,"不用了",dismiss).build()).build();
    }
    static Intent accessibilityIntent(Context context) {
        return new Intent(ACCESSIBILITY_DETAILS)
                .putExtra(Intent.EXTRA_COMPONENT_NAME,new ComponentName(context,BoujoyDisplayService.class))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }
    static Intent dismissIntent(Context context,String id) {
        return new Intent(context,ConnectionService.class).setAction(DISMISS)
                .setData(Uri.parse(BuildConfig.BIND_SCHEME+"://display-handoff/"+Uri.encode(id))).putExtra(HANDOFF_EXTRA,id);
    }
    void refresh(JSONObject handoff,AvailabilityNotice.Update availability,long now) {
        NotificationChannel channel=manager.getNotificationChannel(CHANNEL);
        if(!manager.areNotificationsEnabled()||channel==null||channel.getImportance()==NotificationManager.IMPORTANCE_NONE){
            handoffFingerprint="";shizukuPosted=false;executorPosted=false;return;
        }
        updateHandoff(handoff,now);
        if(availability.showShizuku()!=shizukuPosted) {
            if(!availability.showShizuku()){manager.cancel(TAG,SHIZUKU);shizukuPosted=false;}
            else try {
                Intent launch=context.getPackageManager().getLaunchIntentForPackage("moe.shizuku.privileged.api");
                String body="点此打开 Shizuku，由你手动启动";
                if(launch==null){launch=new Intent(context,MainActivity.class);body="打开 Boujoy 检查 Shizuku 是否已安装";}
                postAvailability(SHIZUKU,"后台执行需要启动 Shizuku",body,launch);shizukuPosted=true;
            }catch(RuntimeException ignored){}
        }
        if(availability.showExecutor()!=executorPosted) {
            if(!availability.showExecutor()){manager.cancel(TAG,EXECUTOR);executorPosted=false;}
            else try {
                // HyperOS may resolve the detail page but deny its launch. The user-click
                // trampoline catches that actual failure and falls back to the system list.
                Intent launch=new Intent(context,DisplayServiceSettingsActivity.class);
                postAvailability(EXECUTOR,"后台执行服务被系统关闭了，点此重新开启","在系统设置中手动开启「Boujoy 后台执行」",launch);executorPosted=true;
            }catch(RuntimeException ignored){}
        }
    }
    private void updateHandoff(JSONObject handoff,long now) {
        String fingerprint=handoff==null?"":handoff.toString();
        boolean pending=actionable(handoff,now);
        if(!pending)fingerprint=handoff!=null&&"dismissed".equals(handoff.optString("state"))&&"new_session".equals(handoff.optString("reason"))?"closed:"+handoff.optString("handoffId"):"";
        if(fingerprint.equals(handoffFingerprint))return;
        try {
            if(pending) {
                String id=handoff.optString("handoffId");
                PendingIntent take=HandoffActivity.pendingIntent(context,id);
                PendingIntent dismiss=PendingIntent.getService(context,HANDOFF,dismissIntent(context,id),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
                manager.notify(TAG,HANDOFF,handoffNotification(context,handoff,take,dismiss));
            }else if(fingerprint.startsWith("closed:")) {
                PendingIntent open=PendingIntent.getActivity(context,HANDOFF,new Intent(context,MainActivity.class),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
                manager.notify(TAG,HANDOFF,new Notification.Builder(context,CHANNEL).setSmallIcon(R.drawable.ic_boujoy)
                        .setContentTitle("上次留下的页面已关闭").setContentText("新任务已开始").setContentIntent(open)
                        .setAutoCancel(true).setOnlyAlertOnce(true).setVisibility(Notification.VISIBILITY_PRIVATE).build());
            }else manager.cancel(TAG,HANDOFF);
            handoffFingerprint=fingerprint;
        }catch(RuntimeException ignored){} // The local UI remains available if notification permission is off.
    }
    private void postAvailability(int id,String title,String body,Intent destination) {
        PendingIntent open=PendingIntent.getActivity(context,id,destination,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        manager.notify(TAG,id,new Notification.Builder(context,CHANNEL).setSmallIcon(R.drawable.ic_boujoy)
                .setContentTitle(title).setContentText(body).setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).build());
    }
    void close(){manager.cancel(TAG,HANDOFF);manager.cancel(TAG,SHIZUKU);manager.cancel(TAG,EXECUTOR);}
}
