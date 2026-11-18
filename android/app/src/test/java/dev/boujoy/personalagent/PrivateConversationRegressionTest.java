package dev.boujoy.personalagent;
import org.json.*;import org.junit.Test;import static org.junit.Assert.*;
public class PrivateConversationRegressionTest {
    private static final String PRIVATE="11111111-1111-4111-8111-111111111111",GROUP="22222222-2222-4222-8222-222222222222";
    private JSONArray tasks(){return new JSONArray().put(Tunnel.json("id",PRIVATE,"roleId","concierge","conversationId",PRIVATE)).put(Tunnel.json("id",GROUP,"roleId","concierge","conversationId","group:some-group:role:concierge","preview","group-only-content"));}
    @Test public void legacyGroupSummaryCannotBecomePrivateHistoryOrDetailRequest(){
        var tasks=tasks();assertEquals(PRIVATE,ConversationIdentity.latest(tasks,"concierge").get(0).optString("id"));assertEquals(1,ConversationIdentity.latest(tasks,"concierge").size());
        var cache=new TaskDetailCache();cache.update(tasks);assertEquals(1,cache.requests(1,4).size());
        var snapshot=Tunnel.json("state",Tunnel.json("tasks",tasks));assertFalse(ChatPresenter.present(snapshot).rows().stream().anyMatch(r->r.taskId().equals(GROUP)||r.text().contains("group-only-content")));
    }
    @Test public void contaminatedSelectionRepairsDestinationWithoutLosingDraftOrResending(){
        var state=new ChatComposerState();state.selectConversation(GROUP);state.setText("帮我处理一个从未预设的新任务");state.setAttachments(new JSONArray().put(Tunnel.json("name","keep.txt")));
        state.reconcile(Tunnel.json("state",Tunnel.json("tasks",tasks())));assertEquals("",state.conversationId());assertEquals("帮我处理一个从未预设的新任务",state.text());assertEquals(1,state.attachments().length());assertFalse(state.waiting());assertEquals("",state.begin().conversationId());
    }
    @Test public void privateFollowupStillRetainsContext(){
        var state=new ChatComposerState();state.selectConversation(PRIVATE);state.reconcile(Tunnel.json("state",Tunnel.json("tasks",tasks())));state.setText("沿用刚才的要求继续");assertEquals(PRIVATE,state.begin().conversationId());
    }
    @Test public void expiredNegativeReceiptEndsWaitingButFreshUnknownNeverGrantsReplay(){
        JSONObject receipt=Tunnel.json("received",false,"status","not_received"),message=Tunnel.json("expiresAt","2026-11-04T15:00:00Z");long expiry=Binding.parseTime(message.opt("expiresAt"));
        assertEquals("unconfirmed",MessageDelivery.statusAfterLookup(receipt,message,expiry-1));assertEquals("not_received",MessageDelivery.statusAfterLookup(receipt,message,expiry));assertEquals("unconfirmed",MessageDelivery.statusAfterLookup(new JSONObject(),message,expiry));assertEquals("received",MessageDelivery.statusAfterLookup(Tunnel.json("received",true),message,expiry));
        assertEquals("not_received",MessageDelivery.statusAfterFailure(new GatewayClient.GatewayError(400,"invalid_private_conversation","invalid")));assertEquals("unconfirmed",MessageDelivery.statusAfterFailure(new java.io.IOException("lost reply")));
    }
}
