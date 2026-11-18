package dev.boujoy.personalagent;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import static org.junit.Assert.*;

/** Native pixels prove that list edges expose the page, without painting a white haze. */
@RunWith(org.robolectric.RobolectricTestRunner.class)
@Config(sdk=35,qualifiers="w390dp-h844dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class AssistantListFadeVisualTest {
    private ActivityController<Activity> controller;
    private Activity activity(){
        controller=Robolectric.buildActivity(Activity.class).setup();
        Activity activity=controller.get();activity.setTheme(R.style.AppTheme);return activity;
    }
    private void attach(Activity activity,View view,int width,int height){
        FrameLayout host=new FrameLayout(activity);activity.setContentView(host);
        host.addView(view,new FrameLayout.LayoutParams(width,height));
    }
    @After public void close(){if(controller!=null)controller.pause().stop().destroy();}
    @Test public void assistantListHasNaturalEdgesAtTopMiddleAndEnd()throws Exception{
        Activity activity=activity();AssistantPanel panel=new AssistantPanel(activity,new AssistantPanel.Navigation(){
            public void openRole(String id){}public void openTask(String id){}public void settings(){}
        });
        JSONObject snapshot=NativeVisualTest.fixture();JSONArray roles=snapshot.getJSONObject("state").getJSONArray("roles");
        String[] names={"旅行助理","阅读伙伴","学习教练","家居管家","写作助理","音乐伙伴","小机器人","日程助理"};
        for(int i=0;i<names.length;i++)roles.put(Tunnel.json("id","fade-preview-"+i,"name",names[i],"botColor",BotAvatar.COLORS[i%BotAvatar.COLORS.length],"description","随时可以开始新对话","state","idle"));
        panel.update(snapshot);attach(activity,panel.root,390,844);
        Drawable pageBackground=panel.root.getBackground();
        LinearLayout rows=(LinearLayout)NativeVisualTest.field(panel,"rows");ScrollView list=(ScrollView)rows.getParent();
        NativeVisualTest.capture(panel.root,"assistant-fade-01-top",390,844);
        assertFalse(list.isVerticalScrollBarEnabled());assertFalse(list.isHorizontalScrollBarEnabled());
        assertTrue(list.canScrollVertically(1));
        int range=rows.getBottom()+list.getPaddingBottom()-list.getHeight();
        list.scrollTo(0,range/2);
        NativeVisualTest.capture(panel.root,"assistant-fade-02-middle",390,844);
        assertTrue(list.canScrollVertically(-1));assertTrue(list.canScrollVertically(1));
        list.scrollTo(0,range);
        NativeVisualTest.capture(panel.root,"assistant-fade-03-end",390,844);
        assertTrue(list.canScrollVertically(-1));assertFalse(list.canScrollVertically(1));
        assertSame("The original page gradient remains behind the transparent list",pageBackground,panel.root.getBackground());
        panel.close();
    }
    @Test public void alphaMaskIsSmoothTransparentAndNeverWhitensRows()throws Exception{
        Activity activity=activity();AssistantPanel.FadingList list=new AssistantPanel.FadingList(activity);
        View content=new View(activity);content.setBackgroundColor(Color.BLACK);
        // ScrollView measures its child with an unspecified height. A bare View
        // needs an intrinsic minimum; LayoutParams.height alone measures to zero.
        content.setMinimumHeight(1000);
        list.addView(content,new ScrollView.LayoutParams(160,1000));
        FrameLayout scene=new FrameLayout(activity);scene.addView(list,new FrameLayout.LayoutParams(160,240));attach(activity,scene,160,240);
        NativeVisualTest.capture(scene,"assistant-fade-04-mask-layout",160,240);
        assertEquals("The mask fixture must contain drawable overflowing content",1000,content.getHeight());
        assertTrue("The alpha test must exercise a scrolling viewport",list.canScrollVertically(1));
        list.scrollTo(0,200);
        assertEquals(200,list.getScrollY());
        Bitmap mask=NativeVisualTest.capture(scene,"assistant-fade-05-alpha-mask",160,240);
        assertTrue("Clipped content disappears into the page at the top edge",Color.alpha(mask.getPixel(80,0))<8);
        assertTrue("Clipped content disappears into the page at the bottom edge",Color.alpha(mask.getPixel(80,239))<8);
        int previous=0;
        for(int y=0;y<60;y++){
            int pixel=mask.getPixel(80,y),alpha=Color.alpha(pixel);
            assertTrue("Top alpha increases smoothly at y="+y,alpha>=previous);
            assertTrue("No abrupt alpha step at y="+y,alpha-previous<=12);
            if(alpha>0)assertEquals("The fade must not paint white over content",0,pixel&0x00ffffff);
            assertTrue("Both edges have the same smoothness",Math.abs(alpha-Color.alpha(mask.getPixel(80,239-y)))<=2);
            previous=alpha;
        }
        assertEquals("The readable middle retains full opacity",255,Color.alpha(mask.getPixel(80,60)));
        assertTrue("The transition extends beyond the old short white band",Color.alpha(mask.getPixel(80,32))<240);
        list.scrollTo(0,0);
        Bitmap top=NativeVisualTest.capture(scene,"assistant-fade-06-alpha-top",160,240);
        assertEquals("At the start the first row stays clear",255,Color.alpha(top.getPixel(80,0)));
        list.scrollTo(0,1);
        Bitmap firstPixel=NativeVisualTest.capture(scene,"assistant-fade-07-alpha-near-top",160,240);
        assertEquals("A one-pixel scroll does not dim a whole row",255,Color.alpha(firstPixel.getPixel(80,4)));
        list.scrollTo(0,760);
        Bitmap end=NativeVisualTest.capture(scene,"assistant-fade-08-alpha-end",160,240);
        assertEquals("At the end the last row stays clear",255,Color.alpha(end.getPixel(80,239)));
    }
    @Test public void listThatFitsKeepsEveryRowFullyVisible()throws Exception{
        Activity activity=activity();AssistantPanel.FadingList list=new AssistantPanel.FadingList(activity);
        View content=new View(activity);content.setBackgroundColor(0xff0f6151);
        list.setFillViewport(true);list.addView(content,new ScrollView.LayoutParams(160,120));
        FrameLayout scene=new FrameLayout(activity);scene.addView(list,new FrameLayout.LayoutParams(160,240));attach(activity,scene,160,240);
        Bitmap image=NativeVisualTest.capture(scene,"assistant-fade-09-no-overflow",160,240);
        assertFalse(list.canScrollVertically(-1));assertFalse(list.canScrollVertically(1));
        assertEquals(0xff0f6151,image.getPixel(80,0));assertEquals(0xff0f6151,image.getPixel(80,239));
    }
}
