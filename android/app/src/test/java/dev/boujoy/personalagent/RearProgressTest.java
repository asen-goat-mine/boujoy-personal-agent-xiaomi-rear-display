package dev.boujoy.personalagent;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class RearProgressTest {
    private JSONObject row(String id,String label,String state)throws Exception{return new JSONObject().put("id",id).put("label",label).put("state",state);}
    private JSONObject snapshot()throws Exception{return new JSONObject().put("online",true).put("paused",false).put("stateSyncedAtElapsedMs",1000).put("state",new JSONObject().put("tasks",new JSONArray().put(new JSONObject().put("id","live").put("roleId","concierge").put("title","用户的私人要求").put("status","running").put("phase","查看手机页面").put("progress",new JSONArray().put(row("a","已打开应用","completed")).put(row("b","查看手机页面","running"))))).put("roles",new JSONArray().put(new JSONObject().put("id","concierge").put("botColor","violet"))));}
    private JSONObject task(JSONObject snapshot)throws Exception{return snapshot.getJSONObject("state").getJSONArray("tasks").getJSONObject(0);}
    @Test public void freshReceiptsAreStableAcrossRepeatedSnapshotsAndDoNotMutateInput()throws Exception{
        JSONObject s=snapshot();String original=s.toString();var state=RearStatus.from(s,1500,false);var rows=RearProgress.from(s,state,true);
        assertEquals("completed",rows.get(0).state());assertEquals("running",rows.get(1).state());assertEquals(rows,RearProgress.from(s,state,true));assertEquals(original,s.toString());
    }
    @Test public void localStopImmediatelyStopsSpinningBeforeMacStatusCatchesUp()throws Exception{
        JSONObject s=snapshot().put("paused",true);var rows=RearProgress.from(s,RearStatus.from(s,1500,false),true);
        assertEquals("completed",rows.get(0).state());assertEquals("waiting",rows.get(1).state());assertEquals("running",task(s).getString("status"));
    }
    @Test public void waitingFailedAndUnknownTasksNeverSpinOrTurnTheirCurrentStepIntoSuccess()throws Exception{
        for(String status:new String[]{"paused","blocked","failed","unknown_result","waiting_approval","waiting_consent","ready_for_user","queued"}){
            JSONObject s=snapshot();task(s).put("status",status);var rows=RearProgress.from(s,RearStatus.from(s,1500,false),true);assertEquals(status,"waiting",rows.get(1).state());
        }
    }
    @Test public void disconnectionAndExpiredSnapshotsClearAllProgress()throws Exception{
        JSONObject s=snapshot();assertTrue(RearProgress.from(s,RearStatus.from(s,31001,false),true).isEmpty());s.put("online",false);assertTrue(RearProgress.from(s,RearStatus.from(s,1500,false),true).isEmpty());
    }
    @Test public void lockedMainHidesStepsButBackgroundKeepsGenericProgressWithoutPrivateTitle()throws Exception{
        JSONObject s=snapshot();assertTrue(RearProgress.from(s,RearStatus.from(s,1500,true),false).isEmpty());var state=RearStatus.from(s,1500,true,true);assertEquals("",state.title());assertEquals("",state.updatedAt());assertEquals(2,RearProgress.from(s,state,true).size());
    }
    @Test public void oldServerFallbackAndPhaseChangesDoNotInventCompletedHistory()throws Exception{
        JSONObject s=snapshot();task(s).remove("progress");var first=RearProgress.from(s,RearStatus.from(s,1500,false),true);task(s).put("phase","正在思考");var next=RearProgress.from(s,RearStatus.from(s,1500,false),true);assertEquals(1,first.size());assertEquals(1,next.size());assertEquals("running",next.get(0).state());
    }
    @Test public void selectionDoesNotMixParallelTasksAndUsesSelectedBotsColor()throws Exception{
        JSONObject s=snapshot().put("displayTaskId","other");s.getJSONObject("state").getJSONArray("tasks").put(new JSONObject().put("id","other").put("roleId","green").put("status","running").put("phase","新任务阶段"));s.getJSONObject("state").getJSONArray("roles").put(new JSONObject().put("id","green").put("botColor","green"));var state=RearStatus.from(s,1500,false);var rows=RearProgress.from(s,state,true);assertEquals(1,rows.size());assertEquals("新任务阶段",rows.get(0).label());assertEquals("green",RearProgress.color(s,state.taskId()));
    }
    @Test public void malformedRowsAreBoundedDeduplicatedAndUnknownStatesNeverBecomeChecks()throws Exception{
        JSONObject s=snapshot();JSONArray progress=new JSONArray();for(int i=0;i<30;i++)progress.put(row("id"+i,"读取页面\n"+"很长的文字".repeat(20),"running"));progress.put(row("id29","最后一项","invented"));task(s).put("progress",progress);var rows=RearProgress.from(s,RearStatus.from(s,1500,false),true);assertEquals(3,rows.size());assertEquals("waiting",rows.get(2).state());assertEquals(1,rows.stream().filter(r->r.state().equals("running")).count());for(var row:rows){assertFalse(row.label().contains("\n"));assertTrue(row.label().codePointCount(0,row.label().length())<=36);}
    }
}
