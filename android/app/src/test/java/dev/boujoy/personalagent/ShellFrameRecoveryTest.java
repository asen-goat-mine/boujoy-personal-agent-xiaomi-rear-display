package dev.boujoy.personalagent;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.ImageReader;
import android.os.Binder;
import android.os.HandlerThread;
import android.os.ParcelFileDescriptor;
import java.nio.charset.StandardCharsets;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import android.os.SystemClock;
import android.view.Display;
import android.view.Surface;
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
import org.robolectric.shadows.ShadowProcess;
import org.robolectric.shadows.ShadowParcelFileDescriptor;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;

/** Exercises the production recovery transaction; only the platform VirtualDisplay is faked. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=35,shadows={ShellFrameRecoveryTest.DisplayOutput.class,ShellFrameRecoveryTest.FileBackedPipe.class})
public class ShellFrameRecoveryTest {
    @Implements(VirtualDisplay.class)
    public static class DisplayOutput {
        Display display;Surface surface;int replacements;boolean reject;Runnable duringSet;
        @Implementation protected Display getDisplay(){return display;}
        @Implementation protected Surface getSurface(){return surface;}
        @Implementation protected void setSurface(Surface next){
            assertNotNull("never detach the display",next);assertNotSame(surface,next);
            replacements++;if(reject)throw new IllegalStateException("platform_fixture_failure");
            surface=next;if(duringSet!=null)duringSet.run();
        }
        @Implementation protected void release(){}
    }
    /** Robolectric uses two regular-file FDs for a pipe, so reads do not block for its writer. */
    @Implements(ParcelFileDescriptor.class)
    public static class FileBackedPipe extends ShadowParcelFileDescriptor {
        static CountDownLatch writerClosed;
        private boolean writer;
        @Implementation protected static ParcelFileDescriptor[] createPipe()throws IOException {
            ParcelFileDescriptor[] descriptors=ShadowParcelFileDescriptor.createPipe();
            ((FileBackedPipe)Shadow.extract(descriptors[1])).writer=true;
            writerClosed=new CountDownLatch(1);
            return descriptors;
        }
        @Implementation @Override protected void close()throws IOException {
            try{super.close();}finally{if(writer)writerClosed.countDown();}
        }
    }
    private ShellDisplayService service;private DisplayOutput output;private JSONObject session;
    private ImageReader original;private long barrier;private boolean allowed=true;private int permits;
    private final IDisplayPermit permit=new IDisplayPermit.Stub(){
        public boolean permits(){return check();}public boolean permitsWhileLocked(){return check();}
        private boolean check(){
            permits++;assertFalse("Binder callback cannot hold service lock",Thread.holdsLock(service));
            assertFalse("Binder callback cannot hold frame lock",Thread.holdsLock(ReflectionHelpers.getField(service,"frameLock")));
            return allowed;
        }
    };
    @Before public void setup()throws Exception {
        Context context=RuntimeEnvironment.getApplication();ShadowProcess.setUid(2000);
        ShadowBinder.setCallingUid(context.getApplicationInfo().uid);
        service=DisplayAlgorithmFixture.frameTransaction(context);service.attach(new Binder());
        int id=ShadowDisplayManager.addDisplay("w320dp-h640dp-mdpi","Owned frame fixture");
        VirtualDisplay virtual=Shadow.newInstanceOf(VirtualDisplay.class);output=Shadow.extract(virtual);
        output.display=context.getSystemService(DisplayManager.class).getDisplay(id);
        original=ImageReader.newInstance(320,640,PixelFormat.RGBA_8888,3);output.surface=original.getSurface();
        assertTrue(original.getSurface().isValid());
        session=new JSONObject().put("sessionId","712fb1a1-f8de-4201-af36-f745235a8901").put("generation",9)
                .put("displayId",id).put("width",320).put("height",640).put("alwaysUnlocked",true);
        ReflectionHelpers.setField(service,"virtualDisplay",virtual);ReflectionHelpers.setField(service,"session",session);
        ReflectionHelpers.setField(service,"reader",original);ReflectionHelpers.setField(service,"readerGeneration",7L);
        barrier=System.nanoTime();ReflectionHelpers.setField(service,"minimumFrameNanos",barrier);
        frame(original,7,barrier-1_000_000L);
    }
    private void frame(ImageReader source,long generation,long timestamp){
        Bitmap previous=ReflectionHelpers.getField(service,"latestFrame");if(previous!=null&&!previous.isRecycled())previous.recycle();
        ReflectionHelpers.setField(service,"latestFrame",Bitmap.createBitmap(320,640,Bitmap.Config.ARGB_8888));
        ReflectionHelpers.setField(service,"latestFrameNanos",timestamp);ReflectionHelpers.setField(service,"latestFrameReceivedNanos",System.nanoTime());
        ReflectionHelpers.setField(service,"latestFrameReaderGeneration",generation);ReflectionHelpers.setField(service,"latestFrameAt",System.currentTimeMillis());
        ReflectionHelpers.setField(service,"lastFrameIssue",null);
    }
    private boolean recover()throws Exception{return service.recoverFrameSource(session,original,7,barrier,0,SystemClock.elapsedRealtime()+1500,permit);}
    @After public void cleanup(){if(service!=null){ReflectionHelpers.callInstanceMethod(service,"closeDisplay");HandlerThread thread=ReflectionHelpers.getField(service,"thread");thread.quitSafely();}}
    @Test public void staleFrameReplacesOnlyOutputAndClearsTheOldCache()throws Exception {
        JSONObject identity=new JSONObject(session.toString());Surface old=original.getSurface();
        assertTrue(recover());assertEquals(1,output.replacements);assertNotSame(old,output.surface);
        assertEquals(identity.toString(),((JSONObject)ReflectionHelpers.getField(service,"session")).toString());
        assertEquals(8L,(long)ReflectionHelpers.getField(service,"readerGeneration"));
        assertEquals(barrier,(long)ReflectionHelpers.getField(service,"minimumFrameNanos"));
        assertNull(ReflectionHelpers.getField(service,"latestFrame"));assertEquals(0L,(long)ReflectionHelpers.getField(service,"latestFrameAt"));
        assertTrue(permits>=3);
    }
    @Test public void sameBarrierNeverReplacesOutputTwiceEvenWithAStaleNewBuffer()throws Exception {
        assertTrue(recover());ImageReader next=ReflectionHelpers.getField(service,"reader");frame(next,8,barrier-1);
        assertFalse(service.recoverFrameSource(session,next,8,barrier,0,SystemClock.elapsedRealtime()+1500,permit));
        assertEquals(1,output.replacements);
    }
    @Test public void currentStaticFrameAndBadClockDoNotTriggerRecovery()throws Exception {
        ReflectionHelpers.setField(service,"minimumFrameNanos",barrier-2_000_000L);
        assertFalse(service.recoverFrameSource(session,original,7,barrier-2_000_000L,0,SystemClock.elapsedRealtime()+1500,permit));
        ReflectionHelpers.setField(service,"minimumFrameNanos",barrier);ReflectionHelpers.setField(service,"latestFrameAt",0L);
        assertFalse(recover());assertEquals(0,output.replacements);
    }
    @Test public void failedPlatformSwapIsNotSuccessOrReplay()throws Exception {
        output.reject=true;assertThrows(Exception.class,this::recover);assertEquals(1,output.replacements);
        assertSame(original,ReflectionHelpers.getField(service,"reader"));assertFalse(recover());assertEquals(1,output.replacements);
    }
    @Test public void stopOrExpiredDeadlinePreventsAnyReplacement()throws Exception {
        allowed=false;assertThrows(Exception.class,this::recover);assertEquals(0,output.replacements);
        allowed=true;assertThrows(Exception.class,()->service.recoverFrameSource(session,original,7,barrier,0,SystemClock.elapsedRealtime(),permit));
        assertEquals(0,output.replacements);service.revoke();assertThrows(Exception.class,this::recover);assertEquals(0,output.replacements);
    }
    @Test public void stopDuringPlatformSwapNeverReportsRecovered()throws Exception {
        output.duringSet=()->service.revoke();assertThrows(Exception.class,this::recover);
        assertEquals(1,output.replacements);assertNull(ReflectionHelpers.getField(service,"latestFrame"));
    }
    @Test public void differentSessionOrReaderCannotBorrowOldFrame()throws Exception {
        JSONObject other=new JSONObject(session.toString()).put("generation",10);
        assertThrows(Exception.class,()->service.recoverFrameSource(other,original,7,barrier,0,SystemClock.elapsedRealtime()+1500,permit));
        assertFalse(service.recoverFrameSource(session,original,6,barrier,0,SystemClock.elapsedRealtime()+1500,permit));
        assertEquals(0,output.replacements);
    }
    @Test public void lateOldReaderCallbackCannotInvalidateNewFrame()throws Exception {
        assertTrue(recover());ImageReader next=ReflectionHelpers.getField(service,"reader");frame(next,8,System.nanoTime());
        Bitmap fresh=ReflectionHelpers.getField(service,"latestFrame");long at=ReflectionHelpers.getField(service,"latestFrameAt");
        ReflectionHelpers.callInstanceMethod(service,"frame",ReflectionHelpers.ClassParameter.from(ImageReader.class,original));
        assertSame(fresh,ReflectionHelpers.getField(service,"latestFrame"));assertEquals(at,(long)ReflectionHelpers.getField(service,"latestFrameAt"));
    }
    @Test(timeout=5000) public void rejectedCaptureWritesAnActualErrorReceiptInsteadOfEmptyPipe()throws Exception {
        JSONObject stale=new JSONObject(session.toString()).put("generation",10);
        ParcelFileDescriptor pipe=service.capture(stale.toString(),640,permit);assertNotNull(pipe);
        assertTrue("production capture writer must finish",FileBackedPipe.writerClosed.await(3,TimeUnit.SECONDS));
        try(ParcelFileDescriptor.AutoCloseInputStream input=new ParcelFileDescriptor.AutoCloseInputStream(pipe)){
            byte[] receipt=input.readAllBytes();assertTrue("capture error must not be empty EOF",receipt.length>0);
            JSONObject result=new JSONObject(new String(receipt,StandardCharsets.UTF_8));
            assertFalse(result.getBoolean("available"));assertEquals("SESSION_STALE",result.getJSONObject("error").getString("code"));
            assertEquals("session_gate",result.getJSONObject("error").getString("reason"));
        }
        assertEquals(0,output.replacements);
    }
    @Test public void barrierChangeDuringFreshPermitPreventsReplacement()throws Exception {
        IDisplayPermit changing=new IDisplayPermit.Stub(){
            private boolean check(){
                if((long)ReflectionHelpers.getField(service,"recoveredBarrierNanos")==barrier)
                    ReflectionHelpers.setField(service,"minimumFrameNanos",barrier+1);
                return true;
            }
            public boolean permits(){return check();}public boolean permitsWhileLocked(){return check();}
        };
        assertFalse(service.recoverFrameSource(session,original,7,barrier,0,SystemClock.elapsedRealtime()+1500,changing));
        assertEquals(0,output.replacements);assertSame(original,ReflectionHelpers.getField(service,"reader"));
    }
    @Test public void captureFailureEnvelopePreservesKnownCodeAndOnlySafeMetadata()throws Exception {
        JSONObject failed=ShellDisplayService.frameFailure("LOCKED","session_gate");
        assertFalse(failed.getBoolean("available"));assertEquals("LOCKED",failed.getJSONObject("error").getString("code"));
        String serialized=ShellDisplayService.frameFailure("secret page text","private customer text").toString();
        assertFalse(serialized.contains("secret"));assertFalse(serialized.contains("customer"));assertTrue(serialized.contains("capture_exception"));
    }
}
