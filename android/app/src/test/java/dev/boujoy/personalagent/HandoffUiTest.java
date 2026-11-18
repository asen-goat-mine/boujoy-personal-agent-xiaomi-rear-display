package dev.boujoy.personalagent;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class HandoffUiTest {
    private JSONObject handoff(String state) throws Exception {
        return new JSONObject().put("handoffId", "one").put("state", state).put("title", "订单核对")
                .put("summary", "请核对收货信息后自行付款").put("expiresAtMs", 2000);
    }
    @Test public void pendingAndFailedKeepUserControlsUntilExpiry() throws Exception {
        assertNotNull(HandoffUi.from(handoff("pending"), false, 1000));
        HandoffUi.Card retry = HandoffUi.from(handoff("failed"), false, 1000);
        assertTrue(retry.retry()); assertEquals("订单核对", retry.title());
        assertNull(HandoffUi.from(handoff("pending"), false, 2000));
        for (String state : new String[]{"taken", "dismissed", "expired", "unknown"})
            assertNull(state, HandoffUi.from(handoff(state), false, 1000));
    }
    @Test public void lockedCardHasNoTaskTitleOrSummaryButKeepsExplicitControls() throws Exception {
        HandoffUi.Card card = HandoffUi.from(handoff("failed"), true, 1000);
        assertEquals("Boujoy 需要你接手", card.status()); assertEquals("", card.title()); assertEquals("", card.summary());
        assertEquals("one", card.id());
    }
    @Test public void staleAndMissingIdsCannotAuthorizeOldButtons() throws Exception {
        assertFalse(HandoffUi.matches(handoff("pending"), "old", 1000));
        assertFalse(HandoffUi.matches(handoff("taken"), "one", 1000));
        assertFalse(HandoffUi.matches(handoff("pending"), "one", 2000));
        assertFalse(HandoffUi.matches(null, "one", 1000));
        assertNull(HandoffUi.from(handoff("pending").put("handoffId", ""), false, 1000));
        assertNull(HandoffUi.from(handoff("pending").put("expiresAtMs", 0), false, 1000));
    }
    @Test public void malformedLargeTextIsBoundedWithoutSplittingEmoji() throws Exception {
        HandoffUi.Card card = HandoffUi.from(handoff("pending").put("title", "🧭".repeat(50)).put("summary", "字".repeat(170)), false, 1000);
        assertEquals(40, card.title().codePointCount(0, card.title().length())); assertEquals(160, card.summary().length());
    }
}
