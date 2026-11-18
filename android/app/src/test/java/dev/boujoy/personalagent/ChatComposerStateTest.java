package dev.boujoy.personalagent;
import org.json.*;import org.junit.Test;import static org.junit.Assert.*;
public class ChatComposerStateTest {
    private static final String TASK="11111111-1111-4111-8111-111111111111",OTHER="22222222-2222-4222-8222-222222222222";
    static JSONObject receipt(ChatComposerState.Submission submission,String task){return Tunnel.json("outbox",Tunnel.json(submission.messageId(),Tunnel.json("status","received","receipt",Tunnel.json("taskId",task))));}
    static JSONArray attachment(String name){return new JSONArray().put(Tunnel.json("name",name,"base64","sensitive-attachment-bytes"));}
    @Test public void firstReceiptAutomaticallyRoutesNextMessageIntoSameConversation(){
        var state=new ChatComposerState();state.setText("帮我查资料");var first=state.begin();assertEquals("",first.conversationId());
        assertTrue(state.saved(first));assertEquals("",state.text());assertTrue(state.waiting());
        state.reconcile(receipt(first,TASK));state.setText("接着整理成表格");var followup=state.begin();assertEquals(TASK,followup.conversationId());assertNotEquals(first.messageId(),followup.messageId());
    }
    @Test public void unconfirmedFirstMessageCannotAccidentallyCreateASecondIndependentTask(){
        var state=new ChatComposerState();state.setText("第一条");var first=state.begin();state.saved(first);state.setText("第二条");
        try{state.begin();fail("must wait for first receipt");}catch(IllegalStateException expected){}
        state.reconcile(Tunnel.json("outbox",new JSONObject()));assertTrue(state.waiting());assertEquals("第二条",state.text());
        state.reconcile(receipt(first,TASK));assertEquals(TASK,state.begin().conversationId());
    }
    @Test public void lateSaveOrReceiptCannotStealExplicitNewConversationOrItsDraft(){
        var state=new ChatComposerState();state.setText("旧请求");var old=state.begin();state.newConversation();state.setText("新草稿");state.setAttachments(attachment("new.txt"));
        assertFalse(state.saved(old));state.reconcile(receipt(old,TASK));assertEquals("",state.conversationId());assertEquals("新草稿",state.text());assertEquals(1,state.attachments().length());assertFalse(state.waiting());
    }
    @Test public void editWhileSavingKeepsNewTextAndNewAttachments(){
        var state=new ChatComposerState();state.setText("原始请求");state.setAttachments(attachment("old.txt"));var request=state.begin();
        state.setText("接下来要问的问题");state.setAttachments(attachment("new.txt"));state.saved(request);state.reconcile(receipt(request,TASK));
        assertEquals("接下来要问的问题",state.text());assertEquals("new.txt",state.attachments().optJSONObject(0).optString("name"));
    }
    @Test public void savedStateKeepsRoutingAndTextButNeverCopiesAttachmentBytesIntoBinder(){
        var state=new ChatComposerState();state.selectConversation(TASK);state.setText("未发送草稿");state.setAttachments(attachment("private.txt"));
        JSONObject snapshot=state.snapshot();assertFalse(snapshot.toString().contains("sensitive-attachment-bytes"));assertTrue(snapshot.optBoolean("hadAttachments"));
        var restored=new ChatComposerState(snapshot);assertEquals(TASK,restored.conversationId());assertEquals("未发送草稿",restored.text());assertEquals(0,restored.attachments().length());
        // Configuration recreation retains this exact state object and therefore the selected bytes.
        assertEquals("sensitive-attachment-bytes",state.attachments().optJSONObject(0).optString("base64"));
    }
    @Test public void restoredPendingFirstMessageResolvesFromDurableOutboxWithoutResending(){
        var state=new ChatComposerState();state.setText("点一份饭");var first=state.begin();var restored=new ChatComposerState(state.snapshot());
        assertTrue(restored.waiting());restored.reconcile(receipt(first,TASK));assertFalse(restored.waiting());assertEquals(TASK,restored.conversationId());assertEquals("",restored.text());
    }
    @Test public void persistenceFailurePreservesDraftAndAllowsExplicitRetry(){
        var state=new ChatComposerState();state.setText("保留内容");state.setAttachments(attachment("keep.txt"));var request=state.begin();
        assertTrue(state.failed(request));assertFalse(state.waiting());assertEquals("保留内容",state.text());assertEquals(1,state.attachments().length());assertNotEquals(request.messageId(),state.begin().messageId());
    }
    @Test public void lateAttachmentCannotReturnAfterRemovalOrConversationChange(){
        var state=new ChatComposerState();var first=state.beginAttachmentRead();state.setAttachments(new JSONArray());assertFalse(state.acceptAttachment(first,attachment("removed.txt")));
        var second=state.beginAttachmentRead();state.newConversation();assertFalse(state.acceptAttachment(second,attachment("wrong-chat.txt")));assertEquals(0,state.attachments().length());
    }
    @Test public void selectingHistoryPreventsOldCallbackFromChangingTarget(){
        var state=new ChatComposerState();state.setText("原请求");var request=state.begin();state.selectConversation(OTHER);assertFalse(state.saved(request));state.reconcile(receipt(request,TASK));assertEquals(OTHER,state.conversationId());
    }
    @Test public void returningToIdenticalTextIsStillANewDraftAndIsNotClearedByOldSave(){
        var state=new ChatComposerState();state.setText("重复一句话");var request=state.begin();state.setText("");state.setText("重复一句话");state.saved(request);assertEquals("重复一句话",state.text());
    }

