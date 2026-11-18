package dev.boujoy.personalagent;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.Test;
import static org.junit.Assert.*;
public class HandoffTaskMoverTest {
    private HandoffTaskMover.Root target(){return new HandoffTaskMover.Root(42,7,0,3,true,"target.app");}
    private class Platform implements HandoffTaskMover.Platform {
        List<HandoffTaskMover.Root> source=new ArrayList<>(List.of(target())),main=new ArrayList<>();
        HandoffTaskMover.Root focused;int moves,focuses;boolean failMove,failFocus,replaceIdentity;
        public List<HandoffTaskMover.Root> roots(int display){return new ArrayList<>(display==0?main:source);}
        public HandoffTaskMover.Root focused(){return focused;}
        public void move(int id,int display){moves++;assertEquals(42,id);assertEquals(0,display);if(failMove)throw new IllegalStateException("move rejected");source.clear();main.add(new HandoffTaskMover.Root(replaceIdentity?43:id,0,0,1,true,"target.app"));}
        public void focus(int id){focuses++;if(failFocus)throw new IllegalStateException("focus rejected");focused=main.get(0);}
    }
    private void run(Platform p,java.util.function.BooleanSupplier before,java.util.function.BooleanSupplier live)throws Exception {
        AtomicLong clock=new AtomicLong();HandoffTaskMover.moveAndConfirm(p,target(),7,before,live,clock::get,clock::addAndGet);
    }
    @Test public void pendingDoesNotMoveAndRequiresAnExplicitCurrentClick()throws Exception {
        Platform p=new Platform();assertEquals(0,p.moves);
        assertThrows(IllegalStateException.class,()->run(p,()->false,()->true));assertEquals(0,p.moves);assertEquals(0,p.focuses);
    }
    @Test public void successRequiresSameTaskOnMainAndFocused()throws Exception {
        Platform p=new Platform();run(p,()->true,()->true);assertEquals(1,p.moves);assertEquals(1,p.focuses);
        assertTrue(HandoffTaskMover.confirmed(target(),p.main,p.focused));
        assertFalse(HandoffTaskMover.confirmed(target(),p.main,new HandoffTaskMover.Root(9,0,0,1,true,"other.app")));
    }
    @Test public void normalTrampolineFocusLossAfterMoveDoesNotCancel()throws Exception {
        AtomicBoolean clicked=new AtomicBoolean(true);Platform p=new Platform(){@Override public void move(int id,int display){super.move(id,display);clicked.set(false);}};
        run(p,clicked::get,()->true);assertFalse(clicked.get());assertTrue(HandoffTaskMover.confirmed(target(),p.main,p.focused));
    }
    @Test public void failedMovePreservesOriginalTaskAndDoesNotRetryAutomatically()throws Exception {
        Platform p=new Platform();p.failMove=true;assertThrows(IllegalStateException.class,()->run(p,()->true,()->true));
        assertEquals(1,p.moves);assertEquals(1,p.source.size());assertTrue(p.main.isEmpty());
        p.failMove=false;run(p,()->true,()->true);assertEquals(2,p.moves);
    }
    @Test public void retryAfterPartialMoveFocusesSameTaskWithoutMovingOrLaunchingAgain()throws Exception {
        Platform p=new Platform();p.failFocus=true;assertThrows(IllegalStateException.class,()->run(p,()->true,()->true));assertEquals(1,p.moves);
        p.failFocus=false;run(p,()->true,()->true);assertEquals(1,p.moves);assertEquals(2,p.focuses);
    }
    @Test public void stopAfterMovementPreventsFocusAndSuccess()throws Exception {
        Platform p=new Platform();assertThrows(IllegalStateException.class,()->run(p,()->true,()->false));assertEquals(1,p.moves);assertEquals(0,p.focuses);
    }
    @Test public void differentTaskCanNeverConfirmOriginalMovement()throws Exception {
        Platform p=new Platform();p.replaceIdentity=true;assertThrows(IllegalStateException.class,()->run(p,()->true,()->true));assertEquals(1,p.moves);assertEquals(0,p.focuses);
    }
    @Test public void selectionIsLimitedToVisibleTopRootOnOwnedDisplay(){
        HandoffTaskMover.Root workspace=new HandoffTaskMover.Root(3,7,0,9,true,"boujoy.app");
        HandoffTaskMover.Root unrelated=new HandoffTaskMover.Root(4,0,0,10,true,"other.app");
        HandoffTaskMover.Root hidden=new HandoffTaskMover.Root(5,7,0,11,false,"other.app");
        assertEquals(target(),HandoffTaskMover.select(List.of(workspace,unrelated,hidden,target()),7,"boujoy.app"));
        assertThrows(IllegalStateException.class,()->HandoffTaskMover.select(List.of(unrelated),0,"boujoy.app"));
    }
    @Test public void stopDuringPostMoveQueryPreventsTheActualFocusCall()throws Exception {
        AtomicBoolean live=new AtomicBoolean(true);Platform p=new Platform(){@Override public HandoffTaskMover.Root focused(){live.set(false);return null;}};
        assertThrows(IllegalStateException.class,()->run(p,()->true,live::get));assertEquals(1,p.moves);assertEquals(0,p.focuses);
    }

}
