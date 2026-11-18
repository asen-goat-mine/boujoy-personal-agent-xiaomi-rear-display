package dev.boujoy.personalagent;

import org.json.*;
import java.util.*;

/** Execution tasks share one conversation; a selected child is an alias, never a new chat. */
public final class ConversationIdentity {
    private ConversationIdentity() {}
    public static JSONArray tasks(JSONObject snapshot){JSONObject state=snapshot==null?null:snapshot.optJSONObject("state");JSONArray rows=state==null?null:state.optJSONArray("tasks");return rows==null?new JSONArray():rows;}
    public static String resolve(JSONArray tasks,String id){
        if(id==null||id.isBlank())return id;
        Map<String,String> parents=new HashMap<>();for(int i=0;i<tasks.length();i++){JSONObject row=tasks.optJSONObject(i);if(row!=null)parents.put(ChatPresenter.string(row,"id"),ChatPresenter.string(row,"conversationId"));}
        return resolve(parents,id);
    }
    static String resolve(Map<String,String> parents,String id){
        if(id==null||id.isBlank())return id;
        Set<String> visited=new HashSet<>();String current=id;
        while(visited.add(current)){String parent=parents.get(current);if(parent==null||parent.isBlank()||parent.equals(current))return current;current=parent;}
        return id; // Malformed cycles cannot merge unrelated chats.
    }
    public static boolean privateTask(JSONObject task){return task!=null&&ChatPresenter.string(task,"groupId").isBlank()&&task.optJSONObject("groupContext")==null&&ChatPresenter.string(task,"parentId").isBlank()&&!ChatPresenter.string(task,"conversationId").startsWith("group:");}
    public static List<JSONObject> latest(JSONArray tasks,String role){
        Map<String,JSONObject> rows=new LinkedHashMap<>();for(int i=tasks.length()-1;i>=0;i--){JSONObject task=tasks.optJSONObject(i);if(!privateTask(task)||!role.equals(task.optString("roleId","concierge")))continue;String id=resolve(tasks,ChatPresenter.string(task,"id"));if(!id.isBlank())rows.putIfAbsent(id,task);}
        return List.copyOf(rows.values());
    }
}
