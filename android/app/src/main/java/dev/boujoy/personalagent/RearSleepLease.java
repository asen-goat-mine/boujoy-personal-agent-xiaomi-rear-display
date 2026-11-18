package dev.boujoy.personalagent;

import android.os.Binder;
import android.os.Build;
import android.os.IBinder;
import android.os.Parcel;
import android.os.Process;
import android.os.SystemClock;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** A short, shell-owned power lease. It never wakes, launches, unlocks or changes a setting. */
final class RearSleepLease {
    static final long MAX_TTL_MS = 5_000;
    static final long RELEASE_GRACE_MS = 1_500;
    static final String OWNER = "com.android.shell";
    static final String DESCRIPTOR = "android.os.IPowerManager";
    static final int TRANSACTION = 0xFFFFF4;
    private static RearSleepLease instance;

    interface Clock { long now(); }
    interface Ticket { void cancel(); }
    interface Scheduler { Ticket after(long delayMs, Runnable action); }
    interface Backend {
        String dumpPower() throws Exception;
        void request(IBinder token, boolean enabled) throws Exception;
        void terminateShell();
    }
    static final class Result {
        final boolean ok, active;
        final String code, leaseId;
        final long generation, expiresAtElapsedMs;
        Result(boolean ok, boolean active, String code, String id, long generation, long expiresAt) {
            this.ok=ok;this.active=active;this.code=code;this.leaseId=id;
            this.generation=generation;this.expiresAtElapsedMs=expiresAt;
        }
        boolean ok(){return ok;}
        boolean active(){return active;}
        String code(){return code;}
        String leaseId(){return leaseId;}
        long generation(){return generation;}
        long expiresAtElapsedMs(){return expiresAtElapsedMs;}
    }
    static final class PowerState {
        final boolean enabled;
        final String owner;
        PowerState(boolean enabled,String owner){this.enabled=enabled;this.owner=owner;}
        boolean foreign(){return enabled&&!OWNER.equals(owner);}
    }
    private static final Pattern POWER_STATE = Pattern.compile("^mDisableSubFollowSleep=(true|false) pkg=(\\S+)$");
    static PowerState parsePowerState(String dump) {
        PowerState found=null;
        if(dump==null)throw new IllegalStateException("unknown_power_lease_state");
        for(String line:dump.split("\\r?\\n")) {
            String trimmed=line.trim();
            if(!trimmed.startsWith("mDisableSubFollowSleep="))continue;
            Matcher match=POWER_STATE.matcher(trimmed);
            if(found!=null||!match.matches())throw new IllegalStateException("unknown_power_lease_state");
            found=new PowerState(Boolean.parseBoolean(match.group(1)),match.group(2));
        }
        if(found==null)throw new IllegalStateException("unknown_power_lease_state");
        return found;
    }
    static boolean supportedDevice(int uid,String model,int sdk,String incremental) {
        return uid==2000&&"2509FPN0BC".equals(model)&&sdk==37&&"OS4.0.5.0.XPBCNXM".equals(incremental);
    }
    static synchronized RearSleepLease create() {
        if(instance==null)instance=new RearSleepLease(
                supportedDevice(Process.myUid(),Build.MODEL,Build.VERSION.SDK_INT,Build.VERSION.INCREMENTAL),
                SystemClock::elapsedRealtime,new PowerBackend(),new Timers(),new Binder());
        return instance;
    }

    private final boolean supported;
    private final Clock clock;
    private final Backend backend;
    private final Scheduler scheduler;
    private final IBinder token; // One genuine Binder, reused only after explicit false/unlink.
    private final ReentrantLock operations=new ReentrantLock();
    private final AtomicLong revision=new AtomicLong(),retiredGeneration=new AtomicLong(-1);
    private volatile Lease current;
    private volatile Attempt pending;
    private volatile String code="IDLE";
    private enum Unavailable { NONE, CLEANUP_UNCONFIRMED, OWNER_CONFLICT }
    private volatile Unavailable unavailable=Unavailable.NONE;
    private boolean blocked(){return unavailable!=Unavailable.NONE;}
    private static final class Attempt {
        final String id;final long generation,revision;
        Attempt(String id,long generation,long revision){this.id=id;this.generation=generation;this.revision=revision;}
    }
    private static final class Lease {
        final String id;final long generation;
        volatile long expiresAt,hardAt;
        volatile boolean attempted,confirmed,revoked,foreign,terminated;
        Ticket expiryTicket,hardTicket;
        Lease(String id,long generation,long expiresAt){this.id=id;this.generation=generation;this.expiresAt=expiresAt;}
    }
    RearSleepLease(boolean supported,Clock clock,Backend backend,Scheduler scheduler,IBinder token) {
        this.supported=supported;this.clock=clock;this.backend=backend;this.scheduler=scheduler;this.token=token;
        if(!supported)code="UNSUPPORTED_DEVICE";
    }

