package dev.boujoy.personalagent;

import android.app.*;
import android.view.*;
import android.widget.*;
import android.graphics.Rect;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import java.util.*;
import static org.junit.Assert.*;
import static dev.boujoy.personalagent.NativeVisualTest.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,qualifiers="w390dp-h844dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class NativeLayoutAuditTest {
    static List<View> descendants(View root){List<View> out=new ArrayList<>();out.add(root);if(root instanceof ViewGroup group)for(int n=0;n<group.getChildCount();n++)out.addAll(descendants(group.getChildAt(n)));return out;}
    static View label(View root,String value){return descendants(root).stream().filter(v->value.contentEquals(v.getContentDescription()==null?"":v.getContentDescription())||v instanceof TextView text&&value.contentEquals(text.getText())).findFirst().orElseThrow();}
    static Rect bounds(View root,View view){int x=0,y=0;View current=view;while(current!=root){x+=current.getLeft();y+=current.getTop();View parent=(View)current.getParent();x-=parent.getScrollX();y-=parent.getScrollY();current=parent;}return new Rect(x,y,x+view.getWidth(),y+view.getHeight());}
    static void withinWidth(View root){for(View view:descendants(root)){if(!view.isShown()||view.getWidth()==0)continue;Rect rect=bounds(root,view);assertTrue(view.getClass().getSimpleName()+" "+view.getContentDescription()+" "+rect+" exceeds "+root.getWidth(),rect.left>=0&&rect.right<=root.getWidth());}}
    static FrameLayout profile(AssistantPanel panel,String id,int width,int height)throws Exception{panel.showProfile(id);Dialog d=(Dialog)field(panel,"profile");ViewGroup content=d.findViewById(android.R.id.content);View sheet=content.getChildAt(0);content.removeView(sheet);FrameLayout backdrop=new FrameLayout(panel.root.getContext());backdrop.setBackgroundColor(0xffdcdbe0);backdrop.addView(sheet,new FrameLayout.LayoutParams(width,Math.min(height,d.getWindow().getAttributes().height),Gravity.BOTTOM));return backdrop;}
    @Test public void narrowLargeTextProfileKeepsPaletteAndActionsInsideScreen()throws Exception{
        RuntimeEnvironment.setQualifiers("w320dp-h640dp-mdpi");RuntimeEnvironment.setFontScale(1.3f);AssistantPanel p=panel();JSONObject data=fixture();JSONObject shop=data.getJSONObject("state").getJSONArray("roles").getJSONObject(4);shop.put("name","采购和日常生活用品比价助理");shop.put("description","帮我核对品牌、规格、运费和售后政策，超过预算先问我。".repeat(3));p.update(data);
        FrameLayout root=profile(p,"shop",320,640);capture(root,"audit-profile-narrow-large",320,640);withinWidth(root);for(String color:BotAvatar.LABELS)assertTrue("Palette target remains visible "+color,label(root,color).getWidth()>=30);
        for(String name:new String[]{"编辑助理","复制助理","现在出一份简报"}){TextView b=(TextView)label(root,name);Rect rect=bounds(root,b);assertTrue("Footer action fully visible "+name,rect.top>=0&&rect.bottom<=root.getHeight());assertTrue("Footer label fits "+name,b.getLayout().getHeight()<=b.getHeight()-b.getPaddingTop()-b.getPaddingBottom());}
        ScrollView scroll=(ScrollView)descendants(root).stream().filter(v->v instanceof ScrollView).findFirst().orElseThrow();scroll.setSmoothScrollingEnabled(false);scroll.fullScroll(View.FOCUS_DOWN);capture(root,"audit-profile-scrolled",320,640);Rect note=bounds(root,label(root,"快递送公司，周末送家里"));Rect viewport=bounds(root,scroll);assertTrue("Last note remains reachable above footer",note.top>=viewport.top&&note.bottom<=viewport.bottom);
    }
    @Test public void keyboardHeightLongDraftAndAttachmentRemainReachable()throws Exception{
        RuntimeEnvironment.setQualifiers("w320dp-h420dp-mdpi");RuntimeEnvironment.setFontScale(1.3f);MainActivity a=main(fixture(),"coach","");EditText composer=(EditText)field(a,"composer");composer.setText("这是一段尚未发送、需要保留的多行草稿。\n".repeat(5));ChatComposerState chat=(ChatComposerState)field(a,"chat");chat.setAttachments(new JSONArray().put(object("name","本月需要核对的日用品规格与价格清单.pdf")));invoke(a,"syncComposer",new Class[]{});View root=(View)field(a,"chatRoot");capture(root,"audit-keyboard-height",320,420);withinWidth(root);
        ScrollView scroller=(ScrollView)field(a,"chatScroll");scroller.setSmoothScrollingEnabled(false);scroller.fullScroll(View.FOCUS_DOWN);capture(root,"audit-keyboard-scrolled",320,420);View send=(View)field(a,"send");Rect visible=bounds(root,send);assertTrue("Send reachable after scrolling: "+visible,visible.top>=0&&visible.bottom<=root.getHeight());assertEquals(composer.getText().toString(),chat.text());a.finish();
    }
    @Test public void searchCanBeClearedAndOfflineConnectionRemainsAccessible()throws Exception{
        AssistantPanel p=panel();label(p.root,"搜索助理或对话").performClick();EditText search=(EditText)field(p,"search");search.setText("采购");capture(p.root,"audit-search",390,844);assertEquals(1,((LinearLayout)field(p,"rows")).getChildCount());label(p.root,"搜索助理或对话").performClick();assertEquals("Closing search must clear the hidden filter",6,((LinearLayout)field(p,"rows")).getChildCount());
        JSONObject data=fixture().put("online",false).put("status","电脑离线，请检查连接");p.update(data);View status=(View)field(p,"status");assertTrue("Offline list must offer connection settings",status.isClickable());capture(p.root,"audit-offline",390,844);withinWidth(p.root);
    }
    @Test public void confirmationButtonsAndUserBubbleFitAtLargeFont()throws Exception{
        RuntimeEnvironment.setQualifiers("w320dp-h640dp-mdpi");RuntimeEnvironment.setFontScale(2f);JSONObject data=fixture();String id="22222222-2222-4222-8222-222222222222";JSONObject task=object("id",id,"conversationId",id,"roleId","concierge","title","页面检查","status","waiting_approval","updatedAt","2026-11-02T00:00:00Z","messages",new JSONArray().put(object("id","u","role","user","content","帮我检查这条尚未发送的长消息是否显示完整")),"approvals",new JSONArray().put(object("id","audit-only","status","pending","summary","只检查确认卡片的显示，不执行发送")));
        data.getJSONObject("state").put("tasks",new JSONArray().put(task));data.put("taskDetails",object(id,object("detail",task)));MainActivity a=main(data,"concierge",id);View root=(View)field(a,"chatRoot");capture(root,"audit-confirmation-large",320,640);withinWidth(root);for(String name:new String[]{"允许这次操作","拒绝"}){TextView button=(TextView)label(root,name);assertTrue("Approval label fits "+name,button.getLayout().getHeight()<=button.getHeight()-button.getPaddingTop()-button.getPaddingBottom());}TextView detail=(TextView)descendants(root).stream().filter(v->v instanceof TextView text&&"查看这一步的具体内容".contentEquals(text.getText())).findFirst().orElseThrow();assertTrue("Multiline detail link must not be clipped",detail.getLayout().getHeight()<=detail.getHeight()-detail.getPaddingTop()-detail.getPaddingBottom());View user=label(root,"帮我检查这条尚未发送的长消息是否显示完整");assertTrue(user.getWidth()<=Math.round((320-36)*.8f)+user.getPaddingLeft()+user.getPaddingRight());ScrollView scroll=(ScrollView)field(a,"chatScroll");scroll.setSmoothScrollingEnabled(false);scroll.fullScroll(View.FOCUS_DOWN);capture(root,"audit-confirmation-scrolled",320,640);Rect viewport=bounds(root,scroll);for(String name:new String[]{"允许这次操作","拒绝"}){Rect button=bounds(root,label(root,name));assertTrue("Approval is reachable "+name,button.top>=viewport.top&&button.bottom<=viewport.bottom);}a.finish();
    }
    @Test public void assistantSwitchPreservesDraftAndUnfoldedLayoutKeepsContentReadable()throws Exception{
        RuntimeEnvironment.setQualifiers("w768dp-h900dp-mdpi");MainActivity a=main(fixture(),"coach","");EditText edit=(EditText)field(a,"composer");edit.setText("保留这份草稿");invoke(a,"selectRole",new Class[]{String.class},"shop");assertEquals("",edit.getText().toString());invoke(a,"selectRole",new Class[]{String.class},"coach");assertEquals("保留这份草稿",edit.getText().toString());ViewGroup stage=(ViewGroup)a.findViewById(android.R.id.content);capture(stage,"audit-unfolded",768,900);assertTrue(((View)field(a,"chatRoot")).getWidth()<=680);withinWidth(stage);a.finish();
    }
}
