package dev.boujoy.personalagent;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.InputMethod;
import android.os.Handler;
import android.os.Looper;
import android.view.accessibility.AccessibilityEvent;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.SurroundingText;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;
import org.json.JSONObject;

/** Android 13+ editing connection: retains the user's keyboard and needs no adb. */
public final class BoujoyTypingService extends AccessibilityService {
    private static volatile BoujoyTypingService connected;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private final String instance = UUID.randomUUID().toString();
    private long editorGeneration;
    public record Outcome(String status, String diagnostic, JSONObject proof) {
        public Outcome(String status, String diagnostic) { this(status, diagnostic, null); }
    }
    @Override public InputMethod onCreateInputMethod() {
        return new InputMethod(this) {
            @Override public void onStartInput(EditorInfo info, boolean restarting) { editorGeneration++; super.onStartInput(info, restarting); }
            @Override public void onFinishInput() { editorGeneration++; super.onFinishInput(); }
        };
    }
    @Override protected void onServiceConnected() { connected = this; }
    @Override public void onAccessibilityEvent(AccessibilityEvent event) { /* Never collect event text. */ }
    @Override public void onInterrupt() { }
    @Override public boolean onUnbind(android.content.Intent intent) { if (connected == this) connected = null; return super.onUnbind(intent); }
    @Override public void onDestroy() { if (connected == this) connected = null; super.onDestroy(); }
    public static boolean ready() { return connected != null; }
    public static String type(String text, String mode, String pkg, BooleanSupplier allowed) { return typeDetailed(text, mode, pkg, allowed).status(); }
    public static Outcome perform(String operation, String text, String mode, String pkg,
            String referenceId, long epoch, BooleanSupplier allowed) {
        return EditorReadback.dispatch(operation, () -> typeDetailed(text, mode, pkg, allowed),
                () -> "replace".equals(mode) ? verifyDetailed(text, pkg, referenceId, epoch, allowed) : new Outcome("unverified", "invalid_request"),
                () -> new Outcome("failed", "invalid_request"));
    }
    private static String hex(byte[] bytes) { StringBuilder out = new StringBuilder(); for (byte value : bytes) out.append(String.format(java.util.Locale.ROOT, "%02x", value & 255)); return out.toString(); }
    private EditorReadback.Sample sample(String pkg) {
        InputMethod input = getInputMethod();
        EditorInfo info = input == null ? null : input.getCurrentInputEditorInfo();
        InputMethod.AccessibilityInputConnection connection = input == null ? null : input.getCurrentInputConnection();
        if (info == null || connection == null || !input.getCurrentInputStarted() || !TypingPolicy.writableEditor(pkg, info.packageName)) return null;
        boolean protectedField = TypingPolicy.password(info.inputType) || String.valueOf(info.hintText).matches("(?i).*(密码|验证码|password|passcode|\\bOTP\\b).*");
        if (protectedField) return new EditorReadback.Sample("protected", null, -1, true, true);
        String identity;
        try { identity = hex(MessageDigest.getInstance("SHA-256").digest((instance + ":" + editorGeneration + ":" + pkg + ":" + info.fieldId + ":" + info.inputType).getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
        SurroundingText value = connection.getSurroundingText(2000, 2000, 0);
        return new EditorReadback.Sample(identity, value == null ? null : value.getText().toString(), value == null ? -1 : value.getOffset(), true, false);
    }
    private static Outcome verifyDetailed(String text, String pkg, String referenceId, long epoch, BooleanSupplier allowed) {
        if (TypingPolicy.readOnlyApp(pkg)) return new Outcome("unverified", "protected_input");
        if (!TypingPolicy.textAllowed(text, "replace") || pkg == null || !pkg.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+") || referenceId == null || !referenceId.matches("[a-f0-9-]{36}") || epoch < 0) return new Outcome("unverified", "invalid_request");
        CompletableFuture<Outcome> done = new CompletableFuture<>();
        MAIN.post(() -> {
            if (done.isDone()) return;
            try {
                BoujoyTypingService service = connected;
                if (service == null || !allowed.getAsBoolean()) { done.complete(new Outcome("unverified", "control_paused")); return; }
                EditorReadback.Sample first = service.sample(pkg);
                if (!EditorReadback.exact(first, text)) { done.complete(new Outcome("unverified", EditorReadback.diagnostic(first, text))); return; }
                MAIN.postDelayed(() -> {
                    if (done.isDone()) return;
                    try {
                        if (connected != service || !allowed.getAsBoolean()) { done.complete(new Outcome("unverified", "control_paused")); return; }
                        EditorReadback.Sample second = service.sample(pkg);
                        if (connected != service || !allowed.getAsBoolean() || !EditorReadback.stableExact(first, second, text)) { done.complete(new Outcome("unverified", EditorReadback.exact(second,text) ? "editor_changed_after_commit" : EditorReadback.diagnostic(second, text))); return; }
                        done.complete(new Outcome("verified", "readback_verified", Tunnel.json("referenceId", referenceId, "controlEpoch", epoch, "editorIdentity", second.identity(), "exact", true, "reads", 2)));
                    } catch (RuntimeException error) { done.complete(new Outcome("unverified", "readback_unavailable")); }
                }, 160);
            } catch (RuntimeException error) { done.complete(new Outcome("unverified", "readback_unavailable")); }
        });
        try { return done.get(6, TimeUnit.SECONDS); }
        catch (Exception error) { Outcome timed = new Outcome("unverified", "readback_unavailable"); done.complete(timed); return done.getNow(timed); }
    }
    public static Outcome typeDetailed(String text, String mode, String pkg, BooleanSupplier allowed) {
        if (TypingPolicy.readOnlyApp(pkg)) return new Outcome("failed", "protected_input");
        if (!TypingPolicy.textAllowed(text, mode) || pkg == null || !pkg.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")) return new Outcome("failed", "invalid_request");
        if (connected == null) return new Outcome("permission", "service_unavailable");
        CompletableFuture<Outcome> done = new CompletableFuture<>();
        EditorDispatch submitted = new EditorDispatch();
        MAIN.post(() -> deliver(text, mode, pkg, allowed, done, submitted));
        try { return done.get(6, TimeUnit.SECONDS); }
        catch (Exception error) {
            submitted.stopBeforeCommit();
            Outcome timed = new Outcome(submitted.mayHaveCommitted() ? "submitted" : "failed", submitted.mayHaveCommitted() ? "commit_timeout" : "prepare_timeout");
            done.complete(timed); return done.getNow(timed);
        }
    }
    private static void deliver(String text, String mode, String pkg, BooleanSupplier allowed, CompletableFuture<Outcome> done, EditorDispatch submitted) {
        if (done.isDone()) return;
        try {
            BoujoyTypingService service = connected;
            if (service == null) { done.complete(new Outcome("permission", "service_unavailable")); return; }
            if (!allowed.getAsBoolean()) { done.complete(new Outcome("failed", "control_paused")); return; }
            InputMethod input = service.getInputMethod();
            EditorInfo info = input == null ? null : input.getCurrentInputEditorInfo();
            InputMethod.AccessibilityInputConnection connection = input == null ? null : input.getCurrentInputConnection();
            if (info == null || connection == null || !input.getCurrentInputStarted() || !TypingPolicy.writableEditor(pkg, info.packageName)) { done.complete(new Outcome("unfocused", "focus_missing")); return; }
            if (TypingPolicy.password(info.inputType) || String.valueOf(info.hintText).matches("(?i).*(密码|验证码|password|passcode|\\bOTP\\b).*")) { done.complete(new Outcome("password", "protected_input")); return; }
            if ("replace".equals(mode)) {
                EditorReplacement.prepare(new EditorReplacement.Selection() {
                    public int[] surroundingRange() {
                        try { SurroundingText before = connection.getSurroundingText(2000, 2000, 0); return before == null ? null : new int[]{before.getOffset(), before.getText().length()}; }
                        catch (RuntimeException unavailable) { return null; }
                    }
                    public void select(int start, int end) { connection.setSelection(start, end); }
                    public void selectAll() { connection.performContextMenuAction(android.R.id.selectAll); }
                });
            }
            EditorInfo currentInfo = input.getCurrentInputEditorInfo();
            if (done.isDone() || !allowed.getAsBoolean() || currentInfo == null || !TypingPolicy.writableEditor(pkg, currentInfo.packageName) || currentInfo.fieldId != info.fieldId) { done.complete(new Outcome("failed", "editor_changed_before_commit")); return; }
            // Once commit may have been dispatched, never report not-sent or retry.
            if (!submitted.beginCommit()) return;
            connection.commitText(text, 1, null);
            confirmSubmitted(service, input, info, connection, service.editorGeneration, text, mode, pkg, allowed, done, 0);

        } catch (RuntimeException error) { done.complete(new Outcome(submitted.mayHaveCommitted() ? "submitted" : "failed", submitted.mayHaveCommitted() ? "commit_exception" : "prepare_exception")); }
    }
    private static void confirmSubmitted(BoujoyTypingService service, InputMethod input, EditorInfo info,
            InputMethod.AccessibilityInputConnection connection, long generation, String text, String mode,
            String pkg, BooleanSupplier allowed, CompletableFuture<Outcome> done, int attempt) {
        MAIN.postDelayed(() -> {
            if (done.isDone()) return;
            try {
                EditorInfo after = input.getCurrentInputEditorInfo();
                if (connected != service || !allowed.getAsBoolean() || service.editorGeneration != generation || !input.getCurrentInputStarted() || after == null || !TypingPolicy.writableEditor(pkg, after.packageName) || after.fieldId != info.fieldId) { done.complete(new Outcome("submitted", "editor_changed_after_commit")); return; }
                SurroundingText readback = connection.getSurroundingText(2000, 2000, 0);
                boolean verified = readback != null && ("replace".equals(mode) ? readback.getOffset() == 0 && text.contentEquals(readback.getText()) : readback.getText().toString().contains(text));
                if (!verified && attempt == 0) { confirmSubmitted(service, input, info, connection, generation, text, mode, pkg, allowed, done, 1); return; }
                done.complete(new Outcome(verified ? "typed" : "submitted", verified ? "readback_verified" : "readback_unavailable"));
            } catch (RuntimeException error) {
                if (attempt == 0) confirmSubmitted(service, input, info, connection, generation, text, mode, pkg, allowed, done, 1);
                else done.complete(new Outcome("submitted", "readback_unavailable"));
            }
        }, attempt == 0 ? 120 : 200);
    }

}
