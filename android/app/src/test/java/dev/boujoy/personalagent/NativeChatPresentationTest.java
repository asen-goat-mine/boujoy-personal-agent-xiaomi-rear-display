package dev.boujoy.personalagent;

import android.text.Spanned;
import android.text.style.StyleSpan;
import android.text.style.TypefaceSpan;
import android.view.View;
import android.widget.TextView;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.*;
import static dev.boujoy.personalagent.NativeVisualTest.*;
import static dev.boujoy.personalagent.NativeLayoutAuditTest.label;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,qualifiers="w390dp-h844dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class NativeChatPresentationTest {
    @Test public void controlButtonFollowsConnectionPauseAndSelectedTaskAcrossRefreshes()throws Exception {
        String id="55555555-5555-4555-8555-555555555555";
        JSONObject data=fixture().put("paused",true).put("controlEpoch",7);
        JSONObject task=object("id",id,"conversationId",id,"roleId","concierge","status","completed");
        data.getJSONObject("state").put("tasks",new JSONArray().put(task));
        MainActivity activity=main(data,"concierge",id);
        try {
            View row=(View)field(activity,"statusRow");
            assertVisibleControl(row,"继续");

            // Only the connection changes. A cached chat presentation must not keep the old action.
            data.put("online",false);
            invoke(activity,"renderSnapshot",new Class[]{JSONObject.class,ConnectionService.class},data,null);
            assertVisibleControl(row,"停止 / 接管");

            data.put("online",true).put("paused",false).put("controlEpoch",8);
            invoke(activity,"renderSnapshot",new Class[]{JSONObject.class,ConnectionService.class},data,null);
            assertEquals(View.GONE,row.getVisibility());

            task.put("status","running");
            invoke(activity,"renderSnapshot",new Class[]{JSONObject.class,ConnectionService.class},data,null);
            assertVisibleControl(row,"停止 / 接管");
        } finally {
            activity.finish();
        }
    }
    private static void assertVisibleControl(View row,String text) {
        assertEquals(View.VISIBLE,row.getVisibility());
        TextView button=(TextView)label(row,text);
        assertEquals(text,button.getText().toString());
        assertEquals(View.VISIBLE,button.getVisibility());
        assertTrue(button.isClickable()&&button.isEnabled());
    }
    @Test public void assistantFormattingKeepsWordsAndLiteralCode() {
        Spanned result=(Spanned)ChatText.assistant("实付 **¥15.9**，编号 `**order_1**`。\n\n下一段");
        assertEquals("实付 ¥15.9，编号 **order_1**。\n\n下一段",result.toString());
        assertEquals(1,result.getSpans(0,result.length(),StyleSpan.class).length);
        assertEquals(1,result.getSpans(0,result.length(),TypefaceSpan.class).length);
        assertEquals("**literal**\n",ChatText.assistant("```java\n**literal**\n```").toString());
        assertEquals("未结束 **金额\n以及 `输入",ChatText.assistant("未结束 **金额\n以及 `输入").toString());
        assertEquals("\\**原文**",ChatText.assistant("\\**原文**").toString());
    }
    @Test public void ordinaryReplyAndIncrementalUpdateKeepDraftAndUserText()throws Exception {
        String id="33333333-3333-4333-8333-333333333333";JSONObject data=fixture();
        JSONObject user=object("id","u","role","user","content","帮我安排一下今晚，别排太满");
        JSONObject reply=object("id","a","role","assistant","content","今晚留三件小事就好：\n\n**19:00 吃晚饭**，慢慢吃，不赶时间。\n\n**20:00 散步 20 分钟**，回来后休息。\n\n**22:30 准备睡觉**，剩下的明天再做。");
        JSONObject task=object("id",id,"conversationId",id,"roleId","concierge","title","今晚安排","status","completed","messages",new JSONArray().put(user).put(reply));
        data.getJSONObject("state").put("tasks",new JSONArray().put(task));data.put("taskDetails",object(id,object("detail",task)));MainActivity a=main(data,"concierge",id);View root=(View)field(a,"chatRoot");
        TextView composer=(TextView)field(a,"composer");composer.setText("散步改到八点半吧");capture(root,"02-conversation",390,844);
        assertNotNull(label(root,user.getString("content")));TextView rendered=(TextView)label(root,ChatText.assistant(reply.getString("content")).toString());
        assertTrue(rendered.getText() instanceof Spanned);assertEquals(3,((Spanned)rendered.getText()).getSpans(0,rendered.length(),StyleSpan.class).length);
        user.put("content","**别排太满**");
        reply.put("content","调整好了：**20:30 散步**，其他时间不变。");
        invoke(a,"renderSnapshot",new Class[]{JSONObject.class,ConnectionService.class},data,null);
        TextView updated=(TextView)label(root,"调整好了：20:30 散步，其他时间不变。");assertNotNull(label(root,"**别排太满**"));assertSame(rendered,updated);assertEquals(1,((Spanned)updated.getText()).getSpans(0,updated.length(),StyleSpan.class).length);
        assertEquals("散步改到八点半吧",composer.getText().toString());a.finish();
    }
    @Test public void wechatEditorJobsAreNoLongerRejectedByPackage() {
        String pkg = "com.tencent.mm";
        java.util.function.BooleanSupplier paused = () -> false;
        for (String mode : new String[]{"insert", "replace"}) {
            BoujoyTypingService.Outcome outcome = BoujoyTypingService.perform("type", "test", mode, pkg, "", 3, paused);
            assertNotEquals("protected_input", outcome.diagnostic());
        }
        assertEquals("invalid_request", BoujoyTypingService.perform("unknown", "", "", pkg, "", 3, paused).diagnostic());
    }
    @Test public void expiredApprovalUpdatesWithoutNewSnapshotAndCannotBeAllowed()throws Exception {
        String id="44444444-4444-4444-8444-444444444444";JSONObject data=fixture();long now=System.currentTimeMillis();
        JSONObject approval=object("id","approval-clock","status","pending","summary","用本周日程表替换旧版文件","expiresAt",now+180000);
        JSONObject task=object("id",id,"conversationId",id,"roleId","concierge","title","替换旧版日程表","status","waiting_approval","messages",new JSONArray().put(object("id","u","role","user","content","把本周日程表保存到旧版文件的位置")),"approvals",new JSONArray().put(approval));
        data.getJSONObject("state").put("tasks",new JSONArray().put(task));data.put("taskDetails",object(id,object("detail",task)));
        String before=data.toString();assertFalse(ApprovalPresentation.expired(approval,now));assertTrue(ApprovalPresentation.expired(approval,now+180000));
        assertEquals(ApprovalPresentation.revision(data,now),ApprovalPresentation.revision(data,now+179999));assertNotEquals(ApprovalPresentation.revision(data,now),ApprovalPresentation.revision(data,now+180000));
        MainActivity a=main(data,"concierge",id);View root=(View)field(a,"chatRoot");assertTrue(label(root,"允许这次操作").isEnabled());
        invoke(a,"renderSnapshot",new Class[]{JSONObject.class,ConnectionService.class,long.class},data,null,now+180001);capture(root,"02-confirmation-expired",390,844);
        assertNotNull(label(root,"确认已过期 · 请重新核实"));assertFalse(label(root,"允许这次操作").isEnabled());assertTrue(label(root,"拒绝").isEnabled());assertEquals(before,data.toString());a.finish();
    }

    @Test public void approvalButtonsAreReachableBeforeTaskHistoryArrives()throws Exception{
        String id="44444444-4444-4444-8444-444444444444";JSONObject data=fixture();JSONObject task=object("id",id,"conversationId",id,"roleId","concierge","status","waiting_approval","approvals",new JSONArray().put(object("id","approval-summary","status","pending","summary","生成一张图片，保存到工作文件夹","expiresAt",System.currentTimeMillis()+180000)));
        data.getJSONObject("state").put("tasks",new JSONArray().put(task));data.put("taskDetails",new JSONObject());MainActivity a=main(data,"concierge",id);View root=(View)field(a,"chatRoot");assertTrue(label(root,"允许这次操作").isEnabled());assertNotNull(label(root,"拒绝"));capture(root,"approval-without-history",390,844);a.finish();
    }
}
