package dev.boujoy.personalagent;

import android.content.Context;
import android.hardware.display.DisplayManager;
import android.os.Handler;
import android.os.HandlerThread;
import java.lang.reflect.Constructor;
import java.util.HashSet;
import java.util.concurrent.atomic.AtomicLong;
import org.robolectric.Robolectric;
import org.robolectric.util.ReflectionHelpers;

/**
 * Synthetic admission for shared algorithm tests, never a product entry point.
 * Actual edition admission is tested separately in EditionIsolationTest. These
 * fixtures do not enable a component, start Shizuku or allocate a real display.
 */
final class DisplayAlgorithmFixture {
    private DisplayAlgorithmFixture() {}

    static BoujoyDisplayService connectedAccessibility() {
        BoujoyDisplayService.setLifecycleListener(null);
        BoujoyDisplayService service=Robolectric.buildService(BoujoyDisplayService.class).create().get();
        ReflectionHelpers.setStaticField(BoujoyDisplayService.class,"connected",service);
        BoujoyDisplayService.setSessionDisplay(-1);
        return service;
    }

    /**
     * Instantiate only the Binder superclass; the shell-admission constructor is
     * deliberately not run. Seed an inert frame transaction, then exercise the
     * production attach/revoke/capture/recovery/retirement methods unchanged.
     * This avoids pretending the generic edition can start a shell service.
     */
    static ShellDisplayService frameTransaction(Context context)throws Exception {
        Class<?> factoryType=Class.forName("sun.reflect.ReflectionFactory");
        Object factory=factoryType.getMethod("getReflectionFactory").invoke(null);
        Constructor<?> constructor=(Constructor<?>)factoryType.getMethod("newConstructorForSerialization",Class.class,Constructor.class)
                .invoke(factory,ShellDisplayService.class,IShellDisplay.Stub.class.getDeclaredConstructor());
        constructor.setAccessible(true);
        ShellDisplayService service=(ShellDisplayService)constructor.newInstance();
        ReflectionHelpers.setField(service,"shell",context);
        ReflectionHelpers.setField(service,"ownerUid",context.getApplicationInfo().uid);
        ReflectionHelpers.setField(service,"ownerPackage",context.getPackageName());
        ReflectionHelpers.setField(service,"displays",context.getSystemService(DisplayManager.class));
        HandlerThread thread=new HandlerThread("Boujoy-frame-test-fixture");thread.start();
        ReflectionHelpers.setField(service,"thread",thread);
        ReflectionHelpers.setField(service,"handler",new Handler(thread.getLooper()));
        ReflectionHelpers.setField(service,"revocation",new AtomicLong());
        ReflectionHelpers.setField(service,"rearSleepLease",RearSleepLease.create());
        ReflectionHelpers.setField(service,"handoff",new DisplayHandoff());
        ReflectionHelpers.setField(service,"sessionTaskIds",new HashSet<Integer>());
        ReflectionHelpers.setField(service,"sessionPackages",new HashSet<String>());
        ReflectionHelpers.setField(service,"sessionTaskFloor",Integer.MAX_VALUE);
        ReflectionHelpers.setField(service,"recoveredBarrierNanos",-1L);
        ReflectionHelpers.setField(service,"lastFrameIssue","no_frame");
        ReflectionHelpers.setField(service,"frameLock",new Object());
        return service;
    }
}
