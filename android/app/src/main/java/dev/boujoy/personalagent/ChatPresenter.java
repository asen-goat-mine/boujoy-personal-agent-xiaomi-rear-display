package dev.boujoy.personalagent;

import org.json.*;
import java.util.*;

/** Pure presentation: server messages are history; a task summary is never a reply to an outbox item. */
public final class ChatPresenter {
    public enum Kind { HEADER, USER, ASSISTANT, NOTICE, ACTIONS, GREETING, PROGRESS, ATTACHMENT, MATERIALS }
    public record Row(String key,String taskId,Kind kind,String text,String status) {}
    public record Presentation(List<Row> rows,String fingerprint) {}
    private static final Set<String> ACTIVE=Set.of("running","queued","waiting_children","waiting_approval");
    private ChatPresenter() {}
    static String string(JSONObject object,String key){Object value=object==null?null:object.opt(key);return value instanceof String?(String)value:"";}
    public static String detailResult(JSONObject detail){String result=string(detail,"result");return result.isBlank()?string(detail,"blockedReason"):result;}
    /** Content-free, fixed categories from the authenticated gateway. */
    public static String phoneDiagnostic(JSONObject row){
        String reason=string(row,"reason"),code=string(row,"failureCode");
        if(reason.isBlank())reason=string(row,"code");
        String text=switch(reason){
            case "outside_task_scope" -> "当前页面已离开任务应用";
            case "assistant_chat_foreground" -> "聊天界面在前台，手机连接仍保留";
            case "foreign_window_overlay" -> "其他应用窗口覆盖了任务页面";
            case "protected_account_surface" -> "已到密码、登录或确认页面，交给你处理";
            case "private_content_outside_scope" -> "当前私密内容不在任务范围内";
            case "observation_timeout","rpc_timeout" -> "云通道读屏超时，尚未取得可操作的画面";
            case "phone_use_observation_failed" -> "手机执行端未能返回有效画面";
            default -> "";
        };
        if(text.isBlank()&&"phone_transport".equals(string(row,"type")))return "";
        if(text.isBlank())text="手机操作未完成";
        String pkg=string(row,"foregroundPackage");
        if(pkg.matches("[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*){1,12}"))text+=" · "+pkg;
        if(code.matches("[A-Za-z0-9_]{1,80}"))text+="（"+code+"）";
        return text;
    }
    private static JSONArray array(JSONObject object,String key){JSONArray value=object==null?null:object.optJSONArray(key);return value==null?new JSONArray():value;}
    /** The gateway summary contract. Deliberately excludes global revision, clock, usage and device telemetry. */
    public static String taskVersion(JSONObject task){JSONArray values=new JSONArray();for(String key:List.of("id","updatedAt","title","status","result","blockedReason","preview","deadlineAt","restartKey","canReconcile","notice","phoneQueued"))values.put(task==null?JSONObject.NULL:task.opt(key));return values.toString();}
    private static String visibleSummary(JSONObject task){JSONArray values=new JSONArray();for(String key:List.of("id","title","status","result","blockedReason","preview","deadlineAt","restartKey"))values.put(string(task,key));return values.toString();}
    private static List<JSONObject> localRows(JSONObject outbox){
        List<JSONObject> result=new ArrayList<>();if(outbox!=null)outbox.keys().forEachRemaining(key->{JSONObject row=outbox.optJSONObject(key);if(row!=null&&row.optJSONObject("message")!=null)result.add(row);});
        result.sort(Comparator.<JSONObject>comparingLong(r->Binding.parseTime(r.optJSONObject("message").opt("createdAt"))).thenComparing(r->string(r.optJSONObject("message"),"messageId")));return result;
    }
    private static String localText(JSONObject message){return string(message,"text")+(array(message,"attachments").length()>0?"\n［已选择附件］":"");}
    private static String delivery(String status){return switch(status){
        case "queued"->"消息保存在这台手机，等待连接。";case "sending"->"正在交给电脑…";
        case "unconfirmed"->"接收结果待核实；正在查询原消息，没有重复执行。";
        case "not_received"->"电脑没有接收这条请求，已停止发送。";case "cancelled_local"->"你已接管，未发送这条请求。";
        case "received"->"电脑已接收；这条消息的完整对话正在同步。";default->"正在核实状态…";};}
    public static String taskStatus(String status){return switch(status){
        case "running"->"正在处理…";case "queued"->"已接收，等待执行。";case "waiting_children"->"正在由助理协作处理。";
        case "paused","stopped","interrupted"->"任务已暂停。";case "cancelled"->"已停止。";
        case "waiting_consent"->"这项任务需要你允许使用 DeepSeek，请打开详情。";
        case "waiting_approval","waiting_user","waiting_setup","blocked"->"需要你接着处理。";
        case "needs_input"->"请补充任务信息。";case "needs_review"->"需要你查看核实结果。";
        case "ready_for_user"->"已准备好，请你接手处理。";case "unknown_result"->"操作结果待核实，请查看手机后再决定。";
        case "expired"->"任务已到时限，后续操作已停止。";case "completed","succeeded"->"已完成。";
        case "failed"->"任务未完成，请查看具体原因。";default->status.isBlank()?"正在读取任务状态…":status;};}
    private static void add(List<Row> rows,String key,String task,Kind kind,String text){if(!text.isBlank())rows.add(new Row(key,task,kind,text,""));}
    public static Presentation present(JSONObject snapshot){return present(snapshot,null,"");}
    public static Presentation present(JSONObject snapshot,String selected,String pendingMessageId){
        JSONObject state=snapshot.optJSONObject("state"),outbox=snapshot.optJSONObject("outbox"),details=snapshot.optJSONObject("taskDetails");
        JSONArray source=array(state,"tasks");final String canonical=ConversationIdentity.resolve(source,selected);
        List<JSONObject> local=localRows(outbox),tasks=new ArrayList<>();Set<String> consumed=new HashSet<>();
        if(selected!=null)local.removeIf(row->{JSONObject message=row.optJSONObject("message");String target=string(row.optJSONObject("receipt"),"taskId");if(target.isBlank())target=string(message,"conversationId");return !string(message,"messageId").equals(pendingMessageId)&&(selected.isBlank()||!canonical.equals(ConversationIdentity.resolve(source,target)));});
        Map<String,String> owners=new HashMap<>();
        for(int i=0;i<source.length();i++){JSONObject task=source.optJSONObject(i);if(!ConversationIdentity.privateTask(task)||string(task,"id").isBlank()||selected!=null&&(selected.isBlank()||!canonical.equals(ConversationIdentity.resolve(source,string(task,"id")))))continue;tasks.add(task);
            JSONObject cached=details==null?null:details.optJSONObject(string(task,"id")),detail=cached==null?null:cached.optJSONObject("detail");
            for(int n=0;n<array(detail,"messages").length();n++){JSONObject message=array(detail,"messages").optJSONObject(n);if(message!=null&&!string(message,"clientRequestId").isBlank())owners.put(string(message,"clientRequestId"),string(task,"id"));}
        }
        // Stable conversation order follows the earliest actual message/local submission, not polling time.
        Map<String,Long> started=new HashMap<>();
        for(JSONObject task:tasks){String id=string(task,"id");JSONObject cached=details==null?null:details.optJSONObject(id),detail=cached==null?null:cached.optJSONObject("detail");long at=Long.MAX_VALUE;
            JSONArray history=array(detail,"messages");for(int i=0;i<history.length();i++){JSONObject message=history.optJSONObject(i);if(message!=null){long value=Binding.parseTime(message.opt("at"));if(value>0)at=Math.min(at,value);}}
            for(JSONObject row:local){JSONObject message=row.optJSONObject("message");String target=owners.getOrDefault(string(message,"messageId"),string(row.optJSONObject("receipt"),"taskId"));if(target.isBlank())target=string(message,"conversationId");if(id.equals(target)){long value=Binding.parseTime(message.opt("createdAt"));if(value>0)at=Math.min(at,value);}}
            if(at==Long.MAX_VALUE){at=Binding.parseTime(task.opt("createdAt"));if(at<=0)at=Binding.parseTime(task.opt("updatedAt"));}started.put(id,at);
        }
        tasks.sort(Comparator.<JSONObject>comparingLong(t->started.get(string(t,"id"))).thenComparing(t->string(t,"id")));
        List<Row> rows=new ArrayList<>();
        for(JSONObject task:tasks){String id=string(task,"id"),status=string(task,"status");JSONObject cached=details==null?null:details.optJSONObject(id),detail=cached==null?null:cached.optJSONObject("detail");
            boolean hasHistory=detail!=null&&detail.optJSONArray("messages")!=null, changedSummary=hasHistory&&!visibleSummary(task).equals(visibleSummary(detail));
            add(rows,id+":heading",id,Kind.HEADER,string(task,"title"));
            Set<String> confirmed=new HashSet<>();String lastAssistant="";boolean lastUser=false;
            JSONArray history=array(detail,"messages");Set<Integer> visibleReplies=new HashSet<>();int lastReply=-1;
            for(int n=0;n<history.length();n++){JSONObject m=history.optJSONObject(n);if(m==null)continue;if("user".equals(string(m,"role"))){if(lastReply>=0)visibleReplies.add(lastReply);lastReply=-1;}else if("assistant".equals(string(m,"role"))&&!string(m,"content").isBlank()&&string(m,"approvalId").isBlank())lastReply=n;}
            if(lastReply>=0&&(ACTIVE.contains(string(detail,"status"))||string(detail,"result").isBlank()||string(detail,"result").equals(string(history.optJSONObject(lastReply),"content"))))visibleReplies.add(lastReply);
            for(int i=0;i<history.length();i++){JSONObject message=history.optJSONObject(i);if(message==null)continue;String role=string(message,"role"),content=string(message,"content"),clientId=string(message,"clientRequestId");
                if(!clientId.isBlank()&&"user".equals(role))confirmed.add(clientId);
                if("assistant".equals(role)&&!visibleReplies.contains(i))continue;
                if(!Set.of("user","assistant").contains(role)||content.isBlank()||"user".equals(role)&&message.optBoolean("watchNotice"))continue;
                String messageId=string(message,"id");if(messageId.isBlank())messageId="index-"+i;
                boolean outcome="assistant".equals(role)&&!string(message,"outcome").isBlank()&&!"ready_for_user".equals(string(message,"outcome"));
                add(rows,id+":message:"+messageId,id,outcome?Kind.NOTICE:"user".equals(role)?Kind.USER:Kind.ASSISTANT,outcome?"未完成 · "+content:content);
                lastUser="user".equals(role);lastAssistant=lastUser?"":content;
            }
            // A confirmed task result belongs before any newer phone message still awaiting receipt.
            if(hasHistory){String result=string(detail,"result");if(!ACTIVE.contains(string(detail,"status"))&&!result.isBlank()&&(lastUser||!result.equals(lastAssistant)))add(rows,id+":result",id,Kind.ASSISTANT,result);}
            for(JSONObject row:local){JSONObject message=row.optJSONObject("message");String messageId=string(message,"messageId");
                String target=owners.getOrDefault(messageId,string(row.optJSONObject("receipt"),"taskId"));if(target.isBlank())target=string(message,"conversationId");
                if(!id.equals(target))continue;consumed.add(messageId);if(confirmed.contains(messageId))continue;
                add(rows,"local:"+messageId,id,Kind.USER,localText(message));add(rows,"delivery:"+messageId,id,Kind.NOTICE,delivery(string(row,"status")));
            }
            if(!hasHistory){String text=string(task,"result");if(text.isBlank())text=string(task,"blockedReason");if(text.isBlank())text=string(task,"preview");
                add(rows,id+":summary",id,Kind.NOTICE,"最新任务摘要（完整对话尚未同步）"+(text.isBlank()?"":"\n"+text));
            }else if(changedSummary){String result=string(task,"result");
                if(!ACTIVE.contains(status)&&!result.isBlank()&&!result.equals(lastAssistant))add(rows,id+":latest-result",id,Kind.NOTICE,"最新任务结果（对话记录同步中）\n"+result);
                else add(rows,id+":history-stale",id,Kind.NOTICE,"以上是已同步的对话记录，正在更新最新内容。");}
            JSONArray materials=new JSONArray();JSONArray artifacts=array(detail,"artifacts");for(int i=0;i<artifacts.length();i++){JSONObject artifact=artifacts.optJSONObject(i);if(artifact!=null&&!string(artifact,"id").isBlank()){if("input".equals(string(artifact,"kind"))&&(artifact.optBoolean("imported")||!string(artifact,"importedFrom").isBlank())&&!ImagePreviews.mime(artifact).startsWith("image/")&&!ImagePreviews.mime(artifact).startsWith("video/"))materials.put(artifact);else add(rows,id+":artifact:"+string(artifact,"id"),id,Kind.ATTACHMENT,artifact.toString());}}if(materials.length()>0)add(rows,id+":materials",id,Kind.MATERIALS,materials.toString());
            if(cached!=null&&cached.optBoolean("readFailed"))add(rows,id+":history-error",id,Kind.NOTICE,"对话记录暂时读取失败，已保留本机记录；连接恢复后会重试。");
            String reason=string(task,"blockedReason");if(hasHistory&&!reason.isBlank()&&!lastAssistant.contains(reason))add(rows,id+":reason",id,Kind.NOTICE,reason);
            if(ACTIVE.contains(status)){JSONArray children=array(detail,"harnessChildren");StringBuilder names=new StringBuilder();for(int i=0;i<children.length();i++){JSONObject child=children.optJSONObject(i);if(child==null)continue;String childState=string(child,"status");if(names.length()>0)names.append("、");names.append(string(child,"label")).append("running".equals(childState)?"（进行中）":"completed".equals(childState)?"（已完成）":"（未完成）");}if(names.length()>0)add(rows,id+":children",id,Kind.NOTICE,"子任务："+names);}
            String draft=string(task,"liveDraft");if("running".equals(status)&&!draft.isBlank()&&!draft.equals(lastAssistant))add(rows,id+":progress",id,Kind.PROGRESS,draft);
            add(rows,id+":status",id,Kind.NOTICE,task.optBoolean("phoneQueued")?"正在等其他任务用完手机，轮到后会继续。":taskStatus(status));
            rows.add(new Row(id+":actions",id,Kind.ACTIONS,"",status));
        }
        for(JSONObject row:local){JSONObject message=row.optJSONObject("message");String id=string(message,"messageId");if(consumed.contains(id))continue;
            add(rows,"local:"+id,"",Kind.USER,localText(message));add(rows,"delivery:"+id,"",Kind.NOTICE,delivery(string(row,"status")));
        }
        if(rows.isEmpty()&&selected!=null&&!selected.isBlank())add(rows,"history-unavailable",selected,Kind.NOTICE,"这段对话暂未同步，请稍候或从顶部选择其他对话。");
        if(rows.isEmpty()){add(rows,"welcome","",Kind.GREETING,"今天想让我帮你做什么？");add(rows,"welcome-detail","",Kind.NOTICE,snapshot.optBoolean("paired")?"发一句话，电脑上的助理会接着处理。":"先连接你的电脑，之后在这里直接交代事情。");}
        // Connection availability is already shown in the persistent status area.
        String error=string(snapshot,"error");
        if(!"电脑暂不可用".equals(error))add(rows,"error","",Kind.NOTICE,error);
        JSONArray signature=new JSONArray();for(Row row:rows)signature.put(new JSONArray().put(row.key()).put(row.taskId()).put(row.kind().name()).put(row.text()).put(row.status()));
        return new Presentation(List.copyOf(rows),signature.toString());
    }
}
