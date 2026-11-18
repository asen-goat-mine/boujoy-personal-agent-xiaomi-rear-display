package dev.boujoy.personalagent;

import android.app.*;
import android.content.*;
import android.graphics.*;
import android.os.*;
import android.view.*;
import android.widget.*;
import org.json.*;
import java.util.*;

/** Ephemeral task-page viewer. No arbitrary URL, desktop, coordinate or file access. */
public final class BrowserActivity extends Activity {
    private final Handler main=new Handler(Looper.getMainLooper());
    private String taskId;
    private JSONObject session,frame;
    private ImageView image;
    private TextView status;
    private LinearLayout elements;
    private Bitmap bitmap;
    private boolean busy,closing;
    private final BroadcastReceiver updates=new BroadcastReceiver(){public void onReceive(Context c,Intent i){
        ConnectionService service=ConnectionService.current;
        if(session!=null&&(service==null||!service.snapshot().optBoolean("online")||service.snapshot().optLong("controlEpoch",-1)!=session.optLong("controlEpoch"))){clearFrame();status.setText("连接或控制状态已变化；任务保持暂停，请重新接管。");}
    }};
    private Button button(String label,Runnable action){Button b=new Button(this);b.setText(label);b.setAllCaps(false);b.setOnClickListener(v->{if(!busy)action.run();});return b;}
    @Override public void onCreate(Bundle saved){
        super.onCreate(saved);getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        taskId=getIntent().getStringExtra("taskId");
        LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setPadding(20,16,20,16);
        TextView title=new TextView(this);title.setText("电脑工作页");title.setTextSize(24);root.addView(title);
        status=new TextView(this);status.setText("正在暂停任务并接管这个页面…");root.addView(status);
        LinearLayout controls=new LinearLayout(this);
        controls.addView(button("刷新",this::refresh));controls.addView(button("上翻",()->act(Tunnel.json("action","scroll","direction","up"))));controls.addView(button("下翻",()->act(Tunnel.json("action","scroll","direction","down"))));root.addView(controls);
        Button stop=new Button(this);stop.setText("停止 / 返回聊天");stop.setOnClickListener(v->{closing=true;ConnectionService active=ConnectionService.current;if(active!=null)active.pauseLocal("explicit_browser_stop");finish();});root.addView(stop);
        ScrollView scroll=new ScrollView(this);LinearLayout contents=new LinearLayout(this);contents.setOrientation(LinearLayout.VERTICAL);
        image=new ImageView(this);image.setAdjustViewBounds(true);contents.addView(image,new LinearLayout.LayoutParams(-1,-2));
        elements=new LinearLayout(this);elements.setOrientation(LinearLayout.VERTICAL);contents.addView(elements);scroll.addView(contents);root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        root.addView(button("交还并继续原任务",()->new AlertDialog.Builder(this).setTitle("继续原任务？").setMessage("将退出人工操作，让助理重新读取当前页面并继续。原任务期限保持不变。").setNegativeButton("取消",null).setPositiveButton("交还并继续",(d,w)->finishWorkspace(true)).show()));
        root.addView(button("关闭，保持暂停",()->finishWorkspace(false)));setContentView(root);
        ConnectionService service=ConnectionService.current;if(service==null){status.setText("连接服务未就绪");return;}busy=true;
        service.browserBegin(taskId,(value,error)->main.post(()->{busy=false;if(closing)return;if(error!=null){fail(error);return;}session=value;refresh();}));
    }
    @Override protected void onResume(){super.onResume();registerReceiver(updates,new IntentFilter(ConnectionService.UPDATE),Context.RECEIVER_NOT_EXPORTED);}
    @Override protected void onPause(){super.onPause();try{unregisterReceiver(updates);}catch(Exception ignored){}clearFrame();if(!closing){closing=true;ConnectionService service=ConnectionService.current;if(service!=null)service.pauseLocal("browser_workspace_backgrounded");finish();}}
    private void refresh(){if(session==null||busy||closing)return;ConnectionService service=ConnectionService.current;if(service==null)return;busy=true;clearFrame();status.setText("正在读取当前页面…");
        service.browserRequest(taskId,session,"frame",new JSONObject(),(value,error)->main.post(()->{busy=false;if(closing)return;if(error!=null){fail(error);return;}frame=value;
            try{byte[] bytes=Base64.getDecoder().decode(value.getString("imageBase64"));bitmap=BitmapFactory.decodeByteArray(bytes,0,bytes.length);if(bitmap==null)throw new IllegalArgumentException("画面无法读取");image.setImageBitmap(bitmap);status.setText(getString(R.string.browser_paused,value.optString("title","工作页")));
                JSONArray controls=value.getJSONArray("elements");for(int n=0;n<controls.length();n++){JSONObject element=controls.getJSONObject(n);if(element.optBoolean("disabled"))continue;String label=element.optString("text"),tag=element.optString("tag");if(label.isBlank())label=tag+" #"+element.optInt("index");final int index=element.getInt("index");
                    if(Set.of("input","textarea").contains(tag)&&!Set.of("button","submit","checkbox","radio","file","hidden").contains(element.optString("type"))){String hint=label;elements.addView(button("填写 · "+label,()->{EditText text=new EditText(this);text.setHint(hint);new AlertDialog.Builder(this).setTitle("填写当前控件").setView(text).setNegativeButton("取消",null).setPositiveButton("填写",(d,w)->act(Tunnel.json("action","fill","index",index,"text",text.getText().toString()))).show();}));}
                    else if(!"file".equals(element.optString("type")))elements.addView(button(label,()->act(Tunnel.json("action","click","index",index))));
                }
            }catch(Exception e){fail(e);}
        }));
    }
    private void act(JSONObject args){if(frame==null||session==null||busy||closing)return;ConnectionService service=ConnectionService.current;if(service==null)return;busy=true;
        try{args.put("frameId",frame.getString("frameId"));}catch(Exception e){busy=false;fail(e);return;}clearFrame();status.setText("正在处理你的操作…");
        service.browserRequest(taskId,session,"act",args,(reply,error)->main.post(()->{busy=false;if(closing)return;if(error!=null){fail(error);return;}refresh();}));
    }
    private void finishWorkspace(boolean resume){if(busy||closing)return;if(session==null){closing=true;finish();return;}ConnectionService service=ConnectionService.current;if(service==null)return;busy=true;clearFrame();
        service.browserFinish(taskId,session,resume,(reply,error)->main.post(()->{busy=false;if(closing)return;if(error!=null&&resume){fail(error);return;}closing=true;if(error!=null)service.pauseLocal("browser_close_unconfirmed");if(resume)setResult(RESULT_OK,new Intent().putExtra("explicitHandoff",true));finish();}));
    }
    private void clearFrame(){frame=null;if(image!=null)image.setImageDrawable(null);if(bitmap!=null){bitmap.recycle();bitmap=null;}if(elements!=null)elements.removeAllViews();}
    private void fail(Exception error){clearFrame();status.setText(getString(R.string.browser_error,error.getMessage()==null?"工作页暂不可用":error.getMessage()));}
    @Override public void onBackPressed(){finishWorkspace(false);}
    @Override protected void onDestroy(){clearFrame();super.onDestroy();}
}
