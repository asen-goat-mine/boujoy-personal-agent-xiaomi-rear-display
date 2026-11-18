package dev.boujoy.personalagent;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.os.SystemClock;
import android.view.View;

/**
 * Small pixel effects for the rear display. No backgrounds: everything sits on the
 * original pure-black page, drawn on a whole-pixel grid with anti-aliasing off.
 * Time comes from SystemClock.uptimeMillis(), so a frozen clock (tests) draws one frame.
 */
final class RearPixelArt {
    private RearPixelArt() {}

    /** idle, work, wait, done, warn */
    static String moodOf(String status) {
        if (status == null) return "idle";
        return switch (status) {
            case "queued", "running", "waiting_children" -> "work";
            case "waiting_approval", "waiting_consent", "ready_for_user", "needs_input", "waiting_user", "waiting_setup", "blocked" -> "wait";
            case "completed", "succeeded" -> "done";
            case "failed", "unknown_result", "expired" -> "warn";
            default -> "idle";
        };
    }
    static int alpha(int color, int alpha) { return (color & 0x00ffffff) | (Math.max(0, Math.min(255, alpha)) << 24); }
    static boolean animationsOn() { return ValueAnimator.areAnimatorsEnabled(); }

    /** Draws a small bitmap glyph: rows of '#' characters, one cell = unit pixels. */
    static void glyph(Canvas canvas, Paint paint, String[] rows, float left, float top, float unit) {
        for (int y = 0; y < rows.length; y++) for (int x = 0; x < rows[y].length(); x++)
            if (rows[y].charAt(x) == '#') canvas.drawRect(left + x * unit, top + y * unit, left + (x + 1) * unit, top + (y + 1) * unit, paint);
    }
    static final String[] HEART = {".#.#.", "#####", "#####", ".###.", "..#.."};
    static final String[] BANG = {"##", "##", "##", "##", "..", "##"};
    static final String[] ASK = {".###.", "#...#", "...#.", "..#..", ".....", "..#.."};
    static final String[] SLEEP_Z = {"####", "..#.", ".#..", "####"};
    static final String[] SPARK = {".#.", "###", ".#."};

