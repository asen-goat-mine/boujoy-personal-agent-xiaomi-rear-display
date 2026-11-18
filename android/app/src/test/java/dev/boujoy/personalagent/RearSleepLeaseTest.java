package dev.boujoy.personalagent;

import android.os.Binder;
import android.os.IBinder;
import android.os.Parcel;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public class RearSleepLeaseTest {
    private static final class Time implements RearSleepLease.Clock,RearSleepLease.Scheduler {
        long now=10_000;final List<Job> jobs=new ArrayList<>();
        static final class Job implements RearSleepLease.Ticket {
            final long at;final Runnable action;boolean cancelled,ran;
            Job(long at,Runnable action){this.at=at;this.action=action;}
            public void cancel(){cancelled=true;}
        }
        public long now(){return now;}
        public synchronized RearSleepLease.Ticket after(long delay,Runnable action){Job j=new Job(now+delay,action);jobs.add(j);return j;}
        void advance(long delta) {
            long end=now+delta;
            while(true) {
                Job next;
                synchronized(this){next=jobs.stream().filter(j->!j.cancelled&&!j.ran&&j.at<=end).min(Comparator.comparingLong(j->j.at)).orElse(null);}
                if(next==null)break;
                now=Math.max(now,next.at);next.ran=true;next.action.run();
            }
            now=Math.max(now,end);
        }
    }
    private static class Power implements RearSleepLease.Backend {
        String owner="null";boolean enabled,failDump;int reads,terminated;
        final List<Boolean> requests=new ArrayList<>();final List<IBinder> tokens=new ArrayList<>();
        Runnable duringDump;
        public String dumpPower() throws Exception {
            reads++;if(duringDump!=null){Runnable action=duringDump;duringDump=null;action.run();}
            if(failDump)throw new IllegalStateException("offline");
            return "Power Manager State:\n    mDisableSubFollowSleep="+enabled+" pkg="+owner+"\n";
        }
        public void request(IBinder token,boolean value) throws Exception {requests.add(value);tokens.add(token);enabled=value;owner=value?RearSleepLease.OWNER:"null";}
        public void terminateShell(){terminated++;}
    }
    private static final class Fixture {
        final Time time=new Time();final Power power;final IBinder token=new Binder();final RearSleepLease lease;
        Fixture(){this(new Power());}
        Fixture(Power power){this.power=power;lease=new RearSleepLease(true,time,power,time,token);}
        RearSleepLease.Result start(){return lease.acquireOrRenew("one",1,time.now+3_000);}
    }
    @Test public void onlyVerifiedShellDeviceAndFirmwareCanReachThePrivateTransaction() {
        assertTrue(RearSleepLease.supportedDevice(2000,"2509FPN0BC",37,"OS4.0.5.0.XPBCNXM"));
        assertFalse(RearSleepLease.supportedDevice(0,"2509FPN0BC",37,"OS4.0.5.0.XPBCNXM"));
        assertFalse(RearSleepLease.supportedDevice(10353,"2509FPN0BC",37,"OS4.0.5.0.XPBCNXM"));
        assertFalse(RearSleepLease.supportedDevice(2000,"SM-F9560",37,"OS4.0.5.0.XPBCNXM"));
        assertFalse(RearSleepLease.supportedDevice(2000,"2509FPN0BC",36,"OS4.0.5.0.XPBCNXM"));
        assertFalse(RearSleepLease.supportedDevice(2000,"2509FPN0BC",37,"OS4.0.6.0.XPBCNXM"));
        Time time=new Time();Power power=new Power();RearSleepLease unsupported=new RearSleepLease(false,time,power,time,new Binder());
        assertEquals("UNSUPPORTED_DEVICE",unsupported.acquireOrRenew("one",1,time.now+3_000).code());
        unsupported.revoke();unsupported.releaseAll();time.advance(10_000);
        assertEquals(0,power.reads);assertTrue(power.requests.isEmpty());assertEquals(0,power.terminated);
    }
    @Test public void realParcelUsesTheStableShellTokenAndAcceptsTheOemEmptyReply() throws Exception {
        List<Boolean> values=new ArrayList<>();Binder token=new Binder();
        Binder service=new Binder(){@Override protected boolean onTransact(int code,Parcel data,Parcel reply,int flags) {
            assertEquals(0xFFFFF4,code);assertEquals(0,flags);data.enforceInterface("android.os.IPowerManager");
            assertSame(token,data.readStrongBinder());values.add(data.readBoolean());assertEquals("com.android.shell",data.readString());
            assertEquals(0,data.dataAvail());return true;
        }};
        RearSleepLease.PowerBackend.transact(service,token,true);RearSleepLease.PowerBackend.transact(service,token,false);
        assertEquals(List.of(true,false),values);
        try{RearSleepLease.PowerBackend.transact(new Binder(),token,true);fail("Unsupported transaction must fail");}
        catch(IllegalStateException expected){assertEquals("unsupported_transaction",expected.getMessage());}
        Binder denied=new Binder(){@Override protected boolean onTransact(int code,Parcel data,Parcel reply,int flags){reply.writeException(new SecurityException("denied"));return true;}};
        try{RearSleepLease.PowerBackend.transact(denied,token,true);fail("Marshalled denial must propagate");}
        catch(SecurityException expected){assertEquals("denied",expected.getMessage());}
    }
    @Test public void renewsOneTokenWithoutRepeatedGlobalWritesAndReleasesAtOriginalDeadline() {
        Fixture f=new Fixture();assertTrue(f.start().active());f.time.advance(1_000);
        assertTrue(f.lease.acquireOrRenew("one",1,14_000).active());
        assertEquals(List.of(true),f.power.requests);assertEquals(14_000,f.lease.snapshot().expiresAtElapsedMs());
        f.time.advance(2_999);assertTrue(f.lease.snapshot().active());
        f.time.advance(1);assertFalse(f.lease.snapshot().active());assertEquals(List.of(true,false),f.power.requests);
        assertSame(f.token,f.power.tokens.get(0));assertSame(f.token,f.power.tokens.get(1));
        f.time.advance(5_000);assertEquals(0,f.power.terminated);
    }
    @Test public void lateReadsAndOldDeadlinesNeverGetANewReceiptTimeTtl() {
        Fixture f=new Fixture();f.power.duringDump=()->f.time.now+=3_001;
        assertEquals("EXPIRED_REQUEST",f.lease.acquireOrRenew("one",1,13_000).code());assertTrue(f.power.requests.isEmpty());
        Fixture active=new Fixture();assertTrue(active.start().active());active.time.advance(1_000);
        assertTrue(active.lease.acquireOrRenew("one",1,14_000).active());
        assertEquals("STALE_DEADLINE",active.lease.acquireOrRenew("one",1,13_000).code());
        assertEquals("EXPIRED_REQUEST",active.lease.acquireOrRenew("one",1,10_999).code());
        assertTrue(active.lease.snapshot().active());assertEquals(14_000,active.lease.snapshot().expiresAtElapsedMs());
        assertEquals(List.of(true),active.power.requests);
    }
    @Test public void failedOldRenewCompensationCannotRevokeALaterDeadlineInTheSameGeneration() {
        Fixture f=new Fixture();assertTrue(f.start().active());f.time.advance(1_000);
        assertTrue(f.lease.acquireOrRenew("one",1,14_000).active());
        assertEquals("STALE_DEADLINE",f.lease.releaseIfNotRenewed("one",1,13_000).code());
        assertTrue(f.lease.snapshot().active());assertEquals(List.of(true),f.power.requests);
        assertTrue(f.lease.releaseIfNotRenewed("one",1,14_000).ok());
        assertEquals(List.of(true,false),f.power.requests);
    }
    @Test public void releasedGenerationCannotReturnAndOldReleaseCannotClearNewGeneration() {
        Fixture f=new Fixture();assertTrue(f.start().active());assertTrue(f.lease.release("one",1).ok());
        assertEquals("STALE_LEASE",f.lease.acquireOrRenew("one",1,13_000).code());
        assertTrue(f.lease.acquireOrRenew("two",2,13_000).active());
        assertEquals("STALE_LEASE",f.lease.release("one",1).code());assertTrue(f.lease.snapshot().active());
        assertEquals(List.of(true,false,true),f.power.requests);
        Fixture before=new Fixture();before.lease.release("pending",5);
        assertEquals("STALE_LEASE",before.lease.acquireOrRenew("pending",5,13_000).code());assertTrue(before.power.requests.isEmpty());
    }
    @Test public void anyPreexistingLeaseIncludingAnotherShellIsNeverAdopted() {
        for(String owner:List.of("com.android.shell","com.xiaomi.camera")) {
            Fixture f=new Fixture();f.power.enabled=true;f.power.owner=owner;
            assertEquals("OWNER_CONFLICT",f.start().code());f.lease.revoke();f.time.advance(30_000);
            assertTrue(f.power.requests.isEmpty());assertEquals(0,f.power.terminated);
        }
    }
    @Test public void aForeignTakeoverIsNotOverwrittenOrTerminated() {
        Fixture f=new Fixture();assertTrue(f.start().active());f.power.owner="com.xiaomi.camera";
        assertEquals("OWNER_CONFLICT",f.lease.acquireOrRenew("one",1,14_000).code());
        f.lease.revoke();f.lease.releaseAll();f.time.advance(30_000);
        assertEquals(List.of(true),f.power.requests);assertEquals(0,f.power.terminated);
        assertEquals("OWNER_CONFLICT",f.lease.acquireOrRenew("two",2,f.time.now+3_000).code());
    }
    @Test public void missingMalformedAndAmbiguousDumpStateNeverMeanFreeOwnership() {
        for(String dump:List.of("", "mDisableSubFollowSleep=maybe pkg=null", "mDisableSubFollowSleep=false pkg=null\nmDisableSubFollowSleep=false pkg=null")) {
            try{RearSleepLease.parsePowerState(dump);fail("Ambiguous power state must fail closed");}catch(IllegalStateException expected){}
        }
        Fixture f=new Fixture();f.power.failDump=true;
        assertEquals("BACKEND_FAILED",f.start().code());assertTrue(f.power.requests.isEmpty());
        f.time.advance(30_000);assertEquals(0,f.power.terminated);
    }
    @Test public void unconfirmedCleanupUsesBoundedTokenDeathFallbackOnlyAfterOwningALease() {
        Fixture f=new Fixture();assertTrue(f.start().active());f.power.failDump=true;
        assertEquals("RELEASE_UNCONFIRMED",f.lease.release("one",1).code());
        assertEquals(List.of(true),f.power.requests);assertEquals(0,f.power.terminated);
        f.time.advance(1_499);assertEquals(0,f.power.terminated);f.time.advance(1);assertEquals(1,f.power.terminated);
    }
    @Test public void confirmedCleanupRetryRestoresNewGenerationsAfterATransientFailure() {
        Fixture f=new Fixture();assertTrue(f.start().active());
        f.power.failDump=true;
        assertEquals("RELEASE_UNCONFIRMED",f.lease.release("one",1).code());
        assertFalse("An unconfirmed release must still block new ownership",f.lease.acquireOrRenew("two",2,13_000).ok());
        assertEquals(List.of(true),f.power.requests);
        f.power.failDump=false;
        assertTrue("A retry must confirm both false and a fresh power dump",f.lease.release("one",1).ok());
        assertTrue(f.lease.acquireOrRenew("two",2,13_000).active());
        assertEquals(List.of(true,false,true),f.power.requests);
        assertSame("Recovery keeps the same genuine shell token",f.token,f.power.tokens.get(2));
        assertEquals("STALE_LEASE",f.lease.release("one",1).code());
        f.time.advance(1_500);
        assertEquals("The old cleanup watchdog must not kill recovered ownership",0,f.power.terminated);
        assertTrue(f.lease.snapshot().active());
        f.time.advance(1_500);
        assertEquals(List.of(true,false,true,false),f.power.requests);
        assertEquals(0,f.power.terminated);
    }
    @Test public void foreignOwnerConflictDoesNotBecomeRecoverableWhenTheFlagLaterClears() {
        for(boolean previouslyOwned:new boolean[]{false,true}) {
            Fixture f=new Fixture();if(previouslyOwned)assertTrue(f.start().active());
            f.power.enabled=true;f.power.owner="com.xiaomi.camera";
            assertEquals("OWNER_CONFLICT",f.lease.acquireOrRenew("one",1,13_000).code());
            f.power.enabled=false;f.power.owner="null";
            assertFalse(f.lease.release("one",1).ok());
            assertEquals("OWNER_CONFLICT",f.lease.acquireOrRenew("two",2,13_000).code());
            f.lease.revoke();f.time.advance(30_000);
            assertEquals(previouslyOwned?List.of(true):List.of(),f.power.requests);
            assertEquals(0,f.power.terminated);
        }
    }
    @Test public void oldAlreadyStartedHardCallbackCannotKillRenewedLease() {
        Fixture f=new Fixture();assertTrue(f.start().active());Runnable oldHard=f.time.jobs.get(1).action;
        f.time.advance(2_000);assertTrue(f.lease.acquireOrRenew("one",1,15_000).active());
        f.time.now=14_500;oldHard.run();assertEquals(0,f.power.terminated);assertTrue(f.lease.snapshot().active());
        assertEquals(List.of(true),f.power.requests);
    }
    @Test public void revokeAndSnapshotDoNotWaitForPendingPowerReadAndPreventLateAcquire() throws Exception {
        CountDownLatch reading=new CountDownLatch(1),resume=new CountDownLatch(1);
        Power power=new Power(){@Override public String dumpPower() throws Exception {
            if(reads==0){reading.countDown();if(!resume.await(3,TimeUnit.SECONDS))throw new IllegalStateException("test_timeout");}
            return super.dumpPower();
        }};
        Fixture f=new Fixture(power);AtomicReference<RearSleepLease.Result> answer=new AtomicReference<>();
        Thread caller=new Thread(()->answer.set(f.start()));caller.start();assertTrue(reading.await(2,TimeUnit.SECONDS));
        try {
            f.lease.revoke();assertFalse(f.lease.snapshot().active());
            assertEquals("BUSY",f.lease.acquireOrRenew("other",2,13_000).code());
        } finally {resume.countDown();caller.join(3_000);}
        assertFalse(caller.isAlive());assertEquals("REVOKED",answer.get().code());assertTrue(power.requests.isEmpty());
        assertEquals("STALE_LEASE",f.lease.acquireOrRenew("one",1,13_000).code());
        assertTrue(f.lease.acquireOrRenew("two",2,13_000).active());
        f.time.advance(0);assertTrue(f.lease.snapshot().active());
    }
    @Test public void ttlHardRecoveryStillRunsWhileInitialBinderRequestIsStuck() throws Exception {
        CountDownLatch writing=new CountDownLatch(1),resume=new CountDownLatch(1);
        Power power=new Power(){@Override public void request(IBinder token,boolean enabled) throws Exception {
            super.request(token,enabled);
            if(enabled){writing.countDown();if(!resume.await(3,TimeUnit.SECONDS))throw new IllegalStateException("test_timeout");}
        }};
        Fixture f=new Fixture(power);Thread caller=new Thread(f::start);caller.start();assertTrue(writing.await(2,TimeUnit.SECONDS));
        try {
            f.lease.revoke();assertFalse(f.lease.snapshot().active());f.time.advance(4_500);
            assertEquals(1,power.terminated);
        } finally {resume.countDown();caller.join(3_000);}
        assertFalse(caller.isAlive());
    }
}
