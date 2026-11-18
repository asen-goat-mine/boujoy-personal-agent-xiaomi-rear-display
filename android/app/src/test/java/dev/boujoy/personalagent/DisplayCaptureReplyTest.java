package dev.boujoy.personalagent;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class) @Config(sdk=35)
public class DisplayCaptureReplyTest {
    @Test public void captureErrorsKeepSessionAndPermissionFailureDistinctFromMissingFrame()throws Exception {
        for(String code:new String[]{"NO_FRAME","SESSION_STALE","LOCKED","LOCALLY_PAUSED"}) {
            JSONObject reply=Tunnel.json("available",false,"error",Tunnel.json("code",code,"reason","pre_barrier_timeout"));
            DisplayExecutor.BackendException error=assertThrows(DisplayExecutor.BackendException.class,()->DisplayBridge.decodeCapturedFrame(reply));
            assertEquals(code,error.code);assertFalse(error.started);
        }
    }
    @Test public void unexpectedShellErrorCannotBecomeASuccessfulFrameOrAnArbitraryPublicError() {
        JSONObject reply=Tunnel.json("available",false,"error",Tunnel.json("code","unexpected","reason","ignored"));
        DisplayExecutor.BackendException error=assertThrows(DisplayExecutor.BackendException.class,()->DisplayBridge.decodeCapturedFrame(reply));
        assertEquals("NO_FRAME",error.code);
    }
    @Test public void successfulFrameIsPassedIntactForExistingScreenshotValidation()throws Exception {
        JSONObject reply=Tunnel.json("available",true,"frame_at_ms",12345,"data_base64","fixture","width",720,"height",1280);
        assertSame(reply,DisplayBridge.decodeCapturedFrame(reply));assertEquals(12345,reply.getLong("frame_at_ms"));
    }
}
