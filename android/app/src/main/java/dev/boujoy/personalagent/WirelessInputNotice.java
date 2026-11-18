package dev.boujoy.personalagent;

/**
 * Tells the person when Boujoy 无线输入 (the accessibility editing service) is off,
 * e.g. after an update turned it off, instead of finding out mid-task. Posts once per
 * off period after a short grace (the service binds a few seconds after start), and
 * clears the notice as soon as the service is back.
 */
public final class WirelessInputNotice {
    public enum Action { NONE, POST, CANCEL }
    static final long GRACE_MS = 10_000;
    private long offSince = -1;
    private boolean posted;
    public synchronized Action step(boolean paired, boolean ready, long now) {
        if (ready || !paired) {
            offSince = -1;
            if (posted) { posted = false; return Action.CANCEL; }
            return Action.NONE;
        }
        if (offSince < 0) offSince = now;
        if (!posted && now - offSince >= GRACE_MS) { posted = true; return Action.POST; }
        return Action.NONE;
    }
}
