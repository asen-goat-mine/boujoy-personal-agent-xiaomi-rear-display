package dev.boujoy.personalagent;

import org.json.*;
import java.util.*;

/** Bounded, versioned read cache; a late reply from another task version/binding cannot overwrite history. */
public final class TaskDetailCache {
    public record Request(String id,String version,long generation) {}
    private final Map<String,String> conversations=new HashMap<>();
    private final Map<String,String> desired=new LinkedHashMap<>();
    private final Map<String,JSONObject> details=new HashMap<>();
    private final Map<String,Request> pending=new HashMap<>();
    private final Map<String,Long> retryAt=new HashMap<>();
    private final Set<String> failures=new HashSet<>();
    private long generation;
    private String focus;
    public synchronized void focus(String id){focus=id;}
    public synchronized void clear(){generation++;desired.clear();conversations.clear();details.clear();pending.clear();retryAt.clear();failures.clear();}
    public synchronized void update(JSONArray tasks){
        Map<String,String> next=new LinkedHashMap<>();if(tasks!=null)for(int i=tasks.length()-1;i>=0&&next.size()<150;i--){JSONObject task=tasks.optJSONObject(i);if(ConversationIdentity.privateTask(task)&&!ChatPresenter.string(task,"id").isBlank()){next.put(ChatPresenter.string(task,"id"),ChatPresenter.taskVersion(task));conversations.put(ChatPresenter.string(task,"id"),ChatPresenter.string(task,"conversationId"));}}
        for(String id:next.keySet())if(!Objects.equals(desired.get(id),next.get(id)))retryAt.remove(id);
        desired.clear();desired.putAll(next);details.keySet().retainAll(next.keySet());conversations.keySet().retainAll(next.keySet());retryAt.keySet().retainAll(next.keySet());failures.retainAll(next.keySet());
    }
    public synchronized List<Request> requests(long now,int concurrency){
        String canonical=ConversationIdentity.resolve(conversations,focus);
        List<Request> result=new ArrayList<>();for(var entry:desired.entrySet()){
            if(pending.size()>=concurrency)break;String id=entry.getKey();if(focus!=null&&(focus.isBlank()||!canonical.equals(ConversationIdentity.resolve(conversations,id))))continue;JSONObject cached=details.get(id);
            if(pending.containsKey(id)||retryAt.getOrDefault(id,0L)>now||(cached!=null&&entry.getValue().equals(ChatPresenter.string(cached,"version"))))continue;
            Request request=new Request(id,entry.getValue(),generation);pending.put(id,request);result.add(request);
        }return result;
    }
    public synchronized boolean complete(Request request,JSONObject detail,long now){
        if(!request.equals(pending.get(request.id())))return false;pending.remove(request.id());
        if(request.generation()!=generation||!request.version().equals(desired.get(request.id())))return false;
        if(!request.id().equals(ChatPresenter.string(detail,"id"))||!request.version().equals(ChatPresenter.taskVersion(detail))||detail.optJSONArray("messages")==null){retryAt.put(request.id(),now+4000);return false;}
        try{details.put(request.id(),new JSONObject().put("version",request.version()).put("detail",new JSONObject(detail.toString())));retryAt.remove(request.id());failures.remove(request.id());return true;}catch(JSONException e){return false;}
    }
    public synchronized void failed(Request request,long now){if(request.equals(pending.get(request.id()))){pending.remove(request.id());retryAt.put(request.id(),now+8000);failures.add(request.id());}}
    public synchronized JSONObject snapshot(){JSONObject result=new JSONObject();try{for(String id:desired.keySet()){JSONObject value=details.containsKey(id)?new JSONObject(details.get(id).toString()):new JSONObject();if(failures.contains(id))value.put("readFailed",true);if(value.length()>0)result.put(id,value);}}catch(JSONException ignored){}return result;}
}
