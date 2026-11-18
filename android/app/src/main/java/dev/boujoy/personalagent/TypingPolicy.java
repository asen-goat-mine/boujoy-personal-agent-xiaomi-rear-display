package dev.boujoy.personalagent;

import android.text.InputType;

/** Decides which focused fields Boujoy may type into. Password fields are never accepted. */
public final class TypingPolicy {
    private TypingPolicy() {}
    /** No app is read-only by package any more (2026-11-07: the user wants the model free in WeChat too).
     *  Password and verification-code fields stay protected by {@link #password} and the hint check. */
    public static boolean readOnlyApp(String pkg) {
        return false;
    }
    public static boolean writableEditor(String target, String active) {
        return target != null && target.equals(active) && !readOnlyApp(active);
    }
    public static boolean password(int inputType) {
        int klass = inputType & InputType.TYPE_MASK_CLASS;
        int variation = inputType & InputType.TYPE_MASK_VARIATION;
        if (klass == InputType.TYPE_CLASS_TEXT) {
            return variation == InputType.TYPE_TEXT_VARIATION_PASSWORD
                    || variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
                    || variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD;
        }
        return klass == InputType.TYPE_CLASS_NUMBER && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD;
    }
    public static boolean textAllowed(String text, String mode) {
        if (text == null || text.isEmpty() || text.length() > 2000) return false;
        if (!"insert".equals(mode) && !"replace".equals(mode)) return false;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c < 32 && c != '\n' && c != '\t') return false;
        }
        return true;
    }
}
