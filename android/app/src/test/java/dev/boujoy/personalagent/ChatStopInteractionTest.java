package dev.boujoy.personalagent;

import android.graphics.Rect;
import android.os.Looper;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLContext;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.util.ReflectionHelpers;
import static dev.boujoy.personalagent.NativeLayoutAuditTest.label;
import static dev.boujoy.personalagent.NativeVisualTest.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,qualifiers="w390dp-h844dp-mdpi",shadows=ChatStopInteractionTest.Mac.class)
public class ChatStopInteractionTest {
    private static final String ID="55555555-5555-4555-8555-555555555555";
    private MainActivity activity;
    private ActivityController<MainActivity> controller;
    private ConnectionService service;
    private ControlState gate;
    private static final List<String> calls=new CopyOnWriteArrayList<>();

    @Implements(value=GatewayClient.class,isInAndroidSdk=false)
    public static class Mac {
        @Implementation protected JSONObject json(String method,String path,JSONObject request,boolean control){calls.add(path);return new JSONObject();}
    }

    @After public void close(){ConnectionService.current=null;if(controller!=null)controller.pause().stop().destroy();if(service!=null)service.onDestroy();calls.clear();}

    private JSONObject snapshot()throws Exception{
        JSONObject task=object("id",ID,"conversationId",ID,"roleId","concierge","title","整理计划","status","running","updatedAt","2026-11-12T10:00:00Z");
        JSONObject detail=new JSONObject(task.toString()).put("messages",new JSONArray().put(object("id","user","role","user","content","帮我整理计划")).put(object("id","answer","role","assistant","content","正在整理。")));
        JSONObject data=fixture();data.getJSONObject("state").put("tasks",new JSONArray().put(task));data.put("taskDetails",object(ID,object("detail",detail)));return data;
    }
    private void open(JSONObject data)throws Exception{
        ConnectionService.current=null;controller=Robolectric.buildActivity(MainActivity.class).create().start().resume().visible();activity=controller.get();
        ChatComposerState chat=(ChatComposerState)field(activity,"chat");chat.selectRole("concierge");chat.selectConversation(ID);
        invoke(activity,"showAssistantList",new Class[]{boolean.class},false);render(data);layout();
        assertTrue("Touches must run on an attached window, including posted performClick",((View)field(activity,"chatRoot")).isAttachedToWindow());
    }
    private void attachControl(){
        // Real stop handling and in-memory gate; no periodic jobs, storage or network.
        service=Robolectric.buildService(ConnectionService.class).get();ControlStateTest.Memory memory=new ControlStateTest.Memory();memory.paused=false;gate=new ControlState(memory);
        ReflectionHelpers.setField(service,"gate",gate);
        ReflectionHelpers.setField(service,"gateway",new GatewayClient(null,(SSLContext)null));
        ConnectionService.current=service;
    }
    private void render(JSONObject data)throws Exception{invoke(activity,"renderSnapshot",new Class[]{JSONObject.class,ConnectionService.class},data,null);}
    private void layout()throws Exception{
        View root=activity.getWindow().getDecorView();
        for(int i=0;i<2;i++){root.measure(View.MeasureSpec.makeMeasureSpec(390,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(844,View.MeasureSpec.EXACTLY));root.layout(0,0,390,844);Shadows.shadowOf(Looper.getMainLooper()).idle();}
    }
    private ConversationScrollView scroll()throws Exception{return (ConversationScrollView)field(activity,"chatScroll");}
    private Rect bounds(View child)throws Exception{Rect bounds=new Rect(0,0,child.getWidth(),child.getHeight());scroll().offsetDescendantRectToMyCoords(child,bounds);return bounds;}
    private void touch(int action,long down,Rect point)throws Exception{
        MotionEvent event=MotionEvent.obtain(down,SystemClock.uptimeMillis(),action,point.exactCenterX(),point.exactCenterY(),0);
        try{assertTrue(scroll().dispatchTouchEvent(event));}finally{event.recycle();}
    }
    private void finishControl()throws Exception{((MobileWorkers)field(service,"workers")).control.submit(()->{}).get(5,TimeUnit.SECONDS);}

    @Test public void draftAndDetailUpdatesKeepTheSameStopControl()throws Exception{
        JSONObject data=snapshot();open(data);View root=(View)field(activity,"chatRoot");View stop=label(root,"停止");
        JSONObject next=new JSONObject(data.toString()),task=next.getJSONObject("state").getJSONArray("tasks").getJSONObject(0);
        task.put("updatedAt","2026-11-12T10:00:04Z").put("liveDraft","核对中").put("usage",object("tokens",123));
        next.getJSONObject("taskDetails").getJSONObject(ID).put("fetchedAt",123).getJSONObject("detail").put("events",new JSONArray().put(object("type","progress")));
        next.put("approvalRequests",object("another-task",object("status","sending","fingerprint","other"))).put("pendingTaskActions",new JSONArray().put("another-task"));
        render(next);layout();assertSame("Polling metadata and streaming text must not replace Stop",stop,label(root,"停止"));
    }

    @Test public void touchDownRefreshTouchUpStillStopsAndThenShowsLatestReply()throws Exception{
        JSONObject data=snapshot();open(data);attachControl();View root=(View)field(activity,"chatRoot");View stop=label(root,"停止");Rect before=bounds(stop);long down=SystemClock.uptimeMillis();
        touch(MotionEvent.ACTION_DOWN,down,before);
        JSONObject next=new JSONObject(data.toString());next.getJSONObject("taskDetails").getJSONObject(ID).getJSONObject("detail").getJSONArray("messages").getJSONObject(1).put("content","先检查安排。\n然后补充细节。\n最后整理成计划。");
        render(next);layout();
        assertSame(stop,label(root,"停止"));assertEquals("Rows must not move under a pressed button",before,bounds(stop));assertNotNull(label(root,"正在整理。"));
        touch(MotionEvent.ACTION_UP,down,before);Shadows.shadowOf(Looper.getMainLooper()).idle();finishControl();layout();
        assertTrue("The real Stop handler must pause the local gate",gate.paused());assertEquals(1,gate.epoch());assertEquals(List.of("/v1/tasks/"+ID+"/stop"),calls);
        assertNotNull(label(root,"先检查安排。\n然后补充细节。\n最后整理成计划。"));
    }

    @Test public void cancelledTouchCatchesUpWithoutStopping()throws Exception{
        JSONObject data=snapshot();open(data);attachControl();View root=(View)field(activity,"chatRoot");Rect point=bounds(label(root,"停止"));long down=SystemClock.uptimeMillis();touch(MotionEvent.ACTION_DOWN,down,point);
        JSONObject next=new JSONObject(data.toString());next.getJSONObject("state").getJSONArray("tasks").getJSONObject(0).put("liveDraft","新的进度");render(next);
        touch(MotionEvent.ACTION_CANCEL,down,point);Shadows.shadowOf(Looper.getMainLooper()).idle();layout();
        assertFalse(gate.paused());assertTrue(calls.isEmpty());assertNotNull(label(root,"正在处理 · 新的进度"));
    }

    @Test public void fixedTakeoverControlDoesNotDisappearDuringItsTap()throws Exception{
        JSONObject data=snapshot();open(data);attachControl();ViewGroup decor=(ViewGroup)activity.getWindow().getDecorView();
        decor.measure(View.MeasureSpec.makeMeasureSpec(390,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(844,View.MeasureSpec.EXACTLY));decor.layout(0,0,390,844);Shadows.shadowOf(Looper.getMainLooper()).idle();
        View control=(View)field(activity,"controlButton"),row=(View)field(activity,"statusRow");Rect point=new Rect(0,0,control.getWidth(),control.getHeight());decor.offsetDescendantRectToMyCoords(control,point);long down=SystemClock.uptimeMillis();
        MotionEvent press=MotionEvent.obtain(down,down,MotionEvent.ACTION_DOWN,point.exactCenterX(),point.exactCenterY(),0);
        try{assertTrue(activity.dispatchTouchEvent(press));}finally{press.recycle();}
        JSONObject next=new JSONObject(data.toString());next.getJSONObject("state").getJSONArray("tasks").getJSONObject(0).put("status","completed");render(next);assertEquals(View.VISIBLE,row.getVisibility());
        MotionEvent release=MotionEvent.obtain(down,SystemClock.uptimeMillis(),MotionEvent.ACTION_UP,point.exactCenterX(),point.exactCenterY(),0);
        try{assertTrue(activity.dispatchTouchEvent(release));}finally{release.recycle();}
        Shadows.shadowOf(Looper.getMainLooper()).idle();finishControl();assertTrue(gate.paused());assertEquals(1,gate.epoch());assertEquals(View.GONE,row.getVisibility());
    }

    @Test public void relevantTaskAndApprovalChangesStillRefreshActions()throws Exception{
        JSONObject data=snapshot();open(data);View root=(View)field(activity,"chatRoot");JSONObject next=new JSONObject(data.toString()),task=next.getJSONObject("state").getJSONArray("tasks").getJSONObject(0);
        task.put("status","paused");render(next);assertTrue(label(root,"继续").isEnabled());
        next.put("pendingTaskActions",new JSONArray().put(ID));render(next);assertFalse(label(root,"继续").isEnabled());
        task.put("status","waiting_approval").put("approvals",new JSONArray().put(object("id","approval","fingerprint","fp","status","pending","summary","保存计划","expiresAt",System.currentTimeMillis()+60000)));
        render(next);View allow=label(root,"允许这次操作");assertTrue(allow.isEnabled());
        next.put("approvalRequests",object("approval",object("fingerprint","fp","status","sending")));render(next);assertFalse(label(root,"允许这次操作").isEnabled());
    }
}
