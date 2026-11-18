package dev.boujoy.personalagent;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.View;
import android.view.MotionEvent;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import java.io.File;
import java.io.FileOutputStream;
import java.time.Duration;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;

/** Local avatar animation fixtures: no phone, service or fabricated task receipt. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=35, qualifiers="w390dp-h844dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class BotAvatarMotionTest {
    private ActivityController<Activity> controller;
    private Activity activity;
    private FrameLayout host;
    @Before public void setup(){
        controller=Robolectric.buildActivity(Activity.class).setup().visible();activity=controller.get();
        setAnimationScale(1f);
        host=new FrameLayout(activity);activity.setContentView(host);layout();
    }
    @After public void cleanup(){setAnimationScale(1f);controller.pause().stop().destroy();}
    private void setAnimationScale(float scale){
        Settings.Global.putFloat(activity.getContentResolver(),Settings.Global.ANIMATOR_DURATION_SCALE,scale);
        // Robolectric's settings store does not dispatch the provider's change notification.
        activity.getContentResolver().notifyChange(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE),null);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
    }
    private void layout(){host.measure(View.MeasureSpec.makeMeasureSpec(390,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(844,View.MeasureSpec.EXACTLY));host.layout(0,0,390,844);Shadows.shadowOf(Looper.getMainLooper()).idle();}
    private BotAvatar avatar(){return avatar(true);}
    private BotAvatar avatar(boolean level){BotAvatar bot=new BotAvatar(activity,"violet").withoutGroundShadow();if(level)bot.breathingLevel();else bot.breathing();host.addView(bot,new FrameLayout.LayoutParams(136,136));layout();bot.setMotionActive(true);return bot;}
    private static long celebration(BotAvatar bot){return ReflectionHelpers.getField(bot,"celebrationStarted");}
    private static Object animator(BotAvatar bot){return ReflectionHelpers.getField(bot,"idle");}
    @Test public void onlyAnObservedWorkingTaskCanCelebrateOnce(){
        BotAvatar bot=avatar();bot.taskMotion("history","completed",true);assertEquals(-1,celebration(bot));
        bot.taskMotion("live","running",true);bot.taskMotion("live","completed",true);long started=celebration(bot);assertTrue(started>=0);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(120));bot.taskMotion("live","completed",true);assertEquals("Repeated receipts do not restart the jump",started,celebration(bot));
        bot.taskMotion("other","running",true);assertEquals("Task changes cancel an old celebration",-1,celebration(bot));
        bot.taskMotion("third","completed",true);assertEquals(-1,celebration(bot));
    }
    @Test public void pausedStaleAndHiddenTransitionsNeverReplayACompletion(){
        BotAvatar bot=avatar();bot.taskMotion("t","running",true);bot.taskMotion("t","running",false);
        assertNull(animator(bot));bot.taskMotion("t","completed",true);assertEquals(-1,celebration(bot));
        bot.taskMotion("t","running",true);host.setVisibility(View.GONE);assertNull(animator(bot));
        host.setVisibility(View.VISIBLE);layout();bot.taskMotion("t","succeeded",true);assertEquals("A hidden transition must not celebrate on return",-1,celebration(bot));
        bot.taskMotion("t","running",true);bot.taskMotion("t","failed",true);assertEquals(-1,celebration(bot));
    }
    @Test public void offscreenDetachedAndReducedMotionAvatarsStopTheirAnimator(){
        BotAvatar bot=avatar();assertNotNull(animator(bot));host.removeView(bot);assertNull(animator(bot));
        ScrollView scroll=new ScrollView(activity);LinearLayout column=new LinearLayout(activity);column.setOrientation(LinearLayout.VERTICAL);scroll.addView(column);host.addView(scroll,new FrameLayout.LayoutParams(200,200));
        column.addView(bot,new LinearLayout.LayoutParams(136,136));column.addView(new View(activity),new LinearLayout.LayoutParams(136,1000));layout();bot.setMotionActive(true);assertNotNull(animator(bot));
        scroll.scrollTo(0,700);ReflectionHelpers.callInstanceMethod(scroll.getViewTreeObserver(),"dispatchOnScrollChanged");assertNull("A clipped list avatar must not keep animating",animator(bot));
        scroll.scrollTo(0,0);ReflectionHelpers.callInstanceMethod(scroll.getViewTreeObserver(),"dispatchOnScrollChanged");assertNotNull(animator(bot));
        setAnimationScale(0f);bot.setMotionActive(true);assertNull(animator(bot));
        bot.taskMotion("t","running",true);bot.taskMotion("t","completed",true);assertEquals(-1,celebration(bot));
    }
    private static void size(BotAvatar bot,int side){
        bot.measure(View.MeasureSpec.makeMeasureSpec(side,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(side,View.MeasureSpec.EXACTLY));bot.layout(0,0,side,side);
    }
    private static Bitmap draw(BotAvatar bot,int side){
        Bitmap bitmap=Bitmap.createBitmap(side,side,Bitmap.Config.ARGB_8888);bot.draw(new Canvas(bitmap));return bitmap;
    }
    private static Bitmap drawPose(BotAvatar bot,int side,BotAvatar.Pose pose){size(bot,side);bot.applyPose(pose);return draw(bot,side);}
    private static Rect inkBounds(Bitmap bitmap){
        int width=bitmap.getWidth(),height=bitmap.getHeight();int[] pixels=new int[width*height];bitmap.getPixels(pixels,0,width,0,0,width,height);
        Rect found=new Rect(width,height,0,0);
        for(int y=0;y<height;y++)for(int x=0;x<width;x++)if(Color.alpha(pixels[y*width+x])>8){found.left=Math.min(found.left,x);found.top=Math.min(found.top,y);found.right=Math.max(found.right,x+1);found.bottom=Math.max(found.bottom,y+1);}
        return found;
    }
    private static int eyeColorCount(Bitmap bitmap,int left,int right){
        int count=0;
        for(int y=145;y<198;y++)for(int x=left;x<right;x++){
            int pixel=bitmap.getPixel(x,y);
            // Preserve the violet eye's original multicolor texture; do not require a flat replacement ink.
            if(Color.alpha(pixel)>150&&Color.blue(pixel)>Color.red(pixel)+10&&Color.blue(pixel)>Color.green(pixel)+25)count++;
        }
        return count;
    }
    private static double[] alphaCenter(Bitmap bitmap){
        int width=bitmap.getWidth(),height=bitmap.getHeight();int[] pixels=new int[width*height];bitmap.getPixels(pixels,0,width,0,0,width,height);
        double mass=0,x=0,y=0;
        for(int i=0;i<pixels.length;i++){int alpha=Color.alpha(pixels[i]);mass+=alpha;x+=(i%width)*alpha;y+=(i/width)*alpha;}
        assertTrue(mass>0);return new double[]{x/mass,y/mass};
    }
    private static Bitmap capturePose(BotAvatar bot,String name,int side,BotAvatar.Pose sample)throws Exception{
        size(bot,side);bot.applyPose(sample);return NativeVisualTest.capture(bot,name,side,side);
    }
    private static BotAvatar.Pose pose(long time,boolean level){return BotAvatar.samplePose(time,false,-1,level);}
    @Test public void canvasMotionDoesNotMoveTheClickTargetOrMakeTheRearAvatarClickable()throws Exception{
        BotAvatar bot=avatar(false);bot.setMotionActive(false);AtomicInteger clicks=new AtomicInteger();bot.setOnClickListener(v->clicks.incrementAndGet());
        Rect before=new Rect();bot.getHitRect(before);
        for(BotAvatar.Pose sample:new BotAvatar.Pose[]{pose(3330,false),pose(6100,false),pose(12325,false),BotAvatar.samplePose(0,false,280,false)}){
            bot.applyPose(sample);Rect after=new Rect();bot.getHitRect(after);assertEquals(before,after);
            assertEquals(0,bot.getTranslationX(),0);assertEquals(0,bot.getTranslationY(),0);assertEquals(0,bot.getRotation(),0);assertEquals(1,bot.getScaleX(),0);assertEquals(1,bot.getScaleY(),0);
            long now=SystemClock.uptimeMillis();MotionEvent down=MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,8,8,0),up=MotionEvent.obtain(now,now+10,MotionEvent.ACTION_UP,8,8,0);
            try{assertTrue(bot.dispatchTouchEvent(down));assertTrue(bot.dispatchTouchEvent(up));}finally{down.recycle();up.recycle();}
            Shadows.shadowOf(Looper.getMainLooper()).idle(); // View posts PerformClick after ACTION_UP.
        }
        assertEquals("The same point in the View stays clickable throughout every drawing transform",4,clicks.get());
        bot.setOnClickListener(null);bot.setClickable(false);bot.applyPose(BotAvatar.samplePose(0,false,280,true));
        NativeVisualTest.capture(bot,"bot-motion-04-completion",136,136);
        assertFalse(bot.isClickable());assertFalse((Boolean)ReflectionHelpers.getField(bot,"groundShadow"));
    }
    @Test public void sampledGesturesKeepTheTwoEyesDistinctAndActuallyRenderTheWink(){
        BotAvatar.Pose firstBlink=pose(1490,true),between=pose(1600,true),secondBlink=pose(1750,true);
        assertTrue(firstBlink.blink>.95f);assertEquals(0,between.blink,0);assertTrue(secondBlink.blink>.95f);
        BotAvatar.Pose rightWink=pose(3330,true),leftWink=pose(23330,true);
        assertEquals(1,rightWink.leftEyeOpen,0);assertTrue(rightWink.rightEyeOpen<.05f);
        assertEquals(1,leftWink.rightEyeOpen,0);assertTrue(leftWink.leftEyeOpen<.05f);
        assertTrue(pose(6100,true).look>0);assertTrue(pose(16500,true).look<0);
        BotAvatar bot=avatar();bot.setMotionActive(false);
        Bitmap right=drawPose(bot,256,rightWink),left=drawPose(bot,256,leftWink);
        assertTrue("Right wink keeps the left eye open in the rendered artwork",eyeColorCount(right,96,136)>eyeColorCount(right,138,178)+60);
        assertTrue("The next cycle winks with the other eye",eyeColorCount(left,138,178)>eyeColorCount(left,96,136)+60);
        assertFalse(right.sameAs(left));assertEquals("An idle hop never records a task success",-1,celebration(bot));
    }
    @Test public void gestureExtremesKeepTransparentMarginsAtListAndRearSizes(){
        long[] times={0,1490,1750,3330,6100,9050,12065,12325,12650,16500,23330};
        for(boolean level:new boolean[]{false,true}){
            BotAvatar bot=avatar(level);bot.setMotionActive(false);
            for(int side:new int[]{48,136})for(boolean working:new boolean[]{false,true}){
                for(long time:times)assertInside(bot,side,BotAvatar.samplePose(time,working,-1,level),level);
                for(long age:new long[]{50,280,515,725,940})assertInside(bot,side,BotAvatar.samplePose(0,working,age,level),level);
            }
        }
    }
    private static void assertInside(BotAvatar bot,int side,BotAvatar.Pose sample,boolean level){
        if(level)assertEquals("Rear/header artwork remains level",0,sample.tilt,0);
        size(bot,side);bot.applyPose(sample);int pad=16;
        Bitmap overscan=Bitmap.createBitmap(side+pad*2,side+pad*2,Bitmap.Config.ARGB_8888);Canvas canvas=new Canvas(overscan);canvas.translate(pad,pad);bot.draw(canvas);
        Rect ink=inkBounds(overscan);assertFalse(ink.isEmpty());
        assertTrue(sample.gesture+" must retain a transparent margin rather than crop: "+ink,
                ink.left>pad&&ink.top>pad&&ink.right<pad+side&&ink.bottom<pad+side);
    }
    @Test public void disablingMotionClearsEveryAddedPoseAndNeverReplaysAHiddenSuccess(){
        BotAvatar bot=avatar(false);bot.setMotionActive(false);Bitmap neutral=draw(bot,136);
        for(BotAvatar.Pose sample:new BotAvatar.Pose[]{pose(3330,false),pose(6100,false),pose(12325,false),BotAvatar.samplePose(0,false,280,false)}){
            bot.applyPose(sample);assertFalse("The sampled gesture must visibly differ from rest",neutral.sameAs(draw(bot,136)));
            bot.setMotionActive(false);assertNull(animator(bot));assertTrue("Turning motion off clears every added drawing channel",neutral.sameAs(draw(bot,136)));
        }
        bot.taskMotion("live","running",true);
        setAnimationScale(0f);
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(160));assertNull("Changing the system animation setting stops an already running avatar",animator(bot));
        assertTrue(neutral.sameAs(draw(bot,136)));
        setAnimationScale(1f);bot.setMotionActive(true);bot.taskMotion("live","completed",true);assertEquals(-1,celebration(bot));
        bot.taskMotion("live","running",true);host.setVisibility(View.GONE);Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2));
        host.setVisibility(View.VISIBLE);layout();bot.taskMotion("live","completed",true);assertEquals(-1,celebration(bot));
    }
    @Test public void gestureAndCelebrationJoinsHaveContinuousPositionAndVelocity(){
        long[] joins={1400,1580,1660,1840,1880,3000,3150,3510,3700,5500,5760,6320,6700,
                8700,9400,12000,12130,12520,12800,15900,16160,16720,17100,20000};
        for(boolean level:new boolean[]{false,true}){
            for(long at:joins)assertSmoothJoin("idle@"+at,
                    BotAvatar.samplePose(at-2,false,-1,level),BotAvatar.samplePose(at-1,false,-1,level),
                    BotAvatar.samplePose(at+1,false,-1,level),BotAvatar.samplePose(at+2,false,-1,level));
            for(long start:new long[]{3330,5100,6100,11325,12325,16500}){
                assertSmoothJoin("success entry@"+start,
                        BotAvatar.samplePose(start-2,false,-1,level),BotAvatar.samplePose(start-1,false,-1,level),
                        BotAvatar.samplePose(start+1,false,1,level),BotAvatar.samplePose(start+2,false,2,level));
                long end=start+BotAvatar.CELEBRATION_MS;
                assertSmoothJoin("success exit@"+end,
                        BotAvatar.samplePose(end-2,false,BotAvatar.CELEBRATION_MS-2,level),BotAvatar.samplePose(end-1,false,BotAvatar.CELEBRATION_MS-1,level),
                        BotAvatar.samplePose(end+1,false,-1,level),BotAvatar.samplePose(end+2,false,-1,level));
            }
        }
    }
    private static double[] channels(BotAvatar.Pose p){
        // Comparable source-art units for translations, rotation, scale, and eye geometry.
        return new double[]{p.bob,p.jump*10,p.look*6,p.tilt*2,p.scaleX*112,p.scaleY*112,p.leftEyeOpen*28,p.rightEyeOpen*28,p.happy*8};
    }
    private static void assertSmoothJoin(String name,BotAvatar.Pose before2,BotAvatar.Pose before1,BotAvatar.Pose after1,BotAvatar.Pose after2){
        double[] a=channels(before2),b=channels(before1),c=channels(after1),d=channels(after2);
        for(int i=0;i<a.length;i++){
            assertTrue(name+" channel "+i+" changes position abruptly",Math.abs(c[i]-b[i])<.2);
            assertTrue(name+" channel "+i+" changes velocity abruptly",Math.abs((d[i]-c[i])-(b[i]-a[i]))<.04);
        }
    }
    @Test public void renderedTravelIsLargerAtBothSmallListAndRearSizes(){
        BotAvatar bot=avatar();bot.setMotionActive(false);
        for(int side:new int[]{48,136}){
            double left=alphaCenter(drawPose(bot,side,pose(16500,true)))[0],right=alphaCenter(drawPose(bot,side,pose(6100,true)))[0];
            double minY=Double.POSITIVE_INFINITY,maxY=Double.NEGATIVE_INFINITY;
            for(int i=0;i<24;i++){
                double y=alphaCenter(drawPose(bot,side,pose(11850+i*1000L/24,true)))[1];minY=Math.min(minY,y);maxY=Math.max(maxY,y);
            }
            double peek=right-left,hop=maxY-minY;
            // 1.0.45's saved native 136px PNGs measured 3.1406px left/right travel and
            // 5.7215px vertical travel in these same hop samples. Measure rendered pixels,
            // so raising Pose.jump while a drawing clamp suppresses it cannot pass.
            assertTrue(side+"px peek travel stayed too small: "+peek,peek>=(side==48?1.8:5.0));
            assertTrue(side+"px hop travel stayed too small: "+hop,hop>=(side==48?2.3:6.5));
            System.out.printf(Locale.ROOT,"avatar-motion-1.0.46 %dpx: peek=%.4fpx hop=%.4fpx%n",side,peek,hop);
        }
    }
    @Test public void nativeMotionFramesKeepTheOriginalArtworkAndShowTheNewGestures()throws Exception{
        BotAvatar bot=avatar();bot.setMotionActive(false);bot.setOnClickListener(null);bot.setClickable(false);
        String[] names={"rest","blink-1","blink-2","wink-right","wink-left","peek-right","peek-left","nod","hop","done-1","done-2","settled"};
        long[] times={2200,1490,1750,3330,23330,6100,16500,9050,12325,0,0,18000};
        long[] ages={-1,-1,-1,-1,-1,-1,-1,-1,-1,280,725,1100};
        Bitmap contact=Bitmap.createBitmap(640,504,Bitmap.Config.ARGB_8888);Canvas sheet=new Canvas(contact);sheet.drawColor(0xfff5f4f8);
        Paint labels=new Paint(Paint.ANTI_ALIAS_FLAG);labels.setColor(0xff464351);labels.setTextSize(11);labels.setTypeface(Typeface.MONOSPACE);
        for(int i=0;i<names.length;i++){
            Bitmap frame=capturePose(bot,"bot-motion-1.0.46-"+names[i],136,BotAvatar.samplePose(times[i],false,ages[i],true));
            int x=i%4*160,y=i/4*168;sheet.drawBitmap(frame,x+12,y+4,null);sheet.drawText(names[i],x+12,y+157,labels);
        }
        File output=new File(System.getProperty("boujoy.visual.output"));
        try(FileOutputStream out=new FileOutputStream(new File(output,"bot-motion-1.0.46-contact-sheet.png"))){assertTrue(contact.compress(Bitmap.CompressFormat.PNG,100,out));}
        Bitmap actual=Bitmap.createBitmap(680,260,Bitmap.Config.ARGB_8888);Canvas sizes=new Canvas(actual);sizes.drawColor(0xfff5f4f8);
        int[] selected={0,3,5,8,9};
        for(int row=0;row<2;row++){
            int side=row==0?48:96,top=row==0?12:112;
            for(int column=0;column<selected.length;column++){
                int i=selected[column];Bitmap frame=capturePose(bot,"bot-motion-1.0.46-"+side+"px-"+names[i],side,BotAvatar.samplePose(times[i],false,ages[i],true));
                int x=column*136+(136-side)/2;sizes.drawBitmap(frame,x,top,null);sizes.drawText(side+"px "+names[i],column*136+8,top+side+22,labels);
            }
        }
        try(FileOutputStream out=new FileOutputStream(new File(output,"bot-motion-1.0.46-actual-sizes.png"))){assertTrue(actual.compress(Bitmap.CompressFormat.PNG,100,out));}
        // Continuous 24-second baseline: one complete idle cycle, then success at 20.5s.
        // Entry and exit keep the same wall-clock phase; no gesture slices are stitched together.
        File frames=new File(output,"avatar-motion-1.0.46");assertTrue(frames.isDirectory()||frames.mkdirs());
        int frameCount=24*24;
        for(int number=0;number<frameCount;number++){
            long time=number*1000L/24,age=time>=20500&&time<20500+BotAvatar.CELEBRATION_MS?time-20500:-1;
            capturePose(bot,String.format(Locale.ROOT,"avatar-motion-1.0.46/frame-%04d",number),136,BotAvatar.samplePose(time,false,age,true));
        }
        assertEquals(576,frameCount);
    }

    private static void updateMotionAt(BotAvatar bot,long time){
        ReflectionHelpers.callInstanceMethod(bot,"updateMotion",ReflectionHelpers.ClassParameter.from(long.class,time));
    }
    private static void moodAt(BotAvatar bot,String mood,long time){
        bot.setMood(mood);ReflectionHelpers.setField(bot,"moodSince",time);
        if((Long)ReflectionHelpers.getField(bot,"moodBlendStarted")>=0)ReflectionHelpers.setField(bot,"moodBlendStarted",time);
    }
    private static BotAvatar.Pose displayedPose(BotAvatar bot){
        BotAvatar.Pose pose=new BotAvatar.Pose();
        pose.bob=ReflectionHelpers.getField(bot,"bob");pose.look=ReflectionHelpers.getField(bot,"look");
        pose.blink=ReflectionHelpers.getField(bot,"blink");pose.jump=ReflectionHelpers.getField(bot,"jump");
        pose.tilt=ReflectionHelpers.getField(bot,"tilt");pose.happy=ReflectionHelpers.getField(bot,"happy");
        pose.scaleX=ReflectionHelpers.getField(bot,"scaleX");pose.scaleY=ReflectionHelpers.getField(bot,"scaleY");
        pose.leftEyeOpen=ReflectionHelpers.getField(bot,"leftEyeOpen");pose.rightEyeOpen=ReflectionHelpers.getField(bot,"rightEyeOpen");
        return pose;
    }
    private static void assertSamePose(String message,BotAvatar.Pose before,BotAvatar.Pose after){
        assertArrayEquals(message,channels(before),channels(after),.00001);assertEquals(message,before.blink,after.blink,.00001);
    }
    private static void assertSmoothMoodJoin(String name,BotAvatar.Pose before2,BotAvatar.Pose before1,BotAvatar.Pose after1,BotAvatar.Pose after2){
        double[] a=channels(before2),b=channels(before1),c=channels(after1),d=channels(after2);
        for(int i=0;i<a.length;i++){
            double incoming=b[i]-a[i],outgoing=d[i]-c[i];
            // The samples span two milliseconds. Subtract the travel predicted by
            // both one-millisecond tangents: fast smooth eye motion is not a jump.
            // A position step remains in this residual; constant/quadratic travel cancels.
            double residual=(c[i]-b[i])-(incoming+outgoing);
            assertTrue(name+" channel "+i+" has a position discontinuity: "+residual,Math.abs(residual)<.03);
            assertTrue(name+" channel "+i+" changes velocity abruptly",Math.abs(outgoing-incoming)<.04);
        }
    }
    @Test public void allRearMoodsKeepContinuousPositionAndVelocityAcrossTheirCycles(){
        long[] joins={0,110,120,170,260,430,470,480,600,650,680,700,750,900,1400,1500,1680,2400,2600,3100,3200,3700,4200,5500,5600,6000,6100,6250,6300,6500,7000,7100,9000,11000,15000};
        for(String mood:new String[]{"idle","work","wait","done","warn"})for(long at:joins){
            // Offset the age so the nonnegative completion timeline is not crossed at zero.
            long age="done".equals(mood)?at:2000;
            if("done".equals(mood)&&at==0)continue;
            assertSmoothMoodJoin(mood+"@"+at,
                    BotAvatar.sampleMoodPose(at-2,mood,age-2),BotAvatar.sampleMoodPose(at-1,mood,age-1),
                    BotAvatar.sampleMoodPose(at+1,mood,age+1),BotAvatar.sampleMoodPose(at+2,mood,age+2));
        }
        for(long at:new long[]{350,700,1050,1400}){
            double before=BotAvatar.sampleMoodPose(at-1,"done",2000).bob-BotAvatar.sampleMoodPose(at-2,"done",1999).bob;
            double after=BotAvatar.sampleMoodPose(at+2,"done",2003).bob-BotAvatar.sampleMoodPose(at+1,"done",2002).bob;
            assertTrue("Completion bob must not have the abs(sine) velocity cusp",Math.abs(after-before)<.002);
        }
    }
    @Test public void completedMoodFinishesItsCurrentHopBeforeChangingCadence(){
        assertTrue(BotAvatar.sampleMoodPose(5999,"done",5999).jump>.4f);
        assertTrue("The six-second mark must not cut off an in-flight hop",BotAvatar.sampleMoodPose(6000,"done",6000).jump>.4f);
        for(long at:new long[]{BotAvatar.DONE_FAST_END_MS-1,BotAvatar.DONE_FAST_END_MS}){
            BotAvatar.Pose pose=BotAvatar.sampleMoodPose(at,"done",at);
            assertEquals(0,pose.jump,0);assertEquals(1,pose.scaleX,0);assertEquals(1,pose.scaleY,0);
        }
        for(long age=BotAvatar.DONE_FAST_END_MS+650;age<BotAvatar.DONE_FAST_END_MS+4000;age+=17)
            assertEquals("The settled cadence has one hop per four seconds",0,BotAvatar.sampleMoodPose(age,"done",age).jump,0);
        assertTrue(BotAvatar.sampleMoodPose(11290,"done",11290).jump>1.3f);
    }
    @Test public void everyRearMoodChangeStartsAtTheDisplayedPoseAndSettlesOnItsTarget(){
        String[] moods={"idle","work","wait","done","warn"};
        for(String from:moods)for(String to:moods){
            if(from.equals(to))continue;
            BotAvatar bot=avatar();moodAt(bot,from,0);updateMotionAt(bot,1000);
            BotAvatar.Pose before=displayedPose(bot);Bitmap beforeImage=draw(bot,136);
            moodAt(bot,to,1000);updateMotionAt(bot,1000);
            assertSamePose(from+" -> "+to,before,displayedPose(bot));
            assertTrue("Retargeting must preserve the currently displayed pixels",beforeImage.sameAs(draw(bot,136)));
            updateMotionAt(bot,1001);BotAvatar.Pose first=displayedPose(bot);
            double[] a=channels(before),b=channels(first);
            for(int i=0;i<a.length;i++)assertTrue("Mood entry must ease in",Math.abs(a[i]-b[i])<.01);
            long settled=1000+BotAvatar.MOOD_TRANSITION_MS;updateMotionAt(bot,settled);
            long offset=ReflectionHelpers.getField(bot,"motionOffset");
            assertSamePose("A completed blend must reach the live target",BotAvatar.sampleMoodPose(settled+offset,to,BotAvatar.MOOD_TRANSITION_MS),displayedPose(bot));
            bot.setMotionActive(false);
        }
    }
    @Test public void rapidRearMoodChangesBlendFromTheInProgressPoseWithoutRewinding(){
        BotAvatar bot=avatar();moodAt(bot,"work",0);updateMotionAt(bot,1000);
        long at=1000;
        for(String next:new String[]{"wait","warn","done","idle","work","done"}){
            updateMotionAt(bot,at);BotAvatar.Pose before=displayedPose(bot);
            moodAt(bot,next,at);updateMotionAt(bot,at);
            assertSamePose("Rapid retarget to "+next,before,displayedPose(bot));
            at+=35;
        }
        long blendStarted=ReflectionHelpers.getField(bot,"moodBlendStarted");
        bot.setMood("done");assertEquals("Repeated receipts must not restart an unfinished transition",blendStarted,(long)ReflectionHelpers.getField(bot,"moodBlendStarted"));
        updateMotionAt(bot,at+BotAvatar.MOOD_TRANSITION_MS);
        assertEquals(-1L,(long)ReflectionHelpers.getField(bot,"moodBlendStarted"));bot.setMotionActive(false);
    }
    @Test public void reducedMotionHiddenAndDetachedRearMoodsCancelTransitionsAndObservers(){
        BotAvatar bot=avatar();moodAt(bot,"work",0);updateMotionAt(bot,1000);moodAt(bot,"done",1000);updateMotionAt(bot,1070);
        assertNotNull(animator(bot));setAnimationScale(0f);
        assertNull("A settings notification stops motion without waiting for another frame",animator(bot));
        assertEquals(-1L,(long)ReflectionHelpers.getField(bot,"moodBlendStarted"));
        assertSamePose("Reduced motion resets the full pose",new BotAvatar.Pose(),displayedPose(bot));
        setAnimationScale(1f);assertNotNull("Re-enabling animation while visible resumes allowed motion",animator(bot));
        moodAt(bot,"wait",2000);updateMotionAt(bot,2070);host.setVisibility(View.GONE);
        assertNull(animator(bot));assertEquals(-1L,(long)ReflectionHelpers.getField(bot,"moodBlendStarted"));
        assertSamePose("Hidden moods cannot retain a half-finished transform",new BotAvatar.Pose(),displayedPose(bot));
        host.setVisibility(View.VISIBLE);layout();assertNotNull(animator(bot));
        host.removeView(bot);assertNull(animator(bot));assertFalse((Boolean)ReflectionHelpers.getField(bot,"motionSettingsObserved"));
        setAnimationScale(0f);setAnimationScale(1f);assertNull("A detached view cannot restart from settings changes",animator(bot));
        host.addView(bot,new FrameLayout.LayoutParams(136,136));layout();assertTrue((Boolean)ReflectionHelpers.getField(bot,"motionSettingsObserved"));
        bot.setMotionActive(false);
    }
    @Test public void nativeRearMoodTransitionFramesAreAvailableForVisualReview()throws Exception{
        BotAvatar bot=avatar();ReflectionHelpers.setField(bot,"motionOffset",0L);
        File output=new File(System.getProperty("boujoy.visual.output")),frames=new File(output,"rear-motion-1.0.52");assertTrue(frames.isDirectory()||frames.mkdirs());
        Bitmap contact=Bitmap.createBitmap(680,336,Bitmap.Config.ARGB_8888);Canvas sheet=new Canvas(contact);sheet.drawColor(Color.BLACK);
        Paint labels=new Paint(Paint.ANTI_ALIAS_FLAG);labels.setColor(Color.WHITE);labels.setTextSize(11);
        int[] selected={0,30,45,60,75,90,105,120,150,179};int cell=0;
        for(int number=0;number<180;number++){
            long at=number*1000L/60;
            if(number==0)moodAt(bot,"idle",at);if(number==30)moodAt(bot,"work",at);if(number==60)moodAt(bot,"wait",at);if(number==90)moodAt(bot,"done",at);if(number==144)moodAt(bot,"warn",at);
            updateMotionAt(bot,at);Bitmap frame=NativeVisualTest.capture(bot,String.format(Locale.ROOT,"rear-motion-1.0.52/frame-%04d",number),136,136);
            if(cell<selected.length&&selected[cell]==number){int x=cell%5*136,y=cell/5*168;sheet.drawBitmap(frame,x,y,null);sheet.drawText(at+"ms "+ReflectionHelpers.getField(bot,"mood"),x+6,y+155,labels);cell++;}
        }
        try(FileOutputStream out=new FileOutputStream(new File(output,"rear-motion-1.0.52-contact-sheet.png"))){assertTrue(contact.compress(Bitmap.CompressFormat.PNG,100,out));}
        assertEquals(10,cell);bot.setMotionActive(false);
    }
}