    Result acquireOrRenew(String id,long generation,long originalExpiresAt) {
        Attempt attempt=new Attempt(id,generation,revision.get());
        if(!operations.tryLock())return view(false,"BUSY");
        pending=attempt;
        try {
            if(!supported)return result(false,"UNSUPPORTED_DEVICE");
            if(blocked())return view(false,code);
            long now=clock.now();
            if(id==null||id.isEmpty()||id.length()>160||generation<0||originalExpiresAt<=now||originalExpiresAt-now>MAX_TTL_MS)
                return result(false,originalExpiresAt<=now?"EXPIRED_REQUEST":"INVALID_REQUEST");
            Lease lease=current;
            if(lease!=null) {
                if(!matches(lease,id,generation))return result(false,"STALE_LEASE");
                if(lease.revoked)return result(false,"REVOKED");
                if(originalExpiresAt<lease.expiresAt)return result(false,"STALE_DEADLINE");
                if(now>=lease.expiresAt){releaseCurrent(lease,"EXPIRED");return result(false,"EXPIRED_REQUEST");}
            } else if(generation<=retiredGeneration.get())return result(false,"STALE_LEASE");
            if(!valid(attempt))return result(false,"REVOKED");
            PowerState before=parsePowerState(backend.dumpPower());
            if(!valid(attempt))return result(false,"REVOKED");
            // Package equality cannot prove token ownership: another genuine shell process
            // has this same package. Never adopt any lease which predates our own token.
            if(lease==null&&before.enabled)return conflict(null);
            if(lease!=null&&before.foreign())return conflict(lease);
            if(clock.now()>=originalExpiresAt)return result(false,"EXPIRED_REQUEST");
            if(lease!=null) {
                if(clock.now()>=lease.expiresAt){releaseCurrent(lease,"EXPIRED");return result(false,"EXPIRED_REQUEST");}
                if(!before.enabled){releaseCurrent(lease,"CLEARED_BY_SYSTEM");return result(false,"CLEARED_BY_SYSTEM");}
                lease.expiresAt=originalExpiresAt;arm(lease);
                if(!valid(attempt)||lease.revoked){releaseCurrent(lease,"REVOKED");return result(false,"REVOKED");}
                return result(true,"HELD");
            }
            lease=new Lease(id,generation,originalExpiresAt);current=lease;
            if(!valid(attempt)||lease.revoked){retire(generation);current=null;return result(false,"REVOKED");}
            arm(lease);lease.attempted=true;
            backend.request(token,true);
            if(!valid(attempt)||lease.revoked){releaseCurrent(lease,"REVOKED");return result(false,"REVOKED");}
            PowerState after=parsePowerState(backend.dumpPower());
            if(after.foreign())return conflict(lease);
            if(!after.enabled||clock.now()>=lease.expiresAt||!valid(attempt)||lease.revoked) {
                releaseCurrent(lease,"NOT_CONFIRMED");return result(false,"NOT_CONFIRMED");
            }
            lease.confirmed=true;return result(true,"HELD");
        } catch(Exception failure) {
            Lease lease=current;
            if(lease!=null&&matches(lease,id,generation))releaseCurrent(lease,"BACKEND_FAILED");
            return result(false,blocked()?code:"BACKEND_FAILED");
        } finally {pending=null;operations.unlock();}
    }
    private boolean valid(Attempt attempt) {
        return attempt.revision==revision.get()&&attempt.generation>retiredGeneration.get();
    }
    private void retire(long generation){retiredGeneration.accumulateAndGet(generation,Math::max);}
    private static boolean matches(Lease lease,String id,long generation){return lease.generation==generation&&lease.id.equals(id);}

