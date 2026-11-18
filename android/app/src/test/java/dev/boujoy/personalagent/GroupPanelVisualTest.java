package dev.boujoy.personalagent;

import android.app.Activity;
import android.view.*;
import android.widget.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import java.lang.reflect.Field;
import java.util.Set;
import static org.junit.Assert.*;
import static dev.boujoy.personalagent.NativeVisualTest.*;
import static dev.boujoy.personalagent.NativeLayoutAuditTest.*;
import static dev.boujoy.personalagent.NativeSheetVisualTest.*;

/** Synthetic UI fixtures only: no model, phone, or production service. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,qualifiers="w390dp-h844dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class GroupPanelVisualTest {
    private void set(Object owner,String name,Object value)throws Exception{Field field=owner.getClass().getDeclaredField(name);field.setAccessible(true);field.set(owner,value);}
    private JSONObject group(){return object("id","qa-group","name","项目协作群","coordinatorRoleId","shop","memberRoleIds",new JSONArray().put("shop").put("coach"),"members",new JSONArray().put(object("id","shop","name","采购助理","available",true)).put(object("id","coach","name","安排助理","available",true)),"messages",new JSONArray().put(object("kind","user","content","@采购助理 整理今晚要做的事，再把安排交给日程助理。")).put(object("kind","assistant","roleId","shop","content","需要准备的材料已经整理好，接下来交给安排助理核对时间。")).put(object("kind","handoff","roleId","shop","recipientRoleIds",new JSONArray().put("coach"),"content","请根据已整理的事项安排时间，并核对与现有日程是否冲突。")),"receipts",new JSONArray().put(object("taskId","one","label","等待交班结果")).put(object("taskId","two","label","已暂停")),"tasks",new JSONArray().put(object("id","one","roleId","shop","status","waiting_children")).put(object("id","two","roleId","coach","status","paused","blockedReason","等你明确下一步后继续。")));}
    @Test public void groupKeyboardAndMemberSelectionRemainUsableWithoutDispatch()throws Exception{
        ConnectionService.current=null;Activity activity=Robolectric.buildActivity(Activity.class).setup().get();GroupPanel panel=new GroupPanel(activity);panel.update(fixture());panel.showGroup("qa-group");JSONObject data=group();set(panel,"detail",data);invoke(panel,"drawDetail",new Class[]{});UiSheet sheet=(UiSheet)field(panel,"sheet");FrameLayout root=frame(sheet,390,844);capture(root,"10-group-chat",390,844);readableControls(root);assertNotNull(label(root,"发送"));assertNotNull(GroupPanelTest.findDescription(root,"展开任务跟进"));GroupPanelTest.findDescription(root,"展开任务跟进").performClick();assertNotNull(label(root,"暂停这件事"));assertNotNull(label(root,"继续这件事"));
        click(root,"@采购助理");assertEquals(Set.of("shop"),field(panel,"recipients"));assertNotNull(label(sheet.shell,"✓ 采购助理"));assertEquals("",field(panel,"pendingId"));
        root=frame(sheet,390,440);capture(root,"10-group-keyboard",390,440);readableControls(root);android.graphics.Rect bounds=bounds(root,label(root,"发送"));assertTrue(bounds.top>=0);assertTrue(bounds.bottom<=440);panel.close();activity.finish();
    }
    @Test public void groupEditorWorksAtNarrowWidthAndLargeText()throws Exception{
        ConnectionService.current=null;RuntimeEnvironment.setQualifiers("w320dp-h640dp-mdpi");RuntimeEnvironment.setFontScale(1.3f);Activity activity=Robolectric.buildActivity(Activity.class).setup().get();GroupPanel panel=new GroupPanel(activity);panel.update(fixture());invoke(panel,"editMembers",new Class[]{JSONObject.class},new Object[]{null});UiSheet editor=(UiSheet)field(panel,"editor");FrameLayout root=frame(editor,320,640);capture(root,"11-create-group",320,640);readableControls(root);assertNotNull(label(root,"建群"));panel.close();activity.finish();
    }

    @Test public void fixedGroupMediaTableAndApprovalDetailsAreVisible()throws Exception{
        ConnectionService.current=null;MainActivity activity=main(fixture(),"concierge","");
        GroupPanelInteractionTest.Client client=new GroupPanelInteractionTest.Client();
        client.detail.put("messages",new JSONArray().put(object("id","result","kind","assistant","roleId","r1","content","## 核算结果\n\n| 项目 | 金额 |\n|---|---:|\n| 红色 | 17 |\n| 蓝色 | 29 |\n| **合计** | **46** |","artifacts",new JSONArray().put(object("id","video-one","name","合成视频.webm","mime","video/webm","size",18573)))));
        client.detail.put("tasks",new JSONArray().put(object("id","confirm","roleId","r1","title","创建一份文件","status","waiting_approval")));
        GroupPanel panel=new GroupPanel(activity,client);panel.update(client.state);panel.showGroup("group-one");GroupPanelInteractionTest.idle();UiSheet sheet=(UiSheet)field(panel,"sheet");FrameLayout root=frame(sheet,390,844);capture(root,"12-fixed-group",390,844);readableControls(root);assertNotNull(label(root,"查看并处理确认"));assertNotNull(label(root,"保存到手机"));panel.close();
        JSONObject approval=object("id","a","fingerprint","f","status","pending","summary","创建指定文件","details",new JSONArray().put(object("label","工作目录","value","Documents/Boujoy/QA")).put(object("label","完整任务指令","value","先确认 approval.txt 不存在，再创建文件，内容仅 HELLO。不要修改其他文件。")));
        JSONObject detail=object("id","confirm","groupId","group-one","title","创建一份文件","status","waiting_approval","approvals",new JSONArray().put(approval));
        invoke(activity,"renderTaskDetails",new Class[]{String.class,JSONObject.class},"confirm",detail);UiSheet dialog=(UiSheet)field(activity,"taskDialog");root=frame(dialog,390,844);capture(root,"13-fixed-approval-details",390,844);assertNotNull(label(root,"允许这次操作"));assertNotNull(label(root,"拒绝"));dialog.dismiss();activity.finish();
    }
}
