package dev.boujoy.personalagent;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;

/** A bounded view of confirmed server receipts; phase changes never create checkmarks. */
final class RearProgress {
    record Step(String id, String label, String state) {}

    static List<Step> from(JSONObject snapshot, RearStatus.ViewState current, boolean background) {
        if (snapshot == null || current == null || current.stale() || current.taskId().isBlank()
                || current.locked() && !background) return List.of();
        JSONObject task = task(snapshot, current.taskId());
        if (task == null) return List.of();
        boolean moving = !snapshot.optBoolean("paused", true)
                && ("running".equals(task.optString("status")) || "waiting_children".equals(task.optString("status")));
        LinkedHashMap<String, Step> unique = new LinkedHashMap<>();
        JSONArray progress = task.optJSONArray("progress");
        if (progress != null) for (int i = Math.max(0, progress.length() - 24); i < progress.length(); i++) {
            JSONObject row = progress.optJSONObject(i);
            if (row == null) continue;
            String id = clean(row.optString("id", ""), 120), label = clean(row.optString("label", ""), 36);
            if (id.isBlank() || label.isBlank()) continue;
            String state = row.optString("state", "waiting");
            if (!"completed".equals(state) && !("running".equals(state) && moving)) state = "waiting";
            unique.put(id, new Step(id, label, state));
        }
        List<Step> rows = new ArrayList<>(unique.values());
        if (rows.size() > 3) rows = new ArrayList<>(rows.subList(rows.size() - 3, rows.size()));
        if (rows.isEmpty()) {
            boolean completed = "completed".equals(task.optString("status")) || "succeeded".equals(task.optString("status"));
            String label = completed ? "任务已完成" : current.phase().isBlank() ? current.status() : current.phase();
            rows.add(new Step(current.taskId() + ":current", clean(label, 36), completed ? "completed" : moving ? "running" : "waiting"));
        }
        // A malformed/older service must not make several items spin at once.
        boolean runningSeen = false;
        for (int i = rows.size() - 1; i >= 0; i--) {
            Step row = rows.get(i);
            if ("running".equals(row.state())) {
                if (runningSeen) rows.set(i, new Step(row.id(), row.label(), "waiting"));
                runningSeen = true;
            }
        }
        return List.copyOf(rows);
    }

    static String color(JSONObject snapshot, String taskId) {
        JSONObject task = task(snapshot, taskId), state = snapshot == null ? null : snapshot.optJSONObject("state");
        JSONArray roles = state == null ? null : state.optJSONArray("roles");
        String roleId = task == null ? "" : task.optString("roleId", "");
        if (roles != null && !roleId.isBlank()) for (int i = 0; i < roles.length(); i++) {
            JSONObject role = roles.optJSONObject(i);
            if (role != null && roleId.equals(role.optString("id"))) return clean(role.optString("botColor", "violet"), 16);
        }
        return "violet";
    }

    private static JSONObject task(JSONObject snapshot, String id) {
        JSONObject state = snapshot == null ? null : snapshot.optJSONObject("state");
        JSONArray tasks = state == null ? null : state.optJSONArray("tasks");
        if (tasks != null && id != null && !id.isBlank()) for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.optJSONObject(i);
            if (task != null && id.equals(task.optString("id"))) return task;
        }
        return null;
    }
    private static String clean(String value, int limit) {
        String text = value.replaceAll("[\\p{Cntrl}\\p{Zl}\\p{Zp}]", " ").replaceAll("\\s+", " ").strip();
        return text.codePointCount(0, text.length()) <= limit ? text : text.substring(0, text.offsetByCodePoints(0, limit - 1)) + "…";
    }
}
