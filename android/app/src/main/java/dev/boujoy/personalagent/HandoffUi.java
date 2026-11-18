package dev.boujoy.personalagent;

import org.json.JSONObject;

/** Presentation only. The bridge remains authoritative when a button is pressed. */
final class HandoffUi {
    record Card(String id, String status, String title, String summary, boolean retry) {}

    static Card from(JSONObject handoff, boolean locked, long nowMs) {
        if (handoff == null) return null;
        String id = handoff.optString("handoffId", "");
        String state = handoff.optString("state", "");
        if (id.isBlank() || id.length() > 128 || !("pending".equals(state) || "failed".equals(state))
                || handoff.optLong("expiresAtMs", 0) <= nowMs) return null;
        boolean retry = "failed".equals(state);
        if (locked) return new Card(id, "Boujoy 需要你接手", "", "", retry);
        String title = text(handoff, "title", 40);
        return new Card(id, retry ? "没能移到主屏，请稍后重试" : "需要你接手",
                title.isBlank() ? "后台留下的页面" : title, text(handoff, "summary", 160), retry);
    }
    static boolean matches(JSONObject handoff, String id, long nowMs) {
        Card card = from(handoff, false, nowMs);
        return card != null && card.id().equals(id);
    }
    private static String text(JSONObject source, String key, int maxCodePoints) {
        String value = source.isNull(key) ? "" : source.optString(key, "").strip();
        int count = value.codePointCount(0, value.length());
        return count <= maxCodePoints ? value : value.substring(0, value.offsetByCodePoints(0, maxCodePoints));
    }
}