    /** No monitor, Binder calls or process wait: also invalidates an acquire still reading power. */
    void revoke() {
        revision.incrementAndGet();
        Attempt attempt=pending;if(attempt!=null)retire(attempt.generation);
        Lease lease=current;
        if(lease!=null){lease.revoked=true;retire(lease.generation);queueRelease(lease,"REVOKED",0);}
    }
    Result release(String id,long generation) {
        if(!supported)return view(false,"UNSUPPORTED_DEVICE");
        Lease lease=current;
        if(lease==null) {
            if(id!=null&&!id.isEmpty()&&generation>=0)retire(generation);
            return view(!blocked(),blocked()?code:"RELEASED");
        }
        if(!matches(lease,id,generation))return view(false,"STALE_LEASE");
        lease.revoked=true;retire(generation);
        if(!operations.tryLock()){queueRelease(lease,"RELEASED",0);return view(true,"RELEASE_PENDING");}
        try{return releaseCurrent(lease,"RELEASED");}finally{operations.unlock();}
    }
    /** Compensates one failed renew without revoking a later renew of that same generation. */
    Result releaseIfNotRenewed(String id,long generation,long requestExpiresAt) {
        if(!supported)return view(false,"UNSUPPORTED_DEVICE");
        if(!operations.tryLock()) {
            scheduler.after(50,()->releaseIfNotRenewed(id,generation,requestExpiresAt));
            return view(true,"RELEASE_PENDING");
        }
        try {
            Lease lease=current;
            if(lease==null)return view(!blocked(),blocked()?code:"RELEASED");
            if(!matches(lease,id,generation))return view(false,"STALE_LEASE");
            if(lease.expiresAt>requestExpiresAt)return view(false,"STALE_DEADLINE");
            return releaseCurrent(lease,"RELEASED");
        } finally {operations.unlock();}
    }
    Result releaseAll(){revoke();return view(!blocked(),blocked()?code:current==null?"RELEASED":"RELEASE_PENDING");}
    Result snapshot(){return view(supported&&!blocked(),code);}
    private Result result(boolean ok,String nextCode){code=nextCode;return view(ok,nextCode);}
    private Result view(boolean ok,String nextCode) {
        Lease lease=current;
        return new Result(ok,lease!=null&&lease.confirmed&&!lease.revoked&&!blocked()&&clock.now()<lease.expiresAt,
                nextCode,lease==null?"":lease.id,lease==null?-1:lease.generation,lease==null?0:lease.expiresAt);
    }
    private void arm(Lease lease) {
        cancelTimers(lease);
        lease.hardAt=lease.expiresAt+RELEASE_GRACE_MS;
        lease.expiryTicket=scheduler.after(Math.max(0,lease.expiresAt-clock.now()),()->{
            if(current==lease&&clock.now()>=lease.expiresAt){lease.revoked=true;retire(lease.generation);queueRelease(lease,"EXPIRED",0);}
        });
        scheduleHard(lease);
    }
    private void scheduleHard(Lease lease) {
        if(lease.hardTicket!=null)lease.hardTicket.cancel();
        lease.hardTicket=scheduler.after(Math.max(0,lease.hardAt-clock.now()),()->hardRecovery(lease));
    }
    private void queueRelease(Lease lease,String reason,long delay) {
        scheduler.after(delay,()->{
            if(current!=lease||lease.foreign||lease.terminated)return;
            if(!operations.tryLock()){queueRelease(lease,reason,50);return;}
            try{releaseCurrent(lease,reason);}finally{operations.unlock();}
        });
    }
    private Result releaseCurrent(Lease lease,String reason) {
        if(current!=lease)return view(false,"STALE_LEASE");
        lease.revoked=true;lease.confirmed=false;retire(lease.generation);
        if(!lease.attempted){current=null;cancelTimers(lease);return result(true,reason);}
        // Never postpone an existing hard deadline through repeated stop requests.
        lease.hardAt=Math.min(lease.hardAt,clock.now()+RELEASE_GRACE_MS);scheduleHard(lease);
        try {
            PowerState before=parsePowerState(backend.dumpPower());
            if(before.foreign())return conflict(lease);
            backend.request(token,false); // Unregister our token even if the system already cleared the flag.
            PowerState after=parsePowerState(backend.dumpPower());
            if(after.foreign())return conflict(lease);
            if(after.enabled)throw new IllegalStateException("release_not_confirmed");
            current=null;
            // A transient cleanup error is recoverable only after this token's false
            // transaction and a fresh dump both confirm release. Never reopen on hope.
            if(unavailable==Unavailable.CLEANUP_UNCONFIRMED)unavailable=Unavailable.NONE;
            cancelTimers(lease);return result(true,reason);
        } catch(Exception failure){unavailable=Unavailable.CLEANUP_UNCONFIRMED;return result(false,"RELEASE_UNCONFIRMED");}
    }
    private Result conflict(Lease lease) {
        if(lease!=null){lease.foreign=true;retire(lease.generation);cancelTimers(lease);}
        current=null;unavailable=Unavailable.OWNER_CONFLICT;
        // OEM retains the old death callback until false, which would clear the foreign flag.
        // Leave both alone. Eventual process death remains an unavoidable firmware limitation.
        return result(false,"OWNER_CONFLICT");
    }
    private void hardRecovery(Lease lease) {
        // No operation/service lock. Recheck the current deadline: cancel(false) cannot stop an
        // old callback which already started just before a successful renewal.
        if(current!=lease||lease.foreign||lease.terminated||!lease.attempted||clock.now()<lease.hardAt
                ||!lease.revoked&&clock.now()<lease.expiresAt)return;
        lease.terminated=true;backend.terminateShell();
    }
    private void cancelTimers(Lease lease) {
        if(lease.expiryTicket!=null)lease.expiryTicket.cancel();
        if(lease.hardTicket!=null)lease.hardTicket.cancel();
        lease.expiryTicket=null;lease.hardTicket=null;
    }
    private static final class Timers implements Scheduler {
        private final ScheduledThreadPoolExecutor timers=new ScheduledThreadPoolExecutor(2,r->{
            Thread thread=new Thread(r,"Boujoy-rear-lease-deadline");thread.setDaemon(true);return thread;
        });
        Timers(){timers.setRemoveOnCancelPolicy(true);}
        public Ticket after(long delayMs,Runnable action) {
            java.util.concurrent.ScheduledFuture<?> future=timers.schedule(action,Math.max(0,delayMs),TimeUnit.MILLISECONDS);
            return ()->future.cancel(false);
        }
    }
    static final class PowerBackend implements Backend {
        private IBinder power;
        private IBinder power() throws Exception {
            if(power==null) {
                power=(IBinder)Class.forName("android.os.ServiceManager").getMethod("getService",String.class).invoke(null,"power");
                if(power==null||!DESCRIPTOR.equals(power.getInterfaceDescriptor()))throw new IllegalStateException("wrong_power_service");
            }
            return power;
        }
        @Override public void request(IBinder token,boolean enabled) throws Exception {
            long identity=Binder.clearCallingIdentity();
            try { transact(power(),token,enabled); }
            finally { Binder.restoreCallingIdentity(identity); }
        }
        static void transact(IBinder power,IBinder token,boolean enabled) throws Exception {
            Parcel data=Parcel.obtain(),reply=Parcel.obtain();
            try {
                data.writeInterfaceToken(DESCRIPTOR);data.writeStrongBinder(token);data.writeBoolean(enabled);data.writeString(OWNER);
                if(!power.transact(TRANSACTION,data,reply,0))throw new IllegalStateException("unsupported_transaction");
                // This OEM handler writes no normal reply, but marshalled exceptions must propagate.
                if(reply.dataSize()>0)reply.readException();
            } finally {data.recycle();reply.recycle();}
        }
        @Override public String dumpPower() throws Exception {
            java.lang.Process process=new ProcessBuilder("/system/bin/dumpsys","power").redirectErrorStream(true).start();
            ByteArrayOutputStream output=new ByteArrayOutputStream();
            final Exception[] failure={null};
            Thread reader=new Thread(()->{
                try(InputStream stream=process.getInputStream()) {
                    byte[] buffer=new byte[4096];int count;
                    while((count=stream.read(buffer))!=-1) {
                        if(output.size()+count>512_000)throw new IllegalStateException("oversized_power_dump");
                        output.write(buffer,0,count);
                    }
                } catch(Exception error){failure[0]=error;}
            },"Boujoy-rear-power-read");
            reader.setDaemon(true);reader.start();
            try {
                if(!process.waitFor(900,TimeUnit.MILLISECONDS))throw new IllegalStateException("power_dump_timeout");
                reader.join(100);
                if(reader.isAlive()||process.exitValue()!=0||failure[0]!=null)throw new IllegalStateException("power_dump_failed");
                return output.toString(StandardCharsets.UTF_8.name());
            } finally {process.destroyForcibly();}
        }
        @Override public void terminateShell() {
            if(Process.myUid()==2000)Process.killProcess(Process.myPid());
        }
    }
}