    /** A thin dotted pixel rule between the task title and its steps. */
    static final class Rule extends View {
        private final Paint paint = new Paint();
        Rule(Context context) { super(context); paint.setAntiAlias(false); paint.setColor(0xff3a3a3a); setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO); }
        @Override protected void onDraw(Canvas canvas) {
            float u = Math.max(2, (float) Math.floor(getResources().getDisplayMetrics().density)), h = getHeight();
            for (float x = 0; x + u <= getWidth(); x += u * 3) canvas.drawRect(x, 0, x + u * 2, Math.min(h, u), paint);
        }
    }

    /**
     * Drawn over the robot's own square: mood particles in the corners and above the head,
     * never across the face. Only moves while the robot itself is allowed to move.
     */
    static final class Effects extends View {
        private final Paint paint = new Paint();
        private String mood = "idle";
        private int tint = Color.WHITE;
        private boolean active;
        private long moodAt = SystemClock.uptimeMillis();
        private long frameTime = moodAt;
        private boolean systemMotionEnabled = true, motionSettingsObserved;
        private final android.database.ContentObserver motionSettingsObserver = new android.database.ContentObserver(new android.os.Handler(android.os.Looper.getMainLooper())) {
            @Override public void onChange(boolean selfChange) { refreshMotionSetting(); }
        };
        private void refreshMotionSetting() {
            systemMotionEnabled = android.provider.Settings.Global.getFloat(getContext().getContentResolver(), android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f;
            invalidate();
        }
        Effects(Context context) { super(context); paint.setAntiAlias(false); setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO); setClickable(false); }
        void set(String value, int color, boolean moving) {
            String next = value == null ? "idle" : value;
            boolean changed = !next.equals(mood) || color != tint || moving != active;
            if (!next.equals(mood)) moodAt = SystemClock.uptimeMillis();
            mood = next; tint = color; active = moving;
            if (changed) { frameTime = SystemClock.uptimeMillis(); invalidate(); }
        }
        @Override protected void onDraw(Canvas canvas) {
            float w = getWidth(), h = getHeight(); if (w < 24 || h < 24) return;
            float u = Math.max(2, (float) Math.floor(w / 40));
            boolean moving = active && systemMotionEnabled && animationsOn() && isAttachedToWindow() && isShown() && getWindowVisibility() == VISIBLE;
            if (moving) frameTime = SystemClock.uptimeMillis();
            long now = frameTime, since = Math.max(0, now - moodAt);
            int light = 0xfff5efdc;
            switch (mood) {
                case "work" -> {
                    // Typing dots by the head (clear of the antenna), then small sparks drifting up the sides.
                    for (int i = 0; i < 3; i++) {
                        paint.setColor(alpha(Color.WHITE, Math.round(85 + 170 * wave(now - i * 260L, 1040))));
                        canvas.drawRect(u * 3 + i * u * 2.5f, u * 4, u * 3 + i * u * 2.5f + u * 1.5f, u * 5.5f, paint);
                    }
                    for (int i = 0; i < 4; i++) {
                        float p = ((now + i * 650) % 2600) / 2600f, x = i % 2 == 0 ? u * (1 + i) : w - u * (2 + i);
                        paint.setColor(alpha(i % 2 == 0 ? tint : light, particleAlpha(p, 230)));
                        canvas.drawRect(x, h * .82f - p * h * .55f, x + u, h * .82f - p * h * .55f + u, paint);
                    }
                }
                case "wait" -> {
                    float bounce = u * wave(now, 600);
                    paint.setColor(Color.WHITE); glyph(canvas, paint, BANG, u * 4, u * 2 + bounce, u * 1.2f);
                }
                case "done" -> {
                    for (int i = 0; i < 4; i++) {
                        float p = ((since + i * 520) % 2080) / 2080f;
                        float x = i % 2 == 0 ? u * (1 + i) : w - u * (6 + i);
                        paint.setColor(alpha(i == 1 ? 0xffff7aa2 : i == 3 ? tint : light, particleAlpha(p, 255)));
                        glyph(canvas, paint, i == 1 ? HEART : SPARK, x, h * .55f - p * h * .45f, u);
                    }
                }
                case "warn" -> {
                    paint.setColor(alpha(Color.WHITE, Math.round(119 + 136 * wave(now, 900))));
                    glyph(canvas, paint, ASK, u * 3, u * 2, u * 1.1f);
                }
                default -> {
                    for (int i = 0; i < 2; i++) {
                        float p = ((now + i * 1600) % 3200) / 3200f;
                        paint.setColor(alpha(Color.WHITE, particleAlpha(p, 200)));
                        glyph(canvas, paint, SLEEP_Z, u * 3 + p * u * 3, u * 9 - p * u * 5, u * (i == 0 ? 1.2f : .8f));
                    }
                }
            }
            // Share the display frame cadence with the avatar; a 90ms timer made the
            // particles visibly stutter even when the robot was drawing smoothly.
            if (moving) postInvalidateOnAnimation();
        }
        @Override protected void onAttachedToWindow() {
            super.onAttachedToWindow();
            getContext().getContentResolver().registerContentObserver(android.provider.Settings.Global.getUriFor(android.provider.Settings.Global.ANIMATOR_DURATION_SCALE), false, motionSettingsObserver);
            motionSettingsObserved = true; refreshMotionSetting();
        }
        @Override protected void onDetachedFromWindow() {
            if (motionSettingsObserved) { getContext().getContentResolver().unregisterContentObserver(motionSettingsObserver); motionSettingsObserved = false; }
            super.onDetachedFromWindow();
        }
        private static float wave(long time, long period) {
            return (float) (.5 - .5 * Math.cos(Math.floorMod(time, period) * Math.PI * 2 / period));
        }
        private static int particleAlpha(float phase, int peak) {
            // Fade in at the spawn point so wrapping particles never pop into view.
            return Math.round(peak * Math.min(1f, phase / .12f) * (1 - phase));
        }
        @Override protected void onWindowVisibilityChanged(int visibility) { super.onWindowVisibilityChanged(visibility); if (visibility == VISIBLE) invalidate(); }
        @Override public void onVisibilityAggregated(boolean visible) { super.onVisibilityAggregated(visible); if (visible) invalidate(); }
    }
}
