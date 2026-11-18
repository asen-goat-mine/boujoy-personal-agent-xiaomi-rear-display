package dev.boujoy.personalagent;

import android.app.Activity;
import android.content.*;
import android.database.*;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.view.*;
import android.widget.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowContentResolver;
import java.util.*;
import static org.junit.Assert.*;
import static dev.boujoy.personalagent.NativeVisualTest.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,qualifiers="w390dp-h844dp-mdpi")
public class MobileFixesTest {
    @Test public void requestsShareLiveAdmissionButPauseStillRevokesEveryOldRequest(){
        ControlState state=new ControlState(new ControlStateTest.Memory());long first=state.admitRequest();
        assertEquals(first,state.admitRequest());assertTrue(state.permitsData(first));
        long stopped=state.pause("screen_off");assertFalse(state.permitsData(first));
        long resumed=state.admitRequest();assertTrue(resumed>stopped);assertFalse(state.permitsData(first));assertEquals(resumed,state.admitRequest());
    }
    @Test public void groupApprovalVisibleWithoutExpandingAndDeliveredFilesUseSharedHost()throws Exception{
        Activity activity=Robolectric.buildActivity(Activity.class).setup().get();activity.setTheme(R.style.AppTheme);
        GroupPanelInteractionTest.Client client=new GroupPanelInteractionTest.Client();List<String> opened=new ArrayList<>(),files=new ArrayList<>();
        client.detail.put("tasks",new JSONArray().put(object("id","approval-task","roleId","r1","status","waiting_approval")));
        client.detail.put("messages",new JSONArray().put(object("id","answer","kind","assistant","roleId","r1","content","**结果**","artifacts",new JSONArray().put(object("id","video","name","sample.webm","mime","video/webm")))));
        GroupPanel.Host host=new GroupPanel.Host(){public void showTaskDetails(String id){opened.add(id);}public View artifactView(JSONObject artifact){files.add(artifact.optString("id"));Button b=new Button(activity);b.setText("预览 sample.webm");return b;}};
        GroupPanel panel=new GroupPanel(activity,client,host);panel.update(client.state);panel.showGroup("group-one");GroupPanelInteractionTest.idle();View root=((UiSheet)field(panel,"sheet")).shell;
        NativeSheetVisualTest.click(root,"查看并处理确认");assertEquals(List.of("approval-task"),opened);assertEquals(List.of("video"),files);assertTrue(client.writes.isEmpty());panel.close();activity.finish();
    }
    @Test public void nativeMarkdownUsesTableAndCodeWithoutExecutingMarkup(){
        Activity activity=Robolectric.buildActivity(Activity.class).setup().get();
        View view=ReplyView.create(activity,"**标题**\n\n| 项目 | 值 |\n|---|---:|\n| A | 7 |\n\n```html\n<script>test</script>\n```",false);
        assertEquals(1,count(view,TableLayout.class));assertEquals(2,count(view,HorizontalScrollView.class));
        assertNotNull(NativeLayoutAuditTest.label(view,"标题\n"));assertNotNull(NativeLayoutAuditTest.label(view,"<script>test</script>"));activity.finish();
    }
    static int count(View v,Class<?> type){int result=type.isInstance(v)?1:0;if(v instanceof ViewGroup g)for(int i=0;i<g.getChildCount();i++)result+=count(g.getChildAt(i),type);return result;}
    @Test public void approvalDetailsKeepFullInstructionBeyondSummary()throws Exception{
        String prompt="先检查文件，再写入HELLO。".repeat(80);JSONObject a=object("summary","截断摘要","details",new JSONArray().put(object("label","完整任务指令","value",prompt)));
        assertTrue(ApprovalPresentation.details(a).endsWith(prompt));
    }
    public static class Provider extends ContentProvider {
        long size;boolean deleted;boolean unknown;
        public boolean onCreate(){return true;}
        public Cursor query(Uri u,String[] p,String s,String[] a,String o){MatrixCursor c=new MatrixCursor(new String[]{OpenableColumns.SIZE});c.addRow(new Object[]{unknown?null:size});return c;}
        public String getType(Uri u){return "text/plain";}public Uri insert(Uri u,ContentValues v){return u;}public int update(Uri u,ContentValues v,String s,String[] a){return 0;}
        public int delete(Uri u,String s,String[] a){deleted=true;return 1;}
    }
    @Test public void failedSaveCleansNewEmptyOrPartialTargetButNeverDeletesExistingOrUnknown(){
        Context context=RuntimeEnvironment.getApplication();Provider provider=new Provider();ShadowContentResolver.registerProviderInternal("save-test",provider);Uri uri=Uri.parse("content://save-test/new");
        boolean empty=SaveDestination.isEmpty(context.getContentResolver(),uri);assertTrue(empty);provider.size=40;
        assertTrue(SaveDestination.cleanup(context.getContentResolver(),uri,empty));assertTrue(provider.deleted);
        provider.deleted=false;assertFalse(SaveDestination.isEmpty(context.getContentResolver(),uri));assertFalse(SaveDestination.cleanup(context.getContentResolver(),uri,false));assertFalse(provider.deleted);
        provider.unknown=true;assertFalse(SaveDestination.isEmpty(context.getContentResolver(),uri));
    }
}
