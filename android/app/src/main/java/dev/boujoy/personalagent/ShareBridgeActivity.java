package dev.boujoy.personalagent;

import android.app.Activity;
import android.content.*;
import android.net.Uri;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.*;
import org.json.JSONObject;

/** Package launch entry for an already-authorized attachment job; never consumes Intent extras. */
public final class ShareBridgeActivity extends Activity {
    private TextView detail;private Button dispatch;private boolean hasShareJob,reserved,intentAttempted,visible;
    @Override public void onCreate(Bundle state){
        super.onCreate(state);getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        ConnectionService service=ConnectionService.current;JSONObject job=null;try{job=service==null?null:service.pendingShare();}catch(Exception ignored){}
        if(job==null){startActivity(new Intent(this,MainActivity.class));finish();return;}
        hasShareJob=true;
        LinearLayout column=new LinearLayout(this);column.setOrientation(LinearLayout.VERTICAL);int pad=(int)(24*getResources().getDisplayMetrics().density);column.setPadding(pad,pad,pad,pad);
        TextView title=new TextView(this);title.setText("准备任务附件");title.setTextSize(24);column.addView(title);
        detail=new TextView(this);detail.setTextSize(18);detail.setText(getString(R.string.share_details,job.optString("name"),job.optString("targetLabel"),job.optLong("size"),job.optString("jobId")));detail.setContentDescription("附件任务："+job.optString("jobId"));column.addView(detail);
        dispatch=new Button(this);dispatch.setText(job.optString("buttonText"));dispatch.setEnabled("prepared".equals(job.optString("status")));column.addView(dispatch);
        TextView note=new TextView(this);note.setText(R.string.share_note);column.addView(note);
        Button stop=new Button(this);stop.setText("停止 / 接管");stop.setOnClickListener(v->{service.pauseLocal("attachment_takeover");startActivity(new Intent(this,MainActivity.class));finish();});column.addView(stop);setContentView(column);
        String jobId=job.optString("jobId");dispatch.setOnClickListener(v->{if(reserved)return;reserved=true;dispatch.setEnabled(false);service.reserveShare(jobId,(ready,error)->runOnUiThread(()->{
            if(isFinishing()||isDestroyed()||!visible){if(ready!=null)service.shareFailed(ready,"attachment_activity_closed");return;}
            if(error!=null){detail.setText("附件交接未能确认，请回任务查看。不会自动重复分发。");return;}
            try{
                if(!service.sharePermitted(ready))throw new IllegalStateException("手机已被接管");
                Uri uri=service.shareFiles.uri(ready);String target=ready.getString("targetPackage");
                Intent intent=new Intent(Intent.ACTION_SEND).setType(ready.getString("mime")).setPackage(target).putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                intent.setClipData(ClipData.newRawUri(ready.getString("name"),uri));
                // Foreground user-visible Activity, exact package, read-only grant. No background launch bypass.
                grantUriPermission(target,uri,Intent.FLAG_GRANT_READ_URI_PERMISSION);intentAttempted=true;startActivity(intent);service.shareDispatched(ready);detail.setText(getString(R.string.share_dispatched,ready.getString("targetLabel")));finish();
            }catch(Exception e){service.shareFailed(ready,"android_share_unconfirmed");detail.setText("未能确认附件交接，请回任务核实。不会自动重试。");}
        }));});
    }
    @Override public void onBackPressed(){ConnectionService service=ConnectionService.current;if(hasShareJob&&service!=null)service.pauseLocal("attachment_back_takeover");super.onBackPressed();}
    @Override protected void onResume(){super.onResume();visible=true;}
    @Override protected void onStop(){visible=false;if(hasShareJob&&!intentAttempted){ConnectionService service=ConnectionService.current;if(service!=null)service.pauseLocal("attachment_left_before_dispatch");}super.onStop();}
}
