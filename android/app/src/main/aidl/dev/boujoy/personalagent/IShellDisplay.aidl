package dev.boujoy.personalagent;
import android.os.IBinder;
import android.os.ParcelFileDescriptor;
import dev.boujoy.personalagent.IDisplayPermit;
interface IShellDisplay {
    void attach(IBinder client) = 1;
    String command(String operation, String request, IDisplayPermit permit) = 2;
    ParcelFileDescriptor capture(String session, int maxDimension, IDisplayPermit permit) = 3;
    void revoke() = 4;
    void destroy() = 16777114;
}
