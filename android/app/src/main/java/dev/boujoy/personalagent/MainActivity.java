package dev.boujoy.personalagent;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.*;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.media.MediaRecorder;
import android.media.MediaPlayer;
import android.view.*;
import android.widget.*;
import org.json.*;
import java.io.*;
import java.util.*;

/** A single daily entrance: conversation, outcomes and an always-visible takeover action. */
public final class MainActivity extends Activity implements GroupPanel.Host {
    private static final int PURPLE=0xff7057e8,INK=0xff242426,MUTED=0xff8a8a92,BG=0xffffffff;
    private static final int ATTACH=41,VOICE=42,BIND_FILE=43,SAVE_ARTIFACT=44,BROWSER_WORKSPACE=45;
    private boolean explicitBrowserHandoff,configurationReturn;
    private LinearLayout feed,chatRoot,composeDock,statusRow;
    private TextView controlButton;
    private LinearLayout handoffCard;
    private TextView handoffTitle,handoffSummary;
    private Button handoffTake,handoffDismiss;
    private String displayedHandoffId="";
    private TextView shizukuStatus, backgroundExecutorStatus, rearDisplayStatus, rearLockscreenStatus;
    private JSONObject renderedData=new JSONObject();
    private AssistantPanel assistantPanel;
    private boolean listVisible=true;
    private ConversationScrollView chatScroll;
    private ImagePreviews imagePreviews;
    private EditText composer;
    private TextView connection,attachmentLabel,threadTitle,newMessages;
    private Dialog mediaPreview;
    private AlertDialog artifactSaveProgress;
    private String lastVisibleReply="";
    private boolean followNextRender;
    private String renderedConversation="";
    private UiIcon send;
    private FrameLayout pillAvatar;private TextView pillStatus;private String pillColor="";
    private String lastRender="";
    private final Map<String,View> rowViews=new HashMap<>();
    private final Map<String,String> rowSignatures=new HashMap<>();
    private ChatComposerState chat=new ChatComposerState();
    private JSONObject pendingArtifact;
    private Dialog connectionDialog;
    private Dialog menuDialog;
    private Dialog taskDialog;
    private AlertDialog recordingDialog;
    private UiIcon mic;private long micDownAt;private float micDownY;private boolean micStartedByPress;private boolean transcribing;
    private MediaRecorder recorder;
    private File recordingFile,playbackFile;
    private MediaPlayer player;
    private boolean visible;
    private long playbackGeneration;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final BroadcastReceiver handoffScreen=new BroadcastReceiver(){@Override public void onReceive(Context c,Intent i){renderHandoff(Intent.ACTION_SCREEN_OFF.equals(i.getAction())||handoffLocked());}};
    private final BroadcastReceiver updates=new BroadcastReceiver(){@Override public void onReceive(Context c,Intent i){scheduleRender();}};
    private final Runnable refresh=new Runnable(){public void run(){refreshBackgroundStatus();if(!scrolling()){renderHandoff(handoffLocked());render();}main.postDelayed(this,1500);}};
    private boolean chatTouchActive;
    private record DeferredRender(JSONObject data,ConnectionService service,long now) {}
    private DeferredRender deferredRender;
    private final Runnable finishTouchRender=()->{
        if(chatTouchActive||chatScroll!=null&&chatScroll.isTouchActive())return;
        DeferredRender pending=deferredRender;deferredRender=null;
        if(pending!=null&&!isFinishing()&&!isDestroyed())renderSnapshot(pending.data(),pending.service(),Math.max(pending.now(),actionNow(pending.service())));
    };

    @Override public boolean dispatchTouchEvent(MotionEvent event){
        int action=event.getActionMasked();
        if(action==MotionEvent.ACTION_DOWN)chatTouchActive=true;
        boolean handled=false;
        try{handled=super.dispatchTouchEvent(event);return handled;}
        finally{if(action==MotionEvent.ACTION_UP||action==MotionEvent.ACTION_CANCEL||action==MotionEvent.ACTION_DOWN&&!handled){chatTouchActive=false;finishChatTouch();}}
    }
    // View may post performClick from UP; apply queued snapshots only after that callback.
    private void finishChatTouch(){main.removeCallbacks(finishTouchRender);main.post(finishTouchRender);}

