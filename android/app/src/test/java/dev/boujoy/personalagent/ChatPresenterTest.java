package dev.boujoy.personalagent;
import org.json.*;
import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;

public class ChatPresenterTest {
    static JSONObject object(Object... values){return Tunnel.json(values);}
    static JSONObject summary(String id,String version){return object("id",id,"title","会话 "+id,"status","completed","result","回答二","preview","回答二","updatedAt",version);}
    static JSONObject message(String id,String role,String content,String request){return object("id",id,"role",role,"content",content,"clientRequestId",request,"at","2026-10-15T01:00:00Z");}
    static JSONObject detail(JSONObject summary)throws Exception{return new JSONObject(summary.toString()).put("messages",new JSONArray().put(message("u1","user","问题一","one")).put(message("a1","assistant","回答一","")).put(message("u2","user","问题二","two")).put(message("a2","assistant","回答二","")));}
    static JSONObject outbox(String id,String text,String task){return object("status","received","message",object("messageId",id,"text",text,"createdAt","2026-10-15T01:00:00Z"),"receipt",object("taskId",task));}
    static JSONObject snapshot(JSONObject summary,JSONObject detail)throws Exception{
        JSONObject details=new JSONObject();if(detail!=null)details.put(summary.getString("id"),object("version",ChatPresenter.taskVersion(summary),"detail",detail));
        return object("paired",true,"state",object("tasks",new JSONArray().put(summary)),"taskDetails",details,"outbox",object("one",outbox("one","问题一",summary.getString("id")),"two",outbox("two","问题二",summary.getString("id"))));
    }
    static List<String> conversation(JSONObject snapshot){return ChatPresenter.present(snapshot).rows().stream().filter(r->Set.of(ChatPresenter.Kind.USER,ChatPresenter.Kind.ASSISTANT).contains(r.kind())).map(ChatPresenter.Row::text).toList();}
    @Test public void sameTaskMultipleRepliesBelongToActualTurnsAndOutboxDoesNotDuplicateThem()throws Exception{
        JSONObject task=summary("same-task","v1"),state=snapshot(task,detail(task));
        assertEquals(List.of("问题一","回答一","问题二","回答二"),conversation(state));
        assertEquals(1,ChatPresenter.present(state).rows().stream().filter(r->r.kind()==ChatPresenter.Kind.ACTIONS).count());
    }
    @Test public void summariesNeverMasqueradeAsAnswersToFirstOrRepeatedQuestions()throws Exception{
        JSONObject task=summary("same-task","v1"),state=snapshot(task,null);
        assertEquals(List.of("问题一","问题二"),conversation(state));
        assertTrue(ChatPresenter.present(state).rows().stream().anyMatch(r->r.kind()==ChatPresenter.Kind.NOTICE&&r.text().contains("最新任务摘要")&&r.text().contains("回答二")));
        assertFalse(ChatPresenter.present(state).rows().stream().anyMatch(r->r.kind()==ChatPresenter.Kind.ASSISTANT));
    }
    @Test public void heartbeatGlobalRevisionUsageAndJsonOrderDoNotRebuildFeed()throws Exception{
        JSONObject task=summary("same-task","v1"),state=snapshot(task,detail(task));String before=ChatPresenter.present(state).fingerprint();
        state.getJSONObject("state").put("serverTime","new clock").put("revision",999).put("usage",object("requests",900));state.put("online",false).put("status","正在重连");
        JSONObject reverse=new JSONObject();List<String> keys=new ArrayList<>();state.keys().forEachRemaining(keys::add);Collections.reverse(keys);for(String key:keys)reverse.put(key,state.get(key));
        assertEquals(before,ChatPresenter.present(reverse).fingerprint());
        state.getJSONObject("outbox").getJSONObject("one").put("receipt",object("serverTime","heartbeat","taskId","same-task"));
        assertEquals(before,ChatPresenter.present(state).fingerprint());
        task.put("updatedAt","heartbeat-only-timestamp");assertEquals(before,ChatPresenter.present(state).fingerprint());
    }
    @Test public void sameTextRepeatedUserMessagesAreNotDeduplicatedByText()throws Exception{
        JSONObject task=summary("same-task","v1"),detail=detail(task);detail.getJSONArray("messages").getJSONObject(2).put("content","问题一");
        assertEquals(List.of("问题一","回答一","问题一","回答二"),conversation(snapshot(task,detail)));
    }
    @Test public void unsentContinuationRemainsAfterConfirmedAnswerAndNeverStealsIt()throws Exception{
        JSONObject task=summary("same-task","v1"),detail=detail(task);detail.getJSONArray("messages").remove(3);
        JSONObject state=snapshot(task,detail);state.getJSONObject("outbox").put("three",object("status","queued","message",object("messageId","three","conversationId","same-task","text","问题三","createdAt","2026-10-15T02:00:00Z")));
        assertEquals(List.of("问题一","回答一","问题二","回答二","问题三"),conversation(state));
    }
    @Test public void newContinuationsStayBelowAllEarlierExecutionsUntilReceiptedOrConfirmed()throws Exception{
        JSONObject root=summary("root","v1").put("result","根回复"),later=summary("later","v2").put("conversationId","root").put("result","后续回复");
        JSONObject state=snapshot(root,new JSONObject(root.toString()).put("messages",new JSONArray().put(message("u1","user","根问题","initial"))));
        state.getJSONObject("state").getJSONArray("tasks").put(later).put(summary("other","v1"));
        JSONObject history=new JSONObject(later.toString()).put("messages",new JSONArray().put(message("u2","user","后续问题","follow").put("at","2026-10-15T02:00:00Z")));
        state.getJSONObject("taskDetails").put("later",object("detail",history));
        JSONObject local=new JSONObject();state.put("outbox",local);
        for(String key:List.of("m1","m2","m3","other-message")){
            String target=key.equals("other-message")?"other":"root";
            local.put(key,object("status","queued","message",object("messageId",key,"conversationId",target,"text",key,"createdAt","2026-10-15T03:00:0"+(local.length()+1)+"Z")));
        }
        local.getJSONObject("m1").put("receipt",object("taskId","not-synced-yet")).put("status","received");
        var rows=ChatPresenter.present(state,"later","m3").rows();
        assertEquals(List.of("根问题","根回复","后续问题","后续回复","m1","m2","m3"),rows.stream().filter(r->Set.of(ChatPresenter.Kind.USER,ChatPresenter.Kind.ASSISTANT).contains(r.kind())).map(ChatPresenter.Row::text).toList());
        assertEquals(List.of("local:m1","delivery:m1","local:m2","delivery:m2","local:m3","delivery:m3"),rows.subList(rows.size()-6,rows.size()).stream().map(ChatPresenter.Row::key).toList());
        // A confirmed user message is authoritative even when the local receipt is missing.
        history.getJSONArray("messages").put(message("u3","user","m2","m2"));
        rows=ChatPresenter.present(state,"root","m3").rows();
        assertEquals(1,rows.stream().filter(r->r.kind()==ChatPresenter.Kind.USER&&r.text().equals("m2")).count());
        assertFalse(rows.stream().anyMatch(r->r.key().equals("local:m2")||r.key().equals("delivery:m2")));
        assertEquals(List.of("m1","m3"),rows.stream().filter(r->r.key().startsWith("local:")).map(ChatPresenter.Row::text).toList());
        // Once the receipt target is known, its conversation owns the row.
        state.getJSONObject("state").getJSONArray("tasks").put(summary("not-synced-yet","v3").put("conversationId","root"));
        assertTrue(ChatPresenter.present(state,"root","").rows().stream().anyMatch(r->r.key().equals("local:m1")&&r.taskId().equals("not-synced-yet")));
        assertFalse(ChatPresenter.present(state,"other","").rows().stream().anyMatch(r->r.key().equals("local:m1")));
    }
    @Test public void serverClientRequestIdReconcilesLostReceiptWithoutInventingDuplicateUser()throws Exception{
        JSONObject task=summary("same-task","v1"),state=snapshot(task,detail(task));state.getJSONObject("outbox").getJSONObject("two").remove("receipt");state.getJSONObject("outbox").getJSONObject("two").put("status","unconfirmed");
        assertEquals(List.of("问题一","回答一","问题二","回答二"),conversation(state));
    }
    @Test public void staleDetailPreservesKnownHistoryButDoesNotAttachNewSummaryResult()throws Exception{
        JSONObject task=summary("same-task","v1"),state=snapshot(task,detail(task));task.put("updatedAt","v2").put("result","第三个结果尚未拿到完整历史");
        JSONObject cached=state.getJSONObject("taskDetails").getJSONObject("same-task");cached.put("readFailed",true);
        assertEquals(List.of("问题一","回答一","问题二","回答二"),conversation(state));
        assertTrue(ChatPresenter.present(state).rows().stream().anyMatch(r->r.text().contains("读取失败")));
        assertFalse(ChatPresenter.present(state).rows().stream().anyMatch(r->r.kind()==ChatPresenter.Kind.ASSISTANT&&r.text().contains("第三个结果")));
    }
    @Test public void systemToolPayloadsAreNotChatAndStatusChangesAreSemantic()throws Exception{
        JSONObject task=summary("same-task","v1"),detail=detail(task),state=snapshot(task,detail);detail.getJSONArray("messages").put(message("secret","system","internal credential-like payload","")).put(message("tool","tool","raw tool output",""));
        assertFalse(ChatPresenter.present(state).fingerprint().contains("internal credential"));
        String before=ChatPresenter.present(state).fingerprint();task.put("status","unknown_result");assertNotEquals(before,ChatPresenter.present(state).fingerprint());
        assertTrue(ChatPresenter.present(state).rows().stream().anyMatch(r->r.text().contains("结果待核实")));
    }
    @Test public void generalHandoffDoesNotInventPaymentAndKeepsActualResult()throws Exception{
        JSONObject task=summary("hotel-handoff","v1").put("status","ready_for_user").put("result","住宿信息已整理，请核对入住日期；尚未提交订单。").put("preview","住宿信息待核对");
        var summaryOnly=ChatPresenter.present(snapshot(task,null));
        assertEquals("已准备好，请你接手处理。",ChatPresenter.taskStatus("ready_for_user"));
        assertTrue(summaryOnly.rows().stream().anyMatch(r->r.kind()==ChatPresenter.Kind.NOTICE&&r.text().equals("已准备好，请你接手处理。")));
        assertFalse(summaryOnly.rows().stream().anyMatch(r->r.text().contains("付款")));
        JSONObject detail=new JSONObject(task.toString()).put("messages",new JSONArray().put(message("u1","user","帮我整理住宿信息","one")));
        assertEquals(List.of("帮我整理住宿信息","住宿信息已整理，请核对入住日期；尚未提交订单。"),conversation(snapshot(task,detail).put("outbox",new JSONObject())));
        task.put("result","结算页已核验，请你核对金额后付款。");
        detail.put("result",task.getString("result"));
        assertTrue(conversation(snapshot(task,detail).put("outbox",new JSONObject())).contains("结算页已核验，请你核对金额后付款。"));
    }
    @Test public void existingHistoryAnchorSurvivesRowsInsertedAboveAndDoesNotFollowNewBottom(){
        var before=List.of(new ChatScrollAnchor.Item("one",0,100),new ChatScrollAnchor.Item("two",100,250),new ChatScrollAnchor.Item("three",250,800));
        var anchor=ChatScrollAnchor.capture(before,135,800,200,30);
        assertEquals(335,anchor.restore(List.of(new ChatScrollAnchor.Item("new",0,200),new ChatScrollAnchor.Item("one",200,300),new ChatScrollAnchor.Item("two",300,450),new ChatScrollAnchor.Item("three",450,1000)),1000,200));
        assertEquals(135,anchor.restore(List.of(new ChatScrollAnchor.Item("other",0,700)),700,200));
        assertEquals(1000,ChatScrollAnchor.capture(before,600,800,200,30).restore(before,1200,200));
    }

