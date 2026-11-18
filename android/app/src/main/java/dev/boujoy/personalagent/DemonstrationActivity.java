package dev.boujoy.personalagent;

import android.app.Activity;
import android.os.*;
import android.view.WindowManager;
import android.widget.*;
import org.json.JSONObject;

/** Explicit, bounded observation session. It never requests Accessibility or screen capture. */
public final class DemonstrationActivity extends Activity {
    private final Handler handler=new Handler(Looper.getMainLooper());private TextView detail;private Button start,stop;private String taskId,sessionId="";private boolean busy;
    private final Runnable update=new Runnable(){public void run(){refresh();handler.postDelayed(this,1000);}};
    @Override public void onCreate(Bundle state){super.onCreate(state);getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);taskId=getIntent().getStringExtra("taskId");
        LinearLayout body=new LinearLayout(this);body.setOrientation(LinearLayout.VERTICAL);int pad=(int)(24*getResources().getDisplayMetrics().density);body.setPadding(pad,pad,pad,pad);
        TextView title=new TextView(this);title.setText("示范一次操作");title.setTextSize(24);body.addView(title);detail=new TextView(this);detail.setTextSize(17);detail.setText(R.string.demonstration_help);body.addView(detail);
        start=new Button(this);start.setText("开始记录页面变化");start.setOnClickListener(v->{ConnectionService service=ConnectionService.current;if(service==null||taskId==null)return;busy=true;start.setEnabled(false);service.startDemonstration(taskId,(result,error)->handler.post(()->{busy=false;if(error!=null){detail.setText(error.getMessage());start.setEnabled(true);}else{sessionId=result.optString("id");detail.setText(R.string.demonstration_started);stop.setEnabled(true);}}));});body.addView(start);
        stop=new Button(this);stop.setText("结束示范并生成草稿");stop.setEnabled(false);stop.setOnClickListener(v->{ConnectionService service=ConnectionService.current;if(service==null||sessionId.isBlank())return;busy=true;stop.setEnabled(false);service.stopDemonstration(sessionId,(result,error)->handler.post(()->{busy=false;if(error!=null)detail.setText(error.getMessage());else show(result);}));});body.addView(stop);
        Button back=new Button(this);back.setText("返回聊天");back.setOnClickListener(v->finish());body.addView(back);setContentView(body);
    }
    private void refresh(){if(busy)return;ConnectionService service=ConnectionService.current;if(service==null)return;JSONObject state=service.snapshot().optJSONObject("state"),demo=state==null?null:state.optJSONObject("demonstration");if(demo!=null&&(sessionId.equals(demo.optString("id"))||taskId!=null&&taskId.equals(demo.optString("sourceTaskId"))))show(demo);}
    private void show(JSONObject demo){sessionId=demo.optString("id");boolean recording="recording".equals(demo.optString("status"));start.setEnabled(!recording);stop.setEnabled(recording);String text=recording?"正在记录页面变化（"+demo.optInt("pageCount")+" 页）。你自己操作，Boujoy 不点击。":"示范已结束，共记录 "+demo.optInt("pageCount")+" 个不同页面。";if(demo.has("draftId"))text+="\n已保存未验证工作流草稿。";if(demo.has("error"))text+="\n未生成可用草稿："+demo.optString("error");detail.setText(text);}
    @Override protected void onResume(){super.onResume();handler.post(update);}
    @Override protected void onPause(){handler.removeCallbacks(update);super.onPause();}
}
