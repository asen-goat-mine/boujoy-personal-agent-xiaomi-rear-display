package dev.boujoy.personalagent;

import org.json.*;
import java.util.*;

/** Drafts are isolated by conversation; the retained object survives Fold/rotation recreation. */
public final class ChatComposerState {
    public record Submission(long generation,String messageId,String conversationId,String roleId,String text,JSONArray attachments,long textVersion,long attachmentVersion) {}
    public record AttachmentTicket(long generation,long version) {}
    private record Draft(String roleId,String text,JSONArray attachments,Submission pending,long textVersion,long attachmentVersion,String displayedMessageId) {}
    private static final int MAX_RETAINED_DRAFTS=8;
    private final Map<String,String> aliases=new HashMap<>();
    private final LinkedHashMap<String,Draft> drafts=new LinkedHashMap<>();
    private String conversationId="",roleId="concierge",text="",displayedMessageId="";
    private JSONArray attachments=new JSONArray();
    private long generation,textVersion,attachmentVersion,attachmentReadSerial;
    // Retained across configuration changes, never written to the durable outbox or Binder.
    final JSONObject provisional=new JSONObject();
    private Submission pending;
    private static boolean uuid(String value){return value!=null&&value.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");}
    private static JSONArray copy(JSONArray value){try{return new JSONArray(value.toString());}catch(JSONException e){throw new IllegalArgumentException("附件格式无效",e);}}
    public ChatComposerState() {}
    public ChatComposerState(JSONObject saved){
        if(saved==null)return;roleId=saved.optString("roleId","concierge");if(!roleId.matches("[A-Za-z0-9_-]{1,80}"))roleId="concierge";String target=ChatPresenter.string(saved,"conversationId");conversationId=uuid(target)?target:"";
        String displayed=ChatPresenter.string(saved,"displayedMessageId");displayedMessageId=uuid(displayed)?displayed:"";
        text=ChatPresenter.string(saved,"text");if(text.length()>50000)text=text.substring(0,50000);
        attachments=AttachmentDrafts.persistable(saved.optJSONArray("attachments"));
        generation=saved.optLong("generation");textVersion=saved.optLong("textVersion");attachmentVersion=saved.optLong("attachmentVersion");
        JSONObject row=saved.optJSONObject("pending");
        if(row!=null&&uuid(row.optString("messageId")))pending=new Submission(generation,row.optString("messageId"),conversationId,roleId,"",new JSONArray(),row.optLong("textVersion"),row.optLong("attachmentVersion"));
        if(displayedMessageId.isBlank()&&pending!=null)displayedMessageId=pending.messageId();
    }
    public String conversationId(){return conversationId;}
    public String roleId(){return roleId;}
    private String draftKey(){return conversationId.isBlank()?"role:"+roleId:conversationId;}
    public String text(){return text;}
    public JSONArray attachments(){return copy(attachments);}
    boolean hasAttachments(){return attachments.length()>0;}
    public long generation(){return generation;}
    public boolean waiting(){return pending!=null;}
    public String displayedMessageId(){return displayedMessageId;}
    private boolean submittedTextHidden(){return pending!=null&&provisional.has(pending.messageId())&&pending.textVersion()==textVersion;}
    String visibleText(){return submittedTextHidden()?"":text;}
    JSONArray visibleAttachments(){return pending!=null&&provisional.has(pending.messageId())&&pending.attachmentVersion()==attachmentVersion?new JSONArray():attachments();}
    void editVisibleText(String value){if(submittedTextHidden()&&text.equals(value))textVersion++;else setText(value);}
    void appendTranscription(String words){
        String before=visibleText();
        editVisibleText(before.isBlank()?words:before.endsWith(" ")||before.endsWith("\n")?before+words:before+" "+words);
    }
    public void setText(String value){Objects.requireNonNull(value);if(!text.equals(value)){text=value;textVersion++;}}
    public void setAttachments(JSONArray value){attachments=copy(value);attachmentVersion++;attachmentReadSerial++;}
    private Draft current(){return new Draft(roleId,text,attachments,pending,textVersion,attachmentVersion,displayedMessageId);}
    private static boolean dirty(Draft draft){return !draft.text().isBlank()||draft.attachments().length()>0||draft.pending()!=null;}
    private void stash(String target){
        if(!dirty(current())&&!(conversationId.isBlank()&&!displayedMessageId.isBlank()))return;
        if(!drafts.containsKey(target)&&drafts.size()>=MAX_RETAINED_DRAFTS)throw new IllegalStateException("已有多条未发送草稿，请先发送或清除一条再切换");
        drafts.put(draftKey(),current());
    }
    private void restore(String id){
        Draft draft=drafts.remove(id);conversationId=id.startsWith("role:")?"":id;if(id.startsWith("role:"))roleId=id.substring(5);generation++;
        if(draft==null){displayedMessageId="";text="";attachments=new JSONArray();pending=null;textVersion=0;attachmentVersion=0;}
        else{roleId=draft.roleId();displayedMessageId=draft.displayedMessageId();text=draft.text();attachments=draft.attachments();pending=draft.pending();textVersion=draft.textVersion();attachmentVersion=draft.attachmentVersion();}
    }
    public void newConversation(){
        if(!conversationId.isBlank())stash("role:"+roleId);drafts.remove("role:"+roleId);restore("role:"+roleId);
    }
    public void selectRole(String id){
        if(id==null||!id.matches("[A-Za-z0-9_-]{1,80}"))throw new IllegalArgumentException("助理编号无效");
        if(roleId.equals(id))return;
        stash("role:"+id);restore("role:"+id);
    }
    public void identifyRole(String id){if(id!=null&&id.matches("[A-Za-z0-9_-]{1,80}"))roleId=id;}
    public void selectConversation(String id){
        if(!uuid(id))throw new IllegalArgumentException("会话编号无效");id=ConversationIdentity.resolve(aliases,id);if(id.equals(conversationId))return;
        stash(id);restore(id);
    }
    public Submission begin(){
        if(pending!=null)throw new IllegalStateException("正在确认上一条消息的会话，请稍候");
        if(text.isBlank()&&attachments.length()==0)throw new IllegalStateException("写一句你想让我做什么");
        pending=new Submission(generation,UUID.randomUUID().toString(),conversationId,roleId,text,copy(attachments),textVersion,attachmentVersion);displayedMessageId=pending.messageId();return pending;
    }
    private static boolean matches(Submission request,Submission target){return request!=null&&target!=null&&request.generation()==target.generation()&&request.messageId().equals(target.messageId());}
    private static Draft accepted(Draft draft,Submission request,String id){
        return new Draft(draft.roleId(),draft.textVersion()==request.textVersion()?"":draft.text(),draft.attachmentVersion()==request.attachmentVersion()?new JSONArray():draft.attachments(),id.isBlank()?draft.pending():null,draft.textVersion(),draft.attachmentVersion(),draft.displayedMessageId());
    }
    private void apply(Draft draft){roleId=draft.roleId();displayedMessageId=draft.displayedMessageId();text=draft.text();attachments=draft.attachments();pending=draft.pending();textVersion=draft.textVersion();attachmentVersion=draft.attachmentVersion();}
    public boolean saved(Submission request){
        if(matches(request,pending)){apply(accepted(current(),request,conversationId));return true;}
        for(var entry:drafts.entrySet())if(matches(request,entry.getValue().pending())){entry.setValue(accepted(entry.getValue(),request,entry.getKey().startsWith("role:")?"":entry.getKey()));break;}
        return false;
    }
    public boolean failed(Submission request){
        if(matches(request,pending)){pending=null;return true;}
        for(var entry:drafts.entrySet())if(matches(request,entry.getValue().pending())){Draft draft=entry.getValue();entry.setValue(new Draft(draft.roleId(),draft.text(),draft.attachments(),null,draft.textVersion(),draft.attachmentVersion(),draft.displayedMessageId()));break;}
        return false;
    }
    private static JSONObject row(JSONObject snapshot,Submission request){JSONObject outbox=snapshot.optJSONObject("outbox");return outbox==null||request==null?null:outbox.optJSONObject(request.messageId());}
    private static String receivedTask(JSONObject row){JSONObject receipt=row==null?null:row.optJSONObject("receipt");String id=ChatPresenter.string(receipt,"taskId");return row!=null&&"received".equals(row.optString("status"))&&uuid(id)?id:"";}
    public void reconcile(JSONObject snapshot){
        if(snapshot==null)return;
        JSONArray known=ConversationIdentity.tasks(snapshot);for(int n=0;n<known.length();n++){JSONObject task=known.optJSONObject(n);if(task==null)continue;String id=ChatPresenter.string(task,"id");if(ConversationIdentity.privateTask(task))aliases.put(id,ChatPresenter.string(task,"conversationId"));else{aliases.remove(id);if(id.equals(conversationId))conversationId="";}}
        // Older clients could select a group execution as a private conversation.
        // Repair the destination only; retain drafts and local delivery receipts.
        if(conversationId.startsWith("group:"))conversationId="";
        conversationId=ConversationIdentity.resolve(aliases,conversationId);
        for(String old:new ArrayList<>(drafts.keySet())){String canonical=ConversationIdentity.resolve(aliases,old);if(!old.equals(canonical)&&!drafts.containsKey(canonical))drafts.put(canonical,drafts.remove(old));}
        JSONObject row=row(snapshot,pending);
        if(row!=null){Submission request=pending;apply(accepted(current(),request,conversationId));String task=receivedTask(row);
            if(!task.isBlank()){if(conversationId.isBlank())conversationId=ConversationIdentity.resolve(ConversationIdentity.tasks(snapshot),task);pending=null; /* Conversation identity survives new execution tasks. */}
            else if(!conversationId.isBlank()||Set.of("not_received","cancelled_local").contains(row.optString("status")))pending=null;
        }
        for(var entry:new ArrayList<>(drafts.entrySet())){
            Draft draft=entry.getValue();JSONObject stored=row(snapshot,draft.pending());if(stored==null)continue;
            Draft updated=accepted(draft,draft.pending(),entry.getKey().startsWith("role:")?"":entry.getKey());String task=receivedTask(stored);
            if(!task.isBlank()||!entry.getKey().startsWith("role:")||Set.of("not_received","cancelled_local").contains(stored.optString("status")))updated=new Draft(updated.roleId(),updated.text(),updated.attachments(),null,updated.textVersion(),updated.attachmentVersion(),updated.displayedMessageId());
            if(entry.getKey().startsWith("role:")&&!task.isBlank()&&!task.equals(conversationId)&&!drafts.containsKey(task)){drafts.remove(entry.getKey());if(dirty(updated))drafts.put(task,updated);}
            else if(dirty(updated)||entry.getKey().startsWith("role:")&&!updated.displayedMessageId().isBlank())drafts.put(entry.getKey(),updated);else drafts.remove(entry.getKey());
        }
    }
    public AttachmentTicket beginAttachmentRead(){return new AttachmentTicket(generation,++attachmentReadSerial);}
    public boolean acceptAttachment(AttachmentTicket ticket,JSONArray additions){
        if(ticket.generation()!=generation||ticket.version()!=attachmentReadSerial)return false;
        JSONArray selected=visibleAttachments();
        if(selected.length()+additions.length()>10)throw new IllegalStateException("每条消息最多 10 个附件");
        for(int i=0;i<additions.length();i++)selected.put(additions.opt(i));
        setAttachments(selected);return true;
    }
    /** Only the active draft goes in Binder state. Other drafts/bytes remain in the retained object. */
    public JSONObject snapshot(){
        JSONObject result=Tunnel.json("conversationId",conversationId,"roleId",roleId,"text",text,"generation",generation,"textVersion",textVersion,"attachmentVersion",attachmentVersion,"hadAttachments",attachments.length()>0,"attachments",AttachmentDrafts.persistable(attachments),"displayedMessageId",displayedMessageId);
        if(pending!=null)try{result.put("pending",Tunnel.json("messageId",pending.messageId(),"textVersion",pending.textVersion(),"attachmentVersion",pending.attachmentVersion()));}catch(JSONException impossible){throw new IllegalStateException(impossible);}
        return result;
    }
}
