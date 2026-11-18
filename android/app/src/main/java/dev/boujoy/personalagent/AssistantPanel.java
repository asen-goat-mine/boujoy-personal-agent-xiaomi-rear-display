package dev.boujoy.personalagent;

import android.app.*;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.*;
import android.widget.*;
import org.json.*;
import java.util.*;

/** Assistant list and editable profile, backed only by authenticated service state. */
final class AssistantPanel {
    interface Navigation {void openRole(String id);void openTask(String id);void settings();}
    private final Activity activity;private final Navigation navigation;
    final LinearLayout root;private final LinearLayout rows;private final EditText search;private final TextView status;
    private JSONObject snapshot=new JSONObject();private String version="";private Dialog profile,editor;
    private static final int INK=0xff242426,MUTED=0xff8a8a92;
    private String selectedRole="concierge";
    private final GroupPanel groups;
    void selectedRole(String id){if(!selectedRole.equals(id)){selectedRole=id;draw();}}
    AssistantPanel(Activity activity,Navigation navigation){
        this.activity=activity;this.navigation=navigation;search=new EditText(activity);groups=new GroupPanel(activity);
        root=column();root.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,new int[]{0xfff7f7f8,0xfffbfbfc,Color.WHITE}));
        LinearLayout header=row();header.setClipChildren(false);header.setPadding(dp(22),0,dp(18),0);
        LinearLayout brand=row();brand.setGravity(Gravity.BOTTOM);TextView logo=text("boujoy",26,INK);logo.setTypeface(Typeface.create("sans-serif",Typeface.BOLD));logo.setLetterSpacing(-.05f);brand.addView(logo);
        View dot=new View(activity);dot.setBackground(bg(0xff8d79bc,5));LinearLayout.LayoutParams dotParams=new LinearLayout.LayoutParams(dp(5),dp(5));dotParams.leftMargin=dp(4);dotParams.bottomMargin=dp(5);brand.addView(dot,dotParams);header.addView(brand,new LinearLayout.LayoutParams(0,-2,1));
        for(String key:new String[]{"search","plus"}){View control=icon(key,key.equals("search")?"搜索助理或对话":"新建助理",()->{if(key.equals("search")){toggleSearch();}else edit(null);});GradientDrawable surface=new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,new int[]{Color.WHITE,0xfffcfbfe});surface.setCornerRadius(dp(24));surface.setStroke(dp(1),0xffe9e6ef);control.setBackground(new SoftSurface(activity,24,Color.WHITE,0xfffcfbfe,0xffe9e6ef,3,2,0x0a302743));LinearLayout.LayoutParams cp=new LinearLayout.LayoutParams(dp(40),dp(40));cp.leftMargin=dp(8);header.addView(control,cp);}
        root.addView(header,new LinearLayout.LayoutParams(-1,dp(76)));
        search.setTextSize(15);search.setSingleLine(true);search.setHint("搜索助理或对话");search.setVisibility(View.GONE);LinearLayout.LayoutParams searchParams=new LinearLayout.LayoutParams(-1,dp(44));searchParams.setMargins(dp(22),0,dp(22),dp(8));root.addView(search,searchParams);
        search.addTextChangedListener(new android.text.TextWatcher(){public void beforeTextChanged(CharSequence s,int a,int c,int f){}public void onTextChanged(CharSequence s,int a,int b,int c){draw();}public void afterTextChanged(android.text.Editable e){}});
        ScrollView scroll=new FadingList(activity);scroll.setFillViewport(true);scroll.setClipToPadding(false);scroll.setPadding(dp(14),dp(4),dp(14),0);rows=column();rows.setClipChildren(false);scroll.addView(rows);root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        status=text("正在连接电脑…",12,MUTED);status.setPadding(dp(28),dp(8),dp(28),0);status.setOnClickListener(v->navigation.settings());status.setContentDescription("连接状态，点此打开连接设置");root.addView(status);
        LinearLayout footer=column();footer.setPadding(dp(16),dp(10),dp(16),dp(26));
        footer.addView(button("群聊",groups::showList),new LinearLayout.LayoutParams(-1,dp(44)));
        LinearLayout footerActions=row();
        footerActions.addView(button("助理资料",()->showProfile(selectedRole)),new LinearLayout.LayoutParams(0,dp(44),1));
        LinearLayout.LayoutParams settingsParams=new LinearLayout.LayoutParams(0,dp(44),1);settingsParams.leftMargin=dp(8);
        footerActions.addView(button("设置",navigation::settings),settingsParams);
        LinearLayout.LayoutParams actionsParams=new LinearLayout.LayoutParams(-1,dp(44));actionsParams.topMargin=dp(6);
        footer.addView(footerActions,actionsParams);root.addView(footer);
    }
    /** Fade the row pixels themselves, exposing the existing page gradient underneath. */
    static final class FadingList extends ScrollView {
        private static final int[] ALPHA_STOPS={0x00000000,0x0b000000,0x28000000,0x51000000,0x80000000,0xae000000,0xd7000000,0xf4000000,0xff000000};
        private final Paint mask=new Paint(Paint.ANTI_ALIAS_FLAG);
        private final float fadeLength;
        private final android.graphics.Matrix maskPosition=new android.graphics.Matrix();
        private final Shader ramp=new LinearGradient(0,0,0,1,ALPHA_STOPS,null,Shader.TileMode.CLAMP);
        FadingList(android.content.Context context){
            super(context);fadeLength=UiSheet.dp(context,48);
            setVerticalScrollBarEnabled(false);setHorizontalScrollBarEnabled(false);
            setVerticalFadingEdgeEnabled(false);setOverScrollMode(View.OVER_SCROLL_NEVER);
            mask.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.DST_IN));
        }
        @Override protected void dispatchDraw(Canvas canvas){
            int height=getHeight(),width=getWidth();
            if(height==0||width==0||getChildCount()==0){super.dispatchDraw(canvas);return;}
            float length=Math.min(fadeLength,height/3f);
            float above=Math.max(0,getScrollY());
            float below=Math.max(0,getChildAt(0).getBottom()+getPaddingBottom()-getScrollY()-height);
            if(above==0&&below==0){super.dispatchDraw(canvas);return;}
            // ScrollView's drawing coordinates include scrollY; the fade stays at the viewport edges.
            float top=getScrollY(),bottom=top+height;
            int layer=canvas.saveLayer(0,top,width,bottom,null);
            super.dispatchDraw(canvas);
            if(above>0)fade(canvas,top,top+Math.min(length,above),width,false);
            if(below>0)fade(canvas,bottom-Math.min(length,below),bottom,width,true);
            canvas.restoreToCount(layer);
        }
        private void fade(Canvas canvas,float top,float bottom,int width,boolean reverse){
            // Grow only across pixels that have scrolled out, so the first/last row stays clear at rest.
            maskPosition.setScale(1,reverse?top-bottom:bottom-top);
            maskPosition.postTranslate(0,reverse?bottom:top);
            ramp.setLocalMatrix(maskPosition);mask.setShader(ramp);
            canvas.drawRect(0,top,width,bottom,mask);
        }
    }
    private void toggleSearch(){
        boolean open=search.getVisibility()!=View.VISIBLE;search.setVisibility(open?View.VISIBLE:View.GONE);
        android.view.inputmethod.InputMethodManager input=(android.view.inputmethod.InputMethodManager)activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE);
        if(open){search.requestFocus();search.post(()->input.showSoftInput(search,android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT));}
        else{search.setText("");search.clearFocus();input.hideSoftInputFromWindow(search.getWindowToken(),0);}
    }
    int dp(float v){return Math.round(v*activity.getResources().getDisplayMetrics().density);}
    LinearLayout column(){LinearLayout v=new LinearLayout(activity);v.setOrientation(LinearLayout.VERTICAL);return v;}
    LinearLayout row(){LinearLayout v=new LinearLayout(activity);v.setGravity(Gravity.CENTER_VERTICAL);return v;}
    TextView text(String s,int size,int color){TextView v=new TextView(activity);v.setText(s);v.setTextSize(size);v.setTextColor(color);v.setIncludeFontPadding(false);v.setLineSpacing(dp(3),1);return v;}
    GradientDrawable bg(int color,int radius){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));return d;}
    View icon(String icon,String label,Runnable click){UiIcon v=new UiIcon(activity,icon,label,click);v.setLayoutParams(new LinearLayout.LayoutParams(dp(44),dp(44)));return v;}
    Button button(String label,Runnable click){return UiSheet.button(activity,label,click);}
    JSONArray array(JSONObject o,String key){JSONArray a=o==null?null:o.optJSONArray(key);return a==null?new JSONArray():a;}
    JSONObject state(){JSONObject s=snapshot.optJSONObject("state");return s==null?new JSONObject():s;}
    JSONObject role(String id){JSONArray roles=array(state(),"roles");for(int i=0;i<roles.length();i++){JSONObject r=roles.optJSONObject(i);if(r!=null&&id.equals(r.optString("id")))return r;}return Tunnel.json("id",id,"name",id.equals("concierge")?"boujoy":"助理","botColor","violet");}
    void update(JSONObject value){snapshot=value;groups.update(value);status.setText(activity.getString(R.string.connection_status,value.optBoolean("online")?"●":"○",value.optString("status","正在连接…")));status.setVisibility(value.optBoolean("online")?View.GONE:View.VISIBLE);// Conversation rows are shown only during search. Keep the latest snapshot either way.
        String next=array(state(),"roles").toString()+(search.getText().toString().trim().isEmpty()?"":array(state(),"tasks").toString());if(!next.equals(version)){version=next;draw();}}
    private String activityTitle(JSONObject role,String key,String fallback){JSONObject first=array(role,key).optJSONObject(0);return first==null?fallback:first.optString("title",fallback);}
    void draw(){
        rows.removeAllViews();String query=search.getText().toString().trim().toLowerCase(Locale.ROOT);JSONArray roles=array(state(),"roles");
        if(roles.length()==0)roles=new JSONArray().put(Tunnel.json("id","concierge","name","boujoy","description","你的私人助理","botColor","violet"));
        int count=0;
        for(int i=0;i<roles.length();i++){JSONObject r=roles.optJSONObject(i);if(r==null||!(r.optString("name")+r.optString("description")).toLowerCase(Locale.ROOT).contains(query))continue;count++;
            String id=r.optString("id"),name=r.optString("name","助理");LinearLayout item=row();item.setPadding(dp(12),dp(10),dp(12),dp(10));item.setMinimumHeight(dp(70));
            if(id.equals(selectedRole))item.setBackground(new SoftSurface(activity,14,Color.WHITE,0xfffbfaff,0xffece8f6,8,4,0x14483770));
            FrameLayout portrait=new FrameLayout(activity);BotAvatar avatar=new BotAvatar(activity,r.optString("botColor")).breathing();avatar.setClickable(false);portrait.addView(avatar,new FrameLayout.LayoutParams(-1,-1));
            if(Set.of("busy","waiting").contains(r.optString("state"))){View stateDot=new View(activity);GradientDrawable dot=bg("busy".equals(r.optString("state"))?0xff3aa66a:0xffd4a04f,8);dot.setStroke(dp(2),Color.WHITE);stateDot.setBackground(dot);FrameLayout.LayoutParams dotParams=new FrameLayout.LayoutParams(dp(11),dp(11),Gravity.BOTTOM|Gravity.END);dotParams.rightMargin=dp(4);dotParams.bottomMargin=dp(6);portrait.addView(stateDot,dotParams);}item.addView(portrait,new LinearLayout.LayoutParams(dp(52),dp(52)));
            LinearLayout copy=column();copy.setPadding(dp(12),0,0,0);TextView title=text(name,16,INK);title.setTypeface(Typeface.create(Typeface.DEFAULT,600,false));title.setMaxLines(1);title.setEllipsize(android.text.TextUtils.TruncateAt.END);copy.addView(title);
            JSONObject last=r.optJSONObject("lastActivity");String caption="busy".equals(r.optString("state"))?"正在处理 · "+activityTitle(r,"running","你的任务"):"waiting".equals(r.optString("state"))?"等你处理 · "+activityTitle(r,"waiting","打开对话查看"):last!=null?last.optString("title"):r.optString("description","随时可以开始新对话");
            TextView detail=text(caption,12,"busy".equals(r.optString("state"))?0xff2f7a4b:"waiting".equals(r.optString("state"))?0xff9a6a1f:MUTED);detail.setTextSize(12.5f);detail.setMaxLines(1);detail.setEllipsize(android.text.TextUtils.TruncateAt.END);detail.setPadding(0,dp(2),0,0);copy.addView(detail);item.addView(copy,new LinearLayout.LayoutParams(0,-2,1));
            item.setOnClickListener(v->navigation.openRole(id));item.setOnLongClickListener(v->{showProfile(id);return true;});LinearLayout.LayoutParams itemParams=new LinearLayout.LayoutParams(-1,-2);itemParams.bottomMargin=dp(4);rows.addView(item,itemParams);
        }
        if(!query.isBlank()){
            JSONArray tasks=array(state(),"tasks");Set<String> seen=new HashSet<>();
            for(int i=tasks.length()-1;i>=0;i--){JSONObject t=tasks.optJSONObject(i);if(!ConversationIdentity.privateTask(t)||!t.optString("title").toLowerCase(Locale.ROOT).contains(query)||!seen.add(t.optString("conversationId",t.optString("id"))))continue;
                Button found=button(t.optString("title"),()->navigation.openTask(t.optString("id")));found.setGravity(Gravity.START|Gravity.CENTER_VERTICAL);rows.addView(found,new LinearLayout.LayoutParams(-1,dp(56)));count++;
            }
        }
        if(count==0){TextView empty=text("没有找到匹配的助理或对话",14,MUTED);empty.setPadding(dp(12),dp(32),0,0);rows.addView(empty);}
    }
    void showProfile(String id){
        if(profile!=null)profile.dismiss();JSONObject r=role(id);profile=new Dialog(activity);int width=Math.min(activity.getResources().getDisplayMetrics().widthPixels,dp(560));
        LinearLayout shell=column();GradientDrawable sheet=bg(Color.WHITE,0);sheet.setCornerRadii(new float[]{dp(24),dp(24),dp(24),dp(24),0,0,0,0});shell.setBackground(sheet);
        View handle=new View(activity);handle.setBackground(bg(0xffe2e1e6,3));LinearLayout.LayoutParams hp=new LinearLayout.LayoutParams(dp(38),dp(5));hp.gravity=Gravity.CENTER_HORIZONTAL;hp.topMargin=dp(8);shell.addView(handle,hp);
        LinearLayout heading=row();heading.setPadding(dp(20),dp(8),dp(10),dp(4));TextView title=text(r.optString("name"),17,INK);title.setMaxLines(1);title.setEllipsize(android.text.TextUtils.TruncateAt.END);title.setTypeface(Typeface.create(Typeface.DEFAULT,600,false));heading.addView(title,new LinearLayout.LayoutParams(0,-2,1));heading.addView(icon("close","关闭资料",()->profile.dismiss()));shell.addView(heading);shell.addView(divider(0xffefeff1),new LinearLayout.LayoutParams(-1,dp(1)));
        ScrollView scroll=new ScrollView(activity);LinearLayout body=column();body.setPadding(dp(20),dp(16),dp(20),0);scroll.addView(body);shell.addView(scroll,new LinearLayout.LayoutParams(-1,-2));
        LinearLayout intro=row();FrameLayout portrait=new FrameLayout(activity);GradientDrawable portraitBg=new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,new int[]{0xfff3f7ec,0xffe8efdd});portraitBg.setCornerRadius(dp(22));portrait.setBackground(new SoftSurface(activity,22,0xfff3f7ec,0xffe8efdd,0xccffffff,6,4,0x1a4e6c28));BotAvatar avatar=new BotAvatar(activity,r.optString("botColor"));FrameLayout.LayoutParams ap=new FrameLayout.LayoutParams(dp(64),dp(70),Gravity.TOP|Gravity.CENTER_HORIZONTAL);ap.topMargin=dp(6);portrait.addView(avatar,ap);intro.addView(portrait,new LinearLayout.LayoutParams(dp(84),dp(84)));
        LinearLayout introCopy=column();introCopy.setPadding(dp(16),0,0,0);TextView description=text(r.optString("description"),14,0xff6e6e76);introCopy.addView(description);WrapLayout chips=new WrapLayout(activity,dp(6));chips.setPadding(0,dp(8),0,0);for(String caption:new String[]{r.optInt("watchCount")+" 个跟进",r.optInt("routineCount")+" 个例行"}){TextView chip=text(caption,12,0xff5f7a33);chip.setPadding(dp(8),dp(3),dp(8),dp(3));chip.setBackground(bg(0xffeef4e4,8));chips.addView(chip);}introCopy.addView(chips);intro.addView(introCopy,new LinearLayout.LayoutParams(0,-2,1));body.addView(intro);
        TextView paletteLabel=text("配色",12,MUTED);paletteLabel.setPadding(0,dp(16),0,dp(8));body.addView(paletteLabel);LinearLayout colors=row();
        // Twelve colors in two rows of six.
        for(int i=0;i<BotAvatar.COLORS.length;i++){if(i==6){body.addView(colors,new LinearLayout.LayoutParams(Math.min(width-dp(40),dp(331)),-2));colors=row();colors.setPadding(0,dp(6),0,0);}String color=BotAvatar.COLORS[i];FrameLayout hit=new FrameLayout(activity);BotAvatar option=new BotAvatar(activity,color);option.setClickable(false);hit.setContentDescription(BotAvatar.LABELS[i]);GradientDrawable outline=bg(Color.WHITE,11);outline.setStroke(dp(1),color.equals(r.optString("botColor"))?BotAvatar.color(color):0xffececef);hit.setBackground(outline);hit.addView(option,new FrameLayout.LayoutParams(dp(30),dp(30),Gravity.CENTER));hit.setOnClickListener(v->change(id,Tunnel.json("botColor",color),()->showProfile(id)));LinearLayout.LayoutParams cp=new LinearLayout.LayoutParams(0,dp(37),1);cp.rightMargin=i%6==5?0:dp(5);colors.addView(hit,cp);}body.addView(colors,new LinearLayout.LayoutParams(Math.min(width-dp(40),dp(331)),-2));
        LinearLayout responsibilities=column();GradientDrawable border=bg(Color.WHITE,14);border.setStroke(dp(1),0xffececef);responsibilities.setBackground(border);LinearLayout.LayoutParams rp=new LinearLayout.LayoutParams(-1,-2);rp.topMargin=dp(16);body.addView(responsibilities,rp);
        JSONObject brief=r.optJSONObject("brief");String time=brief==null?"08:30":brief.optString("time","08:30");boolean enabled=brief!=null&&brief.optBoolean("enabled");LinearLayout dailyRow=row();dailyRow.setPadding(dp(14),0,dp(14),0);dailyRow.setMinimumHeight(dp(54));LinearLayout dailyCopy=column();dailyCopy.addView(text("每日简报",15,INK));TextView schedule=text("每天 "+time+" · 点击调整时间",12,MUTED);dailyCopy.addView(schedule);dailyRow.addView(dailyCopy,new LinearLayout.LayoutParams(0,-2,1));CheckBox daily=new CheckBox(activity);daily.setContentDescription("每日简报开关");daily.setChecked(enabled);daily.setButtonTintList(android.content.res.ColorStateList.valueOf(INK));daily.setMinHeight(dp(44));daily.setMinWidth(dp(44));dailyRow.addView(daily);responsibilities.addView(dailyRow);
        dailyCopy.setOnClickListener(v->{String[] parts=time.split(":");new TimePickerDialog(activity,(picker,h,m)->change(id,Tunnel.json("brief",Tunnel.json("enabled",enabled,"time",String.format(Locale.ROOT,"%02d:%02d",h,m))),()->showProfile(id)),Integer.parseInt(parts[0]),Integer.parseInt(parts[1]),true).show();});daily.setOnCheckedChangeListener((v,on)->{daily.setEnabled(false);request(id,"",Tunnel.json("brief",Tunnel.json("enabled",on,"time",time)),reply->showProfile(id),()->showProfile(id));});
        JSONArray watches=array(r,"watches");for(int i=0;i<watches.length();i++){JSONObject w=watches.optJSONObject(i);if(w==null)continue;responsibilities.addView(divider(0xfff0f0f2),new LinearLayout.LayoutParams(-1,dp(1)));LinearLayout watch=column();watch.setPadding(dp(14),dp(10),dp(14),dp(10));watch.setMinimumHeight(dp(54));watch.addView(text(("paused".equals(w.optString("status"))?"已暂停：":"正在跟进：")+w.optString("goal"),15,INK));watch.addView(text(w.optString("lastSummary","还没有新进展"),12,MUTED));responsibilities.addView(watch);}
        JSONArray notes=array(r,"notes");TextView noteTitle=text("它记住的事（"+notes.length()+"）",12,MUTED);noteTitle.setPadding(0,dp(18),0,dp(6));body.addView(noteTitle);if(notes.length()==0){TextView none=text("还没有记忆",14,MUTED);none.setPadding(0,dp(10),0,dp(10));body.addView(none);}
        for(int i=0;i<notes.length();i++){JSONObject note=notes.optJSONObject(i);if(note==null)continue;LinearLayout nr=row();nr.setMinimumHeight(dp(44));TextView content=text(note.optString("text"),14,INK);nr.addView(content,new LinearLayout.LayoutParams(0,-2,1));nr.addView(icon("close","删除这条记忆",()->new AlertDialog.Builder(activity).setTitle("忘掉这条记忆？").setMessage(note.optString("text")).setNegativeButton("保留",null).setPositiveButton("忘掉",(d,w)->change(id,Tunnel.json("forgetNote",note.optString("id")),()->showProfile(id))).show()));body.addView(nr);body.addView(divider(0xfff1f1f3),new LinearLayout.LayoutParams(-1,dp(1)));}
        WrapLayout actions=new WrapLayout(activity,dp(8));actions.setPadding(dp(20),dp(16),dp(20),dp(26));for(String label:new String[]{"编辑助理","复制助理","现在出一份简报"}){Button b=button(label,()->{if(label.equals("编辑助理"))edit(r);else if(label.equals("复制助理"))change(id,Tunnel.json("copy",true),()->{profile.dismiss();toast("已复制助理，记忆和定时任务不会复制");});else request(id,"brief",new JSONObject(),reply->{profile.dismiss();String task=reply.optString("taskId");if(!task.isBlank())navigation.openTask(task);else toast("暂无可用简报");});});b.setPadding(dp(16),0,dp(16),0);b.setTextSize(14);b.setMinHeight(dp(42));actions.addView(b,new ViewGroup.LayoutParams(-2,-2));}if(!"concierge".equals(id)){Button remove=button("删除助理",()->{
            AlertDialog confirm=new AlertDialog.Builder(activity).setTitle("删除「"+r.optString("name")+"」？").setMessage("暂停它的任务与安排，并从助理列表移除。聊天历史保留，可在电脑端的全部助理中恢复。").setNegativeButton("取消",null).setPositiveButton("删除助理",null).create();
            confirm.setOnShowListener(d->confirm.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{Button accept=confirm.getButton(AlertDialog.BUTTON_POSITIVE);accept.setEnabled(false);accept.setText("正在删除…");request(id,"",Tunnel.json("remove",true),reply->{confirm.dismiss();profile.dismiss();navigation.openRole("concierge");toast("助理已删除，历史对话保留");},()->{accept.setEnabled(true);accept.setText("删除助理");});}));confirm.show();
        });remove.setTextColor(0xffad3b42);actions.addView(remove,new ViewGroup.LayoutParams(-2,-2));}shell.addView(actions);
        int maximum=Math.min(activity.getResources().getDisplayMetrics().heightPixels-dp(44),dp(800));shell.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(0,View.MeasureSpec.UNSPECIFIED));int height=Math.min(shell.getMeasuredHeight(),maximum);if(shell.getMeasuredHeight()>maximum)scroll.setLayoutParams(new LinearLayout.LayoutParams(-1,0,1));
        profile.setContentView(shell);Window window=profile.getWindow();if(window!=null){window.setBackgroundDrawableResource(android.R.color.transparent);window.setDimAmount(.18f);window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);window.setGravity(Gravity.BOTTOM);}profile.show();if(window!=null)window.setLayout(width,height);
    }
    View divider(int color){View v=new View(activity);v.setBackgroundColor(color);return v;}
    void edit(JSONObject role){
        if(editor!=null)editor.dismiss();LinearLayout form=column();form.setPadding(dp(20),dp(4),dp(20),dp(20));
        EditText name=field(form,"助理名称",role==null?"":role.optString("name"),40),description=field(form,"负责什么",role==null?"":role.optString("description"),240),instruction=field(form,"工作方式和要求",role==null?"":role.optString("instruction"),4000);name.setSingleLine(true);description.setMinLines(2);description.setMaxLines(4);instruction.setMinLines(3);instruction.setMaxLines(6);
        Button cancel=button("取消",()->{if(editor!=null)editor.dismiss();}),save=button("保存",()->{});UiSheet.primary(activity,save);
        UiSheet dialog=new UiSheet(activity,role==null?"新建助理":"编辑助理",form,UiSheet.footer(activity,cancel,save));editor=dialog;
        save.setOnClickListener(v->{if(name.getText().toString().isBlank()||description.getText().toString().isBlank()||instruction.getText().toString().isBlank()){toast("请填写名称、职责和工作方式");return;}save.setEnabled(false);request(role==null?"":role.optString("id"),"",Tunnel.json("name",name.getText().toString(),"description",description.getText().toString(),"instruction",instruction.getText().toString()),reply->{dialog.dismiss();if(profile!=null)profile.dismiss();toast("助理已保存");},()->save.setEnabled(true));});dialog.show();
    }
    EditText field(LinearLayout form,String hint,String value,int limit){TextView label=text(hint,12,MUTED);label.setPadding(0,dp(16),0,dp(8));form.addView(label);EditText v=UiSheet.input(activity,hint);v.setHint(hint);v.setText(value);v.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE|android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);v.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(limit)});form.addView(v,new LinearLayout.LayoutParams(-1,-2));return v;}
    void change(String id,JSONObject changes,Runnable done){request(id,"",changes,reply->done.run());}
    void request(String id,String action,JSONObject changes,java.util.function.Consumer<JSONObject> done){request(id,action,changes,done,()->{});}
    void request(String id,String action,JSONObject changes,java.util.function.Consumer<JSONObject> done,Runnable failed){ConnectionService service=ConnectionService.current;if(service==null){toast("连接服务正在启动");failed.run();return;}service.roleRequest(id,action,changes,(reply,error)->activity.runOnUiThread(()->{if(activity.isDestroyed())return;if(error!=null){toast("请求未确认："+(error.getMessage()==null?"请稍后重试":error.getMessage()));failed.run();return;} // Update local display from an authenticated fresh state before reopening a profile.
            service.readState((fresh,readError)->activity.runOnUiThread(()->{if(activity.isDestroyed())return;if(readError==null)update(fresh);done.accept(reply);}));}));}
    void toast(String text){Toast.makeText(activity,text,Toast.LENGTH_LONG).show();}
    void openGroup(String id){groups.showGroup(id);}
    void close(){groups.close();if(profile!=null)profile.dismiss();if(editor!=null)editor.dismiss();}
}
