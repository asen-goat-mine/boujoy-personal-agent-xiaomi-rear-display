package dev.boujoy.personalagent;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class DisplayCommandGuardTest {
    private JSONObject session(String id,long gen,int display)throws Exception{return new JSONObject().put("sessionId",id).put("generation",gen).put("displayId",display);}
    private JSONObject args(String id,int window)throws Exception{return new JSONObject().put("observation_id",id).put("expected_window_id",window);}
    @Test public void reclaimedGenerationRejectsOldSessionAndItsObservations()throws Exception {
        DisplayCommandGuard guard=new DisplayCommandGuard();JSONObject first=session("session-a",1,7),second=session("session-b",2,7);
        guard.observed("obs-1",first,123,"test.app",1);guard.invalidate(first);
        assertFalse(guard.validSession(first,first));assertFalse(guard.validSession(first,second));assertTrue(guard.validSession(second,second));
        assertEquals("STALE_OBSERVATION",guard.checkObservation(second,args("obs-1",123),123,"test.app",1));
    }
    @Test public void sameGenerationOnAnotherDisplayNeverBorrowsEvidence()throws Exception {
        DisplayCommandGuard guard=new DisplayCommandGuard();JSONObject first=session("same",1,7),other=session("same",1,8);
        guard.observed("obs",first,123,"test.app",4);
        assertEquals("STALE_OBSERVATION",guard.checkObservation(other,args("obs",123),123,"test.app",4));assertFalse(guard.validSession(first,other));
    }
    @Test public void onlyLatestObservationForWindowMayAuthorizeAction()throws Exception {
        DisplayCommandGuard guard=new DisplayCommandGuard();JSONObject session=session("same",1,7);
        guard.observed("old",session,123,"test.app",4);guard.observed("new",session,123,"test.app",4);
        assertEquals("STALE_OBSERVATION",guard.checkObservation(session,args("old",123),123,"test.app",4));assertNull(guard.checkObservation(session,args("new",123),123,"test.app",4));
        guard.forgetObservation();assertEquals("STALE_OBSERVATION",guard.checkObservation(session,args("new",123),123,"test.app",4));
    }
    @Test public void changedPackageOrWindowCannotAuthorizeInput()throws Exception {
        DisplayCommandGuard guard=new DisplayCommandGuard();JSONObject session=session("same",1,7);guard.observed("obs",session,123,"test.app",4);
        assertEquals("WINDOW_CHANGED",guard.checkObservation(session,args("obs",124),123,"test.app",4));
        assertEquals("WINDOW_CHANGED",guard.checkObservation(session,args("obs",123),124,"test.app",4));
        assertEquals("WINDOW_CHANGED",guard.checkObservation(session,args("obs",123),123,"other.app",4));
        assertNull("an in-window content version change alone does not expire the latest observation",guard.checkObservation(session,args("obs",123),123,"test.app",5));
    }
    @Test public void malformedAndMainDisplaySessionsAreRejected()throws Exception {
        DisplayCommandGuard guard=new DisplayCommandGuard();
        assertNull(DisplayCommandGuard.Session.read(session("same",1,0)));assertNull(DisplayCommandGuard.Session.read(session("",1,7)));assertNull(DisplayCommandGuard.Session.read(session("same",0,7)));
        assertFalse(guard.validSession(null,null));assertFalse(guard.validSession(new JSONObject(),new JSONObject()));
    }
    private static class Memory implements ControlState.Storage {
        long epoch;boolean paused;String reason="";
        public long epoch(){return epoch;}public boolean paused(){return paused;}public String reason(){return reason;}
        public void save(long value,boolean flag){epoch=value;paused=flag;}
        public void save(long value,boolean flag,String why,long origin){save(value,flag);reason=why;}
    }
    @Test public void rearStopSurvivesReconnectUnlockAndProcessRecreation() {
        Memory store=new Memory();ControlState gate=new ControlState(store);long before=gate.epoch();gate.pause("rear_stop");
        assertEquals("LOCALLY_PAUSED",DisplayCommandGuard.admission(gate,before,200,100,false));
        gate.observeRemote(gate.epoch()+3,false);assertTrue(gate.paused());assertFalse(gate.pausedByScreenOff());assertFalse(gate.screenOffPauses());
        ControlState restored=new ControlState(store);assertTrue(restored.paused());assertFalse(restored.pausedByScreenOff());assertFalse(restored.permitsData(restored.epoch()));
    }
    @Test public void deadlineAndLockRecheckedAtDispatchTime() {
        ControlState gate=new ControlState(new Memory());
        assertNull(DisplayCommandGuard.admission(gate,0,101,100,false));assertEquals("EXPIRED",DisplayCommandGuard.admission(gate,0,100,100,false));
        assertEquals("EXPIRED",DisplayCommandGuard.admission(gate,0,0,100,false));assertEquals("LOCKED",DisplayCommandGuard.admission(gate,0,101,100,true));
        assertEquals("LOCALLY_PAUSED",DisplayCommandGuard.admission(gate,-1,101,100,false));
    }
    @Test public void laterInvalidationCannotResurrectAnyEarlierGeneration()throws Exception {
        DisplayCommandGuard guard=new DisplayCommandGuard();JSONObject first=session("first",1,7),second=session("second",2,8),third=session("third",3,9);
        guard.invalidate(first);guard.invalidate(second);
        assertFalse(guard.validSession(first,first));assertFalse(guard.validSession(second,second));assertTrue(guard.validSession(third,third));
        assertThrows(IllegalStateException.class,()->guard.observed("old",first,123,"test.app",1));
    }

}
