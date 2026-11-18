package android.media;

import android.graphics.PixelFormat;
import java.nio.ByteBuffer;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Test-side image: package placement is required by Image/Plane package-private constructors. */
public final class FrameRaceImage extends Image {
    public final CountDownLatch copying=new CountDownLatch(1),resume=new CountDownLatch(1);
    public final AtomicBoolean closed=new AtomicBoolean(),invalidatedDuringCopy=new AtomicBoolean();
    private final AtomicBoolean readerClosed;
    private final long timestamp;
    private final boolean pause;
    public FrameRaceImage(AtomicBoolean readerClosed,long timestamp,boolean pause){this.readerClosed=readerClosed;this.timestamp=timestamp;this.pause=pause;}
    @Override public int getFormat(){return PixelFormat.RGBA_8888;}
    @Override public int getWidth(){return 320;}
    @Override public int getHeight(){return 640;}
    @Override public long getTimestamp(){return timestamp;}
    @Override public Plane[] getPlanes(){return new Plane[]{new Plane(){
        @Override public int getRowStride(){return 320*4;}
        @Override public int getPixelStride(){return 4;}
        @Override public ByteBuffer getBuffer(){
            copying.countDown();
            if(pause)try{if(!resume.await(3,TimeUnit.SECONDS))throw new AssertionError("copy latch timeout");}catch(InterruptedException e){Thread.currentThread().interrupt();throw new AssertionError(e);}
            invalidatedDuringCopy.set(readerClosed.get());return ByteBuffer.allocate(320*640*4);
        }
    }};}
    @Override public void close(){closed.set(true);}
}
