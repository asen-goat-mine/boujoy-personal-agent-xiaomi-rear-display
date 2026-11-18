package dev.boujoy.personalagent;

import android.app.Activity;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.widget.*;
import org.json.*;
import java.util.*;

/** Public group conversations. Reading a group never dispatches, resumes or changes control. */
final class GroupPanel {
    interface Host { void showTaskDetails(String id); View artifactView(JSONObject artifact); }
    interface Client {
        void groupRead(String id,ConnectionService.Outcome<JSONObject> callback);
        void groupRequest(String path,JSONObject input,ConnectionService.Outcome<JSONObject> callback);
        void consentTask(String id,ConnectionService.Outcome<JSONObject> callback);
        JSONObject snapshot();
    }
    private final Activity activity;
    private final Client client;
    private final Host host;
    private final Handler main=new Handler(Looper.getMainLooper());
    private UiSheet sheet,editor;
    private JSONObject snapshot=new JSONObject(),detail=new JSONObject();
    private LinearLayout content,transcript,members,pendingRows;
    private TextView notice,replyLabel,groupHeading;
    private boolean showAllTasks,showFollowup;
    private String replyTo="";
    private final Map<String,String> replyDrafts=new HashMap<>();
    private final Map<String,Set<String>> recipientDrafts=new HashMap<>();
    private EditText composer;
    private Button send,newMessages;
    private String lastMessageId="";
    private int unreadMessages;
    private String groupId="",signature="",pendingId="",pendingFingerprint="";
    private final Map<String,String> drafts=new HashMap<>();
    private final Set<String> recipients=new LinkedHashSet<>();
    private long generation;
    private boolean sending,reading,closed;
    private static final int INK=0xff242426,MUTED=0xff8a8a92,ACCENT=0xff8065a7;
    private final Runnable refresh=new Runnable(){public void run(){if(sheet!=null&&sheet.isShowing()&&!groupId.isBlank()&&!activity.isFinishing()){readDetail(false);main.postDelayed(this,4000);}}};
    GroupPanel(Activity activity){this(activity,null);}
    GroupPanel(Activity activity,Client client){this(activity,client,activity instanceof Host?(Host)activity:null);}
    GroupPanel(Activity activity,Client client,Host host){this.activity=activity;this.client=client;this.host=host;}
    void update(JSONObject value){snapshot=value;if(requestRejected(pendingId)){pendingId="";pendingFingerprint="";}drawPending();}
    private int dp(int value){return UiSheet.dp(activity,value);}
    private LinearLayout column(){return UiSheet.column(activity);}
    private LinearLayout row(){LinearLayout v=new LinearLayout(activity);v.setGravity(Gravity.CENTER_VERTICAL);return v;}
    private TextView label(String text,int size,int color){return UiSheet.label(activity,text,size,color);}
    private Button button(String text,Runnable action){return UiSheet.button(activity,text,action);}
    private JSONArray array(JSONObject value,String key){JSONArray result=value.optJSONArray(key);return result==null?new JSONArray():result;}
    private String roleName(String id){for(JSONArray list:new JSONArray[]{array(detail,"members"),array(snapshot.optJSONObject("state")==null?new JSONObject():snapshot.optJSONObject("state"),"roles")})for(int n=0;n<list.length();n++){JSONObject r=list.optJSONObject(n);if(r!=null&&id.equals(r.optString("id")))return r.optString("name","助理");}return "助理";}
    private Client service(){if(client!=null)return client;ConnectionService service=ConnectionService.current;if(service==null){note("连接服务正在启动，请稍后重试");return null;}return new Client(){
        public void groupRead(String id,ConnectionService.Outcome<JSONObject> callback){service.groupRead(id,callback);}
        public void groupRequest(String path,JSONObject input,ConnectionService.Outcome<JSONObject> callback){service.groupRequest(path,input,callback);}
        public void consentTask(String id,ConnectionService.Outcome<JSONObject> callback){service.consentTask(id,callback);}
        public JSONObject snapshot(){return service.snapshot();}
    };}
    private void note(String text){if(notice!=null)notice.setText(text);else Toast.makeText(activity,text,Toast.LENGTH_SHORT).show();}
    private void saveDraft(){if(composer!=null&&!groupId.isBlank()){drafts.put(groupId,composer.getText().toString());replyDrafts.put(groupId,replyTo);recipientDrafts.put(groupId,new LinkedHashSet<>(recipients));}}
    private void dismiss(){saveDraft();generation++;reading=false;main.removeCallbacks(refresh);if(sheet!=null)sheet.dismiss();sheet=null;composer=null;}
    void close(){closed=true;dismiss();if(editor!=null)editor.dismiss();main.removeCallbacksAndMessages(null);}
    void showList(){
        closed=false;dismiss();groupId="";content=column();content.setPadding(dp(20),dp(12),dp(20),dp(24));notice=label("正在读取群聊…",12,MUTED);content.addView(notice);
        UiSheet.spaced(content,button("＋ 创建群",()->editMembers(null)),14);LinearLayout list=column();UiSheet.spaced(content,list,16);pendingRows=column();UiSheet.spaced(content,pendingRows,12);drawPending();
        sheet=new UiSheet(activity,"群聊",content,null);sheet.show();long ticket=generation;Client service=service();if(service==null)return;
        JSONObject state=snapshot.optJSONObject("state");JSONArray cached=state==null?new JSONArray():array(state,"groups");
        renderGroupList(list,cached);if(cached.length()>0)note("已显示上次同步的群聊，正在更新…");
        service.groupRead("",(reply,error)->main.post(()->{
            if(closed||ticket!=generation||sheet==null||!sheet.isShowing())return;
            if(error!=null){note(cached.length()>0?"暂未连上电脑，显示上次同步的群聊。":"群列表暂未读取："+error.getMessage());UiSheet.spaced(list,button("重试",this::showList),10);return;}
            JSONArray groups=array(reply,"groups");renderGroupList(list,groups);
            note(groups.length()==0?"建群后可 @ 指定助理，也可让协调员判断是否接手。":"@ 成员可直接派工。未点名时，由协调员判断是否需要回应。");
        }));
    }
    private void renderGroupList(LinearLayout list,JSONArray groups){
        list.removeAllViews();
        for(int n=0;n<groups.length();n++){JSONObject group=groups.optJSONObject(n);if(group==null||group.optString("id").isBlank())continue;String id=group.optString("id");UiSheet.spaced(list,UiSheet.actionRow(activity,group.optString("name","群聊"),array(group,"memberRoleIds").length()+" 位助理",()->showGroup(id)),10);}
    }

