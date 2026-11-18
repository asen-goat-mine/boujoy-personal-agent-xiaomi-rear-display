package dev.boujoy.personalagent;
import org.json.*;
import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;

public class TaskDetailCacheTest {
    @Test public void unchangedTaskVersionFetchesOnlyOnceAndGlobalHeartbeatNeverMatters()throws Exception{
        var cache=new TaskDetailCache();var task=ChatPresenterTest.summary("one","v1");cache.update(new JSONArray().put(task));var request=cache.requests(100,2).get(0);
        assertTrue(cache.complete(request,ChatPresenterTest.detail(task),101));
        cache.update(new JSONArray().put(new JSONObject(task.toString()).put("serverTime","new").put("irrelevant",99)));
        assertTrue(cache.requests(10000,2).isEmpty());assertEquals(4,cache.snapshot().getJSONObject("one").getJSONObject("detail").getJSONArray("messages").length());
    }
    @Test public void changedVersionRejectsLateReplyAndBindingResetRejectsOldWork()throws Exception{
        var cache=new TaskDetailCache();JSONObject one=ChatPresenterTest.summary("one","v1"),two=ChatPresenterTest.summary("one","v2");cache.update(new JSONArray().put(one));var old=cache.requests(100,2).get(0);
        cache.update(new JSONArray().put(two));assertFalse(cache.complete(old,ChatPresenterTest.detail(one),101));
        var fresh=cache.requests(102,2).get(0);assertTrue(cache.complete(fresh,ChatPresenterTest.detail(two),103));
        two.put("updatedAt","v3");cache.update(new JSONArray().put(two));var beforeReset=cache.requests(104,2).get(0);cache.clear();cache.update(new JSONArray().put(two));var afterReset=cache.requests(105,2).get(0);
        assertFalse(cache.complete(beforeReset,ChatPresenterTest.detail(two),106));assertTrue(cache.complete(afterReset,ChatPresenterTest.detail(two),107));
    }
    @Test public void failedReadKeepsTrueOldHistoryAndUsesBoundedRetry()throws Exception{
        var cache=new TaskDetailCache();var task=ChatPresenterTest.summary("one","v1");cache.update(new JSONArray().put(task));assertTrue(cache.complete(cache.requests(10,2).get(0),ChatPresenterTest.detail(task),11));
        task.put("updatedAt","v2");cache.update(new JSONArray().put(task));var request=cache.requests(12,2).get(0);cache.failed(request,13);
        assertTrue(cache.snapshot().getJSONObject("one").getBoolean("readFailed"));assertEquals("v1",cache.snapshot().getJSONObject("one").getJSONObject("detail").getString("updatedAt"));assertTrue(cache.requests(8012,2).isEmpty());
        assertTrue(cache.complete(cache.requests(8013,2).get(0),ChatPresenterTest.detail(task),8014));assertFalse(cache.snapshot().getJSONObject("one").optBoolean("readFailed"));
    }
    @Test public void concurrentFetchesAreBoundedAndMissingOrMismatchedHistoryIsNotAccepted()throws Exception{
        var cache=new TaskDetailCache();var tasks=new JSONArray();for(int i=0;i<5;i++)tasks.put(ChatPresenterTest.summary("task"+i,"v1"));cache.update(tasks);
        var requests=cache.requests(10,2);assertEquals(2,requests.size());assertTrue(cache.requests(10,2).isEmpty());
        assertFalse(cache.complete(requests.get(0),ChatPresenterTest.summary("task0","v1"),11));assertEquals(1,cache.requests(12,2).size());
        assertFalse(cache.complete(requests.get(1),ChatPresenterTest.detail(ChatPresenterTest.summary("other","v1")),13));
        cache.update(new JSONArray());assertEquals(0,cache.snapshot().length());
    }

    @Test public void currentConversationLoadsBeforeOlderHistoryAndNewChatDoesNotFetchAllThreads()throws Exception{
        var cache=new TaskDetailCache();JSONArray tasks=new JSONArray();for(int i=0;i<150;i++)tasks.put(ChatPresenterTest.summary("task"+i,"v1"));cache.update(tasks);cache.focus("task149");var request=cache.requests(10,2);assertEquals(1,request.size());assertEquals("task149",request.get(0).id());assertTrue(cache.complete(request.get(0),ChatPresenterTest.detail(tasks.getJSONObject(149)),11));
        cache.focus("");assertTrue(cache.requests(12,2).isEmpty());cache.focus("task20");assertEquals("task20",cache.requests(13,2).get(0).id());
    }

    @Test public void selectedChildRequestsEverySiblingWithoutNeedingTheRoot(){
        TaskDetailCache cache=new TaskDetailCache();cache.focus("child-a");cache.update(new org.json.JSONArray().put(Tunnel.json("id","child-a","conversationId","root","updatedAt","1")).put(Tunnel.json("id","child-b","conversationId","root","updatedAt","2")).put(Tunnel.json("id","other","conversationId","elsewhere","updatedAt","3")));
        assertEquals(java.util.Set.of("child-a","child-b"),cache.requests(0,4).stream().map(TaskDetailCache.Request::id).collect(java.util.stream.Collectors.toSet()));
    }
}