    @Override public void onCreate(Bundle state){
        super.onCreate(state);imagePreviews=new ImagePreviews((id,callback)->{ConnectionService service=ConnectionService.current;if(service==null)callback.done(null,new IOException("电脑连接尚未就绪，请重试"));else service.downloadPreview(id,callback);});
        Object retained=getLastNonConfigurationInstance();configurationReturn=retained instanceof ChatComposerState;
        if(retained instanceof ChatComposerState draft)chat=draft;
        else if(state!=null)try{chat=new ChatComposerState(new JSONObject(state.getString("chatComposer","{}")));}catch(Exception ignored){}
        if(state==null&&!(retained instanceof ChatComposerState))try{SecureStore records=new SecureStore(this);JSONObject saved=records.read("chat-ui"),binding=records.read("binding");if(!binding.optString("deviceId").isBlank()&&binding.optString("deviceId").equals(saved.optString("deviceId"))){chat=new ChatComposerState(saved.optJSONObject("composer"));listVisible=saved.optBoolean("listVisible",true);}}catch(Exception ignored){}
        if(state!=null&&state.containsKey("pendingArtifact"))try{pendingArtifact=new JSONObject(state.getString("pendingArtifact"));}catch(Exception ignored){}
        if(state!=null)listVisible=state.getBoolean("listVisible",true);
        buildUi();syncComposer();
        if(!(retained instanceof ChatComposerState)&&state!=null)try{if(new JSONObject(state.getString("chatComposer","{}")).optBoolean("hadAttachments")&&chat.attachments().length()==0)toast("未发送的附件需要重新选择");}catch(Exception ignored){}
        try{startForegroundService(new Intent(this,ConnectionService.class));}catch(Exception e){toast("请保持 Boujoy 打开以建立连接");}
        handleBindingIntent(getIntent());if(state==null&&!(retained instanceof ChatComposerState))handleTaskIntent(getIntent());
    }
    @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);setIntent(intent);handleBindingIntent(intent);handleTaskIntent(intent);}
    private void handleTaskIntent(Intent intent){
        String group=intent==null?null:intent.getStringExtra("groupId");if(group!=null&&group.matches("[a-fA-F0-9-]{36}")){showAssistantList(true);assistantPanel.openGroup(group);return;}
        String task=intent==null?null:intent.getStringExtra("taskId");if(task==null||!task.matches("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}"))return;
        selectConversation(task); // Opening a result selects history only; it never resumes an operation.
    }
    private void handleBindingIntent(Intent intent){
        Uri uri=intent==null?null:intent.getData();if(uri==null||!BuildConfig.BIND_SCHEME.equals(uri.getScheme())||!"bind".equals(uri.getHost()))return;
        try{String data=uri.getQueryParameter("data");if(data==null||data.length()>16384)throw new IllegalArgumentException();
            String configuration=data.trim().startsWith("{")?data:new String(android.util.Base64.decode(data,android.util.Base64.URL_SAFE|android.util.Base64.NO_WRAP),java.nio.charset.StandardCharsets.UTF_8);
            new Binding(new JSONObject(configuration),true);
            main.post(()->showConnection(configuration));
        }catch(Exception e){main.post(()->toast("连接码无效或已过期"));}
    }
    @Override protected void onResume(){
        super.onResume();visible=true;
        registerReceiver(updates,new IntentFilter(ConnectionService.UPDATE),Context.RECEIVER_NOT_EXPORTED);
        IntentFilter screenFilter=new IntentFilter();screenFilter.addAction(Intent.ACTION_SCREEN_OFF);screenFilter.addAction(Intent.ACTION_SCREEN_ON);screenFilter.addAction(Intent.ACTION_USER_PRESENT);registerReceiver(handoffScreen,screenFilter,Context.RECEIVER_NOT_EXPORTED);
        renderHandoff(handoffLocked());
        ConnectionService service=ConnectionService.current;if(service!=null){service.chatHistoryVisible(!listVisible);/* Viewing history does not revoke control or close an in-flight phone stream. */}explicitBrowserHandoff=false;configurationReturn=false;
        main.post(refresh);
    }
    @Override protected void onPause(){renderHandoff(true);try{unregisterReceiver(handoffScreen);}catch(Exception ignored){}super.onPause();try{SecureStore records=new SecureStore(this);String device=records.read("binding").optString("deviceId");if(!device.isBlank())records.write("chat-ui",Tunnel.json("deviceId",device,"composer",chat.snapshot(),"listVisible",listVisible));}catch(Exception ignored){}visible=false;if(mediaPreview!=null){mediaPreview.dismiss();mediaPreview=null;}ConnectionService service=ConnectionService.current;if(service!=null)service.chatHistoryVisible(false);discardRecording();stopPlayback();main.removeCallbacks(refresh);try{unregisterReceiver(updates);}catch(Exception ignored){}}
    @Override public Object onRetainNonConfigurationInstance(){return chat;}
    @Override protected void onSaveInstanceState(Bundle state){state.putBoolean("listVisible",listVisible);state.putString("chatComposer",chat.snapshot().toString());if(pendingArtifact!=null)state.putString("pendingArtifact",pendingArtifact.toString());super.onSaveInstanceState(state);}
    @Override protected void onDestroy(){if(artifactSaveProgress!=null)artifactSaveProgress.dismiss();if(imagePreviews!=null)imagePreviews.close();main.removeCallbacks(refresh);main.removeCallbacks(coalescedRender);main.removeCallbacks(finishTouchRender);deferredRender=null;if(connectionDialog!=null)connectionDialog.dismiss();if(menuDialog!=null)menuDialog.dismiss();if(taskDialog!=null)taskDialog.dismiss();if(assistantPanel!=null)assistantPanel.close();super.onDestroy();}
    private int dp(float v){return Math.round(v*getResources().getDisplayMetrics().density);}
    private TextView text(String s,int size,int color){TextView view=new TextView(this);view.setText(s);view.setTextSize(size);view.setTextColor(color);view.setIncludeFontPadding(false);view.setLineSpacing(dp(3),1);return view;}
    private GradientDrawable background(int color,int radius){GradientDrawable drawable=new GradientDrawable();drawable.setColor(color);drawable.setCornerRadius(dp(radius));return drawable;}
    private Button button(String value,Runnable click){return UiSheet.button(this,value,click);}
    private LinearLayout row(){LinearLayout row=new LinearLayout(this);row.setOrientation(LinearLayout.HORIZONTAL);row.setGravity(Gravity.CENTER_VERTICAL);return row;}
    private UiIcon icon(String icon,String label,Runnable action){UiIcon v=new UiIcon(this,icon,label,action);v.setLayoutParams(new LinearLayout.LayoutParams(dp(44),dp(44)));return v;}
    private void buildUi(){
        FrameLayout stage=new FrameLayout(this){@Override protected void onMeasure(int widthSpec,int heightSpec){int contentWidth=Math.min(View.MeasureSpec.getSize(widthSpec),dp(680));for(int i=0;i<getChildCount();i++)getChildAt(i).getLayoutParams().width=contentWidth;super.onMeasure(widthSpec,heightSpec);}};stage.setBackgroundColor(Color.WHITE);
        LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setPadding(0,0,0,0);GradientDrawable wash=new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,new int[]{0xfff7f5fc,Color.WHITE});wash.setGradientType(GradientDrawable.RADIAL_GRADIENT);wash.setGradientCenter(.5f,.42f);wash.setGradientRadius(dp(230));root.setBackground(wash);chatRoot=root;
        // Header: menu, a floating pill with the bot and what it is doing, and the chat menu.
        FrameLayout header=new FrameLayout(this);header.setClipChildren(false);
        FrameLayout.LayoutParams menuParams=new FrameLayout.LayoutParams(dp(44),dp(44),Gravity.START|Gravity.CENTER_VERTICAL);menuParams.leftMargin=dp(8);header.addView(icon("menu","助理列表",()->showAssistantList(true)),menuParams);
        LinearLayout pill=row();pill.setPadding(dp(10),0,dp(18),0);pill.setBackground(new SoftSurface(this,21,0xf2ffffff,0xf2ffffff,0x12301e40,6,3,0x14302743));
        pillAvatar=new FrameLayout(this);pillAvatar.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);pill.addView(pillAvatar,new LinearLayout.LayoutParams(dp(28),dp(28)));
        threadTitle=text("boujoy",15,INK);threadTitle.setTypeface(Typeface.create(Typeface.DEFAULT,600,false));threadTitle.setMaxLines(1);threadTitle.setMaxWidth(dp(150));threadTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);threadTitle.setGravity(Gravity.CENTER_VERTICAL);threadTitle.setPadding(dp(7),0,0,0);pill.addView(threadTitle,new LinearLayout.LayoutParams(-2,-2));
        pillStatus=text("",12,MUTED);pillStatus.setMaxLines(1);pillStatus.setPadding(dp(9),0,0,0);pillStatus.setVisibility(View.GONE);pill.addView(pillStatus,new LinearLayout.LayoutParams(-2,-2));
        pill.setOnClickListener(v->assistantPanel.showProfile(chat.roleId()));header.addView(pill,new FrameLayout.LayoutParams(-2,dp(42),Gravity.CENTER));
        FrameLayout.LayoutParams moreParams=new FrameLayout.LayoutParams(dp(44),dp(44),Gravity.END|Gravity.CENTER_VERTICAL);moreParams.rightMargin=dp(8);header.addView(icon("more","对话菜单",this::showChatMenu),moreParams);
        // The top bar floats over the conversation: messages scroll under a soft white fade.
        LinearLayout topBar=new LinearLayout(this);topBar.setOrientation(LinearLayout.VERTICAL);topBar.setClipChildren(false);topBar.setPadding(0,0,0,dp(16));topBar.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,new int[]{0xf7ffffff,0xe0ffffff,0x00ffffff}));topBar.addView(header,new LinearLayout.LayoutParams(-1,dp(60)));
        statusRow=row();statusRow.setPadding(dp(18),0,dp(18),0);connection=text("正在连接…",11,MUTED);connection.setOnClickListener(v->showConnection());statusRow.addView(connection,new LinearLayout.LayoutParams(0,-2,1));controlButton=text("停止 / 接管",12,0xff7c6aa6);controlButton.setGravity(Gravity.CENTER);controlButton.setMinHeight(dp(44));controlButton.setPadding(dp(12),0,0,0);controlButton.setOnClickListener(v->{ConnectionService s=ConnectionService.current;if(s!=null)s.pauseLocal("explicit_takeover");});statusRow.addView(controlButton);topBar.addView(statusRow);
        chatScroll=new ConversationScrollView(this);chatScroll.setFillViewport(true);chatScroll.setClipToPadding(false);feed=new LinearLayout(this);feed.setOrientation(LinearLayout.VERTICAL);feed.setPadding(0,dp(6),0,dp(12));chatScroll.addView(feed);FrameLayout stack=new FrameLayout(this);stack.addView(chatScroll,new FrameLayout.LayoutParams(-1,-1));stack.addView(topBar,new FrameLayout.LayoutParams(-1,-2,Gravity.TOP));topBar.addOnLayoutChangeListener((v,l,t,r,b,ol,ot,or,ob)->{int inset=Math.max(0,b-t-dp(16));if(chatScroll.getPaddingTop()!=inset)chatScroll.setPadding(0,inset,0,0);});root.addView(stack,new LinearLayout.LayoutParams(-1,0,1));
        buildHandoffCard(root);
        attachmentLabel=text("",12,MUTED);attachmentLabel.setPadding(dp(8),dp(5),dp(8),dp(5));composeDock=new LinearLayout(this);composeDock.setOrientation(LinearLayout.VERTICAL);composeDock.setClipChildren(false);composeDock.setPadding(dp(17),dp(10),dp(17),dp(24));composeDock.addView(attachmentLabel);
        // One rounded line: + on the left, the text in the middle, mic and a round send in the bot's color.
        LinearLayout input=row();input.setGravity(Gravity.BOTTOM);input.setPadding(dp(6),dp(6),dp(6),dp(6));input.setBackground(new SoftSurface(this,27,Color.WHITE,Color.WHITE,0xffe3e1e8,5,3,0x0c302743));
        UiIcon attach=icon("plus","添加附件",this::chooseAttachment);attach.setBackground(background(0xfff2f1f5,22));input.addView(attach,new LinearLayout.LayoutParams(dp(44),dp(44)));
        composer=new EditText(this);composer.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(50000)});composer.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE|android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        composer.addTextChangedListener(new android.text.TextWatcher(){public void beforeTextChanged(CharSequence s,int start,int count,int after){}public void onTextChanged(CharSequence s,int start,int before,int count){chat.setText(s.toString());updateSend();}public void afterTextChanged(android.text.Editable e){}});
        composer.setHint("交给我办什么？");composer.setContentDescription("消息输入框");composer.setTextSize(15);composer.setTextColor(INK);composer.setHintTextColor(0xffaaa5b1);composer.setBackgroundColor(Color.TRANSPARENT);composer.setPadding(dp(10),dp(12),dp(6),dp(12));composer.setIncludeFontPadding(false);composer.setLineSpacing(dp(4),1);composer.setMaxLines(5);composer.setMinLines(1);composer.setMinimumHeight(dp(44));composer.setGravity(Gravity.CENTER_VERTICAL|Gravity.START);input.addView(composer,new LinearLayout.LayoutParams(0,-2,1));
        mic=icon("mic","语音输入：按住说话，或点一下开始、再点一下结束",this::voice);mic.setOnTouchListener(this::micTouch);input.addView(mic);send=icon("send","发送消息",this::submit);send.setInk(Color.WHITE);input.addView(send,new LinearLayout.LayoutParams(dp(44),dp(44)));composeDock.addView(input);newMessages=text("有新消息 ↓",12,0xff8065a7);newMessages.setGravity(Gravity.CENTER);newMessages.setMinHeight(dp(36));newMessages.setVisibility(View.GONE);newMessages.setOnClickListener(v->{chatScroll.fullScroll(View.FOCUS_DOWN);newMessages.setVisibility(View.GONE);});composeDock.addView(newMessages,0);root.addView(composeDock);
        chatScroll.setOnTouchFinishedListener(this::finishChatTouch);
        chatScroll.setOnScrollChangeListener((View v,int x,int y,int oldX,int oldY)->{lastScrollAt=SystemClock.uptimeMillis();if(chatScroll.isNearBottom())newMessages.setVisibility(View.GONE);});
        FrameLayout.LayoutParams content=new FrameLayout.LayoutParams(-1,-1,Gravity.CENTER);stage.addView(root,content);
        assistantPanel=new AssistantPanel(this,new AssistantPanel.Navigation(){public void openRole(String id){selectRole(id);}public void openTask(String id){selectConversation(id);}public void settings(){showConnection();}});stage.addView(assistantPanel.root,new FrameLayout.LayoutParams(-1,-1,Gravity.CENTER));
        // Keep a readable line length on an unfolded Fold or tablet without clipping on the cover display.
        setContentView(stage);showAssistantList(listVisible);
    }
    private void buildHandoffCard(LinearLayout root){
        handoffCard=new LinearLayout(this);handoffCard.setOrientation(LinearLayout.VERTICAL);
        handoffCard.setPadding(dp(16),dp(10),dp(16),dp(8));handoffCard.setBackground(background(0xfff1edff,14));handoffCard.setVisibility(View.GONE);
        handoffTitle=text("",14,INK);handoffTitle.setMaxLines(2);handoffTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);handoffCard.addView(handoffTitle);
        handoffSummary=text("",12,MUTED);handoffSummary.setMaxLines(3);handoffSummary.setEllipsize(android.text.TextUtils.TruncateAt.END);handoffCard.addView(handoffSummary);
        LinearLayout actions=row();
        handoffTake=button("在主屏接手",()->{String id=displayedHandoffId;if(!HandoffUi.matches(DisplayBridge.get(this).handoff(),id,System.currentTimeMillis())){renderHandoff(handoffLocked());return;}try{HandoffActivity.launch(this,id);}catch(RuntimeException e){toast("无法打开主屏接手入口，请稍后重试");}});
        handoffDismiss=button("不用了",()->{ConnectionService service=ConnectionService.current;String id=displayedHandoffId;if(service!=null&&HandoffUi.matches(DisplayBridge.get(this).handoff(),id,System.currentTimeMillis()))service.dismissHandoff(id);});
        actions.addView(handoffTake,new LinearLayout.LayoutParams(0,dp(44),1));actions.addView(handoffDismiss,new LinearLayout.LayoutParams(0,dp(44),1));handoffCard.addView(actions);
        LinearLayout.LayoutParams layout=new LinearLayout.LayoutParams(-1,-2);layout.setMargins(dp(17),dp(4),dp(17),0);root.addView(handoffCard,layout);
    }
    private boolean handoffLocked(){
        try{KeyguardManager keyguard=getSystemService(KeyguardManager.class);return keyguard==null||keyguard.isDeviceLocked()||keyguard.isKeyguardLocked();}catch(RuntimeException unavailable){return true;}
    }
    private void renderHandoff(boolean locked){
        if(handoffCard==null)return;
        if(!BuildConfig.BACKGROUND_SUPPORTED){handoffCard.setVisibility(View.GONE);displayedHandoffId="";return;}
        locked=locked||!visible;
        HandoffUi.Card card=HandoffUi.from(DisplayBridge.get(this).handoff(),locked,System.currentTimeMillis());
        displayedHandoffId=card==null?"":card.id();handoffCard.setVisibility(card==null?View.GONE:View.VISIBLE);
        handoffTitle.setText(card==null?"":card.status()+(card.title().isBlank()?"":"："+card.title()));
        handoffSummary.setText(card==null?"":card.summary());handoffSummary.setVisibility(card==null||card.summary().isBlank()?View.GONE:View.VISIBLE);
        handoffTake.setEnabled(card!=null);handoffDismiss.setEnabled(card!=null&&ConnectionService.current!=null);
    }
    private void showChatMenu(){showChoices(assistantPanel.role(chat.roleId()).optString("name","boujoy"),new String[]{"新对话","历史对话","助理资料","设置"},which->{switch(which){case 0->selectConversation("");case 1->showConversations();case 2->assistantPanel.showProfile(chat.roleId());default->showConnection();}});}
    private void showChoices(String title,String[] labels,java.util.function.IntConsumer action){
        if(menuDialog!=null)menuDialog.dismiss();LinearLayout body=UiSheet.column(this);body.setPadding(dp(20),dp(8),dp(20),dp(24));
        for(int i=0;i<labels.length;i++){final int index=i;UiSheet.spaced(body,UiSheet.actionRow(this,labels[i],"",()->{if(menuDialog!=null)menuDialog.dismiss();action.accept(index);}),8);}
        menuDialog=new UiSheet(this,title,body,null);menuDialog.show();
    }
    private static long actionNow(ConnectionService service){return service==null?System.currentTimeMillis():service.taskActionNow();}
    private void updateSend(){if(send==null)return;boolean ready=!chat.waiting()&&(!chat.text().isBlank()||chat.attachments().length()>0);send.setEnabled(ready);send.setBackground(background(ready?botAccent():0xffeeedf2,22));send.setInk(ready?Color.WHITE:0xffb1afb8);}
    private int botAccent(){return assistantPanel==null?INK:BotAvatar.color(assistantPanel.role(chat.roleId()).optString("botColor","violet"));}
    // The pill shows the current bot (breathing) and, while its task runs or waits for you, a short status.
    private void updatePill(JSONObject task){
        if(pillAvatar==null||assistantPanel==null)return;JSONObject role=assistantPanel.role(chat.roleId());String color=role.optString("botColor","violet");
        if(!color.equals(pillColor)){pillColor=color;pillAvatar.removeAllViews();BotAvatar avatar=new BotAvatar(this,color).breathingLevel();avatar.setClickable(false);FrameLayout.LayoutParams fit=new FrameLayout.LayoutParams(-1,-1);fit.bottomMargin=dp(2);pillAvatar.addView(avatar,fit);}
        String status=task==null?"":task.optString("status"),label=switch(status){case "queued","running","waiting_children"->"正在处理";case "waiting_approval"->"有一步需要确认";case "ready_for_user"->"等你接手";case "waiting_consent","waiting_setup","needs_input","unknown_result"->"需要你处理";default->"";};
        pillStatus.setText(label.isEmpty()?"":"· "+label);pillStatus.setTextColor("正在处理".equals(label)?BotAvatar.color(color):0xffc47f25);pillStatus.setVisibility(label.isEmpty()?View.GONE:View.VISIBLE);
        composer.setHint("给 "+role.optString("name","boujoy")+" 发消息");updateSend();
    }
    private void showAssistantList(boolean show){listVisible=show;assistantPanel.root.setVisibility(show?View.VISIBLE:View.GONE);chatRoot.setVisibility(show?View.GONE:View.VISIBLE);if(show){composer.clearFocus();((android.view.inputmethod.InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(composer.getWindowToken(),0);}ConnectionService service=ConnectionService.current;if(service!=null){assistantPanel.update(service.snapshot());service.chatHistoryVisible(visible&&!show,chat.conversationId());}}
    private void selectRole(String id){
        try{chat.selectRole(id);if(chat.conversationId().isBlank()&&chat.text().isBlank()&&chat.attachments().length()==0&&!chat.waiting()){JSONObject last=assistantPanel.role(id).optJSONObject("lastActivity");if(ConversationIdentity.privateTask(last)&&!last.optString("id").isBlank())chat.selectConversation(last.optString("id"));}chat.identifyRole(id);showAssistantList(false);lastRender="";syncComposer();render();}catch(IllegalStateException e){toast(e.getMessage());}
    }
    @Override public void onBackPressed(){if(!listVisible){showAssistantList(true);return;}super.onBackPressed();}
    private void submit(){
        ConnectionService service=ConnectionService.current;if(service==null){toast("连接服务正在启动");return;}
        String value=composer.getText().toString().trim();if(value.isEmpty()&&chat.attachments().length()==0){composer.setError("写一句你想让我做什么");return;}
        JSONObject snapshot=service.snapshot();if(!snapshot.optBoolean("paired")){showConnection();return;}
        final ChatComposerState.Submission submitted;
        try{submitted=chat.begin();}catch(IllegalStateException e){toast(e.getMessage());return;}
        followNextRender=true;send.setEnabled(false);
        // Show the message at once; the encrypted outbox write and delivery follow.
        showProvisional(submitted);
        service.submit(value,submitted.conversationId(),submitted.attachments(),submitted.messageId(),submitted.roleId(),(id,error)->main.post(()->{
            provisional.remove(submitted.messageId());
            if(error!=null&&chat.text().isBlank()&&!submitted.text().isBlank())chat.setText(submitted.text()); // never lose a failed message
            boolean current=error==null?chat.saved(submitted):chat.failed(submitted);
            if(!current||isDestroyed())return;
            syncComposer();if(error!=null)toast("消息未保存："+(error.getMessage()==null?"请再试一次":error.getMessage()));
            render();
        }));
        // The target app can take the foreground when the accepted task needs it. No fake completion.
    }
    /** Display-only rows for messages the service has not yet written to the outbox. */
    private final JSONObject provisional=new JSONObject();
    private void showProvisional(ChatComposerState.Submission submitted){
        try{
            JSONObject message=Tunnel.json("messageId",submitted.messageId(),"text",submitted.text().isBlank()?"（附件）":submitted.text().trim(),"createdAt",java.time.Instant.now().toString(),"attachments",submitted.attachments(),"roleId",submitted.roleId());
            if(!submitted.conversationId().isBlank())message.put("conversationId",submitted.conversationId());
            provisional.put(submitted.messageId(),Tunnel.json("message",message,"status","sending","everSent",false));
        }catch(JSONException ignored){return;}
        if(composer.length()>0)composer.setText("");
        render();
    }
    private static String[] keys(JSONObject object){JSONArray names=object==null?null:object.names();String[] out=new String[names==null?0:names.length()];for(int i=0;i<out.length;i++)out[i]=names.optString(i);return out;}
    private JSONObject withProvisional(JSONObject data){
        if(provisional.length()==0||data==null)return data;
        try{
            JSONObject merged=new JSONObject(data,keys(data)),outbox=data.optJSONObject("outbox"),rows=outbox==null?new JSONObject():new JSONObject(outbox,keys(outbox));
            for(String key:keys(provisional))if(!rows.has(key))rows.put(key,provisional.get(key));
            merged.put("outbox",rows);return merged;
        }catch(JSONException e){return data;}
    }
    private void syncComposer(){
        if(!composer.getText().toString().equals(chat.text())){composer.setText(chat.text());composer.setSelection(composer.length());}
        JSONArray selected=chat.attachments();JSONObject first=selected.optJSONObject(0);
        attachmentLabel.setText(first==null?"":"已选 "+selected.length()+" 个附件 · "+first.optString("name","附件")+" · 管理");
        attachmentLabel.setOnClickListener(v->manageAttachments());
        attachmentLabel.setVisibility(first==null?View.GONE:View.VISIBLE);updateSend();
    }
    // Only the cached details of tasks actually on screen take part in change detection;
    // serialising every cached conversation on each update made the chat stutter.
    private static String taskDetail(JSONObject data,String taskId){JSONObject cache=data.optJSONObject("taskDetails");return cache==null||taskId==null?"":String.valueOf(cache.optJSONObject(taskId));}
    private static String shownDetails(JSONObject data,ChatPresenter.Presentation presentation){StringBuilder out=new StringBuilder();Set<String> seen=new HashSet<>();for(ChatPresenter.Row row:presentation.rows())if(row.taskId()!=null&&!row.taskId().isBlank()&&seen.add(row.taskId()))out.append(taskDetail(data,row.taskId()));return out.toString();}
    private static boolean taskActionPending(JSONObject data,String id){JSONArray requests=data.optJSONArray("pendingTaskActions");if(requests!=null)for(int i=0;i<requests.length();i++)if(id.equals(requests.optString(i)))return true;return false;}
    // Running text, telemetry and detail-cache revisions do not change these controls.
    private String taskActionSignature(JSONObject data,JSONObject task,long now){
        if(task==null)return "";String id=task.optString("id"),state=task.optString("status");TaskActions.Action primary=TaskActions.primary(task,now);
        JSONArray key=new JSONArray().put(primary.name()).put(primary!=TaskActions.Action.STOP&&taskActionPending(data,id)).put("ready_for_user".equals(state)?assistantPanel.role(chat.roleId()).optString("botColor"):"");
        if("waiting_approval".equals(state)){
            JSONObject cache=data.optJSONObject("taskDetails"),cached=cache==null?null:cache.optJSONObject(id),detail=cached==null?null:cached.optJSONObject("detail");
            JSONArray approvals=task.optJSONArray("approvals");if(approvals==null&&detail!=null)approvals=detail.optJSONArray("approvals");
            if(approvals!=null)for(int i=0;i<approvals.length();i++){JSONObject approval=approvals.optJSONObject(i);if(approval!=null&&"pending".equals(approval.optString("status","pending")))key.put(new JSONArray().put(approval).put(ApprovalPresentation.expired(approval,now)).put(ApprovalRequests.status(data,approval)));}
        }
        return key.toString();
    }
    private JSONObject latestRenderedTask(String id,JSONObject fallback){
        JSONObject snapshot=deferredRender==null?renderedData:deferredRender.data(),state=snapshot.optJSONObject("state");JSONArray tasks=state==null?null:state.optJSONArray("tasks");
        if(tasks!=null)for(int i=0;i<tasks.length();i++){JSONObject task=tasks.optJSONObject(i);if(task!=null&&id.equals(task.optString("id")))return task;}return fallback;
    }
    // Background updates arrive in bursts (state, details, receipts); draw at most once per ~50 ms.
    private boolean renderQueued;
    private long lastScrollAt;
    // Never rebuild rows under a moving finger; catch up right after the scroll settles.
    private boolean scrolling(){return chatTouchActive||chatScroll!=null&&chatScroll.isTouchActive()||SystemClock.uptimeMillis()-lastScrollAt<250;}
    private final Runnable coalescedRender=()->{if(scrolling()){main.postDelayed(this.coalescedRender,120);return;}this.renderQueued=false;render();};
    private void scheduleRender(){if(renderQueued)return;renderQueued=true;main.postDelayed(coalescedRender,50);}
    private void render(){
        ConnectionService service=ConnectionService.current;if(service==null)return;
        renderSnapshot(service.snapshot(),service);
    }
    private void renderSnapshot(JSONObject data,ConnectionService service){renderSnapshot(data,service,actionNow(service));}
    private void renderSnapshot(JSONObject raw,ConnectionService service,long now){
        // A row or the fixed takeover control must not move/change between DOWN and UP.
        if(chatTouchActive||chatScroll!=null&&chatScroll.isTouchActive()){deferredRender=new DeferredRender(raw,service,now);return;}
        deferredRender=null;
        renderHandoff(handoffLocked());
        JSONObject data=withProvisional(raw);
        renderedData=data;chat.reconcile(data);assistantPanel.update(data);assistantPanel.selectedRole(chat.roleId());if(service!=null)service.chatHistoryVisible(visible&&!listVisible,chat.conversationId());syncComposer();String status=data.optString("status");
        connection.setText(getString(R.string.connection_status,data.optBoolean("online")?"●":"○",status));connection.setTextColor(data.optBoolean("online")?MUTED:0xffa07936);
        String selected=chat.conversationId(),title=selected.isBlank()?"新对话":"当前对话";JSONObject selectedTask=null;JSONObject currentState=data.optJSONObject("state");JSONArray all=currentState==null?null:currentState.optJSONArray("tasks");if(all!=null)for(int n=0;n<all.length();n++){JSONObject task=all.optJSONObject(n);if(ConversationIdentity.privateTask(task)&&!selected.isBlank()&&(selected.equals(ChatPresenter.string(task,"id"))||selected.equals(ChatPresenter.string(task,"conversationId")))){title=ChatPresenter.string(task,"title");selectedTask=task;}}if(selectedTask!=null)chat.identifyRole(selectedTask.optString("roleId","concierge"));threadTitle.setText(assistantPanel.role(chat.roleId()).optString("name","boujoy"));composer.setContentDescription("给 "+assistantPanel.role(chat.roleId()).optString("name","boujoy")+" 发消息");updatePill(selectedTask);threadTitle.setMaxLines(1);threadTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
        ChatPresenter.Presentation presentation=ChatPresenter.present(data,selected,chat.displayedMessageId());
        // New and existing conversations share the same scroll area and fixed bottom composer.
        feed.setGravity(Gravity.TOP);feed.setPadding(dp(18),dp(6),dp(18),0);
        // While control is paused (screen lock, takeover, Mac maintenance) the same
        // spot offers 继续, so handing control back never needs a new message.
        boolean controlPaused=data.optBoolean("paused")&&data.optBoolean("online");
        long displayedEpoch=data.optLong("controlEpoch",-1);
        controlButton.setText(controlPaused?"继续":"停止 / 接管");
        controlButton.setContentDescription(controlPaused?"交还手机控制":"停止并接管手机");
        controlButton.setOnClickListener(v->{
            ConnectionService current=ConnectionService.current;
            if(current==null)return;
            if(!controlPaused)current.pauseLocal("explicit_takeover");
            else if(current==service)current.resumeControl(displayedEpoch);
        });
        statusRow.setVisibility(controlPaused||!data.optBoolean("online")||selectedTask!=null&&TaskActions.primary(selectedTask,now)==TaskActions.Action.STOP?View.VISIBLE:View.GONE);
        String approvalRevision=ApprovalPresentation.revision(data,now)+data.optJSONObject("approvalRequests");
        String fingerprint=approvalRevision+chat.roleId()+assistantPanel.role(chat.roleId()).toString()+selected+presentation.fingerprint()+(selectedTask==null?TaskActions.Action.NONE:TaskActions.primary(selectedTask,now))+data.optJSONArray("pendingTaskActions")+shownDetails(data,presentation);if(fingerprint.equals(lastRender))return;
        boolean follow=followNextRender||!selected.equals(renderedConversation);followNextRender=false;renderedConversation=selected;
        boolean nearBottom=chatScroll.isNearBottom();
        String latest=presentation.rows().stream().filter(row->row.kind()==ChatPresenter.Kind.ASSISTANT||row.key().endsWith(":latest-result")||row.kind()==ChatPresenter.Kind.ATTACHMENT).reduce((a,b)->b).map(row->row.key()+row.text()).orElse("");
        if(!follow&&!nearBottom&&!latest.isBlank()&&!latest.equals(lastVisibleReply))newMessages.setVisibility(View.VISIBLE);else if(follow||nearBottom)newMessages.setVisibility(View.GONE);lastVisibleReply=latest;
        chatScroll.preserve(follow);lastRender=fingerprint;
        JSONObject state=data.optJSONObject("state");JSONArray tasks=state==null?null:state.optJSONArray("tasks");Map<String,JSONObject> byId=new HashMap<>();
        if(tasks!=null)for(int i=0;i<tasks.length();i++){JSONObject task=tasks.optJSONObject(i);if(task!=null)byId.put(task.optString("id"),task);}
        Set<String> retained=new HashSet<>();int position=0;
        for(ChatPresenter.Row row:presentation.rows()){
            if(row.kind()==ChatPresenter.Kind.HEADER||row.kind()==ChatPresenter.Kind.GREETING||row.key().equals("welcome-detail")&&data.optBoolean("paired")||row.key().endsWith(":status")&&Set.of("completed","succeeded","waiting_approval","ready_for_user").contains(byId.getOrDefault(row.taskId(),new JSONObject()).optString("status")))continue;
            JSONObject task=byId.get(row.taskId());
            String signature=row.toString()+(row.kind()==ChatPresenter.Kind.ACTIONS?taskActionSignature(data,task,now):"");
            View view=rowViews.get(row.key());
            if(view!=null&&!signature.equals(rowSignatures.get(row.key()))&&view instanceof TextView&&row.kind()!=ChatPresenter.Kind.ACTIONS){
                ((TextView)view).setText(row.kind()==ChatPresenter.Kind.ASSISTANT?replyText((TextView)view,row.text()):row.kind()==ChatPresenter.Kind.PROGRESS?"正在处理 · "+row.text():row.text());
            }else if(view==null||!signature.equals(rowSignatures.get(row.key()))){
                if(view!=null)feed.removeView(view);
                int before=feed.getChildCount();
                switch(row.kind()){
                    case USER,ASSISTANT->bubble(row.text(),row.kind()==ChatPresenter.Kind.USER);
                    case ACTIONS->{if(task!=null)taskCard(task,service,now);}
                    case ATTACHMENT->artifactCard(row.text());
                    case MATERIALS->{try{JSONArray files=new JSONArray(row.text());LinearLayout material=detailLink("处理时读取的材料 · "+files.length()+" 个",MUTED,()->{String[] names=new String[files.length()];for(int n=0;n<files.length();n++)names[n]=AttachmentDrafts.label(files.optJSONObject(n));showChoices("读取的材料",names,index->chooseArtifactDestination(files.optJSONObject(index)));});feed.addView(material);}catch(JSONException ignored){}}
                    default->{TextView label=text(row.kind()==ChatPresenter.Kind.PROGRESS?"正在处理 · "+row.text():row.text(),12,MUTED);label.setTextIsSelectable(true);
                        label.setPadding(dp(10),dp(8),dp(10),dp(8));feed.addView(label);}
                }
                view=feed.getChildCount()>before?feed.getChildAt(before):null;
            }
            if(view==null)continue;
            view.setTag(row.key());rowViews.put(row.key(),view);rowSignatures.put(row.key(),signature);retained.add(row.key());
            if(feed.indexOfChild(view)!=position){feed.removeView(view);feed.addView(view,position);}position++;
        }
        for(String key:new HashSet<>(rowViews.keySet()))if(!retained.contains(key)){feed.removeView(rowViews.remove(key));rowSignatures.remove(key);}

    }
    private void selectConversation(String id){
        try{if(id.isBlank())chat.newConversation();else {chat.selectConversation(id);ConnectionService service=ConnectionService.current;JSONObject state=service==null?null:service.snapshot().optJSONObject("state");JSONArray tasks=state==null?null:state.optJSONArray("tasks");if(tasks!=null)for(int n=0;n<tasks.length();n++){JSONObject t=tasks.optJSONObject(n);if(t!=null&&id.equals(t.optString("id")))chat.identifyRole(t.optString("roleId","concierge"));}}showAssistantList(false);lastRender="";syncComposer();render();}
        catch(IllegalStateException e){toast(e.getMessage());}
    }
    private void showConversations(){
        ConnectionService service=ConnectionService.current;if(service==null)return;
        JSONObject state=service.snapshot().optJSONObject("state");JSONArray tasks=state==null?null:state.optJSONArray("tasks");List<String> ids=new ArrayList<>(),labels=new ArrayList<>();ids.add("");labels.add("新对话");
        if(tasks!=null)for(JSONObject task:ConversationIdentity.latest(tasks,chat.roleId())){String id=ConversationIdentity.resolve(tasks,ChatPresenter.string(task,"id")),title=ChatPresenter.string(task,"title");if(!id.isBlank()){ids.add(id);labels.add((title.isBlank()?"未命名对话":title)+" · "+taskStatus(ChatPresenter.string(task,"status")));}}
        showChoices("历史对话",labels.toArray(new String[0]),which->selectConversation(ids.get(which)));
    }
    private String delivery(String value){return switch(value){case "queued"->"消息保存在这台手机，等待连接。";case "sending"->"正在交给电脑…";case "unconfirmed"->"接收结果待核实；正在查询原消息，没有重复执行。";case "not_received"->"电脑没有接收这条请求，已停止发送。";case "cancelled_local"->"你已接管，未发送这条请求。";case "received"->"电脑已接收，正在更新任务状态。";default->"正在核实状态…";};}
    private CharSequence replyText(TextView view,String value){return ChatText.assistant(value,Math.max(0,dp(10)-Math.round(view.getLineSpacingExtra())));}
    private void bubble(String value,boolean user){
        if(value==null||value.isBlank())return;
        TextView v=new TextView(this){@Override protected void onMeasure(int widthSpec,int heightSpec){if(user&&View.MeasureSpec.getMode(widthSpec)!=View.MeasureSpec.UNSPECIFIED)widthSpec=View.MeasureSpec.makeMeasureSpec(Math.min(View.MeasureSpec.getSize(widthSpec),Math.round(View.MeasureSpec.getSize(widthSpec)*.8f)+getPaddingLeft()+getPaddingRight()),View.MeasureSpec.AT_MOST);super.onMeasure(widthSpec,heightSpec);}};v.setTextSize(15);v.setTextColor(INK);v.setIncludeFontPadding(false);v.setFallbackLineSpacing(false);v.setLineHeight(Math.round(v.getTextSize()*(user?1.6f:1.75f)));v.setText(user?value:replyText(v,value));v.setTextIsSelectable(true);v.setPadding(dp(16),dp(10),dp(16),dp(10));GradientDrawable bubbleBg=background(user?0xfff0eef6:Color.TRANSPARENT,18);if(user)bubbleBg.setStroke(dp(1),0xffe7e3f0);v.setBackground(bubbleBg);
        LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(user?-2:-1,-2);p.topMargin=0;p.bottomMargin=dp(user?22:18);if(user){p.gravity=Gravity.END;}else {v.setPadding(0,0,0,0);}feed.addView(v,p);
    }
    private void taskCard(JSONObject task,ConnectionService service,long now){
        String id=task.optString("id"),state=task.optString("status");
        LinearLayout card=new LinearLayout(this);card.setOrientation(LinearLayout.VERTICAL);card.setPadding(0,0,0,dp(12));
        if("ready_for_user".equals(state)){LinearLayout handoff=row();handoff.addView(new BotAvatar(this,assistantPanel.role(chat.roleId()).optString("botColor")),new LinearLayout.LayoutParams(dp(34),dp(34)));TextView note=text("已准备好，请在手机上接着处理",14,0xff7c6aa6);note.setPadding(dp(10),0,0,0);handoff.addView(note,new LinearLayout.LayoutParams(0,-2,1));card.addView(handoff);}
        JSONObject cache=renderedData.optJSONObject("taskDetails");JSONObject cached=cache==null?null:cache.optJSONObject(id),detail=cached==null?null:cached.optJSONObject("detail");JSONArray approvals=task.optJSONArray("approvals");if(approvals==null)approvals=detail==null?null:detail.optJSONArray("approvals");
        if("waiting_approval".equals(state)&&approvals!=null)for(int n=0;n<approvals.length();n++){
            JSONObject approval=approvals.optJSONObject(n);if(approval==null||!"pending".equals(approval.optString("status","pending")))continue;
            LinearLayout confirmation=new LinearLayout(this);confirmation.setOrientation(LinearLayout.VERTICAL);confirmation.setPadding(dp(18),dp(16),dp(18),dp(16));GradientDrawable cbg=background(0xfffffaf0,16);cbg.setStroke(dp(1),0xffefd9ae);confirmation.setBackground(cbg);
            boolean expired=ApprovalPresentation.expired(approval,now);
            LinearLayout heading=row();UiIcon help=new UiIcon(this,"help","",()->{});help.setClickable(false);help.setFocusable(false);help.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);heading.addView(help,new LinearLayout.LayoutParams(dp(18),dp(18)));TextView label=text(ApprovalPresentation.label(approval,now),12,0xffa87b2c);LinearLayout.LayoutParams labelParams=new LinearLayout.LayoutParams(0,-2,1);labelParams.leftMargin=dp(8);heading.addView(label,labelParams);confirmation.addView(heading);
            TextView description=text(approval.optString("summary",approval.optString("tool")),15,INK);description.setTextIsSelectable(true);description.setPadding(0,dp(10),0,0);confirmation.addView(description);
            LinearLayout step=detailLink("查看这一步的具体内容",MUTED,()->showTaskDetails(id));step.setMinimumHeight(dp(40));LinearLayout.LayoutParams stepParams=new LinearLayout.LayoutParams(-1,-2);stepParams.bottomMargin=dp(4);confirmation.addView(step,stepParams);
            confirmation.addView(approvalControls(id,approval,now));LinearLayout.LayoutParams confirmationParams=new LinearLayout.LayoutParams(-1,-2);confirmationParams.bottomMargin=dp(6);card.addView(confirmation,confirmationParams);
        }
        LinearLayout actions=row();actions.setPadding(0,dp(8),0,0);LinearLayout details=detailLink("处理过程",0xff9a94a3,()->showTaskDetails(id));actions.addView(details,new LinearLayout.LayoutParams(0,dp(44),1));
        TaskActions.Action primary=TaskActions.primary(task,now);
        if(primary!=TaskActions.Action.NONE){Button action=button(TaskActions.label(primary),()->performTaskAction(latestRenderedTask(id,task),primary));action.setEnabled(primary==TaskActions.Action.STOP||!taskActionPending(renderedData,id));actions.addView(action,new LinearLayout.LayoutParams(-2,dp(44)));}card.addView(actions);feed.addView(card);
    }

    private LinearLayout detailLink(String title,int ink,Runnable action){
        LinearLayout link=row();link.setFocusable(true);link.setOnClickListener(v->action.run());link.setContentDescription(title);
        UiIcon chevron=new UiIcon(this,"chevron","",()->{});chevron.setInk(ink);chevron.setClickable(false);chevron.setFocusable(false);chevron.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);link.addView(chevron,new LinearLayout.LayoutParams(dp(13),dp(13)));
        TextView label=text(title,13,ink);label.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(0,-2,1);params.leftMargin=dp(6);link.addView(label,params);return link;
    }

    private void performTaskAction(JSONObject task,TaskActions.Action action){
        ConnectionService service=ConnectionService.current;if(service==null){toast("连接服务正在启动");return;}
        String id=ChatPresenter.string(task,"id");
        TaskActions.Action current=TaskActions.primary(task,actionNow(service));if(current!=action){toast("任务状态已变化，请刷新查看");return;}
        switch(action){
            case STOP->service.stopTask(id);
            case CONTINUE->service.continueTask(id);
            case RECONCILE->{service.reconcileTask(id);moveTaskToBack(true);}
            case RESTART->service.restartTask(id,ChatPresenter.string(task,"restartKey"));
            case CONSENT->service.consentTask(id,(reply,error)->main.post(()->{if(!isDestroyed())toast(error==null?"已开始处理这项任务":"请求未完成，请查看任务状态");}));
            default->{}
        }
    }
    public void showTaskDetails(String id){
        ConnectionService service=ConnectionService.current;if(service==null){toast("连接服务正在启动");return;}
        AlertDialog loading=new AlertDialog.Builder(this).setMessage("正在读取任务…").setNegativeButton("关闭",null).show();
        service.taskDetails(id,(detail,error)->main.post(()->{
            if(!loading.isShowing()||isFinishing())return;loading.dismiss();
            if(error!=null){toast(error.getMessage()==null?"任务详情读取失败":error.getMessage());return;}
            renderTaskDetails(id,detail);
        }));
    }
    private void renderTaskDetails(String id,JSONObject detail){
        if(taskDialog!=null)taskDialog.dismiss();
        LinearLayout body=new LinearLayout(this);body.setOrientation(LinearLayout.VERTICAL);body.setPadding(dp(20),dp(8),dp(20),dp(20));
        TextView state=text(taskStatus(detail.optString("status")),13,MUTED);body.addView(state);
        body.addView(button("示范一次手机操作",()->{if(taskDialog!=null)taskDialog.dismiss();startActivity(new Intent(this,DemonstrationActivity.class).putExtra("taskId",id));}));
        if(detail.optBoolean("browserWorkspaceAvailable"))body.addView(button("电脑工作页 · 查看并操作",()->{if(taskDialog!=null)taskDialog.dismiss();startActivityForResult(new Intent(this,BrowserActivity.class).putExtra("taskId",id),BROWSER_WORKSPACE);}));
        String result=ChatPresenter.detailResult(detail);if(!result.isBlank())body.addView(text(result,15,INK));
        if(!result.isBlank()&&detail.opt("result") instanceof String)body.addView(button("朗读结果",()->playSpeech(id,"result")));
        if("waiting_consent".equals(detail.optString("status"))){
            TextView explanation=text("仅允许这项任务发送给 DeepSeek，并交还手机控制。不更改默认设置，也不额外授权读取记忆。",14,MUTED);explanation.setPadding(0,dp(12),0,dp(8));body.addView(explanation);
            Button consent=button("允许本次使用 DeepSeek",()->{
                ConnectionService service=ConnectionService.current;if(service==null){toast("连接服务正在启动");return;}
                if(taskDialog!=null)taskDialog.dismiss();service.consentTask(id,(reply,error)->main.post(()->{
                    if(isFinishing())return;toast(error==null?"已授权这次任务":"授权结果待核实："+(error.getMessage()==null?"请刷新详情":error.getMessage()));
                }));
            });body.addView(consent,new LinearLayout.LayoutParams(-1,dp(46)));
        }
        TaskActions.Action detailAction=TaskActions.primary(detail,ConnectionService.current==null?System.currentTimeMillis():ConnectionService.current.taskActionNow());
        if(detail.optString("groupId").isBlank()&&(detailAction==TaskActions.Action.CONTINUE||detailAction==TaskActions.Action.RESTART||detailAction==TaskActions.Action.RECONCILE)){
            Button resume=button(TaskActions.label(detailAction),()->{if(taskDialog!=null)taskDialog.dismiss();performTaskAction(detail,detailAction);});
            LinearLayout.LayoutParams gap=new LinearLayout.LayoutParams(-1,dp(44));gap.topMargin=dp(10);body.addView(resume,gap);
        }
        JSONArray approvals=detail.optJSONArray("approvals");if(approvals!=null)for(int i=0;i<approvals.length();i++){
            JSONObject approval=approvals.optJSONObject(i);if(approval==null||!approval.optString("status","pending").equals("pending"))continue;
            TextView label=text("需要你确认",14,PURPLE);label.setPadding(0,dp(16),0,dp(5));body.addView(label);
            String summary=ApprovalPresentation.details(approval);TextView description=text(summary,15,INK);description.setTextIsSelectable(true);body.addView(description);
            body.addView(approvalControls(id,approval));
        }
        JSONArray artifacts=detail.optJSONArray("artifacts");if(artifacts!=null&&artifacts.length()>0){
            TextView title=text("任务文件",14,PURPLE);title.setPadding(0,dp(16),0,dp(6));body.addView(title);
            for(int i=0;i<artifacts.length();i++){
                JSONObject artifact=artifacts.optJSONObject(i);if(artifact==null)continue;
                String name=artifact.optString("name","文件"),size=artifact.has("size")?" · "+Math.max(1,Math.round(artifact.optLong("size")/1024.0))+" KB":"";
                if(ImagePreviews.mime(artifact).startsWith("image/")||ImagePreviews.mime(artifact).startsWith("video/"))body.addView(button("预览 "+name,()->previewArtifact(artifact)));
                Button save=button("保存 "+name+size,()->chooseArtifactDestination(artifact));LinearLayout.LayoutParams gap=new LinearLayout.LayoutParams(-1,-2);gap.topMargin=dp(6);body.addView(save,gap);
            }
        }
        JSONArray diagnostics=detail.optJSONArray("diagnostics");
        if(diagnostics!=null){
            java.util.Set<String> seen=new java.util.HashSet<>();
            for(int i=diagnostics.length()-1;i>=Math.max(0,diagnostics.length()-6);i--){
                JSONObject row=diagnostics.optJSONObject(i);if(row==null)continue;
                String message=ChatPresenter.phoneDiagnostic(row);if(message.isBlank()||!seen.add(message))continue;
                TextView entry=text(message,12,MUTED);entry.setPadding(0,dp(6),0,0);body.addView(entry);
            }
        }
        JSONArray messages=detail.optJSONArray("messages");if(messages!=null&&messages.length()>0){
            TextView title=text("对话记录",14,PURPLE);title.setPadding(0,dp(16),0,dp(6));body.addView(title);
            for(int i=0;i<messages.length();i++){JSONObject message=messages.optJSONObject(i);if(message==null)continue;
                String content=message.optString("content",message.optString("text"));if(content.isBlank())continue;
                TextView entry=text(("user".equals(message.optString("role"))?"你：":"助理：")+content,14,INK);entry.setTextIsSelectable(true);entry.setPadding(0,dp(6),0,dp(6));body.addView(entry);
                if("assistant".equals(message.optString("role"))&&!message.optString("id").isBlank())body.addView(button("朗读这条回答",()->playSpeech(id,message.optString("id"))));
            }
        }
        for(int n=0;n<body.getChildCount();n++)if(body.getChildAt(n) instanceof Button){LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.topMargin=dp(8);body.getChildAt(n).setLayoutParams(p);}
        Button close=button("关闭",()->{if(taskDialog!=null)taskDialog.dismiss();});Button refresh=button("刷新",()->{if(taskDialog!=null)taskDialog.dismiss();showTaskDetails(id);});
        taskDialog=new UiSheet(this,detail.optString("title","任务详情"),body,UiSheet.footer(this,close,refresh));taskDialog.show();
    }
    private LinearLayout approvalControls(String taskId,JSONObject approval){return approvalControls(taskId,approval,actionNow(ConnectionService.current));}
    private LinearLayout approvalControls(String taskId,JSONObject approval,long now){
        LinearLayout box=new LinearLayout(this);box.setOrientation(LinearLayout.VERTICAL);
        TextView progress=text("",12,MUTED);box.addView(progress);WrapLayout choices=new WrapLayout(this,dp(8));
        Button allow=button("允许这次操作",()->{}),deny=button("拒绝",()->{});UiSheet.primary(this,allow);
        choices.addView(allow,new ViewGroup.LayoutParams(-2,dp(44)));choices.addView(deny,new ViewGroup.LayoutParams(-2,dp(44)));box.addView(choices);
        String status=ApprovalRequests.status(ConnectionService.current==null?renderedData:ConnectionService.current.snapshot(),approval);
        boolean busy=Set.of("sending","accepted").contains(status);allow.setEnabled(!busy&&!ApprovalPresentation.expired(approval,now));deny.setEnabled(!busy);
        progress.setText("sending".equals(status)?"正在提交，请稍候…":"accepted".equals(status)?"电脑已收到这项决定":"unconfirmed".equals(status)?"上次提交结果未确认，请先刷新任务核实":"");
        allow.setOnClickListener(v->decideApproval(taskId,approval,true,allow,deny,progress));deny.setOnClickListener(v->decideApproval(taskId,approval,false,allow,deny,progress));return box;
    }
    private void decideApproval(String taskId,JSONObject approval,boolean allow,Button yes,Button no,TextView progress){
        ConnectionService service=ConnectionService.current;if(allow&&ApprovalPresentation.expired(approval,actionNow(service))){progress.setText("确认已过期，请刷新任务核实");yes.setEnabled(false);return;}if(service==null){progress.setText("连接服务正在启动，请稍后重试");return;}
        yes.setEnabled(false);no.setEnabled(false);progress.setText("正在提交，请稍候…");
        service.approval(approval.optString("id"),approval.optString("fingerprint"),allow,(reply,error)->main.post(()->{
            if(isFinishing()||isDestroyed())return;
            String message=error==null?(allow?"电脑已收到授权，任务将继续":"电脑已收到拒绝决定"):("结果未确认："+(error.getMessage()==null?"请刷新任务核实":error.getMessage()));
            if(error instanceof GatewayClient.GatewayError rejected){
                if(rejected.code.equals("approval_expired"))message="这项确认已失效，请刷新任务查看当前状态";
                else if(rejected.code.equals("approval_changed"))message="操作内容已变化，请查看新的确认项";
            }
            progress.setText(message);toast(message);render();
        }));
    }
    private void chooseArtifactDestination(JSONObject artifact){
        pendingArtifact=artifact;
        Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(artifact.optString("mime","application/octet-stream")).putExtra(Intent.EXTRA_TITLE,artifact.optString("name","Boujoy 文件"));
        startActivityForResult(intent,SAVE_ARTIFACT);
    }
    private String taskStatus(String state){return ChatPresenter.taskStatus(state);}
    private void showReasoning(){
        ConnectionService service=ConnectionService.current;if(service==null){toast("连接服务正在启动");return;}
        service.reasoningSettings(null,(reply,error)->main.post(()->{
            if(error!=null||reply==null){toast("思考设置读取失败，请确认电脑在线后重试");return;}
            showReasoningOptions(reply,service);
        }));
    }
    private void showReasoningOptions(JSONObject reply,ConnectionService service){
            JSONArray options=reply.optJSONArray("options");if(options==null||options.length()==0){toast("请先更新电脑端");return;}
            String[] labels=new String[options.length()];String selected=reply.optString("modelReasoning","auto");
            for(int i=0;i<labels.length;i++){JSONObject option=options.optJSONObject(i);labels[i]=(selected.equals(option.optString("value"))?"✓ ":"")+option.optString("label")+" · "+option.optString("description");}
            showChoices("思考档位 · 两端共用，下次任务生效",labels,index->{
                service.reasoningSettings(options.optJSONObject(index).optString("value"),(saved,failure)->main.post(()->{
                    if(failure!=null){toast("思考档位未保存，请重试");return;}
                    toast("已保存："+options.optJSONObject(index).optString("label")+"，下次任务生效");showConnection();
                }));
            });
    }

    private void showConnection(){showConnection("");}
    private void showConnection(String initial){ConnectionService service=ConnectionService.current;showConnection(initial,service==null?renderedData:service.snapshot());}
    private void showConnection(String initial,JSONObject data){
        if(connectionDialog!=null)connectionDialog.dismiss();
        boolean paired=data.optBoolean("paired"),online=data.optBoolean("online");
        LinearLayout body=UiSheet.column(this);body.setPadding(dp(20),dp(16),dp(20),dp(24));
        LinearLayout status=UiSheet.column(this);status.setPadding(dp(14),dp(14),dp(14),dp(14));status.setBackground(UiSheet.surface(this,online?0xfff4f7ef:0xfffaf8f2,14,online?0xffe2e9d8:0xffeee6d7));
        TextView state=text(paired?(online?"电脑已连接":"电脑暂不可用"):"连接你的电脑",16,INK);state.setTypeface(Typeface.create(Typeface.DEFAULT,600,false));status.addView(state);
        TextView explanation=text(paired?(online?"你可以直接在对话里交代事情。":"连接已保存，电脑恢复可用后会自动重连。"):"在电脑端打开 Boujoy 的异地连接，获取连接码或连接文件。",13,MUTED);explanation.setPadding(0,dp(7),0,0);status.addView(explanation);body.addView(status);
        if(paired)UiSheet.spaced(body,UiSheet.actionRow(this,"重试连接","连接异常时重新连接电脑",()->{
            ConnectionService current=ConnectionService.current;if(current==null){toast("连接服务正在启动");return;}
            current.reconnectTransport();if(connectionDialog!=null)connectionDialog.dismiss();toast("正在重新连接电脑");
        }),10);
        LinearLayout configuration=UiSheet.column(this);configuration.setVisibility(!paired||!initial.isBlank()?View.VISIBLE:View.GONE);
        TextView codeLabel=text("连接码",12,MUTED);codeLabel.setPadding(0,dp(16),0,dp(8));configuration.addView(codeLabel);
        EditText config=UiSheet.input(this,"电脑连接码");config.setHint("粘贴电脑端生成的连接码");config.setTextSize(13);config.setMinLines(3);config.setMaxLines(6);config.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE|android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);config.setText(initial);configuration.addView(config,new LinearLayout.LayoutParams(-1,-2));
        Button connect=button("连接电脑",()->{ConnectionService service=ConnectionService.current;if(service==null){toast("连接服务正在启动");return;}if(config.getText().toString().isBlank()){config.setError("请粘贴连接码");return;}service.importBinding(config.getText().toString());if(connectionDialog!=null)connectionDialog.dismiss();});UiSheet.primary(this,connect);connect.setMinimumHeight(dp(48));UiSheet.spaced(configuration,connect,10);
        UiSheet.spaced(configuration,UiSheet.actionRow(this,"导入连接文件","选择电脑端生成的文件",()->{Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json");startActivityForResult(intent,BIND_FILE);}),10);
        if(paired)UiSheet.spaced(body,UiSheet.actionRow(this,"重新配置连接","更换电脑或更新连接码",()->configuration.setVisibility(configuration.getVisibility()==View.VISIBLE?View.GONE:View.VISIBLE)),10);body.addView(configuration);
        if(BuildConfig.BACKGROUND_SUPPORTED){
        UiSheet.section(body,"小米后台执行");
        shizukuStatus=backgroundStatusRow(body,"授权 Shizuku",()->{
            try{DisplayBridge.get(this).requestPermission(this);}catch(Exception e){toast("请先打开 Shizuku 并启动服务");}
        });
        backgroundExecutorStatus=backgroundStatusRow(body,"Boujoy 后台执行",()->{
            startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
        });
        rearDisplayStatus=backgroundStatusRow(body,"背屏进度",()->{
            DisplayBridge bridge=DisplayBridge.get(this);boolean enabled=!bridge.isRearProgressEnabled();bridge.setRearProgressEnabled(enabled);refreshBackgroundStatus();
            if(enabled)new Thread(()->{try{bridge.startRear();}catch(Exception e){main.post(()->toast("背屏进度已开启，显示暂不可用，请检查 Shizuku 状态"));}finally{main.post(this::refreshBackgroundStatus);}},"boujoy-rear-open").start();
        });
        rearLockscreenStatus=null;
        if(RearLockscreenPermission.isSupportedDevice()){
            rearLockscreenStatus=backgroundStatusRow(body,"锁屏显示权限",()->{
                if(!RearLockscreenPermission.openSettings(this))toast("无法打开系统权限页，请在系统设置中查看 Boujoy 的应用权限");
            });
            TextView lockscreenHelp=text("熄屏显示背屏任务需要此权限；系统仍可能限制背屏启动。\n进入后选择「锁屏显示」或「锁屏时显示」，设为允许。",12,MUTED);lockscreenHelp.setPadding(0,dp(8),0,0);body.addView(lockscreenHelp);
        }
        TextView backgroundHelp=text("后台执行仅用于 Boujoy 的后台显示。请亲手授权 Shizuku，并在无障碍设置中开启「Boujoy 后台执行」。",12,MUTED);backgroundHelp.setPadding(0,dp(10),0,0);body.addView(backgroundHelp);
        }
        UiSheet.section(body,"思考方式");
        UiSheet.spaced(body,UiSheet.actionRow(this,"思考档位","与电脑同步 · 不改变任务时限或工具能力",()->showReasoning()),8);
        UiSheet.section(body,"通知");
        LinearLayout quietRow=row();quietRow.setPadding(dp(14),dp(12),dp(10),dp(12));quietRow.setMinimumHeight(dp(64));quietRow.setBackground(UiSheet.surface(this,Color.WHITE,12,0xffeceaef));LinearLayout quietCopy=UiSheet.column(this);quietCopy.addView(text("仅提醒需要我处理的任务",14,INK));TextView quietNote=text("其余进展留在对话里",12,MUTED);quietNote.setPadding(0,dp(5),0,0);quietCopy.addView(quietNote);quietRow.addView(quietCopy,new LinearLayout.LayoutParams(0,-2,1));
        Switch quiet=new Switch(this);quiet.setContentDescription("仅提醒需要我处理的任务");quiet.setMinHeight(dp(44));quiet.setMinWidth(dp(48));JSONObject stateData=data.optJSONObject("state"),preferences=stateData==null?null:stateData.optJSONObject("notificationPreferences");quiet.setChecked(preferences==null||preferences.optBoolean("quiet",true));quiet.setOnCheckedChangeListener((view,checked)->{ConnectionService service=ConnectionService.current;if(service!=null)service.notificationQuiet(checked,(reply,error)->main.post(()->{if(error!=null)toast("通知设置未保存，请重试");}));});LinearLayout.LayoutParams qp=new LinearLayout.LayoutParams(-2,-2);qp.leftMargin=dp(12);quietRow.addView(quiet,qp);body.addView(quietRow);
        UiSheet.spaced(body,UiSheet.actionRow(this,"系统通知权限","查看系统的通知设置",()->startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,getPackageName()))),8);
        UiSheet.section(body,"手机运行");
        body.addView(UiSheet.actionRow(this,"手机操作服务","打开 Phone Use",()->{Intent launch=getPackageManager().getLaunchIntentForPackage("ai.nidhoggfgg.phoneuse");if(launch!=null)startActivity(launch);else toast("请先安装官方 Phone Use");}));
        UiSheet.spaced(body,UiSheet.actionRow(this,"后台运行","查看系统电池限制",()->{try{startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));}catch(Exception e){startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getPackageName())));}}),8);
        UiSheet.spaced(body,UiSheet.actionRow(this,"无线输入",BoujoyTypingService.ready()?"已启用":"尚未启用 · 查看设置",()->startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))),8);
        connectionDialog=new UiSheet(this,"设置",body,null);connectionDialog.show();refreshBackgroundStatus();
    }
    private TextView backgroundStatusRow(LinearLayout body,String title,Runnable action){
        LinearLayout view=UiSheet.actionRow(this,title,"检查状态…",action);UiSheet.spaced(body,view,8);
        return (TextView)((LinearLayout)view.getChildAt(0)).getChildAt(1);
    }
    private void refreshBackgroundStatus(){
        if(!BuildConfig.BACKGROUND_SUPPORTED||connectionDialog==null||!connectionDialog.isShowing()||shizukuStatus==null)return;
        JSONObject state=DisplayBridge.get(this).status();
        String shizuku=switch(state.optString("shizuku")){case "running"->"已授权 · 服务运行中";case "permission_required"->"等待你授权";case "unsupported"->"当前设备不支持";default->"服务未运行 · 请先打开 Shizuku";};
        shizukuStatus.setText(shizuku);
        backgroundExecutorStatus.setText(state.optBoolean("executorService")?"已启用 · 只作用于后台显示":"尚未启用 · 打开无障碍设置");
        JSONObject rear=state.optJSONObject("rear");
        boolean rearEnabled=DisplayBridge.get(this).isRearProgressEnabled();
        rearDisplayStatus.setText(!rearEnabled?"未开启 · 点击跟随新任务显示进度":rear==null||!rear.optBoolean("available")?"已开启 · 暂未发现背屏 · 点击关闭":rear.optBoolean("showing")?"已开启 · 背屏正在显示 · 点击关闭":"已开启 · 跟随新任务 · 点击关闭");
        if(rearLockscreenStatus!=null)rearLockscreenStatus.setText(RearLockscreenPermission.statusText(RearLockscreenPermission.read(this)));
    }
    private void chooseAttachment(){showChoices("添加附件",new String[]{"照片或视频","文件"},which->{Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");if(which==0)intent.putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"image/*","video/*"});intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true);startActivityForResult(intent,ATTACH);});}
    private void manageAttachments(){JSONArray selected=chat.attachments();String[] names=new String[selected.length()];for(int i=0;i<names.length;i++)names[i]="移除 · "+AttachmentDrafts.label(selected.optJSONObject(i));showChoices("已选附件",names,which->{selected.remove(which);chat.setAttachments(selected);syncComposer();});}
    private void artifactCard(String encoded){try{feed.addView(artifactView(new JSONObject(encoded)));}catch(JSONException ignored){}}
    public View artifactView(JSONObject artifact){LinearLayout card=new LinearLayout(this);card.setOrientation(LinearLayout.VERTICAL);card.setPadding(dp(14),dp(12),dp(14),dp(12));card.setBackground(UiSheet.surface(this,0xfff7f6fa,14,0xffebe8f0));
        String mime=ImagePreviews.mime(artifact),kind=mime.startsWith("image/")?"照片":mime.startsWith("video/")?"视频":"文件";
        TextView name=text(("input".equals(artifact.optString("kind"))?(artifact.optBoolean("imported")?"任务图片 · ":"已发送 · "):"收到 · ")+kind+"\n"+AttachmentDrafts.label(artifact),14,INK);card.addView(name);
        if(mime.startsWith("image/"))addImageThumbnail(card,artifact);
        LinearLayout actions=row();if(mime.startsWith("image/")||mime.startsWith("video/"))actions.addView(button("预览",()->previewArtifact(artifact)),new LinearLayout.LayoutParams(0,-2,1));actions.addView(button("保存到手机",()->chooseArtifactDestination(artifact)),new LinearLayout.LayoutParams(0,-2,1));card.addView(actions);LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.topMargin=dp(8);p.bottomMargin=dp(8);card.setLayoutParams(p);return card;
    }
    private void addImageThumbnail(LinearLayout card,JSONObject artifact){
        ImageView thumbnail=new ImageView(this);thumbnail.setScaleType(ImageView.ScaleType.FIT_CENTER);thumbnail.setContentDescription("查看图片 "+artifact.optString("name"));thumbnail.setBackground(background(0xfff0edf4,10));
        LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,dp(180));params.topMargin=dp(8);card.addView(thumbnail,params);
        TextView hint=text("图片加载中…",12,MUTED);card.addView(hint);
        Runnable load=()->{hint.setText("图片加载中…");imagePreviews.load(artifact,(bitmap,error)->{if(isDestroyed()||!thumbnail.isAttachedToWindow())return;if(error==null){thumbnail.setImageBitmap(bitmap);hint.setText("点击查看大图");}else hint.setText("图片暂未加载，点预览重试");});};
        thumbnail.setOnClickListener(v->previewArtifact(artifact));
        thumbnail.getViewTreeObserver().addOnPreDrawListener(new android.view.ViewTreeObserver.OnPreDrawListener(){public boolean onPreDraw(){
            if(thumbnail.isShown()&&thumbnail.getGlobalVisibleRect(new android.graphics.Rect())){thumbnail.getViewTreeObserver().removeOnPreDrawListener(this);load.run();}return true;
        }});
    }
    private void previewArtifact(JSONObject artifact){
        if(mediaPreview!=null)mediaPreview.dismiss();
        LinearLayout body=new LinearLayout(this);body.setOrientation(LinearLayout.VERTICAL);body.setPadding(dp(16),dp(12),dp(16),dp(12));
        TextView status=text("正在加载预览…",14,MUTED);body.addView(status);Button retry=button("重新加载",()->{});retry.setVisibility(View.GONE);body.addView(retry);
        UiSheet preview=new UiSheet(this,artifact.optString("name","附件"),body,button("保存到手机",()->chooseArtifactDestination(artifact)));mediaPreview=preview;
        final VideoView[] video={null};final File[] videoFile={null};
        preview.setOnDismissListener(d->{if(video[0]!=null)video[0].stopPlayback();if(videoFile[0]!=null)videoFile[0].delete();});preview.show();
        Runnable load=()->{
            status.setText("正在加载预览…");retry.setVisibility(View.GONE);
            if(ImagePreviews.mime(artifact).startsWith("image/"))imagePreviews.load(artifact,(bitmap,error)->{
                if(isDestroyed()||!preview.isShowing())return;
                if(error!=null){status.setText("图片暂未加载："+error.getMessage());retry.setVisibility(View.VISIBLE);return;}
                status.setText("已加载 · 可保存原图");ImageView image=new ImageView(this);image.setAdjustViewBounds(true);image.setScaleType(ImageView.ScaleType.FIT_CENTER);image.setImageBitmap(bitmap);image.setContentDescription("图片预览 "+artifact.optString("name"));body.addView(image,new LinearLayout.LayoutParams(-1,-2));
            });
            else {ConnectionService service=ConnectionService.current;if(service==null){status.setText("电脑连接尚未就绪");retry.setVisibility(View.VISIBLE);return;}
                service.downloadArtifact(artifact.optString("id"),(file,error)->main.post(()->{
                    if(isDestroyed()||!preview.isShowing()){if(file!=null)file.delete();return;}
                    if(error!=null){status.setText("视频暂未加载："+error.getMessage());retry.setVisibility(View.VISIBLE);return;}
                    videoFile[0]=file;VideoView view=new VideoView(this);video[0]=view;view.setVideoPath(file.getAbsolutePath());MediaController controls=new MediaController(this);controls.setAnchorView(view);view.setMediaController(controls);view.setOnPreparedListener(player->{status.setText("视频已加载");view.start();});view.setOnErrorListener((player,what,extra)->{status.setText("视频格式暂不支持，请保存后播放");return true;});body.addView(view,new LinearLayout.LayoutParams(-1,dp(280)));
                }));
            }
        };retry.setOnClickListener(v->load.run());load.run();
    }

    /** Tap to start and tap again to stop, or hold to talk and release. Slide up while holding to cancel. */
    private void voice(){if(recorder!=null)finishRecording();else startRecording();}
    private boolean micTouch(View v,MotionEvent e){
        switch(e.getActionMasked()){
            case MotionEvent.ACTION_DOWN:
                micDownAt=SystemClock.uptimeMillis();micDownY=e.getRawY();micStartedByPress=false;
                if(recorder==null&&!transcribing){micStartedByPress=startRecording();if(micStartedByPress)v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);}
                return true;
            case MotionEvent.ACTION_MOVE:
                if(recorder!=null&&micStartedByPress)composer.setHint(micDownY-e.getRawY()>dp(80)?"松开取消录音":"正在录音… 松开结束，上滑取消");
                return true;
            case MotionEvent.ACTION_UP:{
                if(recorder==null)return true;
                boolean held=SystemClock.uptimeMillis()-micDownAt>=600;
                if(micStartedByPress&&micDownY-e.getRawY()>dp(80)){discardRecording();toast("已取消录音");return true;}
                if(micStartedByPress&&!held){composer.setHint("正在录音… 再点一下麦克风结束");return true;}
                v.performClick();return true;
            }
            case MotionEvent.ACTION_CANCEL:
                if(recorder!=null&&micStartedByPress&&SystemClock.uptimeMillis()-micDownAt>=600)discardRecording();
                return true;
            default:return true;
        }
    }
    private MediaRecorder prepareRecorder(boolean opus)throws Exception{
        if(recordingFile!=null)recordingFile.delete();
        recordingFile=File.createTempFile("boujoy-recording-",opus?".ogg":".m4a",getCacheDir());
        MediaRecorder value=new MediaRecorder(this);recorder=value;
        value.setAudioSource(MediaRecorder.AudioSource.MIC);
        if(opus){value.setOutputFormat(MediaRecorder.OutputFormat.OGG);value.setAudioEncoder(MediaRecorder.AudioEncoder.OPUS);value.setAudioEncodingBitRate(24000);}
        else{value.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);value.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);value.setAudioEncodingBitRate(64000);}
        value.setAudioChannels(1);value.setAudioSamplingRate(16000);value.setMaxDuration(120000);value.setMaxFileSize(8L*1024*1024);
        value.setOutputFile(recordingFile.getAbsolutePath());
        value.setOnInfoListener((r,what,extra)->{if(what==MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED||what==MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED)main.post(this::finishRecording);});
        value.prepare();return value;
    }
    private void discardRecorderOnly(){if(recorder!=null){try{recorder.reset();}catch(Exception ignored){}recorder.release();recorder=null;}}
    private boolean startRecording(){
        if(checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED){requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},VOICE);return false;}
        ConnectionService service=ConnectionService.current;if(service==null||!service.snapshot().optBoolean("online")){toast("请先连接电脑，录音由电脑转写");return false;}
        discardRecording();stopPlayback();
        try{
            // Ogg Opus goes straight to speech recognition on the computer without a conversion step;
            // a phone that cannot record it falls back to AAC in MP4.
            try{recorder=prepareRecorder(true);}catch(Exception opusUnavailable){discardRecorderOnly();recorder=prepareRecorder(false);}
            recorder.start();
            if(mic!=null)mic.setBackground(background(0xffffe1e4,22));
            composer.setHint("正在录音… 松开结束，上滑取消");
            return true;
        }catch(Exception e){discardRecording();toast("录音未能启动，请检查麦克风权限");return false;}
    }
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] results){super.onRequestPermissionsResult(request,permissions,results);if(request==VOICE&&results.length>0&&results[0]==PackageManager.PERMISSION_GRANTED)voice();}
    private void discardRecording(){if(recorder!=null){try{recorder.stop();}catch(Exception ignored){}recorder.release();recorder=null;}if(recordingFile!=null){recordingFile.delete();recordingFile=null;}if(recordingDialog!=null){recordingDialog.dismiss();recordingDialog=null;}resetMic();}
    private void resetMic(){if(mic!=null)mic.setBackground(null);if(composer!=null)composer.setHint(transcribing?"正在转写…":"交给我办什么？");}
    private void finishRecording(){
        if(recorder==null)return;final byte[] bytes;
        try{recorder.stop();recorder.release();recorder=null;bytes=java.nio.file.Files.readAllBytes(recordingFile.toPath());}
        catch(Exception e){discardRecording();toast("录音太短或未能保存，请重新录制");return;}
        discardRecording();ConnectionService service=ConnectionService.current;if(service==null)return;
        // The words go straight into the input box: edit them there and send, no extra dialogs.
        transcribing=true;resetMic();
        service.transcribeVoice(bytes,(draft,error)->main.post(()->{
            transcribing=false;resetMic();
            if(!visible||isFinishing())return;
            if(error!=null){toast("转写未完成："+error.getMessage());return;}
            String words=draft.optString("text").trim();if(words.isEmpty()){toast("没听清，再说一次试试");return;}
            String before=chat.text();chat.setText(before.isBlank()?words:before.endsWith(" ")||before.endsWith("\n")?before+words:before+" "+words);
            syncComposer();composer.requestFocus();composer.setSelection(composer.length());
        }));
    }
    private void stopPlayback(){playbackGeneration++;if(player!=null){try{player.stop();}catch(Exception ignored){}player.release();player=null;}if(playbackFile!=null){playbackFile.delete();playbackFile=null;}}
    private void playSpeech(String taskId,String messageId){
        ConnectionService service=ConnectionService.current;if(service==null)return;stopPlayback();final long generation=playbackGeneration;toast("Mac 正在生成本地朗读…");
        service.speech(taskId,messageId,(bytes,error)->main.post(()->{
            if(!visible||isFinishing()||generation!=playbackGeneration)return;if(error!=null){toast("朗读未完成："+error.getMessage());return;}
            try{stopPlayback();playbackFile=File.createTempFile("boujoy-speech-",".wav",getCacheDir());java.nio.file.Files.write(playbackFile.toPath(),bytes);player=new MediaPlayer();player.setDataSource(playbackFile.getAbsolutePath());player.prepare();player.setOnCompletionListener(p->stopPlayback());player.start();new AlertDialog.Builder(this).setTitle("正在朗读").setMessage("音频由你的 Mac 本地生成。").setPositiveButton("停止",(d,w)->stopPlayback()).setOnCancelListener(d->stopPlayback()).show();}
            catch(Exception e){stopPlayback();toast("音频播放失败");}
        }));
    }
    private String downloadSize(long bytes){return bytes<1024?bytes+" B":bytes<1048576?String.format(java.util.Locale.ROOT,"%.1f KB",bytes/1024.0):String.format(java.util.Locale.ROOT,"%.1f MB",bytes/1048576.0);}
    @Override protected void onActivityResult(int request,int result,Intent data){
        super.onActivityResult(request,result,data);if(result!=RESULT_OK||data==null)return;
        if(request==BROWSER_WORKSPACE){explicitBrowserHandoff=data.getBooleanExtra("explicitHandoff",false);return;}
        if(request==SAVE_ARTIFACT&&data.getData()!=null&&pendingArtifact!=null){
            JSONObject artifact=pendingArtifact;pendingArtifact=null;ConnectionService service=ConnectionService.current;
            if(service==null){Uri destination=data.getData();SaveDestination.cleanup(getContentResolver(),destination,SaveDestination.isEmpty(getContentResolver(),destination));toast("连接服务正在启动，文件尚未保存，请重新保存");return;}
            if(artifactSaveProgress!=null)artifactSaveProgress.dismiss();AlertDialog progress=new AlertDialog.Builder(this).setTitle("正在保存文件").setMessage("正在连接电脑读取文件…").setNegativeButton("收起",null).create();artifactSaveProgress=progress;progress.setOnDismissListener(d->{if(artifactSaveProgress==progress)artifactSaveProgress=null;});progress.show();
            service.saveArtifact(artifact.optString("id"),data.getData(),(received,total)->main.post(()->{if(!isDestroyed()&&progress.isShowing())progress.setMessage(artifact.optString("name","附件")+"\n已下载 "+downloadSize(received)+(total>0?" / "+downloadSize(total):"")+"\n下载完成并校验后写入手机，可收起继续聊天。");}),(bytes,error)->main.post(()->{
                if(isDestroyed())return;String message=error==null?"文件已保存 · "+downloadSize(bytes):"文件未保存，请检查连接或保存位置后重新保存。";
                if(progress.isShowing()){progress.setTitle(error==null?"保存完成":"保存未完成");progress.setMessage(message);progress.getButton(AlertDialog.BUTTON_NEGATIVE).setText("关闭");}else toast(message);
            }));return;
        }
        if(request==BIND_FILE&&data.getData()!=null){
            Uri uri=data.getData();new Thread(()->{
                try{ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(InputStream input=getContentResolver().openInputStream(uri)){
                    if(input==null)throw new IOException("无法打开连接文件");byte[] buffer=new byte[2048];int count;
                    while((count=input.read(buffer))!=-1){bytes.write(buffer,0,count);if(bytes.size()>16384)throw new IOException("连接文件过大");}
                }
                    String configuration=bytes.toString(java.nio.charset.StandardCharsets.UTF_8);new Binding(new JSONObject(configuration),true);
                    main.post(()->showConnection(configuration));
                }catch(Exception e){main.post(()->toast("连接文件无效或已过期"));}
            },"binding-reader").start();return;
        }
        if(request==ATTACH){
            List<Uri> uris=new ArrayList<>();if(data.getClipData()!=null){for(int i=0;i<data.getClipData().getItemCount();i++)uris.add(data.getClipData().getItemAt(i).getUri());}else if(data.getData()!=null)uris.add(data.getData());
            JSONArray selected=chat.attachments();if(selected.length()+uris.size()>10){toast("每条消息最多 10 个附件");return;}
            ChatComposerState.AttachmentTicket ticket=chat.beginAttachmentRead();toast("正在准备附件…");new Thread(()->{
                try{for(Uri uri:uris)selected.put(AttachmentDrafts.read(this,uri));main.post(()->{if(chat.acceptAttachment(ticket,selected)&&!isDestroyed())syncComposer();});}
                catch(Exception e){main.post(()->toast(e.getMessage()==null?"附件读取失败":e.getMessage()));}
            },"attachment-reader").start();
        }
    }

    private void toast(String message){Toast.makeText(this,message,Toast.LENGTH_SHORT).show();}
}