    void showGroup(String id){
        if(id==null||id.isBlank())return;closed=false;dismiss();groupId=id;signature="";lastMessageId="";unreadMessages=0;showAllTasks=false;showFollowup=false;recipients.clear();recipients.addAll(recipientDrafts.getOrDefault(id,Set.of()));replyTo=replyDrafts.getOrDefault(id,"");detail=new JSONObject();content=column();content.setPadding(dp(20),dp(10),dp(20),dp(20));
        LinearLayout controls=row();Button back=button("群列表",this::showList),manage=button("成员",()->editMembers(detail));controls.addView(back,new LinearLayout.LayoutParams(0,-2,1));LinearLayout.LayoutParams manageParams=new LinearLayout.LayoutParams(0,-2,1);manageParams.leftMargin=dp(10);controls.addView(manage,manageParams);content.addView(controls);groupHeading=label("群聊",22,INK);groupHeading.setTypeface(android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT,600,false));UiSheet.spaced(content,groupHeading,18);
        notice=label("正在读取群聊…",12,MUTED);UiSheet.spaced(content,notice,12);transcript=column();UiSheet.spaced(content,transcript,14);pendingRows=column();UiSheet.spaced(content,pendingRows,12);drawPending();
        LinearLayout footer=column();footer.setPadding(dp(16),dp(10),dp(16),dp(16));footer.setBackgroundColor(Color.WHITE);newMessages=button("有新消息 ↓",()->{unreadMessages=0;newMessages.setVisibility(View.GONE);sheet.scroll.fullScroll(View.FOCUS_DOWN);});newMessages.setTextSize(12);newMessages.setTextColor(ACCENT);newMessages.setVisibility(View.GONE);footer.addView(newMessages,new LinearLayout.LayoutParams(-1,dp(40)));HorizontalScrollView names=new HorizontalScrollView(activity);names.setHorizontalScrollBarEnabled(false);members=row();names.addView(members);footer.addView(names);
        replyLabel=label("",12,ACCENT);replyLabel.setOnClickListener(v->{replyTo="";drawReply();});footer.addView(replyLabel);
        composer=UiSheet.input(activity,"群消息");composer.setHint("交代一件事，或选择助理");composer.setMinLines(2);composer.setMaxLines(4);composer.setText(drafts.getOrDefault(id,""));UiSheet.spaced(footer,composer,10);
        LinearLayout action=row();TextView hint=label("点击成员可指定回应者",11,MUTED);action.addView(hint,new LinearLayout.LayoutParams(0,-2,1));send=button("发送",this::sendMessage);UiSheet.primary(activity,send);action.addView(send,new LinearLayout.LayoutParams(dp(76),dp(44)));UiSheet.spaced(footer,action,8);
        sheet=new UiSheet(activity,"群聊",content,footer);sheet.setOnDismissListener(d->{saveDraft();main.removeCallbacks(refresh);});sheet.show();drawPending();readDetail(true);main.postDelayed(refresh,4000);
    }
    private void readDetail(boolean explicit){
        if(reading||groupId.isBlank())return;Client service=service();if(service==null)return;long ticket=generation;String id=groupId;reading=true;
        service.groupRead(id,(reply,error)->main.post(()->{if(closed||ticket!=generation||!id.equals(groupId))return;reading=false;if(sheet==null||!sheet.isShowing())return;if(error!=null){note("群状态暂未更新："+error.getMessage());return;}String next=reply.toString();detail=reply;if(!next.equals(signature)){signature=next;drawDetail();}else if(explicit)note("已读取群状态");}));
    }
    static String coordinatorHint(String status) {
        return switch (status) {
            case "pending" -> "协调员正在判断是否需要回应";
            case "needs_consent" -> "本条未允许使用 DeepSeek，尚未判断是否接手。需要指派时可点名成员。";
            case "needs_setup" -> "模型连接尚未配置，消息已保存，暂未派工。";
            case "budget_limited" -> "今日模型额度已用完，消息已保存，暂未派工。";
            case "interrupted" -> "接手判断已中断，消息已保存。";
            case "revoked" -> "群成员、授权或任务期限已变化，未派工。";
            case "unavailable" -> "模型暂时无法判断是否接手，消息已保存。";
            default -> null;
        };
    }
    private void drawDetail(){
        if(transcript==null)return;boolean bottom=sheet.scroll.getChildAt(0)==null||sheet.scroll.getChildAt(0).getHeight()-sheet.scroll.getScrollY()-sheet.scroll.getHeight()<dp(70);int top=sheet.scroll.getScrollY();
        if(groupHeading!=null)groupHeading.setText(detail.optString("name","群聊"));note(array(detail,"members").length()+" 位助理 · 回复可继续同一件事");drawReply();members.removeAllViews();JSONArray roster=array(detail,"members");Set<String> available=new HashSet<>();for(int n=0;n<roster.length();n++){JSONObject r=roster.optJSONObject(n);if(r==null||!r.optBoolean("available",true))continue;String id=r.optString("id");available.add(id);Button chip=button((recipients.contains(id)?"✓ ":"@")+r.optString("name"),()->{if(!recipients.remove(id))recipients.add(id);drawDetail();});chip.setTextSize(12);if(recipients.contains(id)){chip.setTextColor(ACCENT);chip.setBackground(UiSheet.surface(activity,0xfff1ebf8,20,0xffd7cae8));}LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-2,dp(44));p.rightMargin=dp(7);members.addView(chip,p);}recipients.retainAll(available);
        transcript.removeAllViews();
        JSONArray messages=array(detail,"messages");String latest=messages.length()==0?"":messages.optJSONObject(messages.length()-1).optString("id");if(!lastMessageId.isBlank()&&!latest.equals(lastMessageId)&&!bottom){int index=-1;for(int n=0;n<messages.length();n++)if(lastMessageId.equals(messages.optJSONObject(n).optString("id")))index=n;if(index>=0)unreadMessages+=messages.length()-index-1;}if(bottom)unreadMessages=0;lastMessageId=latest;if(newMessages!=null){newMessages.setVisibility(unreadMessages>0?View.VISIBLE:View.GONE);newMessages.setText(unreadMessages+" 条新消息 ↓");}if(messages.length()==0)transcript.addView(label("群里还没有消息。\n点一位助理，把第一件事交给它。",15,MUTED));
        for(int n=Math.max(0,messages.length()-80);n<messages.length();n++){JSONObject m=messages.optJSONObject(n);if(m==null)continue;String kind=m.optString("kind");LinearLayout item=column();item.setPadding(dp(12),dp(10),dp(12),dp(10));String speaker="user".equals(kind)?"你":roleName(m.optString("roleId"));if("handoff".equals(kind)){JSONArray to=array(m,"recipientRoleIds");if(to.length()>0)speaker+=" → "+roleName(to.optString(0));}LinearLayout identity=row();if(!"user".equals(kind)&&!"handoff".equals(kind)){String color="";JSONArray roles=array(snapshot.optJSONObject("state")==null?new JSONObject():snapshot.optJSONObject("state"),"roles");for(int ri=0;ri<roles.length();ri++){JSONObject role=roles.optJSONObject(ri);if(role!=null&&m.optString("roleId").equals(role.optString("id")))color=role.optString("botColor");}BotAvatar portrait=new BotAvatar(activity,color);portrait.setClickable(false);portrait.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);LinearLayout.LayoutParams avatarParams=new LinearLayout.LayoutParams(dp(28),dp(28));avatarParams.rightMargin=dp(8);identity.addView(portrait,avatarParams);}identity.addView(label(speaker,12,ACCENT),new LinearLayout.LayoutParams(0,-2,1));String time="";try{time=java.time.Instant.parse(m.optString("createdAt")).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("HH:mm"));}catch(Exception ignored){}if(!time.isBlank())identity.addView(label(time,10,MUTED));item.addView(identity);View text=ReplyView.create(activity,m.optString("content"),"user".equals(kind));UiSheet.spaced(item,text,6);
            JSONArray artifacts=array(m,"artifacts");if(host!=null)for(int a=0;a<artifacts.length();a++){JSONObject artifact=artifacts.optJSONObject(a);if(artifact!=null&&!artifact.optString("id").isBlank())UiSheet.spaced(item,host.artifactView(artifact),8);}if("handoff".equals(kind)){text.setVisibility(View.GONE);TextView expand=label("查看交接内容",11,MUTED);expand.setMinHeight(dp(44));expand.setGravity(Gravity.CENTER_VERTICAL);expand.setOnClickListener(v->{boolean open=text.getVisibility()==View.VISIBLE;text.setVisibility(open?View.GONE:View.VISIBLE);expand.setText(open?"查看交接内容":"收起交接内容");});item.addView(expand);}if("assistant".equals(kind)){TextView reply=label("回复 "+speaker,11,MUTED);reply.setMinHeight(dp(44));reply.setGravity(Gravity.CENTER_VERTICAL);reply.setOnClickListener(v->{replyTo=m.optString("id");recipients.clear();recipients.add(m.optString("roleId"));drawDetail();composer.requestFocus();});item.addView(reply);}String decisionHint="user".equals(kind)?coordinatorHint(m.optString("coordinatorStatus")):null;if(decisionHint!=null)UiSheet.spaced(item,label(decisionHint,12,MUTED),6);if("user".equals(kind))item.setBackground(UiSheet.surface(activity,0xfff3eff8,14,0));else if("handoff".equals(kind))item.setBackground(UiSheet.surface(activity,0xfffaf8fd,12,0xffeee8f4));UiSheet.spaced(transcript,item,16);}
        LinkedHashMap<String,JSONObject> receipts=new LinkedHashMap<>();JSONArray receiptRows=array(detail,"receipts");for(int n=0;n<receiptRows.length();n++){JSONObject r=receiptRows.optJSONObject(n);if(r!=null)receipts.put(r.optString("taskId"),r);}JSONArray tasks=array(detail,"tasks");int archived=0;for(int n=0;n<tasks.length();n++){JSONObject task=tasks.optJSONObject(n);if(task!=null&&Set.of("completed","cancelled").contains(task.optString("status")))archived++;}
        int unfinished=tasks.length()-archived,running=0;for(int n=0;n<tasks.length();n++){JSONObject task=tasks.optJSONObject(n);if(task!=null&&Set.of("running","queued","waiting_children").contains(task.optString("status")))running++;}
        if(unfinished>0){TextView heading=label("任务跟进 · "+unfinished+" · "+(running>0?running+" 进行中":unfinished+" 待处理"),12,MUTED);heading.setContentDescription(showFollowup?"收起任务跟进":"展开任务跟进");heading.setMinHeight(dp(44));heading.setGravity(Gravity.CENTER_VERTICAL);heading.setCompoundDrawablePadding(dp(6));heading.setOnClickListener(v->{showFollowup=!showFollowup;drawDetail();});transcript.addView(heading);}
        if(archived>0){TextView heading=label(showAllTasks?"收起已结束任务":"已结束任务 · "+archived,12,MUTED);heading.setMinHeight(dp(44));heading.setGravity(Gravity.CENTER_VERTICAL);heading.setOnClickListener(v->{showAllTasks=!showAllTasks;drawDetail();});transcript.addView(heading);}

        for(int n=0;n<tasks.length();n++){JSONObject task=tasks.optJSONObject(n);if(task==null)continue;boolean ended=Set.of("completed","cancelled").contains(task.optString("status"));if(ended?!showAllTasks:!showFollowup&&!"waiting_approval".equals(task.optString("status")))continue;String id=task.optString("id"),status=task.optString("status");JSONObject receipt=receipts.get(id);LinearLayout item=column();item.setPadding(dp(12),dp(10),dp(12),dp(10));item.setBackground(UiSheet.surface(activity,0xfffaf9fc,12,0xffece8f1));item.addView(label(roleName(task.optString("roleId"))+" · "+(receipt==null?ChatPresenter.taskStatus(status):receipt.optString("label",ChatPresenter.taskStatus(status))),12,ACCENT));String taskTitle=task.optString("title");if(!taskTitle.isBlank()){TextView title=label(taskTitle,13,INK);title.setMaxLines(1);title.setEllipsize(android.text.TextUtils.TruncateAt.END);UiSheet.spaced(item,title,5);}String reason=task.optString("blockedReason");if(!reason.isBlank()){TextView reasonView=label(reason,12,MUTED);reasonView.setMaxLines(2);reasonView.setEllipsize(android.text.TextUtils.TruncateAt.END);UiSheet.spaced(item,reasonView,5);}if(Set.of("running","queued","waiting_children","waiting_approval").contains(status))UiSheet.spaced(item,button("暂停这件事",()->control(id,"pause")),8);else if(Set.of("paused","interrupted","blocked","waiting_setup","needs_review").contains(status))UiSheet.spaced(item,button("继续这件事",()->control(id,"resume")),8);if("waiting_consent".equals(status))UiSheet.spaced(item,button("允许本次使用模型",()->consent(id)),8);if(host!=null)UiSheet.spaced(item,button("waiting_approval".equals(status)?"查看并处理确认":"查看任务",()->host.showTaskDetails(id)),8);UiSheet.spaced(transcript,item,8);}
        sheet.scroll.post(()->{if(sheet!=null&&sheet.isShowing()){if(bottom)sheet.scroll.fullScroll(View.FOCUS_DOWN);else sheet.scroll.scrollTo(0,top);}});
    }
    private void drawReply(){if(replyLabel==null)return;JSONObject target=null;JSONArray messages=array(detail,"messages");for(int n=0;n<messages.length();n++){JSONObject m=messages.optJSONObject(n);if(m!=null&&replyTo.equals(m.optString("id")))target=m;}replyLabel.setVisibility(replyTo.isBlank()?View.GONE:View.VISIBLE);replyLabel.setText(target==null?"正在回复 · 点击取消":"回复 "+roleName(target.optString("roleId"))+" · 点击取消");}
    private void sendMessage(){
        if(sending||composer==null)return;String text=composer.getText().toString().trim();if(text.isBlank()){composer.setError("写一句要交给助理的话");return;}Client service=service();if(service==null)return;
        JSONObject pending=snapshot.optJSONObject("groupRequests");if(pending!=null){Iterator<String> keys=pending.keys();while(keys.hasNext()){JSONObject row=pending.optJSONObject(keys.next());if(row!=null&&!row.optBoolean("rejected")&&row.optString("path").equals("/v1/groups/"+groupId+"/messages")&&sameDraft(row.optJSONObject("body"))){note("这条消息还未确认，请用原请求重试。");return;}}}
        String fingerprint=groupId+"|"+text+"|"+recipients.toString()+"|"+replyTo;if(!fingerprint.equals(pendingFingerprint)){pendingFingerprint=fingerprint;pendingId=Protocol.id();}JSONObject payload=Tunnel.json("messageId",pendingId,"content",text,"memoryConsent",false);if(!replyTo.isBlank())try{payload.put("replyToMessageId",replyTo);}catch(JSONException ignored){}if(!recipients.isEmpty())try{payload.put("recipientRoleIds",new JSONArray(recipients));}catch(JSONException ignored){}
        long ticket=generation;String id=groupId;sending=true;send.setEnabled(false);note("正在确认这条群消息…");
        service.groupRequest("/v1/groups/"+id+"/messages",payload,(reply,error)->main.post(()->{sending=false;update(service.snapshot());if(closed||ticket!=generation||!id.equals(groupId))return;send.setEnabled(true);if(error!=null){note("这条消息尚未确认："+error.getMessage()+"。原文已保留。");return;}pendingId="";pendingFingerprint="";if(sameDraft(payload)){composer.setText("");drafts.remove(id);replyDrafts.remove(id);recipientDrafts.remove(id);replyTo="";recipients.clear();drawReply();}note("消息已接收");signature="";readDetail(true);}));
    }
    private void consent(String taskId){Client service=service();if(service==null)return;long ticket=generation;service.consentTask(taskId,(reply,error)->main.post(()->{if(closed||ticket!=generation)return;if(error!=null){note("授权未确认："+error.getMessage());return;}signature="";readDetail(true);}));}
    private void control(String taskId,String action){if(hasPending("/v1/groups/"+groupId+"/tasks/"+taskId+"/"+action)){note("该操作还未确认，请先用原请求重试。");return;}Client service=service();if(service==null)return;long ticket=generation;String id=groupId;service.groupRequest("/v1/groups/"+id+"/tasks/"+taskId+"/"+action,Tunnel.json("messageId",Protocol.id()),(reply,error)->main.post(()->{update(service.snapshot());if(closed||ticket!=generation)return;if(error!=null){note("操作未确认："+error.getMessage());return;}readDetail(true);}));}
    private boolean requestRejected(String id){JSONObject rows=snapshot.optJSONObject("groupRequests"),entry=rows==null?null:rows.optJSONObject(id);return entry!=null&&entry.optBoolean("rejected");}
    private boolean sameDraft(JSONObject original){if(original==null||composer==null||!original.optString("content").trim().equals(composer.getText().toString().trim())||!original.optString("replyToMessageId").equals(replyTo))return false;Set<String> ids=new HashSet<>();JSONArray selected=array(original,"recipientRoleIds");for(int n=0;n<selected.length();n++)ids.add(selected.optString(n));return ids.equals(recipients);}
    private void restoreDraft(JSONObject payload){if(composer==null)return;composer.setText(payload.optString("content"));replyTo=payload.optString("replyToMessageId");recipients.clear();JSONArray ids=array(payload,"recipientRoleIds");for(int n=0;n<ids.length();n++)recipients.add(ids.optString(n));if(requestRejected(payload.optString("messageId"))){pendingId="";pendingFingerprint="";}drawDetail();note("草稿已恢复，请核对后再发送。");}
    private boolean hasPending(String path){JSONObject rows=snapshot.optJSONObject("groupRequests");if(rows==null)return false;Iterator<String> keys=rows.keys();while(keys.hasNext()){JSONObject row=rows.optJSONObject(keys.next());if(row!=null&&!row.optBoolean("rejected")&&path.equals(row.optString("path")))return true;}return false;}
    private void drawPending(){
        if(pendingRows==null)return;pendingRows.removeAllViews();JSONObject requests=snapshot.optJSONObject("groupRequests");if(requests==null)return;Iterator<String> keys=requests.keys();
        while(keys.hasNext()){JSONObject entry=requests.optJSONObject(keys.next());if(entry==null)continue;String path=entry.optString("path");if(!groupId.isBlank()&&!path.startsWith("/v1/groups/"+groupId+"/"))continue;JSONObject payload=entry.optJSONObject("body");if(payload==null)continue;String title=payload.optString("content",payload.optString("name","群操作"));if(composer!=null&&payload.has("content"))UiSheet.spaced(pendingRows,button("恢复这条草稿",()->restoreDraft(payload)),8);
            if(entry.optBoolean("rejected")){UiSheet.spaced(pendingRows,label("未接受："+title+"\n"+entry.optString("error"),12,MUTED),8);continue;}
            UiSheet.spaced(pendingRows,label("请求尚未确认："+title,12,ACCENT),8);Button retry=button("用原请求重试",()->{});retry.setOnClickListener(v->{Client service=service();if(service==null)return;long ticket=generation;retry.setEnabled(false);service.groupRequest(path,payload,(reply,error)->main.post(()->{if(closed||ticket!=generation)return;update(service.snapshot());retry.setEnabled(true);if(error!=null){note("请求尚未确认："+error.getMessage());return;}if(path.equals("/v1/groups")){showGroup(reply.optString("id"));return;}if(composer!=null&&path.endsWith("/messages")&&sameDraft(payload)){composer.setText("");drafts.remove(groupId);replyDrafts.remove(groupId);recipientDrafts.remove(groupId);replyTo="";recipients.clear();drawReply();pendingId="";pendingFingerprint="";}if(groupId.isBlank())showList();else readDetail(true);}));});UiSheet.spaced(pendingRows,retry,8);
        }
    }
    private void editMembers(JSONObject current){
        if(current!=null&&current.optString("id").isBlank()){note("群信息还没有读到，请稍后重试");return;}if(editor!=null)editor.dismiss();boolean creating=current==null;LinearLayout form=column();form.setPadding(dp(20),dp(10),dp(20),dp(24));EditText name=UiSheet.input(activity,"群名称");name.setSingleLine(true);name.setHint("群名称");if(creating)form.addView(name);
        UiSheet.spaced(form,label("选中要加入群的专职助理。新的专职助理可在助理列表右上角创建。",13,MUTED),12);JSONObject state=snapshot.optJSONObject("state");JSONArray roles=array(state==null?new JSONObject():state,"roles");Set<String> existing=new LinkedHashSet<>();if(current!=null){JSONArray ids=array(current,"memberRoleIds");for(int n=0;n<ids.length();n++)existing.add(ids.optString(n));}Map<String,CheckBox> checks=new LinkedHashMap<>();for(int n=0;n<roles.length();n++){JSONObject role=roles.optJSONObject(n);if(role==null||role.optBoolean("hidden")||!role.isNull("deletedAt"))continue;String id=role.optString("id");CheckBox box=new CheckBox(activity);box.setText(activity.getString(R.string.group_member_description,role.optString("name"),role.optString("description")));box.setTextColor(INK);box.setTextSize(13);box.setMinHeight(dp(56));box.setChecked(existing.contains(id));checks.put(id,box);UiSheet.spaced(form,box,4);}
        final String[] request={"",""};Button cancel=button("取消",()->editor.dismiss());Button save=button(creating?"建群":"保存成员",()->{});UiSheet.primary(activity,save);save.setOnClickListener(v->{JSONArray selected=new JSONArray(),add=new JSONArray(),remove=new JSONArray();for(Map.Entry<String,CheckBox> entry:checks.entrySet()){if(entry.getValue().isChecked()){selected.put(entry.getKey());if(!existing.contains(entry.getKey()))add.put(entry.getKey());}else if(existing.contains(entry.getKey()))remove.put(entry.getKey());}if(selected.length()==0){Toast.makeText(activity,"至少选择一位助理",Toast.LENGTH_SHORT).show();return;}String title=name.getText().toString().trim();if(creating&&title.isBlank()){name.setError("写一个群名称");return;}if(!creating&&!checks.getOrDefault(current.optString("coordinatorRoleId"),new CheckBox(activity)).isChecked()){Toast.makeText(activity,"请保留群协调员",Toast.LENGTH_SHORT).show();return;}Client service=service();if(service==null)return;save.setEnabled(false);String fingerprint=title+"|"+selected.toString();if(!request[0].equals(fingerprint)||requestRejected(request[1])){request[0]=fingerprint;request[1]=Protocol.id();}JSONObject payload=creating?Tunnel.json("messageId",request[1],"name",title,"memberRoleIds",selected):Tunnel.json("messageId",request[1],"addRoleIds",add,"removeRoleIds",remove);String route=creating?"/v1/groups":"/v1/groups/"+current.optString("id")+"/members";if(hasPending(route)){save.setEnabled(true);note("该操作还未确认，请先用原请求重试。");editor.dismiss();return;}service.groupRequest(route,payload,(reply,error)->main.post(()->{if(activity.isDestroyed())return;update(service.snapshot());save.setEnabled(true);if(error!=null){Toast.makeText(activity,"未保存："+error.getMessage(),Toast.LENGTH_LONG).show();return;}editor.dismiss();if(creating){if(sheet!=null&&sheet.isShowing())showGroup(reply.optString("id"));}else{signature="";readDetail(true);}}));});
        editor=new UiSheet(activity,creating?"创建群":"群成员",form,UiSheet.footer(activity,cancel,save));editor.show();
    }
}
