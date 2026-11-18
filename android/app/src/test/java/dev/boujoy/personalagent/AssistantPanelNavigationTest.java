package dev.boujoy.personalagent;

import android.app.Activity;
import android.app.Dialog;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import java.lang.reflect.Field;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,qualifiers="w320dp-h640dp-mdpi")
public class AssistantPanelNavigationTest {
    private Button button(View root,String text){
        if(root instanceof Button value&&text.contentEquals(value.getText()))return value;
        if(root instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++){Button result=button(group.getChildAt(i),text);if(result!=null)return result;}
        return null;
    }
    private Object profile(AssistantPanel panel)throws Exception {Field field=AssistantPanel.class.getDeclaredField("profile");field.setAccessible(true);return field.get(panel);}
    @Test public void settingsButtonNavigatesToAppSettingsRatherThanOpeningAssistantProfile()throws Exception {
        Activity activity=Robolectric.buildActivity(Activity.class).setup().get();activity.setTheme(R.style.AppTheme);
        AtomicInteger settings=new AtomicInteger();
        AssistantPanel panel=new AssistantPanel(activity,new AssistantPanel.Navigation(){public void openRole(String id){}public void openTask(String id){}public void settings(){settings.incrementAndGet();}});
        activity.setContentView(panel.root);
        try{
            Button appSettings=button(panel.root,"设置");assertNotNull(appSettings);assertTrue(appSettings.performClick());
            assertEquals(1,settings.get());assertNull("Settings must not open the profile sheet",profile(panel));
            Button assistantProfile=button(panel.root,"助理资料");assertNotNull(assistantProfile);assertTrue(assistantProfile.performClick());
            assertEquals(1,settings.get());assertTrue(((Dialog)profile(panel)).isShowing());
        }finally{panel.close();activity.finish();}
    }
    @Test public void separateFooterActionsRemainUsableInNarrowLayout(){
        Activity activity=Robolectric.buildActivity(Activity.class).setup().get();activity.setTheme(R.style.AppTheme);
        AssistantPanel panel=new AssistantPanel(activity,new AssistantPanel.Navigation(){public void openRole(String id){}public void openTask(String id){}public void settings(){}});
        activity.setContentView(panel.root);
        try{
            panel.root.measure(View.MeasureSpec.makeMeasureSpec(320,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(640,View.MeasureSpec.EXACTLY));panel.root.layout(0,0,320,640);
            Button settings=button(panel.root,"设置"),profile=button(panel.root,"助理资料");
            assertNotNull(settings);assertNotNull(profile);assertEquals(profile.getParent(),settings.getParent());
            assertTrue(settings.getWidth()>=100);assertTrue(profile.getWidth()>=100);assertTrue(settings.getHeight()>=44);assertTrue(profile.getHeight()>=44);
            assertTrue(profile.getRight()<settings.getLeft());assertTrue(settings.getRight()<=((View)settings.getParent()).getWidth());
        }finally{panel.close();activity.finish();}
    }
}