    @Test public void taskDetailsNeverRenderJsonNullAsAnAnswer(){
        assertEquals("真实阻塞原因",ChatPresenter.detailResult(object("result",JSONObject.NULL,"blockedReason","真实阻塞原因")));
        assertEquals("真实结果",ChatPresenter.detailResult(object("result","真实结果","blockedReason","旧原因")));
        assertEquals("",ChatPresenter.detailResult(object("result",JSONObject.NULL,"blockedReason",JSONObject.NULL)));
        assertEquals("原因",ChatPresenter.detailResult(object("result","","blockedReason","原因")));
    }

    @Test public void selectedConversationNeverIncludesAnotherThreadsMessagesOrOutbox()throws Exception{
        JSONObject a=summary("task-a","a"),b=summary("task-b","b"),state=snapshot(a,detail(a));state.getJSONObject("state").getJSONArray("tasks").put(b);state.getJSONObject("taskDetails").put("task-b",object("detail",detail(b)));
        state.getJSONObject("outbox").put("other",outbox("other","另一个对话的草稿","task-b"));
        var selected=ChatPresenter.present(state,"task-a","");assertFalse(selected.rows().stream().anyMatch(row->row.taskId().equals("task-b")||row.text().contains("另一个对话的草稿")));assertEquals(4,selected.rows().stream().filter(row->Set.of(ChatPresenter.Kind.USER,ChatPresenter.Kind.ASSISTANT).contains(row.kind())).count());
        var fresh=ChatPresenter.present(state,"","");assertTrue(fresh.rows().stream().anyMatch(row->row.kind()==ChatPresenter.Kind.GREETING));assertFalse(fresh.rows().stream().anyMatch(row->row.kind()==ChatPresenter.Kind.USER));
        state.getJSONObject("outbox").put("pending",outbox("pending","本次新对话的消息",""));assertEquals(List.of("本次新对话的消息"),ChatPresenter.present(state,"","pending").rows().stream().filter(row->row.kind()==ChatPresenter.Kind.USER).map(ChatPresenter.Row::text).toList());
    }

