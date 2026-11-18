package dev.boujoy.personalagent;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;

/** Small encrypted endpoint stores; the cloud never owns this outbox. */
public final class SecureStore {
    private final Context context;
    public SecureStore(Context context) { this.context = context.getApplicationContext(); }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        String alias = "boujoy.local-records";
        if (!store.containsAlias(alias)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey)store.getKey(alias, null);
    }
    private File file(String name) { if (!name.matches("[a-z-]+")) throw new IllegalArgumentException(); return new File(context.getNoBackupFilesDir(), name + ".enc"); }
    public synchronized JSONObject read(String name) throws Exception {
        if (!file(name).exists()) return new JSONObject();
        byte[] raw; try (InputStream input = new AtomicFile(file(name)).openRead()) { raw = input.readAllBytes(); }
        if (raw.length < 29 || raw[0] != 1) throw new IOException("本地加密记录损坏，已停止自动执行");
        byte[] iv = java.util.Arrays.copyOfRange(raw, 1, 13);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
        cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
        return new JSONObject(new String(cipher.doFinal(raw, 13, raw.length - 13), StandardCharsets.UTF_8));
    }
    public synchronized void write(String name, JSONObject value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
        byte[] payload = cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8));
        AtomicFile target = new AtomicFile(file(name)); FileOutputStream output = null;
        try { output = target.startWrite(); output.write(1); output.write(cipher.getIV()); output.write(payload); target.finishWrite(output); }
        catch (Exception error) { if (output != null) target.failWrite(output); throw error; }
    }
    public ControlState controlState() {
        SharedPreferences prefs = context.getSharedPreferences("control", Context.MODE_PRIVATE);
        return new ControlState(new ControlState.Storage() {
            public long epoch() { return prefs.getLong("epoch", 0); }
            public boolean paused() { return prefs.getBoolean("paused", true); }
            public String reason() { return prefs.getString("pauseReason", ""); }
            public long maintenanceOrigin() { return prefs.getLong("maintenanceOrigin", -1); }
            public void save(long epoch, boolean paused) {
                save(epoch, paused, paused ? "local_stop" : "", -1);
            }
            public void save(long epoch, boolean paused, String reason, long maintenanceOrigin) {
                if (!prefs.edit().putLong("epoch", epoch).putBoolean("paused", paused).putString("pauseReason", reason).putLong("maintenanceOrigin", maintenanceOrigin).commit()) throw new IllegalStateException("无法保存停止状态");
            }
        });
    }
}
