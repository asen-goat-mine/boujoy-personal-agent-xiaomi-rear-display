package dev.boujoy.personalagent;

/** A complete editor read is evidence; a substring, unknown offset, or changed editor is not. */
public final class EditorReadback {
    private EditorReadback() {}
    public record Sample(String identity, String text, int offset, boolean editable, boolean protectedField) {}
    public static boolean exact(Sample value, String expected) {
        return value != null && value.identity() != null && !value.identity().isEmpty()
                && value.editable() && !value.protectedField() && value.offset() == 0
                && expected != null && expected.equals(value.text());
    }
    public static boolean stableExact(Sample first, Sample second, String expected) {
        return exact(first, expected) && exact(second, expected) && first.identity().equals(second.identity());
    }
    public static String diagnostic(Sample value, String expected) {
        if (value == null || !value.editable()) return "focus_missing";
        if (value.protectedField()) return "protected_input";
        if (value.text() == null) return "readback_unavailable";
        if (value.offset() != 0) return "readback_partial";
        return exact(value, expected) ? "readback_verified" : "readback_mismatch";
    }
    public static <T> T dispatch(String operation, java.util.function.Supplier<T> type,
            java.util.function.Supplier<T> verify, java.util.function.Supplier<T> reject) {
        if ("type".equals(operation)) return type.get();
        if ("verify_replace".equals(operation)) return verify.get();
        return reject.get();
    }
}
