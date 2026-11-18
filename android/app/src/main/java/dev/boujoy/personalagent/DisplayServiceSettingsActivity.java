package dev.boujoy.personalagent;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Toast;

/** User-click notification navigation only; enabling the service stays a system user action. */
public final class DisplayServiceSettingsActivity extends Activity {
    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        try { if (saved == null) openSettings(this); }
        finally { finish(); }
    }
    static void openSettings(Context context) {
        if(!BuildConfig.BACKGROUND_SUPPORTED)return;
        try { context.startActivity(DisplayNotifications.accessibilityIntent(context)); }
        catch (SecurityException | ActivityNotFoundException unsupported) {
            try { context.startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
            catch (SecurityException | ActivityNotFoundException unavailable) {
                Toast.makeText(context, "请在系统设置中打开 Boujoy 后台执行无障碍服务", Toast.LENGTH_LONG).show();
            }
        }
    }
}