    @Test public void switchingConversationsRestoresOnlyTheirOwnUnsentTextAndAttachments(){
        var state=new ChatComposerState();state.selectConversation(TASK);state.setText("A的草稿");state.setAttachments(attachment("a.txt"));state.selectConversation(OTHER);
        assertEquals("",state.text());assertEquals(0,state.attachments().length());state.setText("B的草稿");state.selectConversation(TASK);
        assertEquals("A的草稿",state.text());assertEquals("a.txt",state.attachments().optJSONObject(0).optString("name"));state.selectConversation(OTHER);assertEquals("B的草稿",state.text());assertEquals(0,state.attachments().length());
    }
    @Test public void offscreenSaveAndFailureUpdateTheOriginalDraftWithoutStealingCurrentConversation(){
        var state=new ChatComposerState();state.selectConversation(TASK);state.setText("原请求");var request=state.begin();state.selectConversation(OTHER);state.setText("当前草稿");assertFalse(state.saved(request));assertEquals("当前草稿",state.text());state.selectConversation(TASK);assertEquals("",state.text());assertFalse(state.waiting());
        state.setText("保存失败的请求");request=state.begin();state.selectConversation(OTHER);assertFalse(state.failed(request));state.selectConversation(TASK);assertFalse(state.waiting());assertEquals("保存失败的请求",state.text());
    }
    @Test public void returningBeforeTheSaveCallbackStillRecognizesItsOwnPendingMessage(){
        var state=new ChatComposerState();state.selectConversation(TASK);state.setText("请求");var request=state.begin();state.selectConversation(OTHER);state.selectConversation(TASK);assertTrue(state.saved(request));assertEquals("",state.text());assertFalse(state.waiting());
    }
    @Test public void selectedAttachmentCopiesCannotMutateAnAlreadyPreparedMessage()throws Exception{
        var state=new ChatComposerState();JSONArray selected=attachment("original.txt");state.setAttachments(selected);selected.getJSONObject(0).put("name","wrong.txt");var request=state.begin();state.attachments().getJSONObject(0).put("name","changed-again.txt");assertEquals("original.txt",request.attachments().getJSONObject(0).getString("name"));
    }

    @Test public void lateFirstReceiptKeepsOffscreenFollowupInItsOwnNewConversation(){
        var state=new ChatComposerState();state.setText("第一次请求");var first=state.begin();state.setText("准备好的追问");state.selectConversation(OTHER);state.setText("另一个草稿");assertFalse(state.saved(first));state.reconcile(receipt(first,TASK));assertEquals(OTHER,state.conversationId());assertEquals("另一个草稿",state.text());state.selectConversation(TASK);assertEquals("准备好的追问",state.text());assertFalse(state.waiting());
    }
    @Test public void retainedDraftLimitRefusesSwitchWithoutSilentlyDiscardingUnsentWork(){
        var state=new ChatComposerState();for(int n=1;n<=9;n++){state.selectConversation(String.format("00000000-0000-4000-8000-%012d",n));state.setText("草稿"+n);}
        String selected=state.conversationId();try{state.selectConversation("00000000-0000-4000-8000-000000000010");fail();}catch(IllegalStateException expected){}assertEquals(selected,state.conversationId());assertEquals("草稿9",state.text());state.selectConversation("00000000-0000-4000-8000-000000000001");assertEquals("草稿1",state.text());
    }

    @Test public void aKnownUndeliveredFirstMessageStaysVisibleAfterItsPendingRoutingIsReleased(){
        var state=new ChatComposerState();state.setText("这条消息需要保留");var first=state.begin();state.saved(first);
        JSONObject snapshot=Tunnel.json("paired",true,"state",Tunnel.json("tasks",new JSONArray()),"outbox",Tunnel.json(first.messageId(),Tunnel.json("status","not_received","message",Tunnel.json("messageId",first.messageId(),"text",first.text(),"conversationId",""))));
        state.reconcile(snapshot);assertFalse(state.waiting());var rows=ChatPresenter.present(snapshot,state.conversationId(),state.displayedMessageId()).rows();assertTrue(rows.stream().anyMatch(row->row.kind()==ChatPresenter.Kind.USER&&row.text().equals(first.text())));assertTrue(rows.stream().anyMatch(row->row.text().contains("电脑没有接收")));
        var restored=new ChatComposerState(state.snapshot());assertEquals(state.displayedMessageId(),restored.displayedMessageId());state.newConversation();assertEquals("",state.displayedMessageId());assertFalse(ChatPresenter.present(snapshot,state.conversationId(),state.displayedMessageId()).rows().stream().anyMatch(row->row.kind()==ChatPresenter.Kind.USER));
    }

    @Test public void canonicalizingOldChildKeepsDraftAndDiskAttachmentAfterRecreation()throws Exception{
        String root="00000000-0000-4000-8000-000000000001",child="00000000-0000-4000-8000-000000000002";
        ChatComposerState chat=new ChatComposerState();chat.selectConversation(child);chat.setText("接着整理结果");chat.setAttachments(new org.json.JSONArray().put(Tunnel.json("localId","00000000-0000-4000-8000-000000000003","name","视频.mp4","mime","video/mp4","size",9000000)));
        chat.reconcile(Tunnel.json("state",Tunnel.json("tasks",new org.json.JSONArray().put(Tunnel.json("id",child,"conversationId",root)))));
        ChatComposerState restored=new ChatComposerState(chat.snapshot());assertEquals(root,restored.conversationId());assertEquals("接着整理结果",restored.text());assertEquals(1,restored.attachments().length());assertFalse(restored.snapshot().toString().contains("base64"));
    }
}
