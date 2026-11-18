package dev.boujoy.personalagent;

import android.os.SystemClock;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLContext;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadow.api.Shadow;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;

/** Runs the service's real control worker against a scripted Mac acknowledgement. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, shadows = {ResumeControlTest.OnlineTunnel.class, ResumeControlTest.Mac.class})
public class ResumeControlTest {
    @Implements(value = Tunnel.class, isInAndroidSdk = false)
    public static class OnlineTunnel {
        @Implementation protected boolean connected() { return true; }
    }

    interface Reply { JSONObject to(JSONObject request) throws Exception; }

    @Implements(value = GatewayClient.class, isInAndroidSdk = false)
    public static class Mac {
        final List<String> calls = new ArrayList<>();
        Reply resumeReply = Mac::ack;

        static JSONObject ack(JSONObject request) throws Exception {
            return new JSONObject().put("controlEpoch", request.getLong("controlEpoch"))
                                   .put("paused", request.getBoolean("paused"));
        }

        @Implementation protected JSONObject json(String method, String path, JSONObject request, boolean control) throws Exception {
            calls.add(method + " " + path + " " + control + " " + request.optString("reason") + " "
                    + request.optLong("controlEpoch") + " " + request.optBoolean("paused"));
            return request.getBoolean("paused") ? ack(request) : resumeReply.to(request);
        }
    }

    private ConnectionService service;
    private ControlState gate;
    private MobileWorkers workers;
    private Mac mac;

    @Before public void setUp() {
        // Attach a context without starting the service's periodic jobs or loading real storage.
        service = Robolectric.buildService(ConnectionService.class).get();
        gate = new ControlState(new ControlStateTest.Memory());
        Tunnel tunnel = new Tunnel(null, gate, () -> {});
        GatewayClient gateway = new GatewayClient(tunnel, (SSLContext) null);
        mac = Shadow.extract(gateway);
        ReflectionHelpers.setField(service, "gate", gate);
        ReflectionHelpers.setField(service, "tunnel", tunnel);
        ReflectionHelpers.setField(service, "gateway", gateway);
        ReflectionHelpers.setField(service, "paired", true);
        ReflectionHelpers.setField(service, "lastAuthenticatedAt", Math.max(1L, SystemClock.elapsedRealtime()));
        workers = ReflectionHelpers.getField(service, "workers");
    }

    @After public void tearDown() { service.onDestroy(); }

    private void settle() throws Exception {
        // Rollback enqueues the pause POST from inside the first worker action.
        for (int i = 0; i < 2; i++) workers.control.submit(() -> {}).get(5, TimeUnit.SECONDS);
    }

    private static String call(String reason, long epoch, boolean paused) {
        return "POST /v1/device/control true " + reason + " " + epoch + " " + paused;
    }

    @Test public void exactAcknowledgementHandsBackControlOnce() throws Exception {
        service.resumeControl(0);
        service.resumeControl(0);
        settle();
        assertEquals(new ControlState.Snapshot(1, false), gate.snapshot());
        assertEquals(List.of(call("explicit_user_resume", 1, false)), mac.calls);
    }

    @Test public void lostReplyPersistsAndSyncsANewPause() throws Exception {
        mac.resumeReply = request -> { throw new IOException("lost reply"); };
        service.resumeControl(0);
        settle();
        assertEquals(new ControlState.Snapshot(2, true), gate.snapshot());
        assertEquals(List.of(call("explicit_user_resume", 1, false), call("resume_unconfirmed", 2, true)), mac.calls);
    }

    @Test public void olderAcknowledgementCannotConfirmThisResume() throws Exception {
        mac.resumeReply = request -> new JSONObject().put("controlEpoch", 0).put("paused", false);
        service.resumeControl(0);
        settle();
        assertEquals(new ControlState.Snapshot(2, true), gate.snapshot());
        assertEquals(List.of(call("explicit_user_resume", 1, false), call("resume_unconfirmed", 2, true)), mac.calls);
    }

    @Test public void lateFailureDoesNotOverwriteANewerUserStop() throws Exception {
        mac.resumeReply = request -> {
            service.pauseLocal("explicit_takeover");
            throw new IOException("late reply");
        };
        service.resumeControl(0);
        settle();
        assertEquals(new ControlState.Snapshot(2, true), gate.snapshot());
        assertEquals(List.of(call("explicit_user_resume", 1, false), call("explicit_takeover", 2, true)), mac.calls);
    }

    @Test public void staleButtonAndOfflineButtonCannotGrantControl() throws Exception {
        long latest = gate.pause("screen_off");
        service.resumeControl(latest - 1);
        settle();
        assertEquals(new ControlState.Snapshot(latest, true), gate.snapshot());
        ReflectionHelpers.setField(service, "lastAuthenticatedAt", 0L);
        service.resumeControl(latest);
        settle();
        assertEquals(new ControlState.Snapshot(latest, true), gate.snapshot());
        assertTrue(mac.calls.isEmpty());
    }
}
