package dev.boujoy.personalagent;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class RearStatusTest {
    private JSONObject task(String id,String status,String at)throws Exception {
        return new JSONObject().put("id",id).put("title","私有任务标题").put("phase","读取当前页面").put("phaseAt",at).put("updatedAt",at).put("status",status);
    }
    private JSONObject snapshot(JSONObject task)throws Exception {
        return new JSONObject().put("online",true).put("paused",false).put("stateSyncedAtElapsedMs",1_000)
            .put("state",new JSONObject().put("tasks",new JSONArray().put(task)));
    }
    @Test public void thirtySecondsWithoutSuccessfulSyncExpiresAndDropsRunningPhase()throws Exception {
        JSONObject snapshot=snapshot(task("one","running","2026-11-14T10:00:00Z"));
        assertFalse(RearStatus.from(snapshot,31_000,false).stale());
        RearStatus.ViewState expired=RearStatus.from(snapshot,31_001,false);
        assertTrue(expired.stale());assertEquals("状态已过期",expired.status());assertEquals("",expired.phase());
        assertFalse(expired.status().contains("正在"));
    }
    @Test public void disconnectExpiresImmediatelyEvenWithRecentState()throws Exception {
        JSONObject snapshot=snapshot(task("one","running","2026-11-14T10:00:00Z")).put("online",false);
        assertEquals("状态已过期",RearStatus.from(snapshot,1_001,false).status());
    }
    @Test public void cachedStateAndClockResetCannotClaimFreshness()throws Exception {
        JSONObject snapshot=snapshot(task("one","running","2026-11-14T10:00:00Z"));
        assertTrue(RearStatus.from(snapshot,999,false).stale());
        snapshot.remove("stateSyncedAtElapsedMs");assertTrue(RearStatus.from(snapshot,1_500,false).stale());
    }
    @Test public void lockedScreenRemovesTaskTitlePhaseAndTimeEvenWhenStale()throws Exception {
        JSONObject snapshot=snapshot(task("one","running","2026-11-14T10:00:00Z"));
        for(long now:new long[]{1_500,50_000}){
            RearStatus.ViewState locked=RearStatus.from(snapshot,now,true);
            assertEquals("Boujoy 正在处理",locked.status());assertEquals("",locked.title());assertEquals("",locked.phase());assertEquals("",locked.updatedAt());
            assertTrue(locked.locked());assertTrue(locked.canStop());
        }
    }
    @Test public void localPauseNeverLooksLikeRunningAfterFreshSync()throws Exception {
        JSONObject snapshot=snapshot(task("one","running","2026-11-14T10:00:00Z")).put("paused",true);
        assertEquals("手机已暂停",RearStatus.from(snapshot,1_500,false).status());
    }
    @Test public void activeTaskWinsOverHistoricalCompletionAndItsPhaseIsUsedVerbatim()throws Exception {
        JSONObject running=task("active","running","2026-11-14T09:00:00Z");
        JSONObject snapshot=snapshot(running);snapshot.getJSONObject("state").getJSONArray("tasks").put(task("history","completed","2026-11-14T10:00:00Z"));
        RearStatus.ViewState view=RearStatus.from(snapshot,1_500,false);
        assertEquals("active",view.taskId());assertEquals("读取当前页面",view.phase());assertEquals("正在处理",view.status());
    }
    @Test public void terminalAndWaitingLabelsRemainTruthfulAndNoProgressIsInvented()throws Exception {
        assertEquals("等待确认",RearStatus.from(snapshot(task("one","waiting_approval","")),1_500,false).status());
        RearStatus.ViewState done=RearStatus.from(snapshot(task("one","completed","")),1_500,false);
        assertEquals("已完成",done.status());assertFalse(done.canStop());
        assertEquals("任务失败",RearStatus.from(snapshot(task("one","failed","")),1_500,false).status());
        assertEquals("结果待核实",RearStatus.from(snapshot(task("one","unknown_result","")),1_500,false).status());
    }
    @Test public void historicalUnresolvedTaskCannotHideLatestCompletion()throws Exception {
        for(String oldState:new String[]{"unknown_result","needs_input","blocked","ready_for_user","waiting_setup","waiting_user"}){
            JSONObject data=snapshot(task("old",oldState,"2026-11-13T09:00:00Z"));
            data.getJSONObject("state").getJSONArray("tasks").put(task("finished","completed","2026-11-14T10:00:00Z"));
            RearStatus.ViewState view=RearStatus.from(data,1_500,false);
            assertEquals(oldState,"finished",view.taskId());assertEquals("已完成",view.status());assertFalse(view.canStop());
        }
    }
    @Test public void historicalUnknownResultCannotReplaceNewestStoppedTask()throws Exception {
        for(String stopped:new String[]{"cancelled","stopped"}){
            JSONObject data=snapshot(task("stopped",stopped,"2026-11-14T10:00:00Z"));
            data.getJSONObject("state").getJSONArray("tasks").put(task("old-unknown","unknown_result","2026-11-13T09:00:00Z"));
            RearStatus.ViewState view=RearStatus.from(data,1_500,false);
            assertEquals("stopped",view.taskId());assertEquals("已停止",view.status());assertFalse(view.canStop());
        }
    }
    @Test public void queuedRunningChildrenAndApprovalsKeepPriority()throws Exception {
        for(String status:new String[]{"queued","running","waiting_children","waiting_approval","waiting_consent"}){
            JSONObject data=snapshot(task("active",status,"2026-11-14T09:00:00Z"));
            data.getJSONObject("state").getJSONArray("tasks").put(task("newer-history","completed","2026-11-14T10:00:00Z"));
            RearStatus.ViewState view=RearStatus.from(data,1_500,false);
            assertEquals(status,"active",view.taskId());assertTrue(view.canStop());
        }
    }
    @Test public void newestUnresolvedTaskRemainsStoppableWithoutOverridingByStatus()throws Exception {
        JSONObject data=snapshot(task("old-completed","completed","2026-11-13T09:00:00Z"));
        data.getJSONObject("state").getJSONArray("tasks").put(task("new-unknown","unknown_result","2026-11-14T10:00:00Z"));
        RearStatus.ViewState view=RearStatus.from(data,1_500,false);
        assertEquals("new-unknown",view.taskId());assertEquals("结果待核实",view.status());assertTrue(view.canStop());
    }

    @Test public void actualDisplayTaskWinsOverNewerParallelActiveTask()throws Exception {
        for(String active:new String[]{"queued","running","waiting_children","waiting_approval","waiting_consent"}){
            JSONObject data=snapshot(task("parallel","running","2026-11-14T10:00:00Z")).put("displayTaskId","display-task");
            data.getJSONObject("state").getJSONArray("tasks").put(task("display-task",active,"2026-11-14T09:00:00Z").put("phase","实际后台任务阶段"));
            RearStatus.ViewState view=RearStatus.from(data,1_500,false);
            assertEquals(active,"display-task",view.taskId());assertEquals("实际后台任务阶段",view.phase());
            RearStatus.ViewState locked=RearStatus.from(data,1_500,true);
            assertEquals("display-task",locked.taskId());assertEquals("",locked.title());assertEquals("",locked.phase());
        }
    }
    @Test public void absentTerminalAndHandoffPreferencesCannotOverrideRealActiveTask()throws Exception {
        for(String status:new String[]{"completed","failed","stopped","cancelled","expired","blocked","needs_input","ready_for_user","unknown_result","waiting_setup","waiting_user"}){
            JSONObject data=snapshot(task("preferred",status,"2026-11-14T11:00:00Z")).put("displayTaskId","preferred");
            data.getJSONObject("state").getJSONArray("tasks").put(task("active","running","2026-11-14T10:00:00Z"));
            assertEquals(status,"active",RearStatus.from(data,1_500,false).taskId());
            data.put("displayTaskId","not-in-state");assertEquals("active",RearStatus.from(data,1_500,false).taskId());
        }
    }
    @Test public void noActiveTaskKeepsRecentOutcomeInsteadOfOldDisplayPreference()throws Exception {
        JSONObject data=snapshot(task("old-display","blocked","2026-11-13T10:00:00Z")).put("displayTaskId","old-display");
        data.getJSONObject("state").getJSONArray("tasks").put(task("latest","completed","2026-11-14T10:00:00Z"));
        assertEquals("latest",RearStatus.from(data,1_500,false).taskId());
    }

}
