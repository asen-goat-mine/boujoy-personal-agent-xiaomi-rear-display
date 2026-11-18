package dev.boujoy.personalagent;

import android.content.Context;
import android.inputmethodservice.InputMethodService;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.ExtractedTextRequest;
import android.view.inputmethod.InputConnection;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Commits one host-requested string through the real InputConnection. On Samsung
 * the Mac switches this IME in via adb; Settings.Secure writes are best-effort.
 */
public final class BoujoyInputMethod extends InputMethodService {
    static final String ID = BuildConfig.APPLICATION_ID + "/dev.boujoy.personalagent.BoujoyInputMethod";
    private static final String PREF = "boujoy-ime";
    private static final String TAG = "BoujoyIme";
    private static volatile Job pending;

    public static String type(Context context, String text, String mode) {
        if (!TypingPolicy.textAllowed(text, mode)) return "failed";
        CompletableFuture<String> done = new CompletableFuture<>();
        Handler main = new Handler(Looper.getMainLooper());
        main.post(() -> begin(context.getApplicationContext(), text, mode, done, main));
        try { return done.get(7, TimeUnit.SECONDS); }
        catch (Exception error) { finish("unfocused"); return "unfocused"; }
    }

    private static void begin(Context context, String text, String mode, CompletableFuture<String> done, Handler main) {
        pending = new Job(text, mode, done);
        trySwitch(context);
        main.postDelayed(() -> { Job job = pending; if (job != null) job.finish("unfocused", context); }, 6000);
    }

    private static void trySwitch(Context context) {
        try {
            String current = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.DEFAULT_INPUT_METHOD);
            if (current != null && !current.startsWith(BuildConfig.APPLICATION_ID + "/")) {
                context.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit().putString("user", current).apply();
            }
            String enabled = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ENABLED_INPUT_METHODS);
            if (enabled == null || !enabled.contains(ID)) {
                Settings.Secure.putString(context.getContentResolver(), Settings.Secure.ENABLED_INPUT_METHODS,
                        enabled == null || enabled.isEmpty() ? ID : enabled + ":" + ID);
            }
            Settings.Secure.putString(context.getContentResolver(), Settings.Secure.DEFAULT_INPUT_METHOD, ID);
        } catch (SecurityException error) {
            // Expected on Samsung: the Mac host switches IME with adb instead.
            Log.i(TAG, "host must switch IME");
        } catch (RuntimeException error) {
            Log.w(TAG, "ime switch skipped", error);
        }
    }

    private static void finish(String status) { Job job = pending; if (job != null) job.finish(status, null); }

    @Override public View onCreateInputView() { View view = new View(this); view.setMinimumHeight(1); return view; }
    @Override public boolean onEvaluateFullscreenMode() { return false; }
    @Override public void onStartInput(EditorInfo info, boolean restarting) { deliver(info); }
    @Override public void onStartInputView(EditorInfo info, boolean restarting) { deliver(info); }

    private void deliver(EditorInfo info) {
        Job job = pending; if (job == null || info == null) return;
        if (TypingPolicy.password(info.inputType)) { job.finish("password", this); return; }
        InputConnection connection = getCurrentInputConnection(); if (connection == null) return;
        if ("replace".equals(job.mode)) {
            android.view.inputmethod.ExtractedText extracted = connection.getExtractedText(new ExtractedTextRequest(), 0);
            if (extracted != null && extracted.text != null && extracted.text.length() > 0) connection.setSelection(0, extracted.text.length());
            else connection.deleteSurroundingText(2000, 2000);
        }
        connection.commitText(job.text, 1);
        job.finish("typed", this);
    }

    private static final class Job {
        final String text, mode; final CompletableFuture<String> done; final AtomicBoolean finished = new AtomicBoolean();
        Job(String text, String mode, CompletableFuture<String> done) { this.text = text; this.mode = mode; this.done = done; }
        void finish(String status, Context context) {
            if (!finished.compareAndSet(false, true)) return;
            pending = null; done.complete(status);
            if (context == null) return;
            String user = context.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString("user", null);
            if (user == null || user.startsWith(BuildConfig.APPLICATION_ID + "/")) return;
            try { Settings.Secure.putString(context.getContentResolver(), Settings.Secure.DEFAULT_INPUT_METHOD, user); }
            catch (RuntimeException ignored) { /* Host adb restore is authoritative on Samsung. */ }
        }
    }
}
