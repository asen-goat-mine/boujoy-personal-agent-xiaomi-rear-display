package dev.boujoy.personalagent;

import android.app.Activity;
import android.os.Looper;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.List;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,qualifiers="w390dp-h844dp-mdpi")
public class ConversationScrollViewTest {
    private Activity activity;
    private ConversationScrollView scroll;
    private LinearLayout feed;
    private Button stop;

    @After public void close(){if(activity!=null)activity.finish();}

    private void open(boolean withButton){
        activity=Robolectric.buildActivity(Activity.class).setup().get();
        scroll=new ConversationScrollView(activity);scroll.setPadding(0,100,0,24);
        feed=new LinearLayout(activity);feed.setOrientation(LinearLayout.VERTICAL);scroll.addView(feed);
        for(int i=0;i<20;i++){
            TextView row;
            if(withButton&&i==3){stop=new Button(activity);stop.setText("停止");stop.setFocusable(false);row=stop;}
            else {row=new TextView(activity);row.setText("消息 "+i);}
            row.setTag("row"+i);feed.addView(row,new LinearLayout.LayoutParams(-1,100));
        }
        activity.setContentView(scroll);layout(600);
    }

    private void layout(int height){
        scroll.requestLayout();
        scroll.measure(View.MeasureSpec.makeMeasureSpec(390,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(height,View.MeasureSpec.EXACTLY));
        scroll.layout(0,0,390,height);
    }

    private boolean touch(int action,long down,float y){
        MotionEvent event=MotionEvent.obtain(down,SystemClock.uptimeMillis(),action,195,y,0);
        try{return scroll.dispatchTouchEvent(event);}finally{event.recycle();}
    }

    @Test public void bottomIncludesHeaderAndFooterPaddingAcrossKeyboardAndHeaderChanges(){
        open(false);
        assertEquals(1524,scroll.getScrollY());assertTrue(scroll.isNearBottom());
        layout(600);assertEquals(1524,scroll.getScrollY());
        layout(350);assertEquals(1774,scroll.getScrollY());
        layout(600);assertEquals(1524,scroll.getScrollY());
        scroll.setPadding(0,56,0,24);layout(600);
        assertEquals(1480,scroll.getScrollY());
        assertEquals(600-scroll.getPaddingBottom(),feed.getBottom()-scroll.getScrollY());
    }

    @Test public void readingAnchorSurvivesEarlierRowGrowthAndKeyboardResizeWithPadding(){
        open(false);scroll.scrollTo(0,450);assertFalse(scroll.isNearBottom());
        scroll.preserve(false);feed.getChildAt(0).getLayoutParams().height=180;feed.requestLayout();layout(600);
        assertEquals(530,scroll.getScrollY());
        assertEquals(-50,feed.getChildAt(4).getTop()-scroll.getScrollY());
        layout(350);assertEquals(530,scroll.getScrollY());
        layout(600);assertEquals(530,scroll.getScrollY());
    }

    @Test public void paddingDoesNotTurnAnOlderReadingPositionIntoBottomFollowing(){
        open(false);scroll.scrollTo(0,1424);
        assertFalse(scroll.isNearBottom());
        layout(350);assertEquals(1424,scroll.getScrollY());assertFalse(scroll.isNearBottom());
        scroll.preserve(true);layout(350);assertEquals(1774,scroll.getScrollY());assertTrue(scroll.isNearBottom());
    }

    @Test public void childButtonGestureDefersAnchorRestorationUntilItsDispatchFinishes(){
        open(true);scroll.scrollTo(0,200);
        List<String> events=new ArrayList<>();
        stop.setOnTouchListener((view,event)->{if(event.getActionMasked()==MotionEvent.ACTION_UP)events.add("up");return false;});
        stop.setOnClickListener(view->events.add("click"));
        scroll.setOnTouchFinishedListener(()->{
            assertFalse(scroll.isTouchActive());assertTrue(events.contains("up"));
            scroll.post(()->events.add("refresh"));
        });
        float y=feed.getTop()+stop.getTop()-scroll.getScrollY()+stop.getHeight()/2f;
        long down=SystemClock.uptimeMillis();assertTrue(touch(MotionEvent.ACTION_DOWN,down,y));assertTrue(scroll.isTouchActive());
        scroll.preserve(true);layout(600);assertEquals(200,scroll.getScrollY());
        assertTrue(touch(MotionEvent.ACTION_UP,down,y));assertFalse(scroll.isTouchActive());
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals(List.of("up","click","refresh"),events);
    }

    @Test public void cancelledChildGestureFinishesOnceAndNeverClicks(){
        open(true);scroll.scrollTo(0,200);int[] finished={0},clicks={0};
        stop.setOnClickListener(view->clicks[0]++);
        scroll.setOnTouchFinishedListener(()->{assertFalse(scroll.isTouchActive());finished[0]++;});
        float y=feed.getTop()+stop.getTop()-scroll.getScrollY()+stop.getHeight()/2f;
        long down=SystemClock.uptimeMillis();assertTrue(touch(MotionEvent.ACTION_DOWN,down,y));assertTrue(scroll.isTouchActive());
        touch(MotionEvent.ACTION_CANCEL,down,y);assertFalse(scroll.isTouchActive());
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals(1,finished[0]);assertEquals(0,clicks[0]);
    }

    @Test public void unhandledDownDoesNotLeaveAnActiveGesture(){
        activity=Robolectric.buildActivity(Activity.class).setup().get();scroll=new ConversationScrollView(activity);
        activity.setContentView(scroll);layout(600);
        assertFalse(touch(MotionEvent.ACTION_DOWN,SystemClock.uptimeMillis(),200));assertFalse(scroll.isTouchActive());
    }
}
