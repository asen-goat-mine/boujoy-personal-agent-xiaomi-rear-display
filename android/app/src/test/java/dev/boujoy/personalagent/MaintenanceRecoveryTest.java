package dev.boujoy.personalagent;

import org.junit.Test;
import static org.junit.Assert.*;

/** Control handoff tests include lost replies, persisted pauses, and concurrent user stops. */
public class MaintenanceRecoveryTest {
    static class Memory extends ControlStateTest.Memory {
        String reason="";long origin=-1;
        public String reason(){return reason;}public long maintenanceOrigin(){return origin;}
        public void save(long epoch,boolean paused,String reason,long origin){super.save(epoch,paused);this.reason=reason;this.origin=origin;}
    }
    @Test public void maintenanceNeedsAuthenticatedNewGenerationAndExactAcknowledgement(){
        ControlState gate=new ControlState(new Memory());long admitted=gate.resumeExplicitly();
        assertTrue(gate.observeMaintenance(admitted+1,admitted));assertTrue(gate.paused());
        ControlState.Snapshot pending=gate.snapshot();
        assertFalse(gate.permitsData(admitted));assertFalse(gate.permitsData(admitted+1));
        assertFalse(gate.acknowledgeMaintenance(pending,admitted,admitted+2,true));
        assertFalse(gate.acknowledgeMaintenance(pending,admitted,admitted+3,false));
        assertFalse(gate.acknowledgeMaintenance(pending,admitted-1,admitted+2,false));
        assertTrue(gate.acknowledgeMaintenance(pending,admitted,admitted+2,false));
        assertTrue(gate.permitsSubmission(admitted+2,admitted+2));assertFalse(gate.permitsData(admitted));
    }
    @Test public void userStopOrLockAndLegacyUnknownPauseCannotBecomeMaintenance(){
        for(String reason:new String[]{"screen_off","notification_stop","local_stop","phone_restart"}){
            ControlState gate=new ControlState(new Memory());long admitted=gate.resumeExplicitly();gate.pause(reason);
            gate.observeMaintenance(admitted+10,admitted);
            assertFalse(reason,gate.canResumeMaintenance(admitted+10,admitted));assertTrue(gate.paused());
        }
        ControlState old=new ControlState(new ControlStateTest.Memory());old.observeMaintenance(8,0);
        assertFalse(old.canResumeMaintenance(8,0));assertTrue(old.paused());
    }
    @Test public void newerLocalStopWinsOverAnInFlightMaintenanceReply(){
        ControlState gate=new ControlState(new Memory());long admitted=gate.resumeExplicitly();gate.observeMaintenance(admitted+1,admitted);
        ControlState.Snapshot pending=gate.snapshot();gate.pause("screen_off");
        assertFalse(gate.acknowledgeMaintenance(pending,admitted,admitted+2,false));assertTrue(gate.paused());
        gate.observeMaintenance(admitted+10,admitted);assertFalse(gate.canResumeMaintenance(admitted+10,admitted));
    }
    @Test public void repeatedMaintenanceKeepsTheOriginalAdmissionButCannotAcceptStaleReply(){
        Memory memory=new Memory();ControlState gate=new ControlState(memory);long admitted=gate.resumeExplicitly();gate.observeMaintenance(admitted+1,admitted);
        ControlState.Snapshot stale=gate.snapshot();assertTrue(gate.observeMaintenance(admitted+2,admitted));
        assertFalse(gate.acknowledgeMaintenance(stale,admitted,admitted+2,false));
        ControlState recreated=new ControlState(memory);assertTrue(recreated.canResumeMaintenance(admitted+2,admitted));
        assertTrue(recreated.acknowledgeMaintenance(recreated.snapshot(),admitted,admitted+3,false));
    }
    @Test public void acknowledgementCannotGrantControlWhenPersistenceFails(){
        Memory memory=new Memory();ControlState gate=new ControlState(memory);long admitted=gate.resumeExplicitly();gate.observeMaintenance(admitted+1,admitted);
        memory.fail=true;ControlState.Snapshot expected=gate.snapshot();
        assertThrows(IllegalStateException.class,()->gate.acknowledgeMaintenance(expected,admitted,admitted+2,false));
        assertTrue(gate.paused());assertEquals(admitted+1,gate.epoch());
    }
    @Test public void maintenanceCannotJumpOverAnUnacknowledgedLocalChange(){
        ControlState gate=new ControlState(new Memory());long admitted=gate.resumeExplicitly();gate.resumeExplicitly();
        gate.observeMaintenance(admitted+3,admitted);assertFalse(gate.canResumeMaintenance(admitted+3,admitted));assertTrue(gate.paused());
    }
    @Test public void ordinaryRemoteRepliesStillNeverResumeControl(){
        ControlState gate=new ControlState(new Memory());long admitted=gate.resumeExplicitly();gate.observeMaintenance(admitted+1,admitted);
        gate.observeRemote(admitted+2,false);assertTrue(gate.paused());assertFalse(gate.canResumeMaintenance(admitted+2,admitted));
    }
    @Test public void malformedMaintenanceStillRevokesOldAdmissionWithoutGrantingAutoResume(){
        for(long origin:new long[]{-1,20,21}){
            ControlState gate=new ControlState(new Memory());long admitted=gate.resumeExplicitly();
            assertTrue(gate.observeMaintenance(20,origin));assertTrue(gate.paused());assertFalse(gate.permitsData(admitted));
            assertFalse(gate.canResumeMaintenance(20,origin));
        }
    }
}
