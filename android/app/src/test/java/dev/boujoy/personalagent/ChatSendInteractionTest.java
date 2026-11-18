package dev.boujoy.personalagent;

import android.os.Looper;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import java.io.IOException;
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
import static dev.boujoy.personalagent.NativeLayoutAuditTest.label;
import static dev.boujoy.personalagent.NativeVisualTest.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,qualifiers="w390dp-h844dp-mdpi",shadows=ChatSendInteractionTest.DelayedSave.class)
public class ChatSendInteractionTest {
    private static final String THREAD="55555555-5555-4555-8555-555555555555";
    private static final String OTHER="66666666-6666-4666-8666-666666666666";
    @Implements(value=ConnectionService.class,isInAndroidSdk=false)
    public static class DelayedSave {
        static JSONObject durable;
        static ConnectionService.Outcome<String> held;
        static int snapshots,submissions;
        static String submittedId;
        @Implementation protected void chatHistoryVisible(boolean visible){}
        @Implementation protected void chatHistoryVisible(boolean visible,String thread){}
        @Implementation protected String pairedDeviceId(){return "fixture-device";}
        @Implementation protected JSONObject snapshot(){snapshots++;return durable;}
        @Implementation protected void submit(String text,String thread,JSONArray attachments,String id,String role,ConnectionService.Outcome<String> saved){submissions++;submittedId=id;held=saved;}
    }
    private MainActivity activity;
    private ActivityController<MainActivity> controller;
    private ConnectionService service;
    private ChatComposerState chat;
    private EditText composer;
    private LinearLayout feed;
    private ConversationScrollView scroll;
    @After public void close(){ConnectionService.current=null;if(activity!=null)activity.finish();DelayedSave.held=null;DelayedSave.durable=null;}
    private void render()throws Exception{invoke(activity,"renderSnapshot",new Class[]{JSONObject.class,ConnectionService.class},DelayedSave.durable,service);}
    private void layout()throws Exception{
        View root=activity.getWindow().getDecorView();
        root.measure(View.MeasureSpec.makeMeasureSpec(390,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(844,View.MeasureSpec.EXACTLY));root.layout(0,0,390,844);
    }
    private void open()throws Exception{
        JSONObject data=fixture().put("pairedDeviceId","fixture-device").put("outbox",new JSONObject());
        JSONObject task=object("id",THREAD,"conversationId",THREAD,"roleId","concierge","status","completed");
        data.getJSONObject("state").put("tasks",new JSONArray().put(task));
        JSONArray history=new JSONArray();
        for(int index=0;index<18;index++)history.put(object("id","old-"+index,"role","user","content","历史记录 "+index));
        data.put("taskDetails",object(THREAD,object("detail",new JSONObject(task.toString()).put("messages",history))));
        DelayedSave.durable=data;DelayedSave.held=null;DelayedSave.snapshots=0;DelayedSave.submissions=0;
        ConnectionService.current=null;controller=Robolectric.buildActivity(MainActivity.class).create();activity=controller.get();
        ((ChatComposerState)field(activity,"chat")).selectConversation(THREAD);
        invoke(activity,"showAssistantList",new Class[]{boolean.class},false);
        service=Robolectric.buildService(ConnectionService.class).get();ConnectionService.current=service;
        chat=(ChatComposerState)field(activity,"chat");composer=(EditText)field(activity,"composer");feed=(LinearLayout)field(activity,"feed");scroll=(ConversationScrollView)field(activity,"chatScroll");
        render();layout();DelayedSave.snapshots=0;
    }
    private void send(String draft)throws Exception{
        composer.setText(draft);assertTrue(((View)field(activity,"send")).performClick());
        assertEquals(1,DelayedSave.submissions);assertNotNull(DelayedSave.held);
        assertEquals("Tap must display echo before requesting any full service snapshot",0,DelayedSave.snapshots);
        assertEquals("",composer.getText().toString());
    }
    @Test public void clickEchoesBeforeSaveAndFollowsNewRowOnFirstLayout()throws Exception{
        open();scroll.scrollTo(0,0);assertFalse(scroll.isNearBottom());
        View old=label(feed,"历史记录 5");
        send("现在发送");View echo=label(feed,"现在发送");assertSame(echo,feed.findViewWithTag("local:"+DelayedSave.submittedId));
        assertTrue("Provisional rendering cannot acknowledge a local save",chat.waiting());
        assertFalse(DelayedSave.durable.getJSONObject("outbox").has(DelayedSave.submittedId));
        layout();assertTrue(scroll.isNearBottom());assertSame(old,label(feed,"历史记录 5"));
        String messageId=DelayedSave.submittedId;
        DelayedSave.durable.getJSONObject("outbox").put(messageId,object("message",object("messageId",messageId,"text","现在发送","conversationId",THREAD,"createdAt","2026-11-17T15:00:00Z"),"status","queued"));
        render();DelayedSave.held.done(messageId,null);Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertSame(echo,label(feed,"现在发送"));assertFalse(chat.waiting());assertEquals("",chat.text());assertEquals(1,DelayedSave.submissions);
    }
    @Test public void failedSaveKeepsTextAndAttachmentInOriginatingThread()throws Exception{
        open();chat.setAttachments(new JSONArray().put(object("localId","test-attachment","name","示例.txt","size",12)));
        send("原会话的草稿");assertNotNull(label(feed,"原会话的草稿\n［已选择附件］"));
        chat.selectConversation(OTHER);render();assertEquals("",composer.getText().toString());
        DelayedSave.held.done(null,new IOException("fixture storage failure"));Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals("",chat.text());assertEquals(0,chat.attachments().length());
        chat.selectConversation(THREAD);render();assertEquals("原会话的草稿",composer.getText().toString());assertEquals("示例.txt",chat.attachments().getJSONObject(0).getString("name"));assertFalse(chat.waiting());
        assertNull(feed.findViewWithTag("local:"+DelayedSave.submittedId));
    }
    @Test public void failedSaveDoesNotOverwriteSubsequentTypedDraft()throws Exception{
        open();send("原请求");composer.setText("下一条草稿");
        DelayedSave.held.done(null,new IOException("fixture storage failure"));Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals("下一条草稿",composer.getText().toString());assertFalse(chat.waiting());assertEquals(1,DelayedSave.submissions);
    }
    @Test public void nextAttachmentAndTranscriptionUseTheEmptyVisibleDraft()throws Exception{
        open();chat.setAttachments(new JSONArray().put(object("name","first.txt")));
        send("第一条语音");JSONArray selected=chat.visibleAttachments();assertEquals(0,selected.length());
        ChatComposerState.AttachmentTicket reading=chat.beginAttachmentRead();
        render();assertEquals(View.GONE,((View)field(activity,"attachmentLabel")).getVisibility());
        chat.appendTranscription("下一条语音");render();assertEquals("下一条语音",composer.getText().toString());
        DelayedSave.held.done(DelayedSave.submittedId,null);Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertTrue(chat.acceptAttachment(reading,selected.put(object("name","second.txt"))));render();
        assertEquals(1,chat.visibleAttachments().length());assertEquals("second.txt",chat.visibleAttachments().getJSONObject(0).getString("name"));assertEquals("下一条语音",composer.getText().toString());
    }
    @Test public void attachmentReadStartedBeforeSendAddsOnlyNewSelection()throws Exception{
        open();chat.setAttachments(new JSONArray().put(object("name","sent.txt")));
        ChatComposerState.AttachmentTicket reading=chat.beginAttachmentRead();
        send("发已选附件");assertTrue(chat.acceptAttachment(reading,new JSONArray().put(object("name","later.txt"))));
        DelayedSave.held.done(DelayedSave.submittedId,null);Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals(1,chat.attachments().length());assertEquals("later.txt",chat.attachments().getJSONObject(0).getString("name"));
    }
    @Test public void recreatingActivityRetainsEchoUntilDelayedSaveFails()throws Exception{
        open();controller.start().resume();
        send("旋转时的消息");String key="local:"+DelayedSave.submittedId;
        controller.recreate();activity=controller.get();assertSame(chat,field(activity,"chat"));
        render();feed=(LinearLayout)field(activity,"feed");composer=(EditText)field(activity,"composer");
        assertNotNull(feed.findViewWithTag(key));assertEquals("",composer.getText().toString());
        DelayedSave.held.done(null,new IOException("fixture storage failure"));Shadows.shadowOf(Looper.getMainLooper()).idle();render();
        assertNull(feed.findViewWithTag(key));assertEquals("旋转时的消息",composer.getText().toString());assertFalse(chat.waiting());
    }
    @Test public void retypedIdenticalTextSurvivesSuccessfulSave()throws Exception{
        open();send("同一句话");composer.setText("同一句话");
        DelayedSave.held.done(DelayedSave.submittedId,null);Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertEquals("同一句话",composer.getText().toString());assertEquals("同一句话",chat.text());assertFalse(chat.waiting());
    }
}
