package dev.boujoy.personalagent;

import java.time.Instant;
import java.util.Set;
import org.json.JSONObject;

/** Pure local handoff state; a failed move keeps its original, bounded retention deadline. */
final class DisplayHandoff {
    static final long RETENTION_MS=30*60*1000L;
    private String id,taskId,title,summary,state,reason,error;
    private long atMs,expiresAtMs,expiresAtElapsed;
    synchronized void begin(String id,String taskId,String title,String summary,long wall,long elapsed){
        if(id==null||id.isBlank()||taskId==null||taskId.isBlank()||title==null||summary==null
                ||title.codePointCount(0,title.length())>40||summary.codePointCount(0,summary.length())>160)
            throw new IllegalArgumentException("invalid_handoff");
        this.id=id;this.taskId=taskId;this.title=title;this.summary=summary;state="pending";reason="";error="";atMs=wall;
        expiresAtMs=Math.addExact(wall,RETENTION_MS);expiresAtElapsed=Math.addExact(elapsed,RETENTION_MS);
    }
    synchronized boolean retaining(){return "pending".equals(state)||"failed".equals(state);}
    synchronized boolean matches(String value){return id!=null&&id.equals(value);}
    synchronized boolean due(long wall,long elapsed){return retaining()&&(wall>=expiresAtMs||elapsed>=expiresAtElapsed);}
    synchronized void transition(String expected,String next,String why,String code,long wall){
        if(!matches(expected)||!retaining()||!Set.of("taken","dismissed","expired","failed").contains(next))throw new IllegalStateException("HANDOFF_STALE");
        state=next;reason=why==null?"":why;error=code==null?"":code;atMs=wall;
    }
    synchronized JSONObject snapshot(){
        if(id==null)return null;
        JSONObject result=Tunnel.json("handoffId",id,"state",state,"taskId",taskId,"title",title,"summary",summary,
                "at",Instant.ofEpochMilli(atMs).toString(),"expiresAtMs",expiresAtMs);
        try{if(!reason.isEmpty())result.put("reason",reason);if(!error.isEmpty())result.put("errorCode",error);}catch(Exception ignored){}
        return result;
    }
}
