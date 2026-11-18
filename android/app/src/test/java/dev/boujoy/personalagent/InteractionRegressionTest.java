package dev.boujoy.personalagent;

import android.app.Activity;
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
import java.util.*;
import static dev.boujoy.personalagent.NativeVisualTest.*;
import static dev.boujoy.personalagent.NativeLayoutAuditTest.label;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,qualifiers="w390dp-h844dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class InteractionRegressionTest {
    @Test public void exactApprovalCannotBeSubmittedAgainUntilFailureOrContentChange(){
        ApprovalRequests requests=new ApprovalRequests();assertTrue(requests.begin("a","one"));assertFalse(requests.begin("a","one"));
        requests.finish("a","one",true);assertFalse(requests.begin("a","one"));assertTrue(requests.begin("a","two"));
        requests.finish("a","one",true);assertEquals("sending",requests.snapshot().optJSONObject("a").optString("status"));
        requests.finish("a","two",false);assertTrue(requests.begin("a","two"));
    }
    @Test public void oldMacImageIsPreviewableButSourceDocumentsRemainMaterials()throws Exception{
        JSONObject task=object("id","77777777-7777-4777-8777-777777777777","status","completed","result","图片在 文稿/Boujoy/result.png","messages",new JSONArray(),"artifacts",new JSONArray()
            .put(object("id","image","name","result.PNG","mime","application/octet-stream","kind","input","imported",true))
            .put(object("id","doc","name","source.txt","mime","text/plain","kind","input","imported",true)));
        JSONObject snapshot=fixture();snapshot.getJSONObject("state").put("tasks",new JSONArray().put(task));snapshot.put("taskDetails",object("77777777-7777-4777-8777-777777777777",object("detail",task)));
        var rows=ChatPresenter.present(snapshot,"77777777-7777-4777-8777-777777777777","").rows();assertTrue(rows.stream().anyMatch(r->r.kind()==ChatPresenter.Kind.ATTACHMENT&&r.text().contains("result.PNG")));
        assertTrue(rows.stream().anyMatch(r->r.kind()==ChatPresenter.Kind.MATERIALS&&r.text().contains("source.txt")&&!r.text().contains("result.PNG")));
        MainActivity a=main(snapshot,"concierge","77777777-7777-4777-8777-777777777777");View root=(View)field(a,"chatRoot");assertNotNull(label(root,"预览"));capture(root,"ux-image-entry",390,844);
        invoke(a,"previewArtifact",new Class[]{JSONObject.class},task.getJSONArray("artifacts").getJSONObject(0));Shadows.shadowOf(Looper.getMainLooper()).idle();
        android.app.Dialog preview=(android.app.Dialog)field(a,"mediaPreview");assertTrue(preview.isShowing());assertNotNull(label(preview.getWindow().getDecorView(),"重新加载"));preview.dismiss();a.finish();
    }
    @Test public void submittedApprovalStaysDisabledAcrossRefreshAndDetailsHaveDirectActions()throws Exception{
        JSONObject approval=object("id","a","fingerprint","fp","status","pending","summary","保存测试图片","expiresAt",System.currentTimeMillis()+180000);
        JSONObject task=object("id","77777777-7777-4777-8777-777777777777","status","waiting_approval","approvals",new JSONArray().put(approval),"messages",new JSONArray());JSONObject snapshot=fixture();snapshot.getJSONObject("state").put("tasks",new JSONArray().put(task));
        snapshot.put("approvalRequests",object("a",object("fingerprint","fp","status","sending")));
        MainActivity a=main(snapshot,"concierge","77777777-7777-4777-8777-777777777777");View root=(View)field(a,"chatRoot");assertFalse(label(root,"允许这次操作").isEnabled());assertFalse(label(root,"拒绝").isEnabled());assertNotNull(label(root,"正在提交，请稍候…"));
        invoke(a,"renderTaskDetails",new Class[]{String.class,JSONObject.class},"77777777-7777-4777-8777-777777777777",task);android.app.Dialog dialog=(android.app.Dialog)field(a,"taskDialog");assertFalse(label(dialog.getWindow().getDecorView(),"允许这次操作").isEnabled());dialog.dismiss();a.finish();
    }
    private static void layout(View v,int height){v.measure(View.MeasureSpec.makeMeasureSpec(390,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(height,View.MeasureSpec.EXACTLY));v.layout(0,0,390,height);}
    @Test public void keyboardAndNewRowsPreserveReadingPositionOrBottomAfterLayout(){
        Activity a=Robolectric.buildActivity(Activity.class).setup().get();ConversationScrollView scroll=new ConversationScrollView(a);LinearLayout feed=new LinearLayout(a);feed.setOrientation(LinearLayout.VERTICAL);scroll.addView(feed);a.setContentView(scroll);
        for(int i=0;i<20;i++){TextView row=new TextView(a);row.setText("消息 "+i);row.setTag("row"+i);feed.addView(row,new LinearLayout.LayoutParams(-1,100));}
        layout(scroll,600);assertEquals(1400,scroll.getScrollY());layout(scroll,350);assertEquals(1650,scroll.getScrollY());
        scroll.scrollTo(0,450);layout(scroll,600);assertEquals(450,scroll.getScrollY());
        scroll.preserve(false);feed.getChildAt(0).getLayoutParams().height=180;feed.requestLayout();layout(scroll,600);assertEquals(530,scroll.getScrollY());
        scroll.preserve(true);TextView added=new TextView(a);added.setTag("new");feed.addView(added,new LinearLayout.LayoutParams(-1,250));layout(scroll,350);assertEquals(feed.getHeight()-350,scroll.getScrollY());a.finish();
    }
    @Test public void imageDownloadIsSharedDecodedOffCallbackAndCached()throws Exception{
        List<ConnectionService.Outcome<File>> downloads=new ArrayList<>();ImagePreviews images=new ImagePreviews((id,callback)->downloads.add(callback));JSONObject artifact=object("id","image","sha256","hash");List<Bitmap> results=new ArrayList<>();
        images.load(artifact,(bitmap,error)->{assertNull(error);results.add(bitmap);});images.load(artifact,(bitmap,error)->{assertNull(error);results.add(bitmap);});assertEquals(1,downloads.size());
        File file=File.createTempFile("preview-test",".png");Bitmap original=Bitmap.createBitmap(2000,1000,Bitmap.Config.ARGB_8888);try(FileOutputStream out=new FileOutputStream(file)){original.compress(Bitmap.CompressFormat.PNG,100,out);}
        downloads.get(0).done(file,null);Shadows.shadowOf(Looper.getMainLooper()).idle();assertFalse(file.exists());assertEquals(2,results.size());assertSame(results.get(0),results.get(1));assertTrue(results.get(0).getWidth()<=1600);
        images.load(artifact,(bitmap,error)->results.add(bitmap));assertEquals(1,downloads.size());assertEquals(3,results.size());images.close();
    }
}
