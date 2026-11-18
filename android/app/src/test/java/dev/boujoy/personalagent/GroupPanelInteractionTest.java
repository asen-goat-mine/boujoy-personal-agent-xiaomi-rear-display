package dev.boujoy.personalagent;

import android.app.Activity;
import android.os.Looper;
import android.view.View;
import android.widget.EditText;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import java.io.IOException;
import java.util.*;
import static org.junit.Assert.*;
import static dev.boujoy.personalagent.NativeVisualTest.*;
import static dev.boujoy.personalagent.NativeSheetVisualTest.click;

/** Click-level client contracts. Replies are fixtures; no model or production device is used. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,qualifiers="w390dp-h844dp-mdpi")
public class GroupPanelInteractionTest {
    static void idle(){Shadows.shadowOf(Looper.getMainLooper()).idle();}
    static final class Sent {final String path;final JSONObject body;final ConnectionService.Outcome<JSONObject> callback;Sent(String path,JSONObject body,ConnectionService.Outcome<JSONObject> callback){this.path=path;this.body=body;this.callback=callback;}}
    static final class Client implements GroupPanel.Client {
        JSONObject detail=GroupPanelTest.group(),state=fixture();final List<Sent> writes=new ArrayList<>();final List<String> consents=new ArrayList<>();int reads;Exception readError;
        Client()throws Exception{state.getJSONObject("state").put("roles",detail.getJSONArray("members"));state.put("groupRequests",new JSONObject());}
        public void groupRead(String id,ConnectionService.Outcome<JSONObject> callback){reads++;if(readError!=null){callback.done(null,readError);return;}callback.done(id.isBlank()?object("groups",new JSONArray().put(detail)):detail,null);}
        public void groupRequest(String path,JSONObject body,ConnectionService.Outcome<JSONObject> callback){writes.add(new Sent(path,body,callback));}
        public void consentTask(String id,ConnectionService.Outcome<JSONObject> callback){consents.add(id);callback.done(object("taskId",id,"status","queued"),null);}
        public JSONObject snapshot(){return state;}
    }
    static final class Fixture implements AutoCloseable {
        final Activity activity=Robolectric.buildActivity(Activity.class).setup().get();final Client client=new Client();final GroupPanel panel;
        Fixture()throws Exception{activity.setTheme(R.style.AppTheme);panel=new GroupPanel(activity,client);panel.update(client.state);panel.showGroup("group-one");idle();}
        View root()throws Exception{return ((UiSheet)field(panel,"sheet")).shell;}
        EditText composer()throws Exception{return (EditText)field(panel,"composer");}
        void click(String label)throws Exception{GroupPanelInteractionTest.idle();NativeSheetVisualTest.click(root(),label);idle();}
        public void close(){panel.close();activity.finish();idle();}
    }
    @Test public void groupListDetailAndComposerExplainCoordinatorChoice() throws Exception {
        try (Fixture f = new Fixture()) {
            f.panel.showList(); idle();
            assertNotNull(NativeLayoutAuditTest.label(f.root(), "@ 成员可直接派工。未点名时，由协调员判断是否需要回应。"));
            f.panel.showGroup("group-one"); idle();
            assertNotNull(NativeLayoutAuditTest.label(f.root(), "2 位助理 · 回复可继续同一件事"));
            assertEquals("交代一件事，或选择助理", f.composer().getHint().toString());
            assertTrue(f.client.writes.isEmpty());
        }
    }
    @Test public void coordinationFailuresStayOnTheOriginalMessageAndIgnoreAddsNoReplyOrReceipt() throws Exception {
        try (Fixture f = new Fixture()) {
            JSONObject message = object("id", "coordination-message", "kind", "user", "content", "一条公开记录");
            f.client.detail.put("messages", new JSONArray().put(message));
            f.client.detail.put("tasks", new JSONArray()); f.client.detail.put("receipts", new JSONArray());
            f.panel.showGroup("group-one"); idle();
            for (String status : new String[]{"pending", "needs_consent", "needs_setup", "budget_limited", "unavailable", "interrupted", "revoked", "ignored", "taken", "unknown-future-value"}) {
                message.put("coordinatorStatus", status); invoke(f.panel, "drawDetail", new Class[]{});
                android.view.ViewGroup transcript = (android.view.ViewGroup)field(f.panel, "transcript");
                assertEquals("no separate reply or task receipt", 1, transcript.getChildCount());
                android.view.ViewGroup card = (android.view.ViewGroup)transcript.getChildAt(0);
                assertNotNull(NativeLayoutAuditTest.label(card, "一条公开记录"));
                boolean quiet = List.of("ignored", "taken", "unknown-future-value").contains(status);
                assertEquals(status, quiet ? 2 : 3, card.getChildCount());
                if (!quiet) assertNotNull(NativeLayoutAuditTest.label(card, GroupPanel.coordinatorHint(status)));
            }
            assertTrue(f.client.writes.isEmpty()); assertTrue(f.client.consents.isEmpty());
        }
    }
    @Test public void selectingAMemberSendsOnlyItsIdAndSuccessfulOldReplyDoesNotEraseNewDraft()throws Exception{
        try(Fixture f=new Fixture()){
            assertEquals(0,f.client.writes.size());f.click("@安排员");f.composer().setText("核对时间");f.click("发送");Sent sent=f.client.writes.get(0);
            assertEquals("/v1/groups/group-one/messages",sent.path);assertEquals("核对时间",sent.body.getString("content"));assertEquals("[\"r2\"]",sent.body.getJSONArray("recipientRoleIds").toString());assertFalse(sent.body.has("controlEpoch"));
            f.composer().setText("还有一条补充");sent.callback.done(object("received",true),null);idle();assertEquals("还有一条补充",f.composer().getText().toString());assertEquals(1,f.client.writes.size());
        }
    }
    @Test public void expiredConfirmedMissingRequestAllowsSameTextAsAnExplicitNewSubmission()throws Exception{
        try(Fixture f=new Fixture()){
            f.composer().setText("查资料");f.click("发送");Sent first=f.client.writes.get(0);String originalId=first.body.getString("messageId");JSONObject original=new JSONObject(first.body.toString()).put("controlEpoch",7).put("expiresAt","2026-11-02T00:00:00Z");
            f.client.state.getJSONObject("groupRequests").put(originalId,object("path",first.path,"body",original,"rejected",true,"error","已确认未接收，期限已过"));first.callback.done(null,new IOException("期限已过"));idle();
            assertEquals("查资料",f.composer().getText().toString());f.click("发送");assertEquals(2,f.client.writes.size());Sent next=f.client.writes.get(1);assertNotEquals(originalId,next.body.getString("messageId"));assertEquals("查资料",next.body.getString("content"));assertFalse(next.body.has("expiresAt"));assertEquals(7,original.getLong("controlEpoch"));
        }
    }
    @Test public void reopeningAnUnconfirmedMessageRestoresDraftAndRetriesExactEnvelope()throws Exception{
        try(Fixture f=new Fixture()){
            JSONObject original=object("messageId",UUID.randomUUID().toString(),"content","查资料","recipientRoleIds",new JSONArray().put("r2"),"controlEpoch",9,"expiresAt","2026-11-02T18:00:00Z");String before=original.toString();
            f.client.state.getJSONObject("groupRequests").put(original.getString("messageId"),object("path","/v1/groups/group-one/messages","body",original,"everSent",true));f.panel.update(f.client.state);f.panel.showGroup("group-one");idle();f.click("恢复这条草稿");assertEquals("查资料",f.composer().getText().toString());
            f.click("发送");assertEquals(0,f.client.writes.size());f.click("用原请求重试");assertEquals(1,f.client.writes.size());assertEquals(before,f.client.writes.get(0).body.toString());assertEquals(before,original.toString());
        }
    }
    @Test public void readingNeverDispatchesAndControlsUseTheSelectedTask()throws Exception{
        try(Fixture f=new Fixture()){
            assertTrue(f.client.reads>0);assertTrue(f.client.writes.isEmpty());GroupPanelTest.findDescription(f.root(),"展开任务跟进").performClick();idle();f.click("暂停这件事");assertEquals("/v1/groups/group-one/tasks/t1/pause",f.client.writes.get(0).path);f.client.writes.get(0).callback.done(object("status","paused"),null);idle();
            f.click("继续这件事");assertEquals("/v1/groups/group-one/tasks/t2/resume",f.client.writes.get(1).path);f.client.writes.get(1).callback.done(object("status","queued"),null);idle();
            f.client.detail.put("tasks",new JSONArray().put(object("id","consent-task","roleId","r2","status","waiting_consent")));invoke(f.panel,"drawDetail",new Class[]{});f.click("允许本次使用模型");assertEquals(List.of("consent-task"),f.client.consents);assertEquals(2,f.client.writes.size());
        }
    }

    @Test public void replyingKeepsTheExactMessageAndRecipientAcrossLeavingAndReturning()throws Exception{
        try(Fixture f=new Fixture()){
            f.client.detail.getJSONArray("messages").put(object("id","answer-one","kind","assistant","roleId","r2","content","三个方案已整理"));invoke(f.panel,"drawDetail",new Class[]{});f.click("回复 安排员");f.composer().setText("把第二项展开");f.panel.showList();idle();f.panel.showGroup("group-one");idle();assertEquals("把第二项展开",f.composer().getText().toString());f.click("发送");Sent sent=f.client.writes.get(0);assertEquals("answer-one",sent.body.getString("replyToMessageId"));assertEquals("r2",sent.body.getJSONArray("recipientRoleIds").getString(0));
        }
    }
    @Test public void oldUnfinishedTasksStayVisibleAfterManyCompletedTasks() throws Exception {
        try(Fixture f=new Fixture()){
            JSONArray tasks=f.client.detail.getJSONArray("tasks");
            for(int n=0;n<30;n++)tasks.put(object("id","history-"+n,"roleId","r1","status","completed","title","历史任务 "+n));
            invoke(f.panel,"drawDetail",new Class[]{});
            GroupPanelTest.findDescription(f.root(),"展开任务跟进").performClick();idle();
            assertNotNull(NativeLayoutAuditTest.label(f.root(),"研究资料"));
            assertNotNull(NativeLayoutAuditTest.label(f.root(),"整理结果"));
            f.click("暂停这件事");assertEquals("/v1/groups/group-one/tasks/t1/pause",f.client.writes.get(0).path);
            f.click("已结束任务 · 30");
            assertNotNull(NativeLayoutAuditTest.label(f.root(),"历史任务 0"));
            assertNotNull(NativeLayoutAuditTest.label(f.root(),"历史任务 29"));
        }
    }
    @Test public void confirmedRetryClearsReplyAndRecipientBeforeTheNextMessage() throws Exception {
        try(Fixture f=new Fixture()){
            JSONObject original=object("messageId",UUID.randomUUID().toString(),"content","继续第二项","replyToMessageId","answer-one","recipientRoleIds",new JSONArray().put("r2"));
            f.client.state.getJSONObject("groupRequests").put(original.getString("messageId"),object("path","/v1/groups/group-one/messages","body",original,"everSent",true));
            f.panel.update(f.client.state);f.panel.showGroup("group-one");idle();f.click("恢复这条草稿");f.click("用原请求重试");
            f.client.state.put("groupRequests",new JSONObject());f.client.writes.get(0).callback.done(object("received",true),null);idle();
            assertEquals("",f.composer().getText().toString());
            f.composer().setText("这是下一件独立的事");f.click("发送");JSONObject next=f.client.writes.get(1).body;
            assertFalse(next.has("replyToMessageId"));assertFalse(next.has("recipientRoleIds"));
            f.panel.showList();idle();f.panel.showGroup("group-one");idle();
            assertEquals("",field(f.panel,"replyTo"));assertTrue(((Set<?>)field(f.panel,"recipients")).isEmpty());
        }
    }

    @Test public void failedListRefreshKeepsCachedGroupsAndNeverDispatches()throws Exception{
        try(Fixture f=new Fixture()){
            f.client.state.getJSONObject("state").put("groups",new JSONArray().put(object("id","group-one","name","上次同步的群","memberRoleIds",new JSONArray().put("r2"))));
            f.client.readError=new IOException("offline");f.panel.update(f.client.state);f.panel.showList();idle();
            assertNotNull(NativeLayoutAuditTest.label(f.root(),"上次同步的群"));
            assertNotNull(NativeLayoutAuditTest.label(f.root(),"暂未连上电脑，显示上次同步的群聊。"));
            assertTrue(f.client.writes.isEmpty());
            f.client.readError=null;f.click("重试");
            assertThrows(java.util.NoSuchElementException.class,()->NativeLayoutAuditTest.label(f.root(),"上次同步的群"));
            assertTrue(f.client.writes.isEmpty());
        }
    }

    @Test public void taskFollowupStartsCollapsedAndRefreshKeepsChoiceAndDraft()throws Exception{
        try(Fixture f=new Fixture()){
            assertNotNull(GroupPanelTest.findDescription(f.root(),"展开任务跟进"));
            assertThrows(NoSuchElementException.class,()->NativeLayoutAuditTest.label(f.root(),"暂停这件事"));
            f.composer().setText("保留草稿");GroupPanelTest.findDescription(f.root(),"展开任务跟进").performClick();idle();
            assertNotNull(NativeLayoutAuditTest.label(f.root(),"暂停这件事"));invoke(f.panel,"drawDetail",new Class[]{});
            assertNotNull(GroupPanelTest.findDescription(f.root(),"收起任务跟进"));assertEquals("保留草稿",f.composer().getText().toString());
            GroupPanelTest.findDescription(f.root(),"收起任务跟进").performClick();idle();assertTrue(f.client.writes.isEmpty());
        }
    }

}
