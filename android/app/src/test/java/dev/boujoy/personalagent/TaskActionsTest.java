package dev.boujoy.personalagent;
import org.json.*;import org.junit.Test;import static org.junit.Assert.*;
public class TaskActionsTest {
    @Test public void anExpiredTaskCannotOfferOrdinaryContinue(){
        long now=1700000000000L;
        for(String state:new String[]{"paused","blocked","failed","interrupted","expired"}){
            JSONObject task=Tunnel.json("status",state,"deadlineAt",now-1,"restartKey","a".repeat(64));assertEquals(TaskActions.Action.RESTART,TaskActions.primary(task,now));
            task.remove("restartKey");assertEquals(TaskActions.Action.NONE,TaskActions.primary(task,now));
        }
        assertEquals(TaskActions.Action.CONTINUE,TaskActions.primary(Tunnel.json("status","paused","deadlineAt",now+1000),now));
    }
    @Test public void unknownOrFinishedResultsNeverOfferRestartEvenWithAStaleKey(){
        for(String state:new String[]{"unknown_result","ready_for_user","completed","needs_input"})assertEquals(TaskActions.Action.NONE,TaskActions.primary(Tunnel.json("status",state,"deadlineAt",1,"restartKey","a".repeat(64)),2));
        assertEquals(TaskActions.Action.STOP,TaskActions.primary(Tunnel.json("status","running"),2));
        assertEquals(TaskActions.Action.CONSENT,TaskActions.primary(Tunnel.json("status","waiting_consent"),2));
    }
    @Test public void unknownNavigationOffersObservationOnlyAndNeverExecution()throws Exception{
        JSONObject task=Tunnel.json("status","unknown_result","canReconcile",true,"deadlineAt",1,"restartKey","a".repeat(64));
        assertEquals(TaskActions.Action.RECONCILE,TaskActions.primary(task,2));
        task.put("canReconcile",false);assertEquals(TaskActions.Action.NONE,TaskActions.primary(task,2));
        task.put("status","completed").put("canReconcile",true);assertEquals(TaskActions.Action.NONE,TaskActions.primary(task,2));
    }
}
