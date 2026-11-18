package dev.boujoy.personalagent;

import android.content.ActivityNotFoundException;
import android.content.ContextWrapper;
import android.content.Intent;
import android.provider.Settings;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public class DisplayServiceSettingsActivityTest {
    @Test public void detailPermissionDenialFallsBackToSystemListWithoutGrantingAnything() {
        assertFallback(new SecurityException("OEM restricted details"));
    }
    @Test public void missingDetailsActivityAlsoFallsBack() {
        assertFallback(new ActivityNotFoundException());
    }
    private void assertFallback(RuntimeException failure) {
        List<String> actions=new ArrayList<>();
        ContextWrapper context=new ContextWrapper(RuntimeEnvironment.getApplication()) {
            @Override public void startActivity(Intent intent) {
                actions.add(intent.getAction());
                if(actions.size()==1)throw failure;
            }
        };
        DisplayServiceSettingsActivity.openSettings(context);
        assertEquals(BuildConfig.BACKGROUND_SUPPORTED?List.of("android.settings.ACCESSIBILITY_DETAILS_SETTINGS",Settings.ACTION_ACCESSIBILITY_SETTINGS):List.of(),actions);
    }
}
