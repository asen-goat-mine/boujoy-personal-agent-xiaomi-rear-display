package dev.boujoy.personalagent;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;

/** Screen-off background execution: a locked main screen only stops main-screen work. */
public class BackgroundLockPolicyTest {
    @Test public void unlockedNeverBlocks() {
        assertFalse(DisplayBridge.effectiveLocked(false,false,null));
        assertFalse(DisplayBridge.effectiveLocked(false,true,new JSONObject()));
    }
    @Test public void mainScreenModeStillPausesWhenLocked() throws Exception {
        assertTrue(DisplayBridge.effectiveLocked(true,false,null));
        assertTrue(DisplayBridge.effectiveLocked(true,false,new JSONObject().put("alwaysUnlocked",true)));
    }
    @Test public void backgroundModeContinuesOnlyOnAnAlwaysUnlockedDisplay() throws Exception {
        assertFalse("no session yet: it will be created always-unlocked or refused by the shell",DisplayBridge.effectiveLocked(true,true,null));
        assertFalse(DisplayBridge.effectiveLocked(true,true,new JSONObject().put("alwaysUnlocked",true)));
        assertTrue("a system that refused the flag keeps the old lock rule",DisplayBridge.effectiveLocked(true,true,new JSONObject().put("alwaysUnlocked",false)));
        assertTrue(DisplayBridge.effectiveLocked(true,true,new JSONObject()));
    }
}
