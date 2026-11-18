package dev.boujoy.personalagent;

import org.json.*;
import java.util.Set;
import java.util.function.LongSupplier;

/** A bounded, explicit-user screen lease. Polling/reconnection never acquires or extends it. */
public final class ScreenHold {
    public static final long MAX_MILLIS=300000;
    public interface Actuator {void acquire(long timeoutMillis);void release();}
    private final Actuator actuator;private final LongSupplier clock;
    private long epoch=-1,until,acceptedAfterSnapshot;private String taskId="";private boolean held,accepted;
    public ScreenHold(Actuator actuator,LongSupplier clock){this.actuator=actuator;this.clock=clock;}
    public synchronized boolean begin(long requestedEpoch,boolean unlocked,boolean interactive,boolean online){
        release();if(requestedEpoch<0||!unlocked||!interactive||!online)return false;
        epoch=requestedEpoch;until=clock.getAsLong()+MAX_MILLIS;
        try{held=true;actuator.acquire(MAX_MILLIS);return true;}catch(RuntimeException e){release();throw e;}
    }
    public synchronized void accepted(long requestEpoch,String id,String status,long lastStartedSnapshot){
        if(!held||requestEpoch!=epoch)return;taskId=id==null?"":id;accepted=true;acceptedAfterSnapshot=lastStartedSnapshot;
        if(status!=null&&!status.isBlank()&&!activeStatus(status))release();
    }
    public synchronized void update(long currentEpoch,boolean paused,boolean online,boolean unlocked,boolean interactive,JSONArray tasks,long snapshotSerial){
        if(!held)return;
        if(epoch!=currentEpoch||paused||!online||!unlocked||!interactive||clock.getAsLong()>=until){release();return;}
        if(accepted&&snapshotSerial>acceptedAfterSnapshot&&!taskId.isBlank()&&tasks!=null)for(int i=0;i<tasks.length();i++){
            JSONObject task=tasks.optJSONObject(i);if(task!=null&&taskId.equals(task.optString("id"))){if(!activeStatus(task.optString("status")))release();return;}
        }
    }
    private static boolean activeStatus(String status){return Set.of("queued","running","waiting_children").contains(status);}
    public synchronized void releaseIfEpoch(long requestedEpoch){if(epoch==requestedEpoch)release();}
    public synchronized void release(){if(held)try{actuator.release();}finally{held=false;}epoch=-1;until=0;accepted=false;taskId="";}
    public synchronized boolean held(){return held;}
}
