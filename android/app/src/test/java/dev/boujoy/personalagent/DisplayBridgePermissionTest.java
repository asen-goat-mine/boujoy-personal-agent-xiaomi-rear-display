package dev.boujoy.personalagent;

import org.junit.Test;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

public class DisplayBridgePermissionTest {
    @Test public void managerGrantStartsBindingWithoutRequestResultCallback(){
        DisplayBridge.AuthorizationState state=new DisplayBridge.AuthorizationState();
        state.probe(()->"permission_required");
        assertFalse(state.shouldBind(false,false,false,10_000,0));
        DisplayBridge.AuthorizationState.Update granted=state.probe(()->"running");
        assertTrue(granted.changed());assertTrue(granted.granted());
        assertTrue(state.shouldBind(false,false,false,10_000,0));
    }
    @Test public void everyAuthoritativeProbeReadsFreshGrantAndRevocationInvalidates(){
        DisplayBridge.AuthorizationState state=new DisplayBridge.AuthorizationState();
        AtomicReference<String> server=new AtomicReference<>("running");AtomicInteger reads=new AtomicInteger();
        java.util.function.Supplier<String> query=()->{reads.incrementAndGet();return server.get();};
        assertTrue(state.probe(query).granted());
        server.set("permission_required");
        DisplayBridge.AuthorizationState.Update revoked=state.probe(query);
        assertEquals(2,reads.get());assertTrue(revoked.invalidatesExisting());assertFalse(revoked.granted());
        assertEquals("permission_required",state.status());assertFalse(state.shouldBind(false,false,false,10_000,0));
    }
    @Test public void regrantCanBindButPendingLiveClosingAndRetryBackoffCannotLoop(){
        DisplayBridge.AuthorizationState state=new DisplayBridge.AuthorizationState();
        state.probe(()->"running");state.probe(()->"permission_required");state.probe(()->"running");
        assertFalse(state.shouldBind(false,false,false,13_999,10_000));
        assertTrue(state.shouldBind(false,false,false,14_000,10_000));
        assertFalse(state.shouldBind(true,false,false,14_000,10_000));
        assertFalse(state.shouldBind(false,true,false,14_000,10_000));
        assertFalse(state.shouldBind(false,false,true,14_000,10_000));
    }
    @Test public void failedFreshProbeNeverRetainsEarlierGrant(){
        DisplayBridge.AuthorizationState state=new DisplayBridge.AuthorizationState();state.probe(()->"running");
        DisplayBridge.AuthorizationState.Update unavailable=state.probe(()->{throw new IllegalStateException("binder gone");});
        assertTrue(unavailable.invalidatesExisting());assertEquals("not_running",state.status());
    }
    @Test public void rearKeyguardExceptionIsLimitedToBackgroundMode(){
        assertTrue(DisplayBridge.rearLaunchAllowed(true,true,true,true));
        assertFalse(DisplayBridge.rearLaunchAllowed(true,true,false,true));
        assertTrue(DisplayBridge.rearLaunchAllowed(true,false,false,true));
        assertTrue(DisplayBridge.rearLaunchAllowed(true,false,true,true));
    }
    @Test public void rearBackgroundLockAllowanceDoesNotOverrideStopOrOptOut(){
        for(boolean locked:new boolean[]{false,true}){
            assertFalse(DisplayBridge.rearLaunchAllowed(true,locked,true,false));
            assertFalse(DisplayBridge.rearLaunchAllowed(false,locked,true,true));
        }
    }

}
