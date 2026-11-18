package dev.boujoy.personalagent;

import android.app.*;
import android.graphics.*;
import android.os.Looper;
import android.view.*;
import android.widget.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import java.io.*;
import java.lang.reflect.*;
import static org.junit.Assert.*;

/** Local rendering fixtures, never connected to a phone or production service. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,qualifiers="w390dp-h844dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class NativeVisualTest {
    static JSONObject object(Object... values){return Tunnel.json(values);}
    static Object field(Object owner,String name)throws Exception{Field field=owner.getClass().getDeclaredField(name);field.setAccessible(true);return field.get(owner);}
    static void invoke(Object owner,String name,Class<?>[] types,Object... values)throws Exception{Method method=owner.getClass().getDeclaredMethod(name,types);method.setAccessible(true);method.invoke(owner,values);}
    static JSONObject fixture(){
        JSONArray roles=new JSONArray();String[] ids={"concierge","bok","robot","robot2","shop","coach"},names={"boujoy","bok","小机器人","小机器人2号","采购助理小买","健身教练"},colors={"violet","amber","pink","silver","green","teal"};
        for(int i=0;i<ids.length;i++)roles.put(object("id",ids[i],"name",names[i],"botColor",colors[i],"description",i==4?"帮我比价和买日用品，超过 100 元先问我":"你的私人助理","state",i==0?"busy":i==1?"waiting":"idle","running",new JSONArray().put(object("title","瑞幸点单")),"waiting",new JSONArray().put(object("title","替换旧版日程表")),"watchCount",i==4?1:0,"routineCount",i>=4?1:0,"notes",new JSONArray(),"watches",new JSONArray(),"lastActivity",object("title",new String[]{"瑞幸点单","替换旧版日程表","Codex 跑完了，3 个测试没过","空闲","08:30 简报已送到","今晚 22:00 提醒你喝水"}[i])));
        JSONObject shop=roles.optJSONObject(4);try{shop.put("brief",object("enabled",true,"time","08:30"));shop.put("watches",new JSONArray().put(object("goal","维达纸巾低于 ¥30","status","active","lastSummary","最近 ¥32.9")));shop.put("notes",new JSONArray().put(object("id","1","text","买纸巾只买维达")).put(object("id","2","text","日用品预算一般 50 元以内")).put(object("id","3","text","快递送公司，周末送家里")));}catch(JSONException e){throw new AssertionError(e);}
        return object("paired",true,"online",true,"status","电脑已连接","state",object("roles",roles,"tasks",new JSONArray()));
    }
    static void settleDrawables(View view){view.jumpDrawablesToCurrentState();if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++)settleDrawables(group.getChildAt(i));}
    static CheckBox findCheckBox(View view){if(view instanceof CheckBox check)return check;if(view instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++){CheckBox check=findCheckBox(group.getChildAt(i));if(check!=null)return check;}return null;}
    static Bitmap capture(View view,String name,int width,int height)throws Exception{
        for(int i=0;i<2;i++){view.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(height,View.MeasureSpec.EXACTLY));view.layout(0,0,width,height);Shadows.shadowOf(Looper.getMainLooper()).idle();}
        settleDrawables(view);
        Bitmap image=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);view.draw(new Canvas(image));
        File dir=new File(System.getProperty("boujoy.visual.output"));assertTrue(dir.isDirectory()||dir.mkdirs());try(FileOutputStream out=new FileOutputStream(new File(dir,name+".png"))){assertTrue(image.compress(Bitmap.CompressFormat.PNG,100,out));}return image;
    }
    static AssistantPanel panel(){Activity a=Robolectric.buildActivity(Activity.class).setup().get();a.setTheme(R.style.AppTheme);AssistantPanel panel=new AssistantPanel(a,new AssistantPanel.Navigation(){public void openRole(String id){}public void openTask(String id){}public void settings(){}});a.setContentView(panel.root);panel.update(fixture());return panel;}
    static MainActivity main(JSONObject snapshot,String role,String conversation)throws Exception{
        ConnectionService.current=null;MainActivity a=Robolectric.buildActivity(MainActivity.class).create().get();ChatComposerState chat=(ChatComposerState)field(a,"chat");chat.selectRole(role);if(!conversation.isBlank())chat.selectConversation(conversation);
        invoke(a,"showAssistantList",new Class[]{boolean.class},false);invoke(a,"renderSnapshot",new Class[]{JSONObject.class,ConnectionService.class},snapshot,null);return a;
    }
    @Test public void listAndProfileMatchTheReferenceStructure()throws Exception{
        AssistantPanel panel=panel();capture(panel.root,"01-assistants",390,844);
        LinearLayout rows=(LinearLayout)field(panel,"rows");assertEquals(6,rows.getChildCount());assertTrue(rows.getChildAt(0).getHeight()>=70&&rows.getChildAt(0).getHeight()<=74);
        panel.showProfile("shop");Dialog dialog=(Dialog)field(panel,"profile");ViewGroup content=dialog.findViewById(android.R.id.content);View sheet=content.getChildAt(0);CheckBox daily=findCheckBox(sheet);assertNotNull(daily);assertTrue("Enabled brief must remain checked",daily.isChecked());content.removeView(sheet);FrameLayout backdrop=new FrameLayout(panel.root.getContext());backdrop.setBackgroundColor(0xffdcdbe0);backdrop.addView(sheet,new FrameLayout.LayoutParams(390,dialog.getWindow().getAttributes().height,Gravity.BOTTOM));capture(backdrop,"04-profile",390,844);dialog.dismiss();
    }
    @Test public void overflowingAssistantListRendersTopMiddleAndEnd()throws Exception{
        JSONObject snapshot=fixture();JSONArray roles=snapshot.getJSONObject("state").getJSONArray("roles");
        String[] names={"旅行助理","阅读伙伴","学习教练","家居管家","写作助理","音乐伙伴","Bot666","日程助理"};
        for(int i=0;i<names.length;i++)roles.put(object("id","preview-bot-"+i,"name",names[i],"botColor",BotAvatar.COLORS[i%BotAvatar.COLORS.length],"description","随时可以开始新对话","state","idle","running",new JSONArray(),"waiting",new JSONArray(),"notes",new JSONArray(),"watches",new JSONArray()));
        AssistantPanel panel=panel();panel.update(snapshot);LinearLayout rows=(LinearLayout)field(panel,"rows");ScrollView scroll=(ScrollView)rows.getParent();
        capture(panel.root,"01-assistants-scroll-top",390,844);assertTrue("The fixture overflows the list viewport",scroll.canScrollVertically(1));
        int range=rows.getHeight()-scroll.getHeight()+scroll.getPaddingTop()+scroll.getPaddingBottom();scroll.scrollTo(0,range/2);
        capture(panel.root,"01-assistants-scroll-middle",390,844);assertTrue(scroll.canScrollVertically(-1)&&scroll.canScrollVertically(1));
        scroll.scrollTo(0,range);capture(panel.root,"01-assistants-scroll-end",390,844);assertTrue(scroll.canScrollVertically(-1));assertFalse(scroll.canScrollVertically(1));
        panel.close();
    }
    @Test public void emptyConversationKeepsTheNormalBottomComposerAndNoWelcomeRows()throws Exception{
        JSONObject snapshot=fixture();snapshot.getJSONObject("state").getJSONArray("roles").put(object("id","bot666","name","Bot666","botColor","violet","description","新助理","state","idle","running",new JSONArray(),"waiting",new JSONArray(),"watchCount",0,"routineCount",0,"notes",new JSONArray(),"watches",new JSONArray()));
        String before=snapshot.toString();MainActivity a=main(snapshot,"bot666","");
        ViewGroup root=(ViewGroup)field(a,"chatRoot"),feed=(ViewGroup)field(a,"feed");View dock=(View)field(a,"composeDock");EditText composer=(EditText)field(a,"composer");ChatComposerState chat=(ChatComposerState)field(a,"chat");
        capture(root,"03-empty-bottom-composer",390,844);
        assertSame("An empty chat uses the normal fixed composer",root,dock.getParent());
        assertEquals("The composer stays at the bottom of the chat",root.getHeight(),dock.getBottom());
        assertEquals("No hero or fabricated welcome message is inserted",0,feed.getChildCount());
        assertEquals("Bot666",((TextView)field(a,"threadTitle")).getText().toString());
        assertEquals("bot666",chat.roleId());assertEquals("",chat.conversationId());assertEquals(1,composer.getMinLines());
        composer.setText("保留这份未发送草稿\n和第二行内容");chat.setAttachments(new JSONArray().put(object("name","待发送的附件.pdf")));invoke(a,"syncComposer",new Class[]{});
        String draft=chat.text(),attachments=chat.attachments().toString();
        invoke(a,"renderSnapshot",new Class[]{JSONObject.class,ConnectionService.class},snapshot,null);
        capture(root,"03-empty-bottom-composer-keyboard",368,420);
        assertSame(root,dock.getParent());assertSame(composer,field(a,"composer"));assertEquals(root.getHeight(),dock.getBottom());
        assertTrue(dock.getWidth()<=368);assertTrue("Composer remains visible above the keyboard",dock.getTop()>=0);
        Rect sendBounds=new Rect();View send=(View)field(a,"send");send.getDrawingRect(sendBounds);root.offsetDescendantRectToMyCoords(send,sendBounds);
        assertTrue("Send remains inside the resized chat",sendBounds.top>=0&&sendBounds.bottom<=root.getHeight());
        assertEquals(draft,composer.getText().toString());assertEquals(attachments,chat.attachments().toString());assertEquals("bot666",chat.roleId());assertEquals("",chat.conversationId());
        assertEquals(0,feed.getChildCount());assertEquals(before,snapshot.toString());a.finish();
    }
    @Test public void conversationAndApprovalRenderWithoutChangingDraftOrTaskState()throws Exception{
        String id="11111111-1111-4111-8111-111111111111";JSONObject snapshot=fixture();JSONObject task=object("id",id,"conversationId",id,"roleId","concierge","title","瑞幸点单","status","ready_for_user","result","","updatedAt","2026-11-02T00:00:00Z","messages",new JSONArray().put(object("id","u","role","user","content","瑞幸帮我点杯生椰拿铁，大杯，送公司")).put(object("id","a","role","assistant","content","好的，按你上次的习惯：大杯、少冰、不加糖，用美团下单送到公司。\n\n已到确认订单页：生椰拿铁 大杯 ×1，**实付 ¥15.9**。付款请你在手机上确认。")));
        snapshot.getJSONObject("state").put("tasks",new JSONArray().put(task));snapshot.put("taskDetails",object(id,object("detail",task)));
        MainActivity a=main(snapshot,"concierge",id);View root=(View)field(a,"chatRoot");capture(root,"02-chat",390,844);
        task.put("status","waiting_approval").put("messages",new JSONArray().put(object("id","u","role","user","content","把本周日程表保存到旧版文件的位置")).put(object("id","a","role","assistant","content","新版日程表已经准备好，确认后会覆盖旧版。\n\n**目标文件**：本周日程表。"))).put("approvals",new JSONArray().put(object("id","preview-approval","status","pending","tool","document_create","summary","用本周日程表替换旧版文件","fingerprint","preview-only","expiresAt",System.currentTimeMillis()+180000)));
        String before=snapshot.toString();invoke(a,"renderSnapshot",new Class[]{JSONObject.class,ConnectionService.class},snapshot,null);capture(root,"02-confirmation",390,844);assertEquals(before,snapshot.toString());assertSame(root,((View)field(a,"composeDock")).getParent());a.finish();
    }
    @Test public void robotShellIsOpaqueInsteadOfInheritingShadowAlpha()throws Exception{
        Activity a=Robolectric.buildActivity(Activity.class).setup().get();BotAvatar bot=new BotAvatar(a,"green");Bitmap image=capture(bot,"robot",136,136);int body=image.getPixel(30,80);assertTrue(Color.alpha(body)>240);assertTrue(Color.red(body)<100);
    }
}
