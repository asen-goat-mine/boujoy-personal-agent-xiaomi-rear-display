package dev.boujoy.personalagent;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.text.TextUtils;
import android.view.Display;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;

/** Rear progress with local-first stop and explicit user handoff controls. */
public final class RearStatusActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private TextView title, phase, status, updated;
    private RearDashboardView dashboard;
    private Button stop, handoffTake, handoffDismiss;
    private LinearLayout handoffActions;
    private String handoffId="",handoffTaskId="";
    private boolean active, registered, closeRegistered, wakePolicyRegistered;
    static final long LAUNCH_WAKE_WINDOW_MS = 2_000;
    private long launchWakeUntil = -1, launchControlEpoch = -1;
    private boolean launchBackground, wakeRequested, showWhenLockedRequested;
    private ConnectionService launchService;
    private final Runnable expireLaunchWake = () -> clearLaunchWake("launch_window_expired");
    private final Runnable wakePolicyChanged = this::recheckLaunchWake;
    private final BroadcastReceiver wakePolicy = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { recheckLaunchWake(); }
    };
    private String stoppedTask = "";
    private RearStatus.ViewState current;
    private final java.util.Map<RearApproval.Scope, JSONObject> approvalDetails = new java.util.HashMap<>();
    private final java.util.Map<RearApproval.Scope, String> approvalDetailErrors = new java.util.HashMap<>();
    private final java.util.Set<RearApproval.Scope> readingApprovals = new java.util.HashSet<>();
    private long approvalUiGeneration;
    private final RearDashboardView.ApprovalActions approvalActions = new RearDashboardView.ApprovalActions() {
        public void decide(RearApproval.Scope scope, boolean allow) { decideRearApproval(scope, allow); }
        public void retryDetails(RearApproval.Scope scope) { approvalDetailErrors.remove(scope); render(); }
    };
    private final Runnable tick = new Runnable() {
        @Override public void run() { render(); if (active) handler.postDelayed(this, 1000); }
    };
    private final BroadcastReceiver updates = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { render(); }
    };
    private final BroadcastReceiver screen = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { render(); }
    };
    private final BroadcastReceiver close = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            dismissRear();
        }
    };
    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        // The shell destination is necessary but not sufficient: never construct task UI on another display.
        if (!requireRearDestination()) return;
        registerReceiver(close, new IntentFilter(DisplayBridge.CLOSE_REAR_ACTION), Context.RECEIVER_NOT_EXPORTED);
        closeRegistered = true;
        registerReceiver(wakePolicy, new IntentFilter(ConnectionService.UPDATE), Context.RECEIVER_NOT_EXPORTED);
        DisplayBridge.get(this).addLifecycleListener(wakePolicyChanged); wakePolicyRegistered = true;
        applyLockscreenPresentation();
        // A validated launch may briefly pause while HyperOS brings the rear display online.
        beginLaunchWake();
        logLifecycle("created");
        if (saved != null) stoppedTask = saved.getString("stoppedTask", "");
        dashboard = new RearDashboardView(this);
        status = dashboard.status; title = dashboard.title; phase = dashboard.phase; updated = dashboard.updated;
        stop = dashboard.stop; handoffActions = dashboard.handoffActions;
        handoffTake = dashboard.handoffTake; handoffDismiss = dashboard.handoffDismiss;
        stop.setContentDescription("停止任务并立即暂停手机操作");
        stop.setOnClickListener(view -> {
            ConnectionService service = ConnectionService.current;
            String taskId = handoffTaskId.isBlank() ? current == null ? "" : current.taskId() : handoffTaskId;
            if (service == null || taskId.isBlank()) return;
            // The helper persists rear_stop and rejects new data before sending the Mac stop request.
            stoppedTask = taskId; service.stopTaskFromRear(stoppedTask); render();
        });
        handoffTake.setOnClickListener(view -> {
            String id = handoffId;
            if (!HandoffUi.matches(DisplayBridge.get(this).handoff(), id, System.currentTimeMillis())) { render(); return; }
            try { HandoffActivity.launch(this, id); }
            catch (RuntimeException unavailable) { android.widget.Toast.makeText(this, "无法打开主屏接手入口，请稍后重试", android.widget.Toast.LENGTH_SHORT).show(); }
        });
        handoffDismiss.setOnClickListener(view -> {
            ConnectionService service = ConnectionService.current; String id = handoffId;
            if (service != null && HandoffUi.matches(DisplayBridge.get(this).handoff(), id, System.currentTimeMillis())) service.dismissHandoff(id);
        });
        setContentView(dashboard); render();
    }
    @Override protected void onStart() {
        super.onStart();
        if (isFinishing() || !requireRearDestination()) return;
        applyLockscreenPresentation(); logLifecycle("started");
    }
    @Override protected void onResume() {
        super.onResume();
        // A close request or a display move may have happened while this Activity was stopped.
        if (isFinishing() || !requireRearDestination()) return;
        applyLockscreenPresentation();
        restoreLaunchWake();
        active = true;
        registerReceiver(updates, new IntentFilter(ConnectionService.UPDATE), Context.RECEIVER_NOT_EXPORTED);
        IntentFilter filter = new IntentFilter(); filter.addAction(Intent.ACTION_SCREEN_OFF); filter.addAction(Intent.ACTION_SCREEN_ON); filter.addAction(Intent.ACTION_USER_PRESENT);
        registerReceiver(screen, filter, Context.RECEIVER_NOT_EXPORTED); registered = true;
        DisplayBridge.get(this).setRearShowing(true); handler.post(tick); logLifecycle("resumed");
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent);
        if (!requireRearDestination()) return;
        // singleInstance receives a fresh explicit launch here instead of onCreate.
        applyLockscreenPresentation(); beginLaunchWake();
        if (active) { render(); if (!isFinishing()) DisplayBridge.get(this).setRearShowing(true); }
        logLifecycle("new_intent");
    }
    @Override protected void onPause() {
        active = false; setKeepScreenOn(false); requestWake(false); handler.removeCallbacks(tick);
        if (registered) { unregisterReceiver(updates); unregisterReceiver(screen); registered = false; }
        // Clear sensitive text before the activity can be retained behind the keyguard.
        clearDetails();
        DisplayBridge.get(this).setRearShowing(false); logLifecycle("paused"); super.onPause();
    }
    @Override protected void onStop() { logLifecycle("stopped"); super.onStop(); }
    @Override public void onWindowFocusChanged(boolean hasFocus) { super.onWindowFocusChanged(hasFocus); logLifecycle(hasFocus ? "focused" : "unfocused"); }
    @Override protected void onSaveInstanceState(Bundle state) { state.putString("stoppedTask", stoppedTask); super.onSaveInstanceState(state); }
    @Override protected void onDestroy() {
        clearLaunchWake("destroyed"); handler.removeCallbacksAndMessages(null); setKeepScreenOn(false);
        setShowWhenLocked(false); showWhenLockedRequested = false;
        if (wakePolicyRegistered) { unregisterReceiver(wakePolicy); DisplayBridge.get(this).removeLifecycleListener(wakePolicyChanged); wakePolicyRegistered = false; }
        if (closeRegistered) { unregisterReceiver(close); closeRegistered = false; }
        super.onDestroy();
    }
    private void applyLockscreenPresentation() {
        // Callers have already validated the actual non-main display and current opt-in.
        setShowWhenLocked(true); showWhenLockedRequested = true;
    }
    private void requestWake(boolean enabled) { setTurnScreenOn(enabled); wakeRequested = enabled; }
    private void beginLaunchWake() {
        handler.removeCallbacks(expireLaunchWake);
        launchBackground = DisplayBridge.get(this).lockedExecutionAllowed();
        launchService = ConnectionService.current;
        JSONObject snapshot = launchService == null ? null : launchService.snapshot();
        launchControlEpoch = snapshot == null ? -1 : snapshot.optLong("controlEpoch", -1);
        launchWakeUntil = SystemClock.elapsedRealtime() + LAUNCH_WAKE_WINDOW_MS;
        restoreLaunchWake();
        if (launchWakeUntil >= 0) handler.postDelayed(expireLaunchWake, LAUNCH_WAKE_WINDOW_MS);
    }
    private void restoreLaunchWake() {
        if (launchWakeUntil < 0) { requestWake(false); return; }
        String blocked = launchWakeBlockReason();
        if (blocked != null) { clearLaunchWake(blocked); return; }
        requestWake(true);
    }
    private void recheckLaunchWake() {
        if (launchWakeUntil < 0) return;
        String blocked = launchWakeBlockReason();
        if (blocked != null) clearLaunchWake(blocked);
    }
    private String launchWakeBlockReason() {
        long remaining = launchWakeUntil - SystemClock.elapsedRealtime();
        if (remaining <= 0 || remaining > LAUNCH_WAKE_WINDOW_MS) return "launch_window_expired";
        DisplayBridge bridge = DisplayBridge.get(this);
        if (isFinishing() || isDestroyed() || !bridge.isRearProgressEnabled()) return "closed";
        JSONObject rear = bridge.status().optJSONObject("rear"); int actual = actualDisplayId();
        if (actual <= Display.DEFAULT_DISPLAY || rear == null || !rear.optBoolean("available") || rear.optInt("displayId", -1) != actual) return "wrong_display";
        if (launchBackground && !bridge.lockedExecutionAllowed()) return "background_disabled";
        if (keyguardLocked() && !bridge.lockedExecutionAllowed()) return "locked_main_mode";
        ConnectionService service = ConnectionService.current;
        if (service != launchService) return "connection_changed";
        if (service != null) {
            JSONObject snapshot = service.snapshot();
            if (snapshot.optBoolean("paused", true)) return "paused";
            if (launchControlEpoch < 0 || snapshot.optLong("controlEpoch", -1) != launchControlEpoch) return "control_changed";
        }
        return null;
    }
    private void clearLaunchWake(String reason) {
        boolean hadRequest = launchWakeUntil >= 0 || wakeRequested;
        launchWakeUntil = -1; launchControlEpoch = -1; launchService = null;
        handler.removeCallbacks(expireLaunchWake); requestWake(false);
        if (hadRequest) logLifecycle("wake_cleared_" + reason);
    }
    private void logLifecycle(String event) {
        // Requested flags are not proof of OEM acceptance; correlate with WindowManager evidence.
        try {
            DisplayBridge bridge = DisplayBridge.get(this);
            android.util.Log.i("BoujoyRear", Tunnel.json("event", "rear_lifecycle", "phase", event,
                    "atElapsedMs", SystemClock.elapsedRealtime(), "displayId", actualDisplayId(),
                    "enabled", bridge.isRearProgressEnabled(), "backgroundAllowed", bridge.lockedExecutionAllowed(),
                    "locked", keyguardLocked(), "active", active, "focused", hasWindowFocus(),
                    "showWhenLockedRequested", showWhenLockedRequested, "wakeRequested", wakeRequested,
                    "launchWakeRemainingMs", Math.max(0, launchWakeUntil - SystemClock.elapsedRealtime())).toString());
        } catch (RuntimeException ignored) {}
    }
    private int actualDisplayId() {
        try { Display display = getDisplay(); return display == null ? Display.INVALID_DISPLAY : display.getDisplayId(); }
        catch (RuntimeException unavailable) { return Display.INVALID_DISPLAY; }
    }
    private boolean requireRearDestination() {
        DisplayBridge bridge = DisplayBridge.get(this);
        JSONObject rear = bridge.status().optJSONObject("rear");
        int actual = actualDisplayId();
        if (bridge.isRearProgressEnabled() && actual > Display.DEFAULT_DISPLAY && rear != null
                && rear.optBoolean("available") && rear.optInt("displayId", Display.INVALID_DISPLAY) == actual) return true;
        dismissRear(); return false;
    }
    private void clearDetails() {
        approvalUiGeneration++; approvalDetails.clear(); approvalDetailErrors.clear(); readingApprovals.clear();
        if (dashboard != null) { dashboard.clearSteps(); dashboard.clearApprovals(); }
        if (title != null) title.setText("");
        if (phase != null) phase.setText("");
        if (updated != null) updated.setText("");
        if (status != null) status.setText("Boujoy 正在处理");
    }
    private void dismissRear() {
        active = false; handler.removeCallbacks(tick); setKeepScreenOn(false); clearLaunchWake("dismissed");
        setShowWhenLocked(false); showWhenLockedRequested = false;
        clearDetails(); current = null;
        if (stop != null) { stop.setEnabled(false); stop.setVisibility(View.GONE); }
        handoffId="";handoffTaskId="";if(handoffActions!=null)handoffActions.setVisibility(View.GONE);
        DisplayBridge.get(this).setRearShowing(false); finish();
    }
    private boolean keyguardLocked() {
        try {
            KeyguardManager keyguard = getSystemService(KeyguardManager.class);
            return keyguard == null || keyguard.isDeviceLocked() || keyguard.isKeyguardLocked();
        } catch (RuntimeException unavailable) { return true; }
    }
    private boolean locked() {
        PowerManager power = getSystemService(PowerManager.class);
        return keyguardLocked() || power == null || !power.isInteractive();
    }
    private void render() {
        if (title == null) return;
        ConnectionService service = ConnectionService.current;
        JSONObject snapshot = service == null ? new JSONObject() : service.snapshot();
        renderSnapshot(snapshot, locked() || snapshot.optBoolean("locked"));
    }
    private void renderSnapshot(JSONObject snapshot, boolean locked) {
        if (!requireRearDestination() || isFinishing()) return;
        ConnectionService service = ConnectionService.current;
        if (snapshot.optBoolean("paused") || (keyguardLocked() || snapshot.optBoolean("locked")) && !DisplayBridge.get(this).lockedExecutionAllowed()) clearLaunchWake(snapshot.optBoolean("paused") ? "paused" : "locked_main_mode");
        else recheckLaunchWake();
        boolean background = DisplayBridge.get(this).lockedExecutionAllowed();
        current = RearStatus.from(snapshot, SystemClock.elapsedRealtime(), locked, background);
        setKeepScreenOn(shouldKeepScreenOn(snapshot, current, active, actualDisplayId())
                || keepLitInBackground(snapshot, current, active, actualDisplayId(), background));
        status.setText(current.status()); title.setText(current.title()); phase.setText(current.phase());
        title.setVisibility(current.title().isBlank() ? View.GONE : View.VISIBLE);
        phase.setVisibility(current.phase().isBlank() ? View.GONE : View.VISIBLE);
        String timestamp = timestamp(current.updatedAt());
        updated.setText(timestamp.isBlank() ? "" : "最近更新 " + timestamp);
        updated.setVisibility(timestamp.isBlank() ? View.GONE : View.VISIBLE);
        java.util.List<RearProgress.Step> steps = RearProgress.from(snapshot, current, background);
        dashboard.showSteps(steps, RearProgress.color(snapshot, current.taskId()),
                active && steps.stream().anyMatch(step -> "running".equals(step.state())));
        JSONObject state = snapshot.optJSONObject("state");
        JSONArray tasks = state == null ? null : state.optJSONArray("tasks");
        String taskStatus = "";
        for (int i = 0; tasks != null && i < tasks.length(); i++) {
            JSONObject task = tasks.optJSONObject(i);
            if (task != null && !current.taskId().isBlank() && current.taskId().equals(task.optString("id"))) {
                taskStatus = task.optString("status", ""); break;
            }
        }
        // Celebrate only an observed task outcome; completed step rows are not task completion.
        dashboard.showTaskMotion(current.taskId(), taskStatus,
                active && snapshot.optBoolean("online") && !current.stale()
                        && !snapshot.optBoolean("paused", true) && (!locked || background));
        stop.setVisibility(current.canStop() ? View.VISIBLE : View.GONE);
        boolean requested = current.taskId().equals(stoppedTask);
        boolean paused = snapshot.optBoolean("paused");
        stop.setEnabled(service != null && (!requested || !paused));
        stop.setText(requested ? paused ? "手机已暂停" : "重试停止" : "停止任务");
        JSONObject held = DisplayBridge.get(this).handoff();
        HandoffUi.Card card = HandoffUi.from(held, locked, System.currentTimeMillis());
        handoffId = card == null ? "" : card.id(); handoffTaskId = card == null ? "" : held.optString("taskId", "");
        handoffActions.setVisibility(card == null || locked ? View.GONE : View.VISIBLE);
        dashboard.refreshMood();
        handoffTake.setEnabled(card != null); handoffDismiss.setEnabled(card != null && service != null);
        if (card != null) {
            dashboard.clearSteps();
            setKeepScreenOn(false); status.setText(locked ? "Boujoy 正在处理" : card.status()); title.setText(card.title()); phase.setText(card.summary());
            title.setVisibility(card.title().isBlank() ? View.GONE : View.VISIBLE); phase.setVisibility(card.summary().isBlank() ? View.GONE : View.VISIBLE);
            updated.setText(""); updated.setVisibility(View.GONE);
            stop.setVisibility(handoffTaskId.isBlank() ? View.GONE : View.VISIBLE); stop.setEnabled(service != null);
            stop.setText(locked ? "停止任务" : "停止 / 接管");
        }
        renderApprovals(service, snapshot, locked, background, card == null);
    }
    private void renderApprovals(ConnectionService service, JSONObject snapshot, boolean locked, boolean background, boolean noHandoff) {
        java.util.List<RearApproval.Card> cards = active && service != null && noHandoff && (!locked || background)
                ? RearApproval.cards(snapshot, current.taskId(), SystemClock.elapsedRealtime(), service.taskActionNow()) : java.util.List.of();
        java.util.Set<RearApproval.Scope> live = new java.util.HashSet<>(); for (RearApproval.Card card : cards) live.add(card.scope());
        approvalDetails.keySet().retainAll(live); approvalDetailErrors.keySet().retainAll(live); readingApprovals.retainAll(live);
        java.util.List<RearApproval.Card> shown = new java.util.ArrayList<>();
        for (RearApproval.Card card : cards) shown.add(RearApproval.withDetails(card, approvalDetails.get(card.scope()), approvalDetailErrors.get(card.scope())));
        int normalStopVisibility=stop.getVisibility();
        dashboard.showApprovals(shown, approvalActions);
        if(!dashboard.showingApprovals())stop.setVisibility(normalStopVisibility);
        for (RearApproval.Card card : cards) if (card.requestStatus().isEmpty() && !approvalDetails.containsKey(card.scope())
                && !approvalDetailErrors.containsKey(card.scope()) && readingApprovals.add(card.scope())) {
            RearApproval.Scope scope = card.scope(); long generation = approvalUiGeneration;
            service.rearApprovalDetails(scope, (detail, error) -> handler.post(() -> {
                if (generation != approvalUiGeneration || !active || service != ConnectionService.current) return;
                readingApprovals.remove(scope);
                if (!RearApproval.matches(service.snapshot(), scope, SystemClock.elapsedRealtime(), service.taskActionNow())) { render(); return; }
                if (error == null && RearApproval.detailMatches(scope, detail)) approvalDetails.put(scope, detail);
                else approvalDetailErrors.put(scope, "内容未核实");
                render();
            }));
        }
    }
    private void decideRearApproval(RearApproval.Scope scope, boolean allow) {
        ConnectionService service = ConnectionService.current;
        if (!active || isFinishing() || !requireRearDestination() || service == null || current == null
                || !scope.taskId().equals(current.taskId()) || (locked() && !DisplayBridge.get(this).lockedExecutionAllowed())
                || !RearApproval.matches(service.snapshot(), scope, SystemClock.elapsedRealtime(), service.taskActionNow())
                || (allow && !RearApproval.detailMatches(scope, approvalDetails.get(scope)))) { render(); return; }
        service.approvalFromRear(scope, allow, (reply, error) -> handler.post(() -> {
            if (active && service == ConnectionService.current && !isFinishing()) render();
        }));
        render();
    }
    /** Background execution: the visible rear page stays lit behind a locked main screen while its task is active. */
    static boolean keepLitInBackground(JSONObject snapshot, RearStatus.ViewState state, boolean visible, int displayId, boolean backgroundAllowed) {
        if (!backgroundAllowed || !visible || snapshot == null || state == null || state.stale() || snapshot.optBoolean("paused", true)
                || displayId <= Display.DEFAULT_DISPLAY || state.taskId().isBlank()) return false;
        JSONObject data = snapshot.optJSONObject("state");
        JSONArray tasks = data == null ? null : data.optJSONArray("tasks");
        if (tasks == null) return false;
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.optJSONObject(i);
            if (task == null || !state.taskId().equals(task.optString("id"))) continue;
            String status = task.optString("status");
            return "queued".equals(status) || "running".equals(status) || "waiting_children".equals(status)
                    || "waiting_approval".equals(status) || "waiting_consent".equals(status);
        }
        return false;
    }
    /** Keep only an already visible rear window lit; this never requests a screen wake-up. */
    static boolean shouldKeepScreenOn(JSONObject snapshot, RearStatus.ViewState state, boolean visible, int displayId) {
        if (!visible || snapshot == null || state == null || state.stale() || state.locked()
                || snapshot.optBoolean("paused", true) || snapshot.optBoolean("locked", true)
                || displayId <= Display.DEFAULT_DISPLAY || state.taskId().isBlank()) return false;
        JSONObject backend = snapshot.optJSONObject("displayBackend");
        JSONObject rear = backend == null ? null : backend.optJSONObject("rear");
        if (rear == null || !rear.optBoolean("available") || rear.optInt("displayId", Display.INVALID_DISPLAY) != displayId) return false;
        JSONObject data = snapshot.optJSONObject("state");
        JSONArray tasks = data == null ? null : data.optJSONArray("tasks");
        if (tasks == null) return false;
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.optJSONObject(i);
            if (task == null || !state.taskId().equals(task.optString("id"))) continue;
            return switch (task.optString("status")) {
                case "queued", "running", "waiting_children", "waiting_approval", "waiting_consent" -> true;
                default -> false;
            };
        }
        return false;
    }
    private void setKeepScreenOn(boolean keep) {
        int flag = WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON;
        if (((getWindow().getAttributes().flags & flag) != 0) == keep) return;
        if (keep) getWindow().addFlags(flag); else getWindow().clearFlags(flag);
    }
    private static String timestamp(String iso) {
        if (iso.isBlank()) return "";
        try { return DateTimeFormatter.ofPattern("HH:mm:ss").withZone(ZoneId.systemDefault()).format(Instant.parse(iso)); }
        catch (Exception ignored) { return ""; }
    }
}
