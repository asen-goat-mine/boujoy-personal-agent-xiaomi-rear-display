package dev.boujoy.personalagent;

import android.app.Dialog;
import android.view.*;
import android.widget.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import static org.junit.Assert.*;
import static dev.boujoy.personalagent.NativeVisualTest.*;
import static dev.boujoy.personalagent.NativeLayoutAuditTest.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,qualifiers="w390dp-h844dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class NativeSheetVisualTest {
    static FrameLayout frame(UiSheet dialog,int width,int height){
        View shell=dialog.shell;if(shell.getParent() instanceof ViewGroup parent)parent.removeView(shell);
        shell.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(height-40,View.MeasureSpec.AT_MOST));
        FrameLayout backdrop=new FrameLayout(shell.getContext());backdrop.setBackgroundColor(0xffdedde2);backdrop.addView(shell,new FrameLayout.LayoutParams(width,shell.getMeasuredHeight(),Gravity.BOTTOM));return backdrop;
    }
    static void click(View root,String caption){View v=label(root,caption);while(!v.isClickable())v=(View)v.getParent();v.performClick();}
    static boolean locallyVisible(View root,View view){for(View v=view;;v=(View)v.getParent()){if(v.getVisibility()!=View.VISIBLE)return false;if(v==root)return true;if(!(v.getParent() instanceof View))return false;}}
    static void readableControls(View root){for(View v:descendants(root))if(locallyVisible(root,v)&&v instanceof Button b){assertTrue("Button touch height "+b.getText(),b.getHeight()>=44);assertTrue("Button label clipped "+b.getText(),b.getLayout().getHeight()<=b.getHeight()-b.getPaddingTop()-b.getPaddingBottom());}}
    @Test public void connectionSheetGroupsSettingsAndExpandsConfigurationWithoutChangingState()throws Exception{
        JSONObject data=fixture().put("online",false).put("status","电脑暂不可用").put("error","电脑暂不可用");String before=data.toString();MainActivity a=main(data,"concierge","");
        assertFalse("No duplicate offline caption in conversation",ChatPresenter.present(data,"","").rows().stream().anyMatch(row->row.key().equals("error")));
        capture((View)field(a,"chatRoot"),"03-empty-offline-clean",390,844);
        invoke(a,"showConnection",new Class[]{String.class,JSONObject.class},"",data);UiSheet dialog=(UiSheet)field(a,"connectionDialog");FrameLayout root=frame(dialog,390,844);capture(root,"06-connection",390,844);readableControls(root);
        assertFalse(locallyVisible(root,label(root,"电脑连接码")));assertNotNull(label(root,"连接已保存，电脑恢复可用后会自动重连。"));click(root,"重新配置连接");
        root=frame(dialog,390,500);capture(root,"06-connection-code-keyboard",390,500);assertTrue(locallyVisible(root,label(root,"电脑连接码")));readableControls(root);assertEquals(before,data.toString());dialog.dismiss();
        JSONObject unpaired=new JSONObject(data.toString()).put("paired",false);invoke(a,"showConnection",new Class[]{String.class,JSONObject.class},"",unpaired);dialog=(UiSheet)field(a,"connectionDialog");root=frame(dialog,390,844);capture(root,"06-first-connection",390,844);readableControls(root);assertTrue(locallyVisible(root,label(root,"电脑连接码")));dialog.dismiss();a.finish();
    }
    @Test public void assistantFormsKeepSaveVisibleWhenKeyboardReducesHeight()throws Exception{
        AssistantPanel panel=panel();panel.edit(null);UiSheet editor=(UiSheet)field(panel,"editor");FrameLayout root=frame(editor,390,844);capture(root,"07-new-assistant",390,844);readableControls(root);
        for(String name:new String[]{"助理名称","负责什么","工作方式和要求"})assertTrue(descendants(root).stream().anyMatch(v->v instanceof EditText&&name.contentEquals(v.getContentDescription())));
        root=frame(editor,390,440);capture(root,"07-new-assistant-keyboard",390,440);readableControls(root);android.graphics.Rect save=bounds(root,label(root,"保存"));assertTrue(save.bottom<=440);assertTrue(save.top>=0);editor.dismiss();
        panel.edit(panel.role("shop"));editor=(UiSheet)field(panel,"editor");root=frame(editor,390,844);capture(root,"07-edit-assistant",390,844);readableControls(root);editor.dismiss();
    }
    @Test public void taskDetailsAndMenusRemainReadableOnNarrowLargeTextScreens()throws Exception{
        RuntimeEnvironment.setQualifiers("w320dp-h640dp-mdpi");RuntimeEnvironment.setFontScale(1.3f);MainActivity a=main(fixture(),"concierge","");invoke(a,"showChatMenu",new Class[]{});UiSheet menu=(UiSheet)field(a,"menuDialog");FrameLayout root=frame(menu,320,640);capture(root,"08-chat-menu",320,640);readableControls(root);menu.dismiss();
        JSONObject detail=object("id","sheet-preview","title","处理过程","status","waiting_approval","result","消息已准备好，请先核对。","approvals",new JSONArray().put(object("id","preview","status","pending","summary","仅用于页面检查，不发送任何消息。")),"messages",new JSONArray());
        invoke(a,"renderTaskDetails",new Class[]{String.class,JSONObject.class},"sheet-preview",detail);UiSheet task=(UiSheet)field(a,"taskDialog");root=frame(task,320,640);capture(root,"09-task-details",320,640);readableControls(root);task.dismiss();a.finish();
    }
    @Test public void reasoningOptionsShowAllLevelsAndCurrentSelection()throws Exception{
        MainActivity a=main(fixture(),"concierge","");JSONArray options=new JSONArray();
        String[] values={"auto","off","low","high","max"},names={"自动","关闭思考","少量思考","深入思考","最大思考"};
        for(int i=0;i<values.length;i++)options.put(object("value",values[i],"label",names[i],"description","与电脑同步，下次任务生效"));
        invoke(a,"showReasoningOptions",new Class[]{JSONObject.class,ConnectionService.class},object("modelReasoning","max","options",options),null);
        UiSheet dialog=(UiSheet)field(a,"menuDialog");FrameLayout root=frame(dialog,390,844);capture(root,"10-reasoning-options",390,844);readableControls(root);
        for(String name:names)assertTrue(descendants(root).stream().anyMatch(v->v instanceof TextView t&&t.getText().toString().contains(name)));
        assertTrue(descendants(root).stream().anyMatch(v->v instanceof TextView t&&t.getText().toString().startsWith("✓ 最大思考")));
        dialog.dismiss();a.finish();
    }
}
