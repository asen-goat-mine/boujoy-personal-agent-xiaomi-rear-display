package dev.boujoy.personalagent;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class RearApprovalTest {
    static final String FP="a".repeat(64);
    static JSONObject approval(long expires) { return Tunnel.json("id","approval-one","taskId","task-one","status","pending","fingerprint",FP,"expiresAt",expires,"summary","把已核对的日程表保存到指定文件"); }
    static JSONObject snapshot(long elapsed,long now,long epoch) {
        return Tunnel.json("online",true,"paired",true,"paused",false,"controlEpoch",epoch,"stateSyncedAtElapsedMs",elapsed,
                "state",Tunnel.json("device",Tunnel.json("controlEpoch",epoch,"paused",false),"tasks",new JSONArray().put(Tunnel.json("id","task-one","status","waiting_approval","approvals",new JSONArray().put(approval(now+60000))))));
    }
    static JSONObject detail(RearApproval.Scope scope) throws Exception { return Tunnel.json("id","task-one","status","waiting_approval","approvals",new JSONArray().put(approval(scope.expiresAt()).put("details",new JSONArray().put(Tunnel.json("label","目标路径","value","Documents/Boujoy/日程表.md")).put(Tunnel.json("label","写入内容","value","第一行\n第二行"))))); }
    static RearApproval.Card card(JSONObject snapshot,long elapsed,long now) { return RearApproval.cards(snapshot,"task-one",elapsed,now).get(0); }
    @Test public void exactDetailsAreRequiredBeforeAllowAndProjectionKeepsCompleteContent() throws Exception {
        JSONObject snapshot=snapshot(1000,10000,7);RearApproval.Card card=card(snapshot,1500,10000);
        assertFalse(card.canAllow());assertTrue(card.canDeny());assertEquals(7,card.scope().controlEpoch());
        JSONObject detail=RearApproval.detail(card.scope(),detail(card.scope()));assertNotNull(detail);
        detail.put("args",Tunnel.json("secret","NEVER-RENDER"));
        RearApproval.Card verified=RearApproval.withDetails(card,detail,"");
        assertTrue(verified.canAllow());assertTrue(verified.canDeny());assertTrue(verified.details().contains("第一行\n第二行"));assertFalse(verified.toString().contains("NEVER-RENDER"));
    }
    @Test public void pauseDisconnectExpiryAndControlChangesImmediatelyRemoveDecisions() throws Exception {
        for(String change:new String[]{"paused","offline","unpaired","old_sync","future_sync","local_epoch","server_epoch","server_paused","stopped","expired"}){
            JSONObject snapshot=snapshot(1000,10000,7);JSONObject state=snapshot.getJSONObject("state");
            assertEquals(1,RearApproval.cards(snapshot,"task-one",1500,10000).size());
            switch(change){
                case "paused"->snapshot.put("paused",true);case "offline"->snapshot.put("online",false);case "unpaired"->snapshot.put("paired",false);
                case "old_sync"->snapshot.put("stateSyncedAtElapsedMs",1);case "future_sync"->snapshot.put("stateSyncedAtElapsedMs",40000);
                case "local_epoch"->snapshot.put("controlEpoch",8);case "server_epoch"->state.getJSONObject("device").put("controlEpoch",8);
                case "server_paused"->state.getJSONObject("device").put("paused",true);
                case "stopped"->state.getJSONArray("tasks").getJSONObject(0).put("status","stopped");
                case "expired"->state.getJSONArray("tasks").getJSONObject(0).getJSONArray("approvals").getJSONObject(0).put("expiresAt",10000);
            }
            assertTrue(change,RearApproval.cards(snapshot,"task-one","old_sync".equals(change)?31002:1500,10000).isEmpty());
        }
    }
    @Test public void changedRequestCannotBorrowPreviousDetailsOrScope() throws Exception {
        JSONObject snapshot=snapshot(1000,10000,7);RearApproval.Card original=card(snapshot,1500,10000);
        JSONObject approval=snapshot.getJSONObject("state").getJSONArray("tasks").getJSONObject(0).getJSONArray("approvals").getJSONObject(0);
        approval.put("fingerprint","b".repeat(64));assertFalse(RearApproval.matches(snapshot,original.scope(),1500,10000));
        RearApproval.Card next=card(snapshot,1500,10000);
        assertFalse(RearApproval.withDetails(next,RearApproval.detail(original.scope(),detail(original.scope())),"").canAllow());
        for(String change:new String[]{"taskId","id","fingerprint","status","expiresAt","summary"}){
            JSONObject value=RearApproval.detail(original.scope(),detail(original.scope()));
            value.put(change,"expiresAt".equals(change)?original.scope().expiresAt()+1:"summary".equals(change)?"":"changed");
            assertFalse(change,RearApproval.detailMatches(original.scope(),value));
        }
    }
    @Test public void eachPendingCardKeepsItsOwnIdentityAndSubmittedChoicesDisappear() throws Exception {
        JSONObject snapshot=snapshot(1000,10000,7);JSONArray approvals=snapshot.getJSONObject("state").getJSONArray("tasks").getJSONObject(0).getJSONArray("approvals");
        approvals.put(approval(70000).put("id","approval-two"));assertEquals(2,RearApproval.cards(snapshot,"task-one",1500,10000).size());
        assertTrue(RearApproval.cards(snapshot,"other-task",1500,10000).isEmpty());
        for(String status:new String[]{"sending","accepted","unconfirmed"}){
            snapshot.put("approvalRequests",Tunnel.json("approval-one",Tunnel.json("fingerprint",FP,"status",status)));
            RearApproval.Card card=card(snapshot,1500,10000);card=RearApproval.withDetails(card,RearApproval.detail(card.scope(),detail(card.scope())),"");
            assertFalse(status,card.canAllow());assertFalse(status,card.canDeny());
            assertTrue(RearApproval.cards(snapshot,"task-one",1500,10000).get(1).canDeny());
        }
    }
    @Test public void emptySummaryOrToolNameNeverCountsAsVerifiedInstructions() throws Exception {
        JSONObject snapshot=snapshot(1000,10000,7);JSONObject approval=snapshot.getJSONObject("state").getJSONArray("tasks").getJSONObject(0).getJSONArray("approvals").getJSONObject(0);
        approval.put("summary","").put("tool","harness_native");RearApproval.Card card=card(snapshot,1500,10000);
        JSONObject detail=RearApproval.detail(card.scope(),detail(card.scope()));detail.put("summary","");
        assertFalse(RearApproval.withDetails(card,detail,"").canAllow());assertEquals("",card.summary());
    }
}
