package dev.boujoy.personalagent;
import org.json.*;
import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;

public class MobileUpgradeTest {
    @Test public void outboxWaitsForResumeAcknowledgementAndOldRepliesCannotReopenGate(){
        ControlState state=new ControlState(new ControlStateTest.Memory());long first=state.resumeExplicitly();assertTrue(state.permitsSubmission(first,first));
        state.pause();long newTask=state.resumeExplicitly();assertFalse(state.permitsSubmission(newTask,first));
        assertFalse(state.observeRemote(newTask-1,true));assertTrue(state.permitsSubmission(newTask,newTask));
        state.pause();assertFalse(state.permitsSubmission(newTask,newTask));
        ControlState recreated=new ControlState(new ControlStateTest.Memory());assertFalse(recreated.permitsSubmission(0,0));
    }
    @Test public void draftsAndLateSavesStayWithTheirAssistant()throws Exception{
        ChatComposerState chat=new ChatComposerState();chat.setText("总助理草稿");chat.setAttachments(new JSONArray().put(new JSONObject().put("name","a.txt")));
        ChatComposerState.Submission first=chat.begin();assertEquals("concierge",first.roleId());
        chat.selectRole("coach");assertEquals("",chat.text());assertEquals(0,chat.attachments().length());chat.setText("教练草稿");
        assertFalse(chat.saved(first));assertEquals("教练草稿",chat.text());
        JSONObject receipt=new JSONObject().put("status","received").put("receipt",new JSONObject().put("taskId",UUID.randomUUID().toString()));
        chat.reconcile(new JSONObject().put("outbox",new JSONObject().put(first.messageId(),receipt)));
        chat.selectRole("concierge");assertEquals("",chat.text());chat.selectRole("coach");assertEquals("教练草稿",chat.text());assertEquals("coach",chat.begin().roleId());
        ChatComposerState restored=new ChatComposerState(chat.snapshot());assertEquals("coach",restored.roleId());assertEquals("教练草稿",restored.text());
    }
    @Test public void watchNoticeIsNotAUserMessageAndOutcomeIsAnHonestNotice()throws Exception{
        String id=UUID.randomUUID().toString();JSONObject t=new JSONObject().put("id",id).put("status","blocked").put("phoneQueued",true).put("messages",new JSONArray()
            .put(new JSONObject().put("id","system-trigger").put("role","user").put("content","内部跟进指令").put("watchNotice",true))
            .put(new JSONObject().put("id","answer").put("role","assistant").put("content","没有取得结果").put("outcome","failed")));
        JSONObject snapshot=new JSONObject().put("state",new JSONObject().put("tasks",new JSONArray().put(t))).put("taskDetails",new JSONObject().put(id,new JSONObject().put("detail",t)));
        var presentation=ChatPresenter.present(snapshot,id,"");assertTrue(presentation.rows().stream().noneMatch(r->r.kind()==ChatPresenter.Kind.USER));
        assertTrue(presentation.rows().stream().anyMatch(r->r.kind()==ChatPresenter.Kind.NOTICE&&r.text().equals("未完成 · 没有取得结果")));
        assertTrue(presentation.rows().stream().anyMatch(r->r.text().contains("等其他任务用完手机")));
    }
    @Test public void intentionalNoticesBypassQuietAndHaveIndependentDeliveryFingerprints()throws Exception{
        JSONObject t=new JSONObject().put("id","task").put("status","completed").put("result","new result");
        JSONObject ledger=new JSONObject().put("initialized",true);TaskNotifications.Update normal=TaskNotifications.consume(ledger,new JSONArray().put(t));assertTrue(TaskNotifications.quietSuppresses(normal.alerts().get(0)));
        ledger=TaskNotifications.outcome(normal.ledger(),normal.alerts().get(0),"posted",1);
        for(String notice:new String[]{"watch","routine","dispatch"}){t.put("notice",notice);var update=TaskNotifications.consume(ledger,new JSONArray().put(t));assertEquals(1,update.alerts().size());assertFalse(TaskNotifications.quietSuppresses(update.alerts().get(0)));assertEquals("new result",update.alerts().get(0).body());assertNotEquals("任务已完成",update.alerts().get(0).title());ledger=TaskNotifications.outcome(update.ledger(),update.alerts().get(0),"posted",2);assertTrue(TaskNotifications.consume(ledger,new JSONArray().put(t)).alerts().isEmpty());}
    }

    @Test public void upgradeDoesNotReannounceAlreadyDeliveredOrHistoricalNotices()throws Exception{
        JSONObject t=new JSONObject().put("id","old-task").put("status","completed").put("result","old result");
        var normal=TaskNotifications.consume(new JSONObject().put("initialized",true),new JSONArray().put(t));
        JSONObject old=TaskNotifications.outcome(normal.ledger(),normal.alerts().get(0),"posted",1);old.remove("noticeAware");t.put("notice","watch");
        assertTrue(TaskNotifications.consume(old,new JSONArray().put(t)).alerts().isEmpty());
        old.getJSONObject("delivery").getJSONObject("old-task").put("status","deferred_quiet");
        var recovered=TaskNotifications.consume(old,new JSONArray().put(t));assertEquals(1,recovered.alerts().size());assertFalse(TaskNotifications.quietSuppresses(recovered.alerts().get(0)));
    }
}