    @org.junit.Test public void phoneDiagnosticsUseFixedReasonsAndIgnoreRawScreenContent() throws Exception {
        JSONObject row=new JSONObject().put("reason","outside_task_scope").put("foregroundPackage","com.android.settings").put("raw","private screen text");
        assertEquals("当前页面已离开任务应用 · com.android.settings",ChatPresenter.phoneDiagnostic(row));
        assertFalse(ChatPresenter.phoneDiagnostic(row).contains("private"));
        assertTrue(ChatPresenter.phoneDiagnostic(new JSONObject().put("reason","assistant_chat_foreground")).contains("连接仍保留"));
    }

    @Test public void liveProgressChangesWithoutInvalidatingHistoryAndNeverBecomesFinalResult()throws Exception{
        JSONObject task=summary("same-task","v1").put("status","running"),history=detail(task);String version=ChatPresenter.taskVersion(task);
        JSONObject state=snapshot(task,history);String before=ChatPresenter.present(state).fingerprint();task.put("liveDraft","正在打开淘宝…");
        assertEquals(version,ChatPresenter.taskVersion(task));assertNotEquals(before,ChatPresenter.present(state).fingerprint());
        assertTrue(ChatPresenter.present(state).rows().stream().anyMatch(row->row.kind()==ChatPresenter.Kind.PROGRESS&&row.text().equals("正在打开淘宝…")));
        assertFalse(conversation(state).contains("正在打开淘宝…"));
        task.put("status","completed");assertFalse(ChatPresenter.present(state).rows().stream().anyMatch(row->row.kind()==ChatPresenter.Kind.PROGRESS));
    }

