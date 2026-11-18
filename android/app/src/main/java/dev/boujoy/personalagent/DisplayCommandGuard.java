package dev.boujoy.personalagent;

import org.json.JSONObject;

/** Pure admission and evidence identity checks. No foreground-display fallback exists. */
public final class DisplayCommandGuard {
    public record Session(String id, long generation, int displayId) {
        public static Session read(JSONObject value) {
            if (value == null) return null;
            String id = value.optString("sessionId", "");
            long generation = value.optLong("generation", -1);
            int display = value.optInt("displayId", -1);
            return id.isEmpty() || generation < 1 || display <= 0 ? null : new Session(id, generation, display);
        }
    }
    public record Observation(String id, Session session, int windowId, String packageName, long uiVersion) {}
    private long revokedThroughGeneration = -1;
    private Observation latest;

    public synchronized void invalidate(JSONObject current) {
        Session session = Session.read(current);
        if (session != null) revokedThroughGeneration = Math.max(revokedThroughGeneration, session.generation);
        latest = null;
    }
    public synchronized void forgetObservation() { latest = null; }
    public synchronized boolean validSession(JSONObject expected, JSONObject current) {
        Session session = Session.read(current);
        return session != null && session.equals(Session.read(expected)) && session.generation > revokedThroughGeneration;
    }
    public synchronized void observed(String id, JSONObject session, int window, String pkg, long version) {
        Session value = Session.read(session);
        if (value == null || value.generation <= revokedThroughGeneration) throw new IllegalStateException("SESSION_STALE");
        latest = new Observation(id, value, window, pkg, version);
    }
    public synchronized String checkObservation(JSONObject session, JSONObject args, int window, String pkg, long version) {
        Session value = Session.read(session);
        if (latest == null || value == null || !value.equals(latest.session) || value.generation <= revokedThroughGeneration
                || !latest.id.equals(args.optString("observation_id", ""))) return "STALE_OBSERVATION";
        if (!args.has("expected_window_id") || args.optInt("expected_window_id", -1) != latest.windowId
                || window != latest.windowId || pkg == null || !pkg.equals(latest.packageName)) return "WINDOW_CHANGED";
        // A sheet or pane opening inside the same window does not expire the observation:
        // the Mac re-reads the label right before a text tap, and every action is followed
        // by a fresh read. This matches main-screen Phone Use, which only binds the
        // latest observation, the window and the package.
        return null;
    }
    public static String admission(ControlState gate, long epoch, long deadline, long now, boolean locked) {
        if (gate == null || !gate.permitsData(epoch)) return "LOCALLY_PAUSED";
        if (deadline <= 0 || now >= deadline) return "EXPIRED";
        if (locked) return "LOCKED";
        return null;
    }
}
