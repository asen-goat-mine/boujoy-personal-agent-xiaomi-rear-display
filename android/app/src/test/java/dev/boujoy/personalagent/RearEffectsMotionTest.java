package dev.boujoy.personalagent;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.SystemClock;
import android.os.Looper;
import android.provider.Settings;
import org.robolectric.Shadows;
import android.view.View;
import android.widget.FrameLayout;
import java.time.Duration;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import org.robolectric.shadows.ShadowSystemClock;
import static org.junit.Assert.*;

/** Rendered motion boundaries and lifecycle, not only the effect's numeric formula. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=35, qualifiers="w390dp-h844dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class RearEffectsMotionTest {
    private ActivityController<Activity> controller;
    private FrameLayout host;
    private RearPixelArt.Effects effects;

    @Before public void setup() {
        controller=Robolectric.buildActivity(Activity.class).setup().visible();
        Activity activity=controller.get(); host=new FrameLayout(activity); activity.setContentView(host);
        effects=new RearPixelArt.Effects(activity); host.addView(effects,new FrameLayout.LayoutParams(136,136));
        host.measure(View.MeasureSpec.makeMeasureSpec(390,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(844,View.MeasureSpec.EXACTLY));
        host.layout(0,0,390,844);
    }
    @After public void cleanup() { animationScale(1f); controller.pause().stop().destroy(); }
    private void animationScale(float value) {
        Activity activity=controller.get();
        Settings.Global.putFloat(activity.getContentResolver(),Settings.Global.ANIMATOR_DURATION_SCALE,value);
        activity.getContentResolver().notifyChange(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE),null);
        Shadows.shadowOf(Looper.getMainLooper()).idle();
    }
    private Bitmap draw() {
        Bitmap result=Bitmap.createBitmap(136,136,Bitmap.Config.ARGB_8888);
        effects.draw(new Canvas(result)); return result;
    }
    private static void advance(long millis) { ShadowSystemClock.advanceBy(Duration.ofMillis(millis)); }
    private static double[] mass(Bitmap image) {
        double total=0,yMass=0;
        for(int y=0;y<image.getHeight();y++)for(int x=0;x<image.getWidth();x++) {
            int alpha=Color.alpha(image.getPixel(x,y)); total+=alpha; yMass+=alpha*y;
        }
        assertTrue(total>0); return new double[]{total,yMass/total};
    }
    private static void beforeBoundary(long boundary,long period) {
        long now=SystemClock.uptimeMillis();
        advance(Math.floorMod(boundary-1-now,period));
    }

    @Test public void inactiveEffectsStayStillEvenWhenTheirParentRedraws() {
        effects.set("work",Color.WHITE,true); Bitmap first=draw(); advance(80);
        assertFalse("Active particles must move",first.sameAs(draw()));
        effects.set("work",Color.WHITE,false); Bitmap stopped=draw(); advance(340);
        assertTrue("Unrelated parent draws must not animate disabled effects",stopped.sameAs(draw()));
        effects.set("work",Color.WHITE,true); Bitmap resumed=draw(); advance(80);
        assertFalse("Effects resume when motion is allowed again",resumed.sameAs(draw()));
    }
    @Test public void hiddenEffectsFreezeAndResumeWithTheirParent() {
        effects.set("work",Color.WHITE,true); draw(); host.setVisibility(View.GONE);
        Bitmap hidden=draw(); advance(400); assertTrue(hidden.sameAs(draw()));
        host.setVisibility(View.VISIBLE); Bitmap resumed=draw(); advance(80);
        assertFalse(resumed.sameAs(draw()));
    }
    @Test public void systemReducedMotionFreezesAndReenablesVisibleEffects() {
        effects.set("work",Color.WHITE,true); draw(); animationScale(0f);
        Bitmap reduced=draw(); advance(400); assertTrue(reduced.sameAs(draw()));
        animationScale(1f); Bitmap resumed=draw(); advance(80);
        assertFalse("Re-enabling system animations resumes effects without rebinding the mood",resumed.sameAs(draw()));
        host.removeView(effects); Bitmap detached=draw(); animationScale(0f); animationScale(1f); advance(300);
        assertTrue("Detached effects stay still after setting changes",detached.sameAs(draw()));
    }
    @Test public void waitingGlyphDoesNotTeleportAtTheOldThreeHundredMillisecondBoundary() {
        effects.set("wait",Color.WHITE,true); beforeBoundary(300,600);
        double[] before=mass(draw()); advance(2); double[] after=mass(draw());
        assertTrue("The exclamation mark must move continuously",Math.abs(after[1]-before[1])<.5);
    }
    @Test public void warningGlyphDoesNotFlashAtTheOldFourHundredFiftyMillisecondBoundary() {
        effects.set("warn",Color.WHITE,true); beforeBoundary(450,900);
        double[] before=mass(draw()); advance(2); double[] after=mass(draw());
        assertTrue("Warning brightness must blend rather than switch abruptly",Math.abs(after[0]-before[0])/before[0]<.03);
    }
}
