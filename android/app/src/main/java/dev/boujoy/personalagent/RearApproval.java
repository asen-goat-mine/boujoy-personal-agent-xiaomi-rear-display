package dev.boujoy.personalagent;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

/** Exact, display-only approval scopes. A rear decision never grants a new control epoch. */
final class RearApproval {
    record Scope(String taskId, String approvalId, String fingerprint, long controlEpoch, long expiresAt) {}
    record Card(Scope scope, String summary, String details, String requestStatus, boolean verified, String detailError) {
        boolean canAllow() { return requestStatus.isEmpty() && verified; }
        boolean canDeny() { return requestStatus.isEmpty(); }
    }
    static List<Card> cards(JSONObject snapshot, String taskId, long nowElapsed, long now) {
        if (snapshot == null || taskId == null || taskId.isBlank() || !snapshot.optBoolean("paired")
                || !snapshot.optBoolean("online") || snapshot.optBoolean("paused", true)) return List.of();
        long synced = snapshot.optLong("stateSyncedAtElapsedMs", 0), epoch = snapshot.optLong("controlEpoch", -1);
        if (epoch < 0 || synced <= 0 || nowElapsed < synced || nowElapsed - synced > RearStatus.FRESH_FOR_MS) return List.of();
        JSONObject state = snapshot.optJSONObject("state"), device = state == null ? null : state.optJSONObject("device");
        if (device == null || device.optBoolean("paused", true) || device.optLong("controlEpoch", -1) != epoch) return List.of();
        JSONArray tasks = state.optJSONArray("tasks");
        for (int i = 0; tasks != null && i < tasks.length(); i++) {
            JSONObject task = tasks.optJSONObject(i);
            if (task == null || !taskId.equals(task.optString("id"))) continue;
            if (!"waiting_approval".equals(task.optString("status"))) return List.of();
            List<Card> result = new ArrayList<>(); JSONArray approvals = task.optJSONArray("approvals");
            for (int n = 0; approvals != null && n < approvals.length(); n++) {
                JSONObject approval = approvals.optJSONObject(n);
                if (approval == null || !"pending".equals(approval.optString("status"))) continue;
                String id = approval.optString("id"), fingerprint = approval.optString("fingerprint");
                long expires = Binding.parseTime(approval.opt("expiresAt"));
                if (!id.matches("[A-Za-z0-9_-]{1,128}") || !fingerprint.matches("[a-f0-9]{64}") || expires <= now) continue;
                Scope scope = new Scope(taskId, id, fingerprint, epoch, expires);
                result.add(new Card(scope, approval.optString("summary", ""), "", ApprovalRequests.status(snapshot, approval), false, ""));
            }
            return List.copyOf(result);
        }
        return List.of();
    }
    static boolean matches(JSONObject snapshot, Scope scope, long nowElapsed, long now) {
        return scope != null && cards(snapshot, scope.taskId(), nowElapsed, now).stream().anyMatch(card -> card.scope().equals(scope));
    }
    static boolean detailMatches(Scope scope, JSONObject approval) {
        return scope != null && approval != null && scope.taskId().equals(approval.optString("taskId"))
                && scope.approvalId().equals(approval.optString("id")) && scope.fingerprint().equals(approval.optString("fingerprint"))
                && "pending".equals(approval.optString("status")) && scope.expiresAt() == Binding.parseTime(approval.opt("expiresAt"))
                && !approval.optString("summary", "").isBlank();
    }
    static JSONObject detail(Scope scope, JSONObject task) {
        if (task == null || scope == null || !scope.taskId().equals(task.optString("id"))
                || !"waiting_approval".equals(task.optString("status"))) return null;
        JSONArray approvals = task.optJSONArray("approvals");
        for (int i = 0; approvals != null && i < approvals.length(); i++) {
            JSONObject approval = approvals.optJSONObject(i);
            if (detailMatches(scope, approval)) return approval;
        }
        return null;
    }
    static Card withDetails(Card card, JSONObject approval, String error) {
        if (!detailMatches(card.scope(), approval)) return new Card(card.scope(), card.summary(), "", card.requestStatus(), false, error == null ? "" : error);
        StringBuilder details = new StringBuilder(); JSONArray fields = approval.optJSONArray("details");
        for (int i = 0; fields != null && i < fields.length(); i++) {
            JSONObject field = fields.optJSONObject(i); if (field == null || field.optString("label").isBlank()) continue;
            if (details.length() > 0) details.append("\n\n");
            details.append(field.optString("label")).append("：\n").append(field.optString("value"));
        }
        return new Card(card.scope(), approval.optString("summary"), details.toString(), card.requestStatus(), true, "");
    }
    private RearApproval() {}
}
