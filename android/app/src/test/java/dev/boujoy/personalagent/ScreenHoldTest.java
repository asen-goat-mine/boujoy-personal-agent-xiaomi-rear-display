package dev.boujoy.personalagent;

import org.json.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class ScreenHoldTest {
    static class Device implements ScreenHold.Actuator{int acquired,released;long timeout;public void acquire(long value){acquired++;timeout=value;}public void release(){released++;}}
    @Test public void cannotWakeLockedOffOrOfflinePhoneAndNeverRenewsFromPolls(){
        Device device=new Device();long[] now={100};ScreenHold hold=new ScreenHold(device,()->now[0]);
        assertFalse(hold.begin(1,false,true,true));assertFalse(hold.begin(1,true,false,true));assertFalse(hold.begin(1,true,true,false));assertEquals(0,device.acquired);
        assertTrue(hold.begin(2,true,true,true));assertEquals(300000,device.timeout);
        now[0]=200000;hold.update(2,false,true,true,true,new JSONArray(),1);assertTrue(hold.held());assertEquals(1,device.acquired);
        now[0]=300100;hold.update(2,false,true,true,true,new JSONArray(),2);assertFalse(hold.held());assertEquals(1,device.released);
        hold.update(2,false,true,true,true,new JSONArray(),3);assertEquals(1,device.acquired);
    }
    @Test public void pauseDisconnectLockScreenOffAndNewEpochReleaseWithoutReacquisition(){
        boolean[][] states={{true,true,true,true},{false,false,true,true},{false,true,false,true},{false,true,true,false}};
        for(boolean[] state:states){Device device=new Device();ScreenHold hold=new ScreenHold(device,()->0);hold.begin(7,true,true,true);hold.update(7,state[0],state[1],state[2],state[3],new JSONArray(),1);assertFalse(hold.held());assertEquals(1,device.released);hold.update(7,false,true,true,true,new JSONArray(),2);assertFalse(hold.held());}
        Device device=new Device();ScreenHold hold=new ScreenHold(device,()->0);hold.begin(8,true,true,true);hold.update(9,false,true,true,true,new JSONArray(),1);assertFalse(hold.held());
    }
    @Test public void onlyCurrentAcceptedTaskControlsCompletionAndStaleRepliesCannotReleaseNewLease(){
        Device device=new Device();ScreenHold hold=new ScreenHold(device,()->0);hold.begin(11,true,true,true);
        JSONArray old=new JSONArray().put(Tunnel.json("id","task","status","waiting_consent"));hold.update(11,false,true,true,true,old,4);assertTrue(hold.held());
        hold.accepted(11,"task","queued",4);hold.update(11,false,true,true,true,old,4);assertTrue("An earlier in-flight snapshot must not cancel the new grant",hold.held());
        hold.update(11,false,true,true,true,new JSONArray().put(Tunnel.json("id","other","status","completed")),5);assertTrue(hold.held());
        hold.update(11,false,true,true,true,new JSONArray().put(Tunnel.json("id","task","status","ready_for_user")),6);assertFalse(hold.held());
        hold.begin(12,true,true,true);hold.accepted(11,"task","completed",7);hold.releaseIfEpoch(11);assertTrue(hold.held());hold.accepted(12,"task","waiting_approval",7);assertFalse(hold.held());
    }
}
