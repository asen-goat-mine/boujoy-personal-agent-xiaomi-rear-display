package dev.boujoy.personalagent;

import android.app.Activity;
import android.app.AppOpsManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import java.util.Locale;

/** Read-only Xiaomi lockscreen permission status; only a user tap opens system settings. */
final class RearLockscreenPermission {
    static final int SHOW_WHEN_LOCKED = 10020;
    enum State { ALLOWED, DENIED, UNKNOWN, NOT_APPLICABLE }
    interface ModeReader { Integer read() throws Exception; }
    interface SettingsLauncher { void start(Intent intent); }

    private RearLockscreenPermission() {}

    static boolean isSupportedDevice() {
        String miuiVersion = "";
        try {
            miuiVersion = (String) Class.forName("android.os.SystemProperties")
                    .getMethod("get", String.class).invoke(null, "ro.miui.ui.version.name");
        } catch (ReflectiveOperationException | RuntimeException | LinkageError ignored) {}
        return isSupportedDevice(Build.MANUFACTURER, Build.BRAND, miuiVersion);
    }

    static boolean isSupportedDevice(String manufacturer, String brand, String miuiVersion) {
        String maker = manufacturer == null ? "" : manufacturer.trim().toLowerCase(Locale.ROOT);
        String name = brand == null ? "" : brand.trim().toLowerCase(Locale.ROOT);
        return "xiaomi".equals(maker) || "xiaomi".equals(name) || "redmi".equals(name)
                || "poco".equals(name) || miuiVersion != null && !miuiVersion.isBlank();
    }

    static State read(Context context) {
        return probe(isSupportedDevice(), () -> readMode(context.getSystemService(Context.APP_OPS_SERVICE),
                context.getApplicationInfo().uid, context.getPackageName()));
    }

    static State probe(boolean supported, ModeReader reader) {
        if (!supported) return State.NOT_APPLICABLE;
        try {
            Integer mode = reader.read();
            if (mode == null) return State.UNKNOWN;
            return switch (mode) {
                case AppOpsManager.MODE_ALLOWED -> State.ALLOWED;
                case AppOpsManager.MODE_IGNORED, AppOpsManager.MODE_ERRORED -> State.DENIED;
                default -> State.UNKNOWN;
            };
        } catch (Exception | LinkageError ignored) {
            // Hidden APIs and vendor op codes vary. An unavailable check is never a denial.
            return State.UNKNOWN;
        }
    }

    static Integer readMode(Object manager, int uid, String packageName) throws ReflectiveOperationException {
        if (manager == null) return null;
        Object mode = manager.getClass().getMethod("checkOpNoThrow", int.class, int.class, String.class)
                .invoke(manager, SHOW_WHEN_LOCKED, uid, packageName);
        return mode instanceof Integer ? (Integer) mode : null;
    }

    static boolean blocksRearLaunch(boolean locked, State state) {
        return locked && state == State.DENIED;
    }

    static String statusText(State state) {
        return switch (state) {
            case ALLOWED -> "已允许 · 查看系统权限";
            case DENIED -> "尚未允许 · 点此打开系统权限页";
            case UNKNOWN -> "请在系统权限页确认 · 点此打开";
            case NOT_APPLICABLE -> "查看应用的系统权限";
        };
    }

    static boolean openSettings(Activity activity) {
        return openSettings(activity.getPackageName(), isSupportedDevice(), activity::startActivity);
    }

    static boolean openSettings(String packageName, boolean supported, SettingsLauncher launcher) {
        if (supported) {
            Intent permissions = new Intent("miui.intent.action.APP_PERM_EDITOR")
                    .setComponent(new ComponentName("com.miui.securitycenter",
                            "com.miui.permcenter.permissions.PermissionsEditorActivity"))
                    .putExtra("extra_pkgname", packageName);
            try { launcher.start(permissions); return true; } catch (RuntimeException ignored) {}
        }
        try {
            launcher.start(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + packageName)));
            return true;
        } catch (RuntimeException ignored) { return false; }
    }
}
