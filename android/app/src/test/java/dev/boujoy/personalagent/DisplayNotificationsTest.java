package dev.boujoy.personalagent;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public class DisplayNotificationsTest {
    private static JSONObject handoff(String state)throws Exception{return new JSONObject().put("handoffId","handoff-1").put("taskId","task-1").put("state",state).put("title","设置显示页").put("summary","请查看显示选项").put("expiresAtMs",2000);}
    @Test public void pendingAndFailedHaveSeparateRearIdentityButTerminalOrExpiredDoNot()throws Exception{
        assertEquals("handoff:handoff-1",DisplayNotifications.rearCandidate(handoff("pending"),"",1000));
        assertEquals("handoff:handoff-1",DisplayNotifications.rearCandidate(handoff("failed"),"task-2",1000));
        for(String state:new String[]{"taken","dismissed","expired"})assertEquals("task-2",DisplayNotifications.rearCandidate(handoff(state),"task-2",1000));
        assertEquals("",DisplayNotifications.rearCandidate(handoff("pending"),"",2000));
        assertFalse(ConnectionService.handoffMatches(handoff("pending"),"stale-id",1000));
        assertTrue(ConnectionService.handoffMatches(handoff("failed"),"handoff-1",1000));
    }
    @Test public void lockscreenVersionHasNoTaskTextOrAction()throws Exception{
        Context context=RuntimeEnvironment.getApplication();
        PendingIntent take=PendingIntent.getActivity(context,10,new Intent(context,MainActivity.class),PendingIntent.FLAG_IMMUTABLE);
        PendingIntent dismiss=PendingIntent.getService(context,11,DisplayNotifications.dismissIntent(context,"handoff-1"),PendingIntent.FLAG_IMMUTABLE);
        Notification notification=DisplayNotifications.handoffNotification(context,handoff("pending"),take,dismiss);
        assertEquals(Notification.VISIBILITY_PRIVATE,notification.visibility);
        assertEquals("设置显示页 需要你接手",notification.extras.getCharSequence(Notification.EXTRA_TITLE));
        assertEquals(2,notification.actions.length);
        assertSame(take,notification.actions[0].actionIntent);assertSame(dismiss,notification.actions[1].actionIntent);
        assertEquals("Boujoy 需要你接手",notification.publicVersion.extras.getCharSequence(Notification.EXTRA_TITLE));
        assertEquals("解锁后查看",notification.publicVersion.extras.getCharSequence(Notification.EXTRA_TEXT));
        assertNull(notification.publicVersion.actions);
    }
    @Test public void navigationAndDismissalCannotSupplyArbitraryExportedCommands(){
        Context context=RuntimeEnvironment.getApplication();
        Intent dismiss=DisplayNotifications.dismissIntent(context,"handoff-1");
        assertEquals(ConnectionService.class.getName(),dismiss.getComponent().getClassName());
        assertEquals(DisplayNotifications.DISMISS,dismiss.getAction());
        assertEquals("handoff-1",dismiss.getStringExtra(DisplayNotifications.HANDOFF_EXTRA));
        Intent settings=DisplayNotifications.accessibilityIntent(context);
        assertEquals(DisplayNotifications.ACCESSIBILITY_DETAILS,settings.getAction());
        assertEquals(BoujoyDisplayService.class.getName(),((android.content.ComponentName)settings.getParcelableExtra(Intent.EXTRA_COMPONENT_NAME)).getClassName());
    }
    @Test public void pendingNoticeExpiresAndRecoveredCapabilityNoticeIsRemoved()throws Exception{
        Context context=RuntimeEnvironment.getApplication();DisplayNotifications notifications=new DisplayNotifications(context);
        android.app.NotificationManager manager=context.getSystemService(android.app.NotificationManager.class);
        notifications.refresh(handoff("pending"),new AvailabilityNotice.Update(false,true,false,false),1000);
        assertEquals(2,manager.getActiveNotifications().length);
        notifications.refresh(handoff("pending"),new AvailabilityNotice.Update(false,false,false,false),2000);
        assertEquals(0,manager.getActiveNotifications().length);
        notifications.close();
    }
    @Test public void failedMoveRetainsExplicitRetryActions()throws Exception{
        Context context=RuntimeEnvironment.getApplication();
        PendingIntent action=PendingIntent.getActivity(context,12,new Intent(context,MainActivity.class),PendingIntent.FLAG_IMMUTABLE);
        Notification notification=DisplayNotifications.handoffNotification(context,handoff("failed"),action,action);
        assertEquals("没能移到主屏，请稍后重试",notification.extras.getCharSequence(Notification.EXTRA_TITLE));
        assertEquals("在主屏接手",notification.actions[0].title);assertEquals(2,notification.actions.length);
    }
}