    @Test public void openingOldChildShowsLaterSiblingEvenWhenRootIsOutsideSnapshot()throws Exception{
        JSONObject first=summary("child-a","v1").put("conversationId","root"),next=summary("child-b","v2").put("conversationId","root").put("result","Mac 已完成统计");
        JSONObject state=snapshot(first,detail(first));state.getJSONObject("state").getJSONArray("tasks").put(next);
        state.getJSONObject("taskDetails").put("child-b",object("detail",new JSONObject(next.toString()).put("messages",new JSONArray().put(message("a3","assistant","Mac 已完成统计","")))));
        state.getJSONObject("outbox").put("three",outbox("three","后续请求","child-b"));
        var rows=ChatPresenter.present(state,"child-a","").rows();assertTrue(rows.stream().anyMatch(row->row.kind()==ChatPresenter.Kind.ASSISTANT&&row.text().equals("Mac 已完成统计")));
        assertEquals(1,ConversationIdentity.latest(state.getJSONObject("state").getJSONArray("tasks"),"concierge").size());
    }
    @Test public void completedSummaryIsVisibleWhileHistoryLagsAndArtifactsStayInChat()throws Exception{
        JSONObject task=summary("one","v1"),history=detail(task);task.put("updatedAt","v2").put("result","新结果：4 单，15564");history.put("artifacts",new JSONArray().put(object("id","file-one","name","报告.pdf","mime","application/pdf","size",4096)));
        var rows=ChatPresenter.present(snapshot(task,history)).rows();assertTrue(rows.stream().anyMatch(row->row.key().endsWith(":latest-result")&&row.text().contains("4 单，15564")));
        assertEquals(1,rows.stream().filter(row->row.kind()==ChatPresenter.Kind.ATTACHMENT&&row.text().contains("报告.pdf")).count());
    }
}
