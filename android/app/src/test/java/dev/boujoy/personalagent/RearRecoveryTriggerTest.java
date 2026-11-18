package dev.boujoy.personalagent;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.hardware.display.DisplayManager;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.view.Display;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowDisplayManager;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;

/** Real service trigger wiring, without a gateway, a shell launch or a running service loop. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, shadows = DisplayConnectionTest.OnlineTunnel.class)
public class RearRecoveryTriggerTest {
    private ConnectionService service;
    private DisplayBridge bridge;
    private ControlState gate;
    private MaintenanceRecoveryTest.Memory storage;
    private DisplayManager displays;
    private PowerManager power;
    private RearProgressCoordinator coordinator;
    private final AtomicLong now = new AtomicLong();
    private final AtomicInteger launches = new AtomicInteger();
    private JSONObject cached;
    private int rearId;

    @Before public void setup() throws Exception {
        service = Robolectric.buildService(ConnectionService.class).get();
        storage = new MaintenanceRecoveryTest.Memory(); gate = new ControlState(storage); gate.resumeExplicitly();
        power = service.getSystemService(PowerManager.class); Shadows.shadowOf(power).setIsInteractive(true);
        KeyguardManager keyguard = service.getSystemService(KeyguardManager.class);
        Shadows.shadowOf(keyguard).setIsDeviceLocked(false); Shadows.shadowOf(keyguard).setKeyguardLocked(false);
        displays = service.getSystemService(DisplayManager.class);
        rearId = ShadowDisplayManager.addDisplay("w347dp-h212dp-450dpi", "Recovery rear fixture");
        Shadows.shadowOf(displays.getDisplay(rearId)).setState(Display.STATE_ON);
        Shadows.shadowOf(displays.getDisplay(Display.DEFAULT_DISPLAY)).setState(Display.STATE_OFF);
        now.set(Math.max(1L, SystemClock.elapsedRealtime()));
        // Main-display state assertions remain applicable to both editions.
        ReflectionHelpers.setField(service, "gate", gate);
        ReflectionHelpers.setField(service, "power", power); ReflectionHelpers.setField(service, "keyguard", keyguard);
        if(!BuildConfig.BACKGROUND_SUPPORTED)return;
        bridge = ReflectionHelpers.callConstructor(DisplayBridge.class,
                ReflectionHelpers.ClassParameter.from(Context.class, service.getApplicationContext()));
        bridge.setRearProgressEnabled(true); bridge.setLockedExecutionAllowed(true); bridge.setRearShowing(true);
        // Do not run Shizuku's periodic probe in this service wiring fixture. The
        // real bridge listener collection and visibility transitions remain intact.
        ((Handler) ReflectionHelpers.getField(bridge, "main")).removeCallbacksAndMessages(null);
        ReflectionHelpers.setField(service, "gate", gate);
        ReflectionHelpers.setField(service, "power", power); ReflectionHelpers.setField(service, "keyguard", keyguard);
        ReflectionHelpers.setField(service, "displayBridge", bridge);
        ReflectionHelpers.setField(service, "tunnel", new Tunnel(null, gate, () -> {}));
        ReflectionHelpers.setField(service, "paired", true);
        ReflectionHelpers.setField(service, "lastAuthenticatedAt", Math.max(1L, SystemClock.elapsedRealtime()));
        ReflectionHelpers.setField(service, "stateSyncedAtElapsedMs", now.get());
        // Keep this stable so a test of screenTick cannot pass via the older
        // display-lock-change callback instead of the new presentation hook.
        ReflectionHelpers.setField(service, "lastDisplayLocked", false);
        cached = new JSONObject().put("device", new JSONObject().put("controlEpoch", gate.epoch()).put("paused", false))
                .put("phoneExecution", new JSONObject().put("mode", "background"))
                .put("tasks", new JSONArray().put(new JSONObject().put("id", "rear-task").put("status", "running")
                        .put("phase", "读取当前页面").put("updatedAt", "2026-11-15T10:00:00Z")));
        ReflectionHelpers.setField(service, "cachedState", cached);
        coordinator = new RearProgressCoordinator(Runnable::run, this::state, now::get, allowed -> {
            assertTrue("The launch barrier must still permit this exact task", allowed.getAsBoolean());
            launches.incrementAndGet(); bridge.setRearShowing(true);
        });
        ReflectionHelpers.setField(service, "rearProgress", coordinator);
        bridge.addLifecycleListener(ReflectionHelpers.getField(service, "displayLifecycle"));
    }

    @After public void cleanup() {
        if (service != null) service.onDestroy();
        if (rearId != 0) ShadowDisplayManager.removeDisplay(rearId);
        if (bridge != null) ((Handler) ReflectionHelpers.getField(bridge, "main")).removeCallbacksAndMessages(null);
    }
    private RearProgressCoordinator.State state() { return ReflectionHelpers.callInstanceMethod(service, "rearProgressState"); }
    private void admitVisible() {
        assertEquals("eligible", RearProgressCoordinator.gateReason(state(), now.get()));
        coordinator.onStateSynced(); assertEquals(0, launches.get());
        now.addAndGet(RearProgressCoordinator.REOPEN_AFTER_MS + 1);
    }
    private void hideWithoutAnotherTrigger() { ReflectionHelpers.setField(bridge, "showing", false); }
    private void tickOnce() {
        Runnable tick = ReflectionHelpers.getField(service, "screenTick"); tick.run();
        ((Handler) ReflectionHelpers.getField(service, "screenHandler")).removeCallbacks(tick);
    }
    private void registerScreenReceiver() {
        ReflectionHelpers.callInstanceMethod(service, "setupScreenHold");
        ((Handler) ReflectionHelpers.getField(service, "screenHandler")).removeCallbacks(ReflectionHelpers.getField(service, "screenTick"));
    }
    private void broadcast(String action) {
        service.sendBroadcast(new Intent(action));
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1));
    }

    @Test public void mainDisplayStateWinsEvenWhenRearKeepsTheDeviceInteractive() {
        for (int state : new int[]{Display.STATE_OFF, Display.STATE_DOZE, Display.STATE_DOZE_SUSPEND}) {
            Shadows.shadowOf(displays.getDisplay(Display.DEFAULT_DISPLAY)).setState(state);
            Shadows.shadowOf(power).setIsInteractive(true);
            assertEquals(Display.STATE_ON, displays.getDisplay(rearId).getState()); assertTrue(power.isInteractive());
            assertTrue("Only the main display determines the off signal: " + state, ConnectionService.mainScreenOff(displays));
            assertTrue(state().mainScreenOff());
        }
    }
    @Test public void unknownOnVrAndSuspendedOnAreNotProofThatTheMainScreenIsOff() {
        for (int state : new int[]{Display.STATE_ON, Display.STATE_UNKNOWN, Display.STATE_VR, Display.STATE_ON_SUSPEND}) {
            Shadows.shadowOf(displays.getDisplay(Display.DEFAULT_DISPLAY)).setState(state);
            assertFalse("Do not infer OFF from state " + state, ConnectionService.mainScreenOff(displays));
        }
        assertFalse(ConnectionService.mainScreenOff(null));
    }
    @Test public void oldCachedDeviceControlCannotBePromotedIntoTheCurrentGate() throws Exception {
        org.junit.Assume.assumeTrue("Xiaomi display integration is not part of the Phone Use edition",BuildConfig.BACKGROUND_SUPPORTED);
        hideWithoutAnotherTrigger();
        JSONObject device = cached.getJSONObject("device");
        device.put("controlEpoch", gate.epoch() - 1); assertEquals(-1, state().controlEpoch());
        coordinator.onStateSynced(); tickOnce(); assertEquals(0, launches.get());
        device.put("controlEpoch", gate.epoch()).put("paused", true); assertEquals(-1, state().controlEpoch());
        coordinator.onStateSynced(); tickOnce(); assertEquals(0, launches.get());
        device.put("paused", false); assertEquals(gate.epoch(), state().controlEpoch());
        gate.pause("rear_stop"); gate.resumeExplicitly();
        assertEquals("A new explicit resume still waits for matching remote device state", -1, state().controlEpoch());
        tickOnce(); assertEquals(0, launches.get());
    }
    @Test public void localPresentationEventsCannotAdmitAFirstTaskFromCache() {
        org.junit.Assume.assumeTrue("Xiaomi display integration is not part of the Phone Use edition",BuildConfig.BACKGROUND_SUPPORTED);
        registerScreenReceiver(); hideWithoutAnotherTrigger();
        tickOnce(); broadcast(Intent.ACTION_SCREEN_OFF); bridge.setRearShowing(false);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1));
        assertEquals("Only a successful state sync can first admit this cached task", 0, launches.get());
    }
    @Test public void screenTickRecoversTheAdmittedSamePhaseAndDoesNotRelaunchWhileVisible() {
        org.junit.Assume.assumeTrue("Xiaomi display integration is not part of the Phone Use edition",BuildConfig.BACKGROUND_SUPPORTED);
        admitVisible(); hideWithoutAnotherTrigger();
        long originalSync = state().syncedAtElapsedMs(); String originalPhase = state().phaseKey();
        tickOnce(); assertEquals(1, launches.get()); assertTrue(bridge.rearVisibility().showing());
        tickOnce(); tickOnce(); assertEquals(1, launches.get());
        assertEquals(originalPhase, state().phaseKey());
        assertEquals("A local tick must not manufacture state freshness", originalSync, state().syncedAtElapsedMs());
    }
    @Test public void actualScreenOffBroadcastRecoversTheAdmittedTask() {
        org.junit.Assume.assumeTrue("Xiaomi display integration is not part of the Phone Use edition",BuildConfig.BACKGROUND_SUPPORTED);
        registerScreenReceiver(); admitVisible(); hideWithoutAnotherTrigger();
        broadcast(Intent.ACTION_SCREEN_OFF);
        assertEquals(1, launches.get()); assertFalse("Background screen off must not pause execution", gate.paused());
        broadcast(Intent.ACTION_SCREEN_OFF); assertEquals(1, launches.get());
    }
    @Test public void actualBridgeVisibilityLifecycleRecoversAndDestroyedServiceNeverRestartsIt() {
        org.junit.Assume.assumeTrue("Xiaomi display integration is not part of the Phone Use edition",BuildConfig.BACKGROUND_SUPPORTED);
        admitVisible(); bridge.setRearShowing(false);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1));
        assertEquals(1, launches.get());
        service.onDestroy(); hideWithoutAnotherTrigger();
        ReflectionHelpers.callInstanceMethod(service, "refreshRearPresentation"); tickOnce(); bridge.setRearShowing(false);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1)); assertEquals(1, launches.get());
        service = null;
    }
    @Test public void screenOnAndAnExplicitStopDoNotRecoverTheRearOrResumeControl() throws Exception {
        org.junit.Assume.assumeTrue("Xiaomi display integration is not part of the Phone Use edition",BuildConfig.BACKGROUND_SUPPORTED);
        registerScreenReceiver(); admitVisible(); hideWithoutAnotherTrigger();
        Shadows.shadowOf(displays.getDisplay(Display.DEFAULT_DISPLAY)).setState(Display.STATE_ON);
        broadcast(Intent.ACTION_SCREEN_ON); assertEquals(0, launches.get());
        Shadows.shadowOf(displays.getDisplay(Display.DEFAULT_DISPLAY)).setState(Display.STATE_OFF);
        gate.pause("rear_stop"); cached.getJSONObject("device").put("controlEpoch", gate.epoch()).put("paused", true);
        broadcast(Intent.ACTION_USER_PRESENT); tickOnce(); bridge.setRearShowing(false);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1));
        assertEquals(0, launches.get()); assertTrue(gate.paused()); assertEquals("rear_stop", storage.reason());
    }
}
