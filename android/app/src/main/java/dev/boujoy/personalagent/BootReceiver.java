package dev.boujoy.personalagent;
import android.content.*;
public final class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context,Intent intent){
        if(intent==null||!(Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())||Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())))return;
        try { if(new SecureStore(context).read("binding").optBoolean("paired")) context.startForegroundService(new Intent(context,ConnectionService.class)); }
        catch(Exception ignored){ /* No silent permission bypass. Opening Boujoy performs the next health check. */ }
    }
}
