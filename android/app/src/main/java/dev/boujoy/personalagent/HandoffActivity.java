package dev.boujoy.personalagent;

import android.app.Activity;
import android.app.ActivityOptions;
import android.app.KeyguardManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.Display;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.TextView;
import android.widget.Toast;

/** Non-exported, user-click-only trampoline. It never launches the target app afresh. */
public final class HandoffActivity extends Activity {
    private static final String ACTION = BuildConfig.APPLICATION_ID+".TAKE_DISPLAY_HANDOFF";
    private static final String EXTRA_ID = "handoffId";
    private String handoffId = "";
    private volatile boolean resumed, focused, clickActive;
    private boolean submitted, unlocking;

    public static Intent intent(Context context, String id) {
        return new Intent(context, HandoffActivity.class).setAction(ACTION)
                .setData(new Uri.Builder().scheme("boujoy-internal").authority("handoff").appendPath(id).build())
                .putExtra(EXTRA_ID, id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    }
    private static Bundle mainDisplayOptions() {
        return ActivityOptions.makeBasic().setLaunchDisplayId(Display.DEFAULT_DISPLAY).toBundle();
    }
    public static PendingIntent pendingIntent(Context context, String id) {
        return PendingIntent.getActivity(context, 0, intent(context, id),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE, mainDisplayOptions());
    }
    public static void launch(Context context, String id) {
        if(!BuildConfig.BACKGROUND_SUPPORTED)throw new IllegalStateException("background_not_supported");
        context.startActivity(intent(context, id), mainDisplayOptions());
    }
    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        if(!BuildConfig.BACKGROUND_SUPPORTED){finish();return;}
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        Intent source = getIntent();
        handoffId = source == null ? "" : source.getStringExtra(EXTRA_ID);
        // Recreating an already started transfer must never replay a move with an uncertain outcome.
        if (saved != null || source == null || !ACTION.equals(source.getAction()) || !onMainDisplay()
                || !currentHandoff()) { finish(); return; }
        clickActive = true;
        setShowWhenLocked(true);
        // A user explicitly requested a main-screen takeover. No task or polling path starts this Activity.
        setTurnScreenOn(true);
        TextView message = new TextView(this); message.setGravity(Gravity.CENTER);
        message.setText("解锁后在主屏接手"); message.setTextSize(18); setContentView(message);
    }
    @Override protected void onResume() {
        super.onResume(); resumed = true; continueUserRequest();
    }
    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus); focused = hasFocus;
        if (hasFocus) continueUserRequest();
    }
    @Override protected void onPause() {
        resumed = false; focused = false; setTurnScreenOn(false);
        // System authentication may pause us. Any other departure before dispatch cancels this click.
        if (!unlocking) clickActive = false;
        super.onPause();
    }
    @Override protected void onDestroy() {
        clickActive = false; resumed = false; focused = false; setTurnScreenOn(false); super.onDestroy();
    }
    private void continueUserRequest() {
        if (!clickActive || !resumed || submitted || unlocking || isFinishing()) return;
        if (!onMainDisplay() || !currentHandoff()) { clickActive = false; finish(); return; }
        try {
            KeyguardManager keyguard = getSystemService(KeyguardManager.class);
            if (keyguard == null) { clickActive = false; finish(); return; }
            if (keyguard.isDeviceLocked() || keyguard.isKeyguardLocked()) {
                unlocking = true;
                keyguard.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                    @Override public void onDismissSucceeded() { unlocking = false; continueUserRequest(); }
                    @Override public void onDismissCancelled() { unlocking = false; clickActive = false; finish(); }
                    @Override public void onDismissError() { unlocking = false; clickActive = false; finish(); }
                });
                return;
            }
        } catch (RuntimeException unavailable) { unlocking = false; clickActive = false; finish(); return; }
        if (!focused) return;
        ConnectionService service = ConnectionService.current;
        if (service == null) { Toast.makeText(this, "Boujoy 连接尚未就绪，请稍后重试", Toast.LENGTH_SHORT).show(); finish(); return; }
        submitted = true;
        service.takeHandoff(handoffId, this::allowsMove, (result, error) -> {
            clickActive = false;
            if (!isDestroyed()) {
                if (error != null || result == null || !"taken".equals(result.optString("state")))
                    Toast.makeText(this, "没能移到主屏，请稍后重试", Toast.LENGTH_LONG).show();
                finish();
            }
        });
    }
    private boolean allowsMove() {
        if (!clickActive || !resumed || !focused || isFinishing() || isDestroyed() || !onMainDisplay()) return false;
        try {
            KeyguardManager keyguard = getSystemService(KeyguardManager.class);
            return keyguard != null && !keyguard.isDeviceLocked() && !keyguard.isKeyguardLocked();
        } catch (RuntimeException unavailable) { return false; }
    }
    private boolean currentHandoff() {
        return HandoffUi.matches(DisplayBridge.get(this).handoff(), handoffId, System.currentTimeMillis());
    }
    private boolean onMainDisplay() {
        try { Display display = getDisplay(); return display != null && display.getDisplayId() == Display.DEFAULT_DISPLAY; }
        catch (RuntimeException unavailable) { return false; }
    }
}
