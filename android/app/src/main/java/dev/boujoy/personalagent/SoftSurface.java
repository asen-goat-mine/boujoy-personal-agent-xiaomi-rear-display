package dev.boujoy.personalagent;
import android.content.Context;
import android.graphics.*;
import android.graphics.drawable.Drawable;
/** Draws the reference's soft CSS-like shadow in native and host-rendered Views. */
final class SoftSurface extends Drawable {
    private final Paint fill=new Paint(Paint.ANTI_ALIAS_FLAG),edge=new Paint(Paint.ANTI_ALIAS_FLAG),shadow=new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF frame=new RectF(),outline=new RectF();private final float radius,density;private final int top,bottom;
    SoftSurface(Context context,float radius,int top,int bottom,int border,float blur,float offset,int shadowColor){density=context.getResources().getDisplayMetrics().density;this.radius=radius*density;this.top=top;this.bottom=bottom;edge.setColor(border);edge.setStyle(Paint.Style.STROKE);edge.setStrokeWidth(density);shadow.setColor(Color.WHITE);shadow.setShadowLayer(blur*density,0,offset*density,shadowColor);}
    @Override protected void onBoundsChange(Rect bounds){frame.set(bounds);outline.set(frame);outline.inset(density/2,density/2);fill.setShader(new LinearGradient(0,bounds.top,0,bounds.bottom,top,bottom,Shader.TileMode.CLAMP));}
    @Override public void draw(Canvas canvas){canvas.drawRoundRect(frame,radius,radius,shadow);canvas.drawRoundRect(frame,radius,radius,fill);canvas.drawRoundRect(outline,radius,radius,edge);}
    @Override public void setAlpha(int alpha){fill.setAlpha(alpha);edge.setAlpha(alpha);shadow.setAlpha(alpha);invalidateSelf();}
    @Override public void setColorFilter(ColorFilter filter){fill.setColorFilter(filter);invalidateSelf();}
    @Override public int getOpacity(){return PixelFormat.TRANSLUCENT;}
}
