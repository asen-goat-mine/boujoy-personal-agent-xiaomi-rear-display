package dev.boujoy.personalagent;
import org.json.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class TaskNotificationsTest {
    private JSONObject task(String status)throws Exception{return new JSONObject().put("id","task-one").put("title","买午饭").put("status",status);}
    @Test public void initialSnapshotDoesNotAnnounceHistoricalTasks()throws Exception{
        TaskNotifications.Update first=TaskNotifications.consume(new JSONObject(),new JSONArray().put(task("completed")));
        assertTrue(first.alerts().isEmpty());assertTrue(first.ledger().getBoolean("initialized"));
    }
    @Test public void transitionNotifiesOnceAcrossPollsAndRecreation()throws Exception{
        TaskNotifications.Update first=TaskNotifications.consume(new JSONObject(),new JSONArray().put(task("running")));
        JSONObject ready=task("ready_for_user");TaskNotifications.Update second=TaskNotifications.consume(first.ledger(),new JSONArray().put(ready));
        assertEquals(1,second.alerts().size());assertEquals("已准备好，请你接着付款",second.alerts().get(0).title());
        ready.put("updatedAt","later-heartbeat");
        TaskNotifications.Update restored=TaskNotifications.consume(TaskNotifications.outcome(second.ledger(),second.alerts().get(0),"posted",1000),new JSONArray().put(ready));
        assertTrue(restored.alerts().isEmpty());
    }
    @Test public void deniedPermissionAndQuietNeverConsumeTheOnlyReminder()throws Exception{
        JSONObject initial=TaskNotifications.consume(new JSONObject(),new JSONArray().put(task("running"))).ledger();
        TaskNotifications.Update done=TaskNotifications.consume(initial,new JSONArray().put(task("completed")));TaskNotifications.Alert alert=done.alerts().get(0);assertTrue(TaskNotifications.quietSuppresses(alert));
        JSONObject quiet=TaskNotifications.outcome(done.ledger(),alert,"deferred_quiet",1);assertEquals(1,TaskNotifications.consume(quiet,new JSONArray().put(task("completed"))).alerts().size());
        JSONObject denied=TaskNotifications.outcome(quiet,alert,"permission_denied",2);assertEquals(1,TaskNotifications.consume(new JSONObject(denied.toString()),new JSONArray().put(task("completed"))).alerts().size());
        JSONObject posted=TaskNotifications.outcome(denied,alert,"posted",3);assertTrue(TaskNotifications.consume(posted,new JSONArray().put(task("completed"))).alerts().isEmpty());assertEquals("posted",TaskNotifications.report(posted).getJSONObject(0).getString("status"));
        TaskNotifications.Alert payment=TaskNotifications.consume(posted,new JSONArray().put(task("ready_for_user"))).alerts().get(0);assertFalse(TaskNotifications.quietSuppresses(payment));
    }
    @Test public void staleNotificationOutcomeCannotAcknowledgeANewerTaskState()throws Exception{
        JSONObject initial=TaskNotifications.consume(new JSONObject(),new JSONArray().put(task("running"))).ledger();TaskNotifications.Update done=TaskNotifications.consume(initial,new JSONArray().put(task("completed")));TaskNotifications.Update unknown=TaskNotifications.consume(done.ledger(),new JSONArray().put(task("unknown_result")));
        JSONObject late=TaskNotifications.outcome(unknown.ledger(),done.alerts().get(0),"posted",9);assertEquals(1,TaskNotifications.consume(late,new JSONArray().put(task("unknown_result"))).alerts().size());
    }
    @Test public void unknownOutcomeNeverBecomesSuccessNotification()throws Exception{
        JSONObject initialized=new JSONObject().put("initialized",true);
        TaskNotifications.Update result=TaskNotifications.consume(initialized,new JSONArray().put(task("unknown_result")));
        assertEquals("操作结果需要核实",result.alerts().get(0).title());
        TaskNotifications.Update blocked=TaskNotifications.consume(result.ledger(),new JSONArray().put(task("waiting_approval")));
        assertEquals(1,blocked.alerts().size());
    }
}
