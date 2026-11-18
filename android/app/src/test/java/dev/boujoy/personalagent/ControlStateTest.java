package dev.boujoy.personalagent;
import org.junit.Test;
import static org.junit.Assert.*;

public class ControlStateTest {
    static class Memory implements ControlState.Storage{
        long epoch;boolean paused=true;boolean fail;
        public long epoch(){return epoch;}public boolean paused(){return paused;}
        public void save(long value,boolean flag){if(fail)throw new IllegalStateException("disk full");epoch=value;paused=flag;}
    }
    @Test public void pausedSurvivesRecreationAndOldEpochNeverResumes(){
        Memory memory=new Memory();ControlState state=new ControlState(memory);
        long old=state.resumeExplicitly();assertTrue(state.permitsData(old));
        long stop=state.pause();assertFalse(state.permitsData(old));assertFalse(state.permitsData(stop));
        ControlState restored=new ControlState(memory);assertTrue(restored.paused());assertEquals(stop,restored.epoch());
        long next=restored.resumeExplicitly();assertTrue(next>stop);assertFalse(restored.permitsData(old));assertTrue(restored.permitsData(next));
    }
    @Test public void failedPersistenceDoesNotGrantControl(){
        Memory memory=new Memory();ControlState state=new ControlState(memory);memory.fail=true;
        assertThrows(IllegalStateException.class,state::resumeExplicitly);assertTrue(state.paused());assertEquals(0,state.epoch());
    }
    @Test public void failedStopRevokesQueuedInputAndRequiresADurableNewResume(){
        Memory memory=new Memory();ControlState state=new ControlState(memory);
        long submitted=state.resumeExplicitly();
        java.util.function.BooleanSupplier queuedInputAllowed=()->state.permitsData(submitted);
        assertTrue(queuedInputAllowed.getAsBoolean());memory.fail=true;
        assertThrows(IllegalStateException.class,()->state.pause("explicit_stop"));
        long revoked=state.epoch();assertTrue(revoked>submitted);assertTrue(state.paused());
        assertFalse("queued input checks the gate when delivery runs",queuedInputAllowed.getAsBoolean());
        assertFalse(state.permitsData(revoked));
        assertThrows(IllegalStateException.class,state::resumeExplicitly);
        assertEquals(revoked,state.epoch());assertTrue(state.paused());
        memory.fail=false;long resumed=state.resumeExplicitly();
        assertTrue(resumed>revoked);assertTrue(state.permitsData(resumed));
        assertFalse("new consent cannot authorize the old queued input",queuedInputAllowed.getAsBoolean());
    }
    @Test public void revocationAlreadyAppliesWhileStorageIsSaving(){
        ControlState[] current=new ControlState[1];boolean[] inspected={false};
        Memory memory=new Memory(){@Override public void save(long value,boolean flag){
            if(flag&&current[0]!=null){
                assertTrue(current[0].paused());assertEquals(value,current[0].epoch());
                assertFalse(current[0].permitsData(value-1));inspected[0]=true;
            }
            super.save(value,flag);
        }};
        ControlState state=new ControlState(memory);current[0]=state;state.resumeExplicitly();memory.fail=true;
        assertThrows(IllegalStateException.class,state::pause);assertTrue(inspected[0]);assertTrue(state.paused());
    }
    @Test public void failedScreenOffCannotBeResumedByUnlockOrRemoteReplies(){
        Memory memory=new Memory();ControlState state=new ControlState(memory);long old=state.resumeExplicitly();memory.fail=true;
        assertThrows(IllegalStateException.class,()->state.pause("screen_off"));long stopped=state.epoch();
        assertTrue(state.paused());assertFalse(state.pausedByScreenOff());assertFalse(state.screenOffPauses());
        memory.fail=false;assertFalse(state.observeRemote(stopped,false));assertTrue(state.paused());
        assertTrue(state.observeRemote(stopped+1,false));assertTrue(state.paused());assertFalse(state.pausedByScreenOff());
        assertFalse(state.permitsData(old));assertFalse(state.permitsData(state.epoch()));
    }
    @Test public void failedRemoteRevocationRejectsBothSameAndNewEpochReplies(){
        for(boolean advance:new boolean[]{false,true}){
            Memory memory=new Memory();ControlState state=new ControlState(memory);long old=state.resumeExplicitly();memory.fail=true;
            long remote=old+(advance?1:0);
            assertThrows(IllegalStateException.class,()->state.observeRemote(remote,true));
            assertEquals(remote,state.epoch());assertTrue(state.paused());assertFalse(state.permitsData(old));
            assertFalse(state.observeRemote(remote,false));assertTrue(state.paused());
        }
    }
    @Test public void failedMaintenancePauseCannotBorrowItsResumeAcknowledgement(){
        Memory memory=new Memory();ControlState state=new ControlState(memory);long origin=state.resumeExplicitly();memory.fail=true;
        assertThrows(IllegalStateException.class,()->state.observeMaintenance(origin+1,origin));
        ControlState.Snapshot stopped=state.snapshot();assertTrue(stopped.paused());
        assertFalse(state.canResumeMaintenance(stopped.epoch(),origin));
        memory.fail=false;
        assertFalse(state.acknowledgeMaintenance(stopped,origin,stopped.epoch()+1,false));
        assertTrue(state.observeMaintenance(stopped.epoch()+1,origin));
        assertFalse(state.canResumeMaintenance(state.epoch(),origin));assertTrue(state.paused());
        assertFalse(state.permitsData(origin));
    }
    @Test public void remoteRepliesNeverRegressOrResumeLocalAdmission(){
        Memory memory=new Memory();ControlState state=new ControlState(memory);
        long first=state.resumeExplicitly();long stop=state.pause();
        assertFalse(state.observeRemote(first,false));assertEquals(stop,state.epoch());assertTrue(state.paused());
        assertTrue(state.observeRemote(20,false));assertEquals(20,state.epoch());assertTrue(state.paused());
        assertFalse(state.observeRemote(20,false));assertFalse(state.permitsData(20));
        long userResume=state.resumeExplicitly();assertTrue(state.permitsData(userResume));
        assertFalse(state.observeRemote(20,true));assertTrue(state.permitsData(userResume));
        assertTrue(state.observeRemote(userResume,true));assertFalse(state.permitsData(userResume));
    }
    @Test public void queuedIntentKeepsClickTimeGenerationAndCannotBorrowNewerConsent(){
        ControlState state=new ControlState(new Memory());
        long clicked=state.resumeExplicitly();ControlState.Snapshot queued=new ControlState.Snapshot(clicked,false);
        state.pause();assertFalse(state.matches(queued));
        long newer=state.resumeExplicitly();assertFalse(state.matches(queued));assertTrue(state.permitsData(newer));
        // A delayed failure from queued must not revoke this newer request either.
        assertNotEquals(clicked,state.epoch());
    }
    @Test public void onlyAScreenOffPauseIsEligibleForUnlockResume(){
        Memory memory=new Memory();ControlState state=new ControlState(memory);
        state.resumeExplicitly();state.pause("screen_off");assertTrue(state.pausedByScreenOff());
        state.resumeExplicitly();assertFalse(state.pausedByScreenOff());
        state.pause("explicit_takeover");assertFalse(state.pausedByScreenOff());
        state.pause("notification_stop");assertFalse(state.pausedByScreenOff());
        state.pause("screen_off");state.pause("explicit_stop");assertFalse("a later user stop wins",state.pausedByScreenOff());
    }
    @Test public void screenOffNeverRelabelsAStopOrTakeover(){
        Memory memory=new Memory();ControlState state=new ControlState(memory);
        state.resumeExplicitly();state.pause("explicit_takeover");long epoch=state.epoch();
        assertFalse("a takeover keeps its reason when the screen goes off",state.screenOffPauses());assertEquals(epoch,state.epoch());assertFalse("unlock must not resume a takeover",state.pausedByScreenOff());
        state.resumeExplicitly();assertTrue(state.screenOffPauses());state.pause("screen_off");assertTrue(state.pausedByScreenOff());
    }
}
