package dev.boujoy.personalagent;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.Executor;
import java.util.concurrent.FutureTask;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import org.junit.Test;
import static org.junit.Assert.*;

public class RearTaskLeaseTest {
    private static RearProgressCoordinator.State state(String task,long epoch,long sync,boolean showing) {
        return new RearProgressCoordinator.State(task,epoch,sync,true,true,false,false,true,showing,"phase",false);
    }
    private static final class QueueWorker implements Executor {
        final Queue<Runnable> queue=new ArrayDeque<>();
        public void execute(Runnable work){queue.add(work);}
        void drain(){while(!queue.isEmpty())queue.remove().run();}
    }
    private record Call(String id,long generation,long deadline,BooleanSupplier allowed) {}
    private static class Backend implements RearTaskLease.Backend {
        final List<Call> calls=new ArrayList<>();
        final List<String> released=new ArrayList<>();
        public void renew(String id,long generation,long deadline,BooleanSupplier allowed)throws Exception {
            assertTrue(allowed.getAsBoolean());calls.add(new Call(id,generation,deadline,allowed));
        }
        public void release(String id,long generation)throws Exception {released.add(id+":"+generation);}
    }
    private static String identity(Call call){return call.id()+":"+call.generation();}

    @Test public void tickCannotAdmitButFirstVisibleEventUsesPreviouslySyncedTask() {
        QueueWorker worker=new QueueWorker();Backend backend=new Backend();AtomicLong now=new AtomicLong(1000);
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(state("task",4,1000,true));
        try(RearTaskLease lease=new RearTaskLease(worker,current::get,now::get,backend)) {
            lease.onPresentationChanged();worker.drain();assertTrue(backend.calls.isEmpty());
            current.set(state("task",4,1000,false));lease.onStateSynced();worker.drain();assertTrue(backend.calls.isEmpty());
            current.set(state("task",4,1000,true));lease.onPresentationChanged();worker.drain();
            assertEquals(1,backend.calls.size());assertEquals(4000,backend.calls.get(0).deadline());
        }
    }
    @Test public void renewsSameIdentityOncePerSecondAndKeepsOriginalQueuedDeadline() {
        QueueWorker worker=new QueueWorker();Backend backend=new Backend();AtomicLong now=new AtomicLong(1000);
        var current=state("task",4,1000,true);
        try(RearTaskLease lease=new RearTaskLease(worker,()->current,now::get,backend)) {
            lease.onStateSynced();now.set(1500);worker.drain();
            Call first=backend.calls.get(0);assertEquals(4000,first.deadline());
            now.set(1999);lease.onPresentationChanged();worker.drain();assertEquals(1,backend.calls.size());
            now.set(2000);lease.onStateSynced();lease.onPresentationChanged();worker.drain();
            Call second=backend.calls.get(1);assertEquals(identity(first),identity(second));assertEquals(5000,second.deadline());
            now.set(4000);assertFalse(first.allowed().getAsBoolean());assertTrue(second.allowed().getAsBoolean());
            worker.drain();assertTrue("Expiring an older renewal must not release the newer one",backend.released.isEmpty());
        }
    }
    @Test public void delayedExpiredWorkCannotStartAndRecoveryGetsANewGeneration() {
        QueueWorker worker=new QueueWorker();Backend backend=new Backend();AtomicLong now=new AtomicLong(1000);
        var current=state("task",4,1000,true);
        try(RearTaskLease lease=new RearTaskLease(worker,()->current,now::get,backend)) {
            lease.onStateSynced();now.set(4000);worker.drain();assertTrue(backend.calls.isEmpty());
            assertEquals(1,backend.released.size());
            lease.onPresentationChanged();worker.drain();assertEquals(1,backend.calls.size());
            assertEquals(7000,backend.calls.get(0).deadline());
            assertNotEquals(backend.released.get(0),identity(backend.calls.get(0)));
        }
    }
    @Test public void deadlineCannotExtendBeyondAuthenticatedStateFreshness() {
        QueueWorker worker=new QueueWorker();Backend backend=new Backend();AtomicLong now=new AtomicLong(30_000);
        var current=state("task",4,1000,true);
        try(RearTaskLease lease=new RearTaskLease(worker,()->current,now::get,backend)) {
            lease.onStateSynced();worker.drain();assertEquals(31_000,backend.calls.get(0).deadline());
            now.set(31_000);assertFalse(backend.calls.get(0).allowed().getAsBoolean());worker.drain();
            lease.onPresentationChanged();worker.drain();assertEquals(1,backend.calls.size());
        }
    }
    @Test public void hiddenVisibleTransitionRetiresPermitButKeepsOnlyTheSameAdmission() {
        QueueWorker worker=new QueueWorker();Backend backend=new Backend();AtomicLong now=new AtomicLong(1000);
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(state("task",4,1000,true));
        try(RearTaskLease lease=new RearTaskLease(worker,current::get,now::get,backend)) {
            lease.onStateSynced();worker.drain();Call first=backend.calls.get(0);
            current.set(state("task",4,1000,false));assertFalse(first.allowed().getAsBoolean());
            current.set(state("task",4,1000,true));assertFalse(first.allowed().getAsBoolean());
            lease.onPresentationChanged();worker.drain();Call second=backend.calls.get(1);
            assertTrue(second.generation()>first.generation());assertNotEquals(first.id(),second.id());
            assertTrue(backend.released.contains(identity(first)));assertTrue(second.allowed().getAsBoolean());
        }
    }
    @Test public void taskOrEpochChangeCannotBeAdmittedByTickOrReviveOldQueuedWork() {
        for(var changed:new RearProgressCoordinator.State[]{state("other",4,1000,true),state("task",5,1000,true)}) {
            QueueWorker worker=new QueueWorker();Backend backend=new Backend();AtomicLong now=new AtomicLong(1000);
            AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(state("task",4,1000,true));
            try(RearTaskLease lease=new RearTaskLease(worker,current::get,now::get,backend)) {
                lease.onStateSynced();current.set(changed);lease.onPresentationChanged();worker.drain();
                assertTrue(backend.calls.isEmpty());
                current.set(state("task",4,1000,true));lease.onPresentationChanged();worker.drain();assertTrue(backend.calls.isEmpty());
                current.set(changed);lease.onStateSynced();worker.drain();assertEquals(1,backend.calls.size());
            }
        }
    }
    @Test public void scopeGatesRevokeImmediatelyAndNeedNewSyncAfterRecovery() {
        var forbidden=new RearProgressCoordinator.State[]{
            new RearProgressCoordinator.State("task",4,40_000,false,true,false,false,true,true,"",false),
            new RearProgressCoordinator.State("task",4,40_000,true,false,false,false,true,true,"",false),
            new RearProgressCoordinator.State("task",4,40_000,true,true,true,false,true,true,"",false),
            new RearProgressCoordinator.State("task",4,40_000,true,true,false,false,false,true,"",false),
            state("",4,40_000,true),state("handoff:held",4,40_000,true),state("task",-1,40_000,true),
            state("task",4,0,true),state("task",4,40_001,true),state("task",4,9_999,true)
        };
        for(var blocked:forbidden) {
            QueueWorker worker=new QueueWorker();Backend backend=new Backend();AtomicLong now=new AtomicLong(40_000);
            AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(state("task",4,40_000,true));
            try(RearTaskLease lease=new RearTaskLease(worker,current::get,now::get,backend)) {
                lease.onStateSynced();worker.drain();Call first=backend.calls.get(0);
                current.set(blocked);assertFalse(first.allowed().getAsBoolean());worker.drain();assertTrue(backend.released.contains(identity(first)));
                current.set(state("task",4,40_000,true));lease.onPresentationChanged();worker.drain();assertEquals(1,backend.calls.size());
                lease.onStateSynced();worker.drain();assertEquals(2,backend.calls.size());assertFalse(first.allowed().getAsBoolean());
            }
        }
    }
    @Test public void lockedMainAndPhaseChangesDoNotRevokeAnAllowedBackgroundTask() {
        QueueWorker worker=new QueueWorker();Backend backend=new Backend();AtomicLong now=new AtomicLong(1000);
        AtomicReference<RearProgressCoordinator.State> current=new AtomicReference<>(state("task",4,1000,true));
        try(RearTaskLease lease=new RearTaskLease(worker,current::get,now::get,backend)) {
            lease.onStateSynced();worker.drain();Call first=backend.calls.get(0);
            current.set(new RearProgressCoordinator.State("task",4,1000,true,true,false,true,true,true,"new phase",true));
            assertTrue(first.allowed().getAsBoolean());now.set(2000);lease.onPresentationChanged();worker.drain();
            assertEquals(identity(first),identity(backend.calls.get(1)));
        }
    }
    @Test public void invalidateAndCloseCancelQueuedWorkBeforeBackendAndCloseIsFinal() {
        QueueWorker worker=new QueueWorker();Backend backend=new Backend();var current=state("task",4,1000,true);
        RearTaskLease lease=new RearTaskLease(worker,()->current,()->1000,backend);
        lease.onStateSynced();lease.invalidate();worker.drain();assertTrue(backend.calls.isEmpty());
        lease.onPresentationChanged();worker.drain();assertTrue(backend.calls.isEmpty());
        lease.onStateSynced();lease.close();worker.drain();lease.onStateSynced();worker.drain();assertTrue(backend.calls.isEmpty());
    }
    @Test public void stopRacingBackendCallbackRevokesBeforeAnySubsequentEffect() {
        QueueWorker worker=new QueueWorker();AtomicReference<RearTaskLease> leaseRef=new AtomicReference<>();AtomicInteger applied=new AtomicInteger();
        Backend backend=new Backend(){
            @Override public void renew(String id,long generation,long deadline,BooleanSupplier allowed)throws Exception {
                assertTrue(allowed.getAsBoolean());leaseRef.get().invalidate();
                if(allowed.getAsBoolean())applied.incrementAndGet();
            }
        };
        RearTaskLease lease=new RearTaskLease(worker,()->state("task",4,1000,true),()->1000,backend);leaseRef.set(lease);
        lease.onStateSynced();worker.drain();assertEquals(0,applied.get());assertFalse(backend.released.isEmpty());lease.close();
    }
    @Test public void supplierAndBackendAreCalledWithoutHoldingAdmissionLock()throws Exception {
        QueueWorker worker=new QueueWorker();AtomicReference<RearTaskLease> leaseRef=new AtomicReference<>();AtomicBoolean inspectSupplier=new AtomicBoolean(true);
        Backend backend=new Backend(){
            @Override public void renew(String id,long generation,long deadline,BooleanSupplier allowed)throws Exception {
                super.renew(id,generation,deadline,allowed);
                FutureTask<Void> invalidate=new FutureTask<>(()->{leaseRef.get().invalidate();return null;});
                Thread other=new Thread(invalidate);other.setDaemon(true);other.start();
                try{invalidate.get(1,TimeUnit.SECONDS);}catch(Exception failure){throw new AssertionError("Backend ran under admission lock",failure);}
            }
        };
        RearTaskLease lease=new RearTaskLease(worker,()->{
            if(inspectSupplier.getAndSet(false)) {
                FutureTask<Void> invalidate=new FutureTask<>(()->{leaseRef.get().invalidate();return null;});
                Thread other=new Thread(invalidate);other.setDaemon(true);other.start();
                try{invalidate.get(1,TimeUnit.SECONDS);}catch(Exception failure){throw new AssertionError("Supplier ran under admission lock",failure);}
            }
            return state("task",4,1000,true);
        },()->1000,backend);leaseRef.set(lease);
        lease.onStateSynced();worker.drain();assertTrue("Invalidation during supplier read must defeat admission",backend.calls.isEmpty());
        lease.onStateSynced();worker.drain();assertEquals(1,backend.calls.size());assertFalse(backend.calls.get(0).allowed().getAsBoolean());lease.close();
    }
    @Test public void rejectedQueueAndBackendFailureRetryWithoutReusingRetiredGeneration() {
        QueueWorker worker=new QueueWorker();AtomicBoolean reject=new AtomicBoolean(true);AtomicLong now=new AtomicLong(1000);Backend backend=new Backend();
        Executor rejecting=work->{if(reject.getAndSet(false))throw new RejectedExecutionException();worker.execute(work);};
        try(RearTaskLease lease=new RearTaskLease(rejecting,()->state("task",4,1000,true),now::get,backend)) {
            lease.onStateSynced();worker.drain();assertTrue(backend.calls.isEmpty());
            now.set(2000);lease.onPresentationChanged();worker.drain();assertEquals(1,backend.calls.size());
        }
        AtomicInteger attempts=new AtomicInteger();Backend failing=new Backend(){
            @Override public void renew(String id,long generation,long deadline,BooleanSupplier allowed)throws Exception {
                super.renew(id,generation,deadline,allowed);if(attempts.incrementAndGet()==1)throw new IllegalStateException("temporary failure");
            }
        };
        now.set(1000);
        try(RearTaskLease lease=new RearTaskLease(worker,()->state("task",4,1000,true),now::get,failing)) {
            lease.onStateSynced();worker.drain();Call first=failing.calls.get(0);
            lease.onPresentationChanged();worker.drain();assertEquals(1,failing.calls.size());
            now.set(2000);lease.onPresentationChanged();worker.drain();assertEquals(2,failing.calls.size());
            assertTrue(failing.calls.get(1).generation()>first.generation());assertTrue(failing.released.contains(identity(first)));
        }
    }
    @Test public void generationRemainsMonotonicAcrossHelpersAtTheSameClockTick() {
        QueueWorker worker=new QueueWorker();Backend backend=new Backend();var current=state("task",4,1000,true);
        try(RearTaskLease first=new RearTaskLease(worker,()->current,()->1000,backend)) {first.onStateSynced();worker.drain();}
        worker.drain();
        try(RearTaskLease second=new RearTaskLease(worker,()->current,()->1000,backend)) {second.onStateSynced();worker.drain();}
        assertTrue(backend.calls.get(1).generation()>backend.calls.get(0).generation());
    }
}
