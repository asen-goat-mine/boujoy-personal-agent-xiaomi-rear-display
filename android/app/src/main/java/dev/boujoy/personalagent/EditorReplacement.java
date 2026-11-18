package dev.boujoy.personalagent;

/** A custom editor may support editing but not expose surrounding text. */
public final class EditorReplacement {
    private EditorReplacement() {}
    public interface Selection {
        int[] surroundingRange(); // offset and length, or null when unavailable
        void select(int start, int end);
        void selectAll();
    }
    public static void prepare(Selection editor) {
        int[] range = editor.surroundingRange();
        if (range != null && range.length == 2 && range[0] == 0 && range[1] >= 0 && range[1] < 4000) {
            editor.select(0, range[1]);
        } else {
            // Selecting the bounded excerpt would append or leave an old prefix.
            // Use the editor's own select-all, never a guessed delete count.
            editor.selectAll();
        }
    }
}
