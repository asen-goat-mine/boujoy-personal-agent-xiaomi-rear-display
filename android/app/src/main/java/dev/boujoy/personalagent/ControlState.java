package dev.boujoy.personalagent;

/** The phone's persistent stream admission gate. It cannot undo an Android input already injected. */
public final class ControlState {
    public interface Storage {
        long epoch(); boolean paused(); void save(long epoch, boolean paused);
        default String reason() { return ""; }
        default long maintenanceOrigin() { return -1; }
        default void save(long epoch, boolean paused, String reason, long maintenanceOrigin) { save(epoch, paused); }
    }
    public record Snapshot(long epoch, boolean paused) {}
    private final Storage storage;
    private long epoch;
    private boolean paused;
    private String pauseReason;
    private long maintenanceOrigin;
    public ControlState(Storage storage) { this.storage = storage; epoch = storage.epoch(); paused = storage.paused(); pauseReason = storage.reason(); maintenanceOrigin = storage.maintenanceOrigin(); }
    public synchronized long pause() { return pause("local_stop"); }
    public synchronized long pause(String reason) { set(Math.addExact(epoch, 1), true, reason, -1); return epoch; }
    public synchronized long resumeExplicitly() { set(Math.addExact(epoch, 1), false); return epoch; }
    /** A new request shares current live admission; only a real resume rotates revoked admission. */
    public synchronized long admitRequest() { return paused ? resumeExplicitly() : epoch; }
    private void set(long value, boolean flag) { set(value, flag, flag ? "remote_pause" : "", -1); }
    private void set(long value, boolean flag, String reason, long origin) {
        if (!flag) {
            // New admission is usable only after it is durable.
            storage.save(value, false, reason, origin);
            epoch = value; paused = false; pauseReason = reason; maintenanceOrigin = origin;
            return;
        }
        // Revocation takes effect even when the disk cannot preserve it.
        epoch = value; paused = true; pauseReason = reason; maintenanceOrigin = origin;
        try { storage.save(value, true, reason, origin); }
        catch (RuntimeException failure) {
            // A failed screen-off/maintenance write must not enable automatic resumption.
            pauseReason = "persistence_failed"; maintenanceOrigin = -1;
            throw failure;
        }
    }
    /** Paused only because the screen went off: unlocking may hand control back. A user stop or takeover is never this. */
    public synchronized boolean pausedByScreenOff() { return paused && "screen_off".equals(pauseReason); }
    /** The screen turning off pauses running control only. An existing stop, takeover or remote pause keeps its own reason, so unlocking never resumes it. */
    public synchronized boolean screenOffPauses() { return !paused; }
    public synchronized long epoch() { return epoch; }
    public synchronized boolean paused() { return paused; }
    public synchronized Snapshot snapshot() { return new Snapshot(epoch, paused); }
    public synchronized boolean matches(Snapshot expected) { return expected.epoch == epoch && expected.paused == paused; }
    /** Remote replies can revoke admission or advance its generation, but never resume it. */
    public synchronized boolean observeRemote(long remoteEpoch, boolean remotePaused) {
        if (remoteEpoch > epoch || (remoteEpoch == epoch && remotePaused && !paused)) {
            set(remoteEpoch, true); return true;
        }
        return false;
    }
    /** Authenticated maintenance can suspend previously admitted control, never a local stop. */
    public synchronized boolean observeMaintenance(long remoteEpoch, long origin) {
        if (remoteEpoch < epoch) return false;
        if (origin < 0 || origin >= remoteEpoch) return observeRemote(remoteEpoch, true);
        boolean eligible = (!paused && epoch == origin) || (paused && "maintenance".equals(pauseReason) && maintenanceOrigin == origin);
        if (!eligible) return observeRemote(remoteEpoch, true);
        if (remoteEpoch == epoch) return false;
        set(remoteEpoch, true, "maintenance", origin); return true;
    }
    public synchronized boolean canResumeMaintenance(long remoteEpoch, long origin) {
        return paused && epoch == remoteEpoch && "maintenance".equals(pauseReason) && maintenanceOrigin == origin;
    }
    /** Keep the local gate shut until the exact new generation is acknowledged. */
    public synchronized boolean acknowledgeMaintenance(Snapshot expected, long origin, long acknowledgedEpoch, boolean acknowledgedPaused) {
        if (!matches(expected) || !canResumeMaintenance(expected.epoch(), origin) || acknowledgedPaused || acknowledgedEpoch != Math.addExact(expected.epoch(), 1)) return false;
        set(acknowledgedEpoch, false); return true;
    }
    /** Message delivery must wait for this generation's remote resume acknowledgement. */
    public synchronized boolean permitsSubmission(long candidate,long acknowledgedEpoch) { return permitsData(candidate) && candidate == acknowledgedEpoch; }
    public synchronized boolean permitsData(long candidate) { return !paused && candidate == epoch; }
}
