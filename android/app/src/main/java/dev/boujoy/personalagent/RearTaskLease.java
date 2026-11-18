package dev.boujoy.personalagent;

import java.util.UUID;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/** Short, task-scoped rear power leases. Only an authenticated state sync admits a task. */
final class RearTaskLease implements AutoCloseable {
    static final long LEASE_MS = 3_000;
    static final long RENEW_EVERY_MS = 1_000;
    // ConnectionService can be recreated while this App process and its shell client remain alive.
    private static final AtomicLong SCOPE_SEQUENCE = new AtomicLong();

    interface Backend {
        /** Preserve this original deadline; recheck allowed before and after the system effect. */
        void renew(String leaseId, long generation, long expiresAtElapsedMs, BooleanSupplier allowed) throws Exception;
        /** Cleanup is specific to this identity; an old release must never clear a newer lease. */
        void release(String leaseId, long generation) throws Exception;
    }
    private record Admission(String taskId, long controlEpoch) {}
    private static final class Lease {
        final Admission admission;
        final String id = UUID.randomUUID().toString();
        final long generation;
        long deadline;
        Lease(Admission admission, long generation) { this.admission=admission;this.generation=generation; }
    }
    private record Renewal(Lease lease, long deadline) {}

    private final Object lock = new Object();
    private final Executor worker;
    private final Supplier<RearProgressCoordinator.State> current;
    private final LongSupplier clock;
    private final Backend backend;
    private Admission admitted;
    private Lease lease;
    private Renewal pending;
    private long revision, nextRenewAt;
    private boolean closed;

    RearTaskLease(Executor worker, Supplier<RearProgressCoordinator.State> current, LongSupplier clock, Backend backend) {
        this.worker=worker;this.current=current;this.clock=clock;this.backend=backend;
    }
    void onStateSynced() { consider(true); }
    void onPresentationChanged() { consider(false); }

    private void consider(boolean synced) {
        long observedRevision;synchronized(lock){observedRevision=revision;}
        RearProgressCoordinator.State state=read();long now=clock.getAsLong();
        boolean eligible=eligible(state,now);
        Lease retired=null;Renewal request=null;
        synchronized(lock) {
            if(closed||observedRevision!=revision)return;
            if(!eligible) {
                retired=clearAdmissionLocked();
            } else {
                if(admitted!=null&&!matches(admitted,state))retired=clearAdmissionLocked();
                if(synced&&admitted==null) {
                    admitted=new Admission(state.taskId(),state.controlEpoch());revision++;nextRenewAt=0;
                }
                if(admitted!=null) {
                    // Sync may admit before the asynchronous Activity launch has become visible.
                    // Hiding retires the lease identity, but not the still-fresh task admission.
                    if(!state.rearShowing()) {
                        if(lease!=null)retired=clearLeaseLocked();
                        nextRenewAt=0;
                    } else {
                        if(lease!=null&&now>=lease.deadline)retired=clearLeaseLocked();
                        if(now>=nextRenewAt&&pending==null) {
                            long until=Math.min(now+LEASE_MS,state.syncedAtElapsedMs()+RearStatus.FRESH_FOR_MS);
                            if(until>now) {
                                if(lease==null) {
                                    long generation=SCOPE_SEQUENCE.updateAndGet(previous->Math.max(previous+1,now));
                                    lease=new Lease(admitted,generation);revision++;
                                }
                                lease.deadline=until;
                                request=new Renewal(lease,until);pending=request;nextRenewAt=now+RENEW_EVERY_MS;
                            }
                        }
                    }
                }
            }
        }
        releaseLater(retired);
        if(request!=null)submit(request);
    }
    private static boolean eligible(RearProgressCoordinator.State state,long now) {
        return state!=null&&state.backgroundAllowed()
                &&state.taskId()!=null&&!state.taskId().startsWith("handoff:")
                &&"eligible".equals(RearProgressCoordinator.gateReason(state,now));
    }
    private static boolean matches(Admission scope,RearProgressCoordinator.State state) {
        return state!=null&&scope.taskId().equals(state.taskId())&&scope.controlEpoch()==state.controlEpoch();
    }
    private RearProgressCoordinator.State read() {
        try{return current.get();}catch(RuntimeException unavailable){return null;}
    }
    private void submit(Renewal request) {
        try{worker.execute(()->renew(request));}
        catch(RuntimeException rejected) {
            // No remote effect occurred. A later tick may retry with a new identity.
            Lease retired=null;
            synchronized(lock){if(pending==request&&lease==request.lease())retired=clearLeaseLocked();}
            releaseLater(retired);
        }
    }
    private void renew(Renewal request) {
        try {
            if(!allowed(request))return;
            backend.renew(request.lease().id,request.lease().generation,request.deadline(),()->allowed(request));
            // A stop may race the final remote barrier. Cleanup still targets only this lease.
            if(!allowed(request))releaseNow(request.lease());
        } catch(Exception failed) {
            long failedAt=clock.getAsLong();Lease retired=null;
            synchronized(lock) {
                if(lease==request.lease()) {
                    retired=clearLeaseLocked();nextRenewAt=failedAt+RENEW_EVERY_MS;
                }
            }
            releaseNow(retired==null?request.lease():retired);
        } finally {synchronized(lock){if(pending==request)pending=null;}}
    }
    private boolean allowed(Renewal request) {
        // Supplier and Binder callbacks must never run under the admission lock.
        RearProgressCoordinator.State state=read();long now=clock.getAsLong();
        boolean eligible=eligible(state,now);Lease retired=null;boolean accepted=false;
        synchronized(lock) {
            if(!closed&&lease==request.lease()&&admitted==request.lease().admission) {
                if(!eligible||!matches(admitted,state))retired=clearAdmissionLocked();
                else if(!state.rearShowing()) {retired=clearLeaseLocked();nextRenewAt=0;}
                else if(now>=request.deadline()) {
                    // An older permit expiring must not revoke a newer renewal of this same lease.
                    if(lease.deadline<=now)retired=clearLeaseLocked();
                } else accepted=true;
            }
        }
        releaseLater(retired);
        return accepted;
    }
    private Lease clearLeaseLocked() {
        Lease old=lease;lease=null;pending=null;revision++;return old;
    }
    private Lease clearAdmissionLocked() {
        Lease old=clearLeaseLocked();admitted=null;nextRenewAt=0;return old;
    }
    private void releaseLater(Lease old) {
        if(old==null)return;
        try{worker.execute(()->releaseNow(old));}
        catch(RuntimeException rejected) { /* The shell enforces the original three-second deadline. */ }
    }
    private void releaseNow(Lease old) {
        if(old==null)return;
        try{backend.release(old.id,old.generation);}catch(Exception unavailable) { /* Shell expiry remains armed. */ }
    }
    void invalidate() {
        Lease old;synchronized(lock){old=clearAdmissionLocked();}
        releaseLater(old);
    }
    @Override public void close() {
        Lease old;synchronized(lock){closed=true;old=clearAdmissionLocked();}
        releaseLater(old);
    }
}
