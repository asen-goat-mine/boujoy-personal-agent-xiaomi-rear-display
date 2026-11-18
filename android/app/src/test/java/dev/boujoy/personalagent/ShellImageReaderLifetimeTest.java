package dev.boujoy.personalagent;

import android.content.Context;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.FrameRaceImage;
import android.media.Image;
import android.media.ImageReader;
import android.os.Binder;
import android.os.HandlerThread;
import android.os.SystemClock;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadow.api.Shadow;
import org.robolectric.shadows.ShadowBinder;
import org.robolectric.shadows.ShadowDisplayManager;
import org.robolectric.shadows.ShadowImageReader;
import org.robolectric.shadows.ShadowProcess;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;

/** Real production frame/retirement calls; only platform buffer lifetime and virtual output are faked. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,shadows={ShellImageReaderLifetimeTest.ReaderLifetime.class,ShellFrameRecoveryTest.DisplayOutput.class})
public class ShellImageReaderLifetimeTest {
    @Implements(ImageReader.class)
    public static class ReaderLifetime extends ShadowImageReader {
        static final class Fixture {
            final Object lock;
            final List<ReaderLifetime> retired=new CopyOnWriteArrayList<>();
            Fixture(Object lock){this.lock=lock;}
        }
        static volatile Fixture currentFixture;
        // ImageReader.finalize() can call close long after the creating test ended.
        // Bind each reader to its own fixture, never the next test's static ledger/lock.
        final Fixture owner=currentFixture;
        final AtomicBoolean closed=new AtomicBoolean();
        volatile FrameRaceImage image;
        int acquisitions;
        @Implementation protected Image acquireLatestImage(){acquisitions++;FrameRaceImage value=image;image=null;return value;}
        @Implementation @Override protected void close(){
            // The platform close is idempotent; a later finalizer is not a new retirement.
            if(!closed.compareAndSet(false,true))return;
            assertNotNull("ImageReader must retain its creating fixture",owner);
            assertTrue("all ImageReader retirement must own the frame lifetime lock",Thread.holdsLock(owner.lock));
            owner.retired.add(this);
            super.close();
        }
    }
    private ShellDisplayService service;private ImageReader reader;private ReaderLifetime source;
    private ReaderLifetime.Fixture fixture;
    private ShellFrameRecoveryTest.DisplayOutput output;private JSONObject session;private long barrier;
    private final IDisplayPermit permit=new IDisplayPermit.Stub(){
        private boolean check(){assertFalse(Thread.holdsLock(service));assertFalse(Thread.holdsLock(fixture.lock));return true;}
        public boolean permits(){return check();}public boolean permitsWhileLocked(){return check();}
    };
    @Before public void setup()throws Exception {
        Context context=RuntimeEnvironment.getApplication();ShadowProcess.setUid(2000);ShadowBinder.setCallingUid(context.getApplicationInfo().uid);
        service=DisplayAlgorithmFixture.frameTransaction(context);service.attach(new Binder());
        fixture=new ReaderLifetime.Fixture(ReflectionHelpers.getField(service,"frameLock"));ReaderLifetime.currentFixture=fixture;
        int id=ShadowDisplayManager.addDisplay("w320dp-h640dp-mdpi","Reader race fixture");
        VirtualDisplay virtual=Shadow.newInstanceOf(VirtualDisplay.class);output=Shadow.extract(virtual);output.display=context.getSystemService(DisplayManager.class).getDisplay(id);
        reader=ImageReader.newInstance(320,640,PixelFormat.RGBA_8888,3);source=Shadow.extract(reader);output.surface=reader.getSurface();
        session=new JSONObject().put("sessionId","712fb1a1-f8de-4201-af36-f745235a8901").put("generation",9).put("displayId",id).put("width",320).put("height",640).put("alwaysUnlocked",true);
        ReflectionHelpers.setField(service,"virtualDisplay",virtual);ReflectionHelpers.setField(service,"session",session);ReflectionHelpers.setField(service,"reader",reader);ReflectionHelpers.setField(service,"readerGeneration",7L);
        barrier=System.nanoTime();ReflectionHelpers.setField(service,"minimumFrameNanos",barrier);
        source.image=new FrameRaceImage(source.closed,barrier-1_000_000L,false);frame(reader);
    }
    @After public void cleanup(){if(service!=null){ReflectionHelpers.callInstanceMethod(service,"closeDisplay");HandlerThread thread=ReflectionHelpers.getField(service,"thread");thread.quitSafely();}if(ReaderLifetime.currentFixture==fixture)ReaderLifetime.currentFixture=null;}
    private void frame(ImageReader value){ReflectionHelpers.callInstanceMethod(service,"frame",ReflectionHelpers.ClassParameter.from(ImageReader.class,value));}
    private boolean recover()throws Exception{return service.recoverFrameSource(session,reader,7,barrier,0,SystemClock.elapsedRealtime()+1500,permit);}
    private void blocked(Thread worker,AtomicBoolean closed)throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(2);
        while(!closed.get()&&worker.getState()!=Thread.State.BLOCKED&&worker.isAlive()&&System.nanoTime()<until)Thread.yield();
        assertFalse("reader was closed while native pixels were still being copied",closed.get());
        assertEquals("retirement must wait without taking the frame callback's service lock",Thread.State.BLOCKED,worker.getState());
    }
    @Test(timeout=6000) public void closeDisplayCannotReleaseAnAcquiredBufferDuringTheProductionCopy()throws Exception {
        FrameRaceImage pixels=new FrameRaceImage(source.closed,barrier-1_000_000L,true);source.image=pixels;
        FutureTask<Void> copy=new FutureTask<>(()->{frame(reader);return null;});Thread copying=new Thread(copy,"copy-fixture");copying.start();
        assertTrue(pixels.copying.await(2,TimeUnit.SECONDS));
        CountDownLatch entered=new CountDownLatch(1);FutureTask<Void> close=new FutureTask<>(()->{entered.countDown();ReflectionHelpers.callInstanceMethod(service,"closeDisplay");return null;});Thread closing=new Thread(close,"close-fixture");closing.start();
        try{assertTrue(entered.await(1,TimeUnit.SECONDS));blocked(closing,source.closed);assertFalse(pixels.closed.get());}
        finally{pixels.resume.countDown();copying.join(2000);closing.join(2000);}
        copy.get();close.get();assertTrue(pixels.closed.get());assertTrue(source.closed.get());assertFalse(pixels.invalidatedDuringCopy.get());assertNull(ReflectionHelpers.getField(service,"reader"));
    }
    @Test(timeout=6000) public void successfulSurfaceRecoveryWaitsForCopyAndImageCloseBeforeRetiringOldReader()throws Exception {
        FrameRaceImage pixels=new FrameRaceImage(source.closed,barrier-1_000_000L,true);source.image=pixels;
        FutureTask<Void> copy=new FutureTask<>(()->{frame(reader);return null;});Thread copying=new Thread(copy,"copy-fixture");copying.start();assertTrue(pixels.copying.await(2,TimeUnit.SECONDS));
        CountDownLatch entered=new CountDownLatch(1);FutureTask<Boolean> replacement=new FutureTask<>(()->{entered.countDown();return recover();});Thread replacing=new Thread(replacement,"swap-fixture");replacing.start();
        try{assertTrue(entered.await(1,TimeUnit.SECONDS));blocked(replacing,source.closed);assertEquals(0,output.replacements);}
        finally{pixels.resume.countDown();copying.join(2000);replacing.join(2000);}
        copy.get();assertTrue(replacement.get());assertTrue(pixels.closed.get());assertFalse(pixels.invalidatedDuringCopy.get());assertTrue(source.closed.get());assertEquals(1,output.replacements);
        ImageReader next=ReflectionHelpers.getField(service,"reader");assertNotSame(reader,next);assertFalse(((ReaderLifetime)Shadow.extract(next)).closed.get());
        int oldAcquisitions=source.acquisitions;frame(reader);assertEquals(oldAcquisitions,source.acquisitions);
    }
    @Test public void failedSurfaceRecoveryClosesOnlyTheUnpublishedReaderUnderTheSameLock()throws Exception {
        FrameRaceImage pixels=new FrameRaceImage(source.closed,barrier-1_000_000L,false);source.image=pixels;frame(reader);assertTrue(pixels.closed.get());
        output.reject=true;assertThrows(Exception.class,this::recover);assertSame(reader,ReflectionHelpers.getField(service,"reader"));assertFalse(source.closed.get());
        assertEquals(1,fixture.retired.size());assertNotSame(source,fixture.retired.get(0));assertTrue(fixture.retired.get(0).closed.get());
        assertFalse(recover());assertEquals(1,fixture.retired.size());
    }
}
