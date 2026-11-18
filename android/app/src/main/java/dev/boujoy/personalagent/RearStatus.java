package dev.boujoy.personalagent;

import org.json.JSONArray;
import org.json.JSONObject;
import java.time.Instant;
import java.util.Set;

/** Pure presentation of authenticated task snapshots. Never estimates progress. */
final class RearStatus {
    static final long FRESH_FOR_MS = 30_000;
    // Unresolved historical work remains stoppable, but must not replace a newer outcome.
    private static final Set<String> PRIORITY = Set.of("queued", "running", "waiting_children", "waiting_approval", "waiting_consent");
    private static final Set<String> STOPPABLE = Set.of("queued", "running", "waiting_children", "waiting_approval", "waiting_consent", "waiting_setup", "waiting_user", "needs_input", "unknown_result", "ready_for_user", "blocked");
    record ViewState(String taskId, String title, String phase, String status, String updatedAt,
                     boolean stale, boolean locked, boolean canStop) {}

    static ViewState from(JSONObject snapshot, long nowElapsedMs, boolean locked) { return from(snapshot, nowElapsedMs, locked, false); }
    /**
     * progressWhileLocked: background execution, where the user turned the screen off and asked
     * to still see what is being done. The current step and state are shown; the task's own
     * title (the user's words) and timestamps stay hidden behind the lock.
     */
    static ViewState from(JSONObject snapshot, long nowElapsedMs, boolean locked, boolean progressWhileLocked) {
        if (snapshot == null) snapshot = new JSONObject();
        long synced = snapshot.optLong("stateSyncedAtElapsedMs", 0);
        boolean stale = !snapshot.optBoolean("online") || synced <= 0 || nowElapsedMs < synced || nowElapsedMs - synced > FRESH_FOR_MS;
        JSONObject state = snapshot.optJSONObject("state");
        JSONObject task = select(state == null ? null : state.optJSONArray("tasks"), text(snapshot,"displayTaskId"));
        String id = text(task, "id"), taskState = text(task, "status");
        boolean canStop = task != null && STOPPABLE.contains(taskState);
        // All task text, including timestamps, is removed from the locked presentation.
        if (locked && progressWhileLocked && !stale && task != null) {
            String label = snapshot.optBoolean("paused") && canStop ? "手机已暂停" : label(taskState);
            return new ViewState(id, "", text(task, "phase"), label, "", false, true, canStop);
        }
        if (locked) return new ViewState(id, "", "", "Boujoy 正在处理", "", stale, true, canStop);
        if (stale) return new ViewState(id, text(task, "title"), "", "状态已过期", text(task, "updatedAt"), true, false, canStop);
        if (task == null) return new ViewState("", "暂无任务", "", "等待新的任务", "", false, false, false);
        String label = snapshot.optBoolean("paused") && canStop ? "手机已暂停" : label(taskState);
        String update = text(task, "phaseAt");
        if (update.isBlank()) update = text(task, "updatedAt");
        return new ViewState(id, text(task, "title"), text(task, "phase"), label, update, false, false, canStop);
    }

    private static JSONObject select(JSONArray tasks, String preferredTaskId) {
        JSONObject selected = null;
        int selectedRank = -1;
        long selectedAt = Long.MIN_VALUE;
        if (tasks == null) return null;
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.optJSONObject(i);
            if (task == null || text(task, "id").isBlank()) continue;
            String status = text(task, "status");
            // A real task executing on this live display wins among active tasks. A stale,
            // absent, completed or handoff-only preference never overrides another active task.
            if (PRIORITY.contains(status) && !preferredTaskId.isBlank() && preferredTaskId.equals(text(task,"id"))) return task;
            int rank = PRIORITY.contains(status) ? 1 : 0;
            long at = timestamp(text(task, "updatedAt"));
            if (selected == null || rank > selectedRank || rank == selectedRank && at > selectedAt) {
                selected = task; selectedRank = rank; selectedAt = at;
            }
        }
        return selected;
    }
    private static long timestamp(String value) { try { return Instant.parse(value).toEpochMilli(); } catch (Exception ignored) { return 0; } }
    private static String text(JSONObject object, String key) {
        return object == null || object.isNull(key) ? "" : object.optString(key, "");
    }
    private static String label(String status) {
        return switch (status) {
            case "queued" -> "等待执行";
            case "running", "waiting_children" -> "正在处理";
            case "waiting_approval", "waiting_consent" -> "等待确认";
            case "waiting_setup", "waiting_user", "needs_input", "ready_for_user", "blocked" -> "等待你处理";
            case "unknown_result" -> "结果待核实";
            case "completed", "succeeded" -> "已完成";
            case "failed" -> "任务失败";
            case "expired" -> "任务已到时限";
            case "stopped", "cancelled", "paused" -> "已停止";
            default -> "状态待核实";
        };
    }
}
