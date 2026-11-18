package dev.boujoy.personalagent;

import android.app.*;
import android.view.*;
import android.widget.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import static org.junit.Assert.*;
import static dev.boujoy.personalagent.NativeVisualTest.*;
import static dev.boujoy.personalagent.NativeLayoutAuditTest.label;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,qualifiers="w390dp-h844dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class GroupPanelTest {
    private static View optional(View root,String title){if(root instanceof TextView text&&title.contentEquals(text.getText()))return root;if(root instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++){View found=optional(group.getChildAt(i),title);if(found!=null)return found;}return null;}
    private static void show(GroupPanel panel,JSONObject group)throws Exception{panel.showGroup(group.getString("id"));java.lang.reflect.Field detail=GroupPanel.class.getDeclaredField("detail");detail.setAccessible(true);detail.set(panel,group);invoke(panel,"drawDetail",new Class[]{});View root=((UiSheet)field(panel,"sheet")).shell;View followup=findDescription(root,"展开任务跟进");if(followup!=null)followup.performClick();}
    static View findDescription(View root,String title){if(title.contentEquals(root.getContentDescription()==null?"":root.getContentDescription()))return root;if(root instanceof ViewGroup g)for(int i=0;i<g.getChildCount();i++){View found=findDescription(g.getChildAt(i),title);if(found!=null)return found;}return null;}
    static JSONObject group(){return object("id","group-one","name","研究与安排","coordinatorRoleId","r1","members",new JSONArray().put(object("id","r1","name","研究员")).put(object("id","r2","name","安排员")),"messages",new JSONArray().put(object("id","m1","kind","user","content","@研究员 查好之后交给安排员")).put(object("id","m2","kind","handoff","roleId","r1","recipientRoleIds",new JSONArray().put("r2"),"content","资料已整理，请接手安排下一步。")),"receipts",new JSONArray().put(object("taskId","t1","roleId","r1","label","已接手","state","accepted")).put(object("taskId","t2","roleId","r2","label","已暂停","state","paused")),"tasks",new JSONArray().put(object("id","t1","roleId","r1","status","running","title","研究资料")).put(object("id","t2","roleId","r2","status","paused","title","整理结果")));}
    @Test public void groupShowsRealReceiptsAndKeepsDraftWhileRefreshing()throws Exception{
        ConnectionService.current=null;Activity a=Robolectric.buildActivity(Activity.class).setup().get();a.setTheme(R.style.AppTheme);GroupPanel panel=new GroupPanel(a);JSONObject data=fixture(),group=group();data.getJSONObject("state").put("groups",new JSONArray().put(group));panel.update(data);show(panel,group);
        UiSheet sheet=(UiSheet)field(panel,"sheet");View root=sheet.shell;assertNotNull(label(root,"研究员 · 已接手"));assertNotNull(label(root,"安排员 · 已暂停"));assertNotNull(label(root,"研究员 → 安排员"));assertNotNull(label(root,"继续这件事"));assertNull(optional(root,"已完成"));
        EditText composer=(EditText)field(panel,"composer");composer.setText("先等我补充时间");group.getJSONArray("receipts").put(object("taskId","t2","roleId","r2","label","已续跑","state","resumed"));group.getJSONArray("tasks").getJSONObject(1).put("status","running");invoke(panel,"drawDetail",new Class[]{});assertEquals("先等我补充时间",composer.getText().toString());assertNotNull(label(root,"安排员 · 已续跑"));((ViewGroup)root.getParent()).removeView(root);FrameLayout frame=new FrameLayout(a);frame.addView(root,new FrameLayout.LayoutParams(390,740));capture(frame,"f1-group-chat",390,740);int[] sendAt=new int[2],rootAt=new int[2];View send=(View)field(panel,"send");send.getLocationOnScreen(sendAt);root.getLocationOnScreen(rootAt);assertTrue("Send bottom "+(sendAt[1]-rootAt[1]+send.getHeight())+" must fit "+root.getHeight(),sendAt[1]-rootAt[1]+send.getHeight()<=root.getHeight());panel.close();a.finish();
    }
    @Test public void pendingSendSurvivesRefreshAndRequiresOriginalRetry()throws Exception{
        ConnectionService.current=null;Activity a=Robolectric.buildActivity(Activity.class).setup().get();a.setTheme(R.style.AppTheme);GroupPanel panel=new GroupPanel(a);JSONObject group=group(),snapshot=fixture();snapshot.put("groupRequests",object("request-one",object("path","/v1/groups/group-one/messages","body",object("messageId","request-one","content","查资料"))));panel.update(snapshot);show(panel,group);View root=((UiSheet)field(panel,"sheet")).shell;assertNotNull(label(root,"请求尚未确认：查资料"));assertNotNull(label(root,"用原请求重试"));assertEquals(1,snapshot.getJSONObject("groupRequests").length());panel.close();a.finish();
    }
    @Test public void consentAndUnknownStatesAreNotReportedAsResumable()throws Exception{
        ConnectionService.current=null;Activity a=Robolectric.buildActivity(Activity.class).setup().get();a.setTheme(R.style.AppTheme);GroupPanel panel=new GroupPanel(a);JSONObject group=group();group.put("tasks",new JSONArray().put(object("id","t1","roleId","r1","status","waiting_consent","title","查资料")).put(object("id","t2","roleId","r2","status","unknown_result","title","整理结果")));panel.update(fixture());show(panel,group);View root=((UiSheet)field(panel,"sheet")).shell;assertNotNull(label(root,"允许本次使用模型"));assertNull(optional(root,"继续这件事"));panel.close();a.finish();
    }
    @Test public void newGroupResultKeepsReadingPositionAndOffersJumpToLatest()throws Exception{
        ConnectionService.current=null;Activity a=Robolectric.buildActivity(Activity.class).setup().get();a.setTheme(R.style.AppTheme);GroupPanel panel=new GroupPanel(a);JSONObject group=group();JSONArray messages=group.getJSONArray("messages");
        for(int n=0;n<30;n++)messages.put(object("id","history-"+n,"kind","assistant","roleId","r1","content","核算记录 "+n+"：本条用于检查长群聊的阅读位置。","createdAt","2026-11-04T13:00:00Z"));
        group.put("tasks",new JSONArray());panel.update(fixture());show(panel,group);UiSheet sheet=(UiSheet)field(panel,"sheet");View root=sheet.shell;((ViewGroup)root.getParent()).removeView(root);FrameLayout frame=new FrameLayout(a);frame.addView(root,new FrameLayout.LayoutParams(390,740));capture(frame,"f2-group-long-history",390,740);
        EditText input=(EditText)field(panel,"composer");input.setText("这段草稿不要丢");sheet.scroll.scrollTo(0,0);
        messages.put(object("id","latest-result","kind","assistant","roleId","r2","content","最终核算：411 件，25 箱余 11 件。","createdAt","2026-11-04T13:01:00Z"));invoke(panel,"drawDetail",new Class[]{});
        Button jump=(Button)field(panel,"newMessages");assertEquals(View.VISIBLE,jump.getVisibility());assertEquals("1 条新消息 ↓",jump.getText().toString());assertEquals(0,sheet.scroll.getScrollY());assertEquals("这段草稿不要丢",input.getText().toString());
        capture(frame,"f3-group-new-result",390,740);jump.performClick();assertEquals(View.GONE,jump.getVisibility());assertEquals("这段草稿不要丢",input.getText().toString());panel.close();a.finish();
    }

}
