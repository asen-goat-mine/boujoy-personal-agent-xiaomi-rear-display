package dev.boujoy.personalagent;
import org.junit.Test;
import static org.junit.Assert.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

public class EditorReadbackTest {
    private EditorReadback.Sample sample(String identity, String text, int offset) { return new EditorReadback.Sample(identity, text, offset, true, false); }
    @Test public void onlyTwoCompleteExactReadsOfTheSameEditorVerify() {
        assertTrue(EditorReadback.stableExact(sample("editor-1", "原文", 0), sample("editor-1", "原文", 0), "原文"));
        assertFalse(EditorReadback.stableExact(sample("editor-1", "原文", 0), sample("editor-2", "原文", 0), "原文"));
    }
    @Test public void missingTruncatedPrefixAndDifferentTextStayUnverified() {
        assertFalse(EditorReadback.exact(null, "原文"));
        assertFalse(EditorReadback.exact(sample("e", "原文", -1), "原文"));
        assertFalse(EditorReadback.exact(sample("e", "原文", 5), "原文"));
        assertFalse(EditorReadback.exact(sample("e", "原文多一个字", 0), "原文"));
        assertFalse(EditorReadback.exact(sample("e", "a b", 0), "ab"));
        assertEquals("readback_partial", EditorReadback.diagnostic(sample("e", "原文", -1), "原文"));
        assertEquals("readback_mismatch", EditorReadback.diagnostic(sample("e", "不同", 0), "原文"));
        assertEquals("readback_unavailable", EditorReadback.diagnostic(sample("e", null, -1), "原文"));
    }
    @Test public void protectedOrNonEditableFieldsNeverVerify() {
        assertFalse(EditorReadback.exact(new EditorReadback.Sample("e", "原文", 0, false, false), "原文"));
        assertFalse(EditorReadback.exact(new EditorReadback.Sample("e", "原文", 0, true, true), "原文"));
    }
    @Test public void verificationAndUnknownOperationsNeverInvokeTheWritePath() {
        AtomicInteger commits = new AtomicInteger(), reads = new AtomicInteger(), rejects = new AtomicInteger();
        assertEquals("verified", EditorReadback.dispatch("verify_replace", () -> { commits.incrementAndGet(); return "typed"; }, () -> { reads.incrementAndGet(); return "verified"; }, () -> { rejects.incrementAndGet(); return "failed"; }));
        assertEquals("failed", EditorReadback.dispatch("future-operation", () -> { commits.incrementAndGet(); return "typed"; }, () -> { reads.incrementAndGet(); return "verified"; }, () -> { rejects.incrementAndGet(); return "failed"; }));
        assertEquals(0, commits.get()); assertEquals(1, reads.get()); assertEquals(1, rejects.get());
    }
    @Test public void missingWireOperationAndLiteralTypeBothUseTheExistingInputPath() throws Exception {
        assertEquals("type", ConnectionService.decodeTypingOperation(new JSONObject("{\"text\":\"draft\"}")));
        assertEquals("type", ConnectionService.decodeTypingOperation(new JSONObject("{\"operation\":\"type\"}")));
        assertEquals("typed", EditorReadback.dispatch("type", () -> "typed", () -> { throw new AssertionError("unexpected read"); }, () -> { throw new AssertionError("unexpected rejection"); }));
        String verify = ConnectionService.decodeTypingOperation(new JSONObject("{\"operation\":\"verify_replace\"}"));
        assertEquals("verified", EditorReadback.dispatch(verify, () -> { throw new AssertionError("unexpected write"); }, () -> "verified", () -> { throw new AssertionError("unexpected rejection"); }));
    }
    @Test public void explicitNullEmptyWrongTypeAndUnknownWireValuesNeverSelectOrCommit() throws Exception {
        for (String value : new String[]{"null", "\"\"", "\" \"", "false", "0", "{}", "[]", "\"TYPE\"", "\"future_operation\""}) {
            String operation = ConnectionService.decodeTypingOperation(new JSONObject("{\"operation\":" + value + "}"));
            assertNull(value, operation);
            assertRejectedWithoutInput(operation);
        }
        for (String operation : new String[]{null, "", " ", "unknown"}) assertRejectedWithoutInput(operation);
    }
    private void assertRejectedWithoutInput(String operation) {
        assertEquals("failed", EditorReadback.dispatch(operation,
                () -> { throw new AssertionError("malformed operation entered selection/commit path"); },
                () -> { throw new AssertionError("malformed operation entered read path"); }, () -> "failed"));
    }
}
