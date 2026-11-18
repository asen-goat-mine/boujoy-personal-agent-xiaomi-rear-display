package dev.boujoy.personalagent;
import android.content.Context;
import android.graphics.*;
import android.view.View;

/** Small native line icons with a full 44 dp touch target. */
public final class UiIcon extends View {
    private final Path linePath=new Path(),attachmentPath=new Path(),gearPath=new Path();
    public UiIcon(Context c){this(c,"menu","菜单",()->{});}
    private final String icon;private final Paint p=new Paint(Paint.ANTI_ALIAS_FLAG);private int color=0xff3a3a40;
    public UiIcon(Context c,String icon,String label,Runnable action){super(c);this.icon=icon;setContentDescription(label);setFocusable(true);for(int i=0;i<8;i++){for(int j=0;j<6;j++){double a=Math.toRadians(i*45+new float[]{-22.5f,-15,-12,12,15,22.5f}[j]);float r=(j==2||j==3)?10.5f:8f,x=12+(float)Math.cos(a)*r,y=12+(float)Math.sin(a)*r;if(i==0&&j==0)gearPath.moveTo(x,y);else gearPath.lineTo(x,y);}}gearPath.close();setOnClickListener(v->action.run());}
    public void setInk(int value){color=value;invalidate();}
    private void line(Canvas c,float...xy){Path path=linePath;path.reset();path.moveTo(xy[0],xy[1]);for(int n=2;n<xy.length;n+=2)path.lineTo(xy[n],xy[n+1]);c.drawPath(path,p);}
    @Override protected void onDraw(Canvas c){super.onDraw(c);float d=getResources().getDisplayMetrics().density;float iconSize=switch(icon){case "search","close","help"->18;case "chevron"->13;case "plus","attach"->21;case "send"->19;default->20;};float s=Math.min(iconSize*d,Math.min(getWidth(),getHeight()))/24;c.save();c.translate((getWidth()-24*s)/2,(getHeight()-24*s)/2);c.scale(s,s);p.setColor(color);p.setStyle(Paint.Style.STROKE);p.setStrokeWidth(switch(icon){case "search","close"->1.9f;case "send"->2f;case "menu"->1.8f;default->1.7f;});p.setStrokeCap(Paint.Cap.ROUND);p.setStrokeJoin(Paint.Join.ROUND);
        switch(icon){
            case "send"->{line(c,12,19,12,5);line(c,6,11,12,5,18,11);}
            case "menu"->{line(c,4,6,20,6);line(c,4,12,20,12);line(c,4,18,20,18);}
            case "plus"->{line(c,12,5,12,19);line(c,5,12,19,12);}
            case "close"->{line(c,6,6,18,18);line(c,6,18,18,6);}
            case "search"->{c.drawCircle(10.5f,10.5f,6.5f,p);line(c,16,16,21,21);}
            case "mic"->{c.drawRoundRect(9,3,15,14,3,3,p);c.drawArc(5,5,19,19,0,180,false,p);line(c,12,19,12,22);}
            case "attach"->{Path q=attachmentPath;q.reset();q.moveTo(16,7);q.lineTo(8,15);q.cubicTo(5,18,8,21,11,18);q.lineTo(19,10);q.cubicTo(24,5,17,-1,12,4);q.lineTo(4,12);q.cubicTo(-3,19,6,27,13,20);q.lineTo(21,12);c.drawPath(q,p);}
            case "chevron"->{line(c,9,5,16,12,9,19);}
            case "help"->{c.drawCircle(12,12,9,p);Path q=attachmentPath;q.reset();q.moveTo(9.5f,9.5f);q.cubicTo(9.5f,6.2f,16,6.2f,14.7f,10.5f);q.cubicTo(14.3f,11.8f,12,11.5f,12,14);c.drawPath(q,p);c.drawPoint(12,17,p);}
            case "history"->{c.drawCircle(12,12,8,p);line(c,12,7,12,12,16,14);}
            case "settings"->{c.drawCircle(12,12,3,p);c.drawPath(gearPath,p);}
            default->{c.drawCircle(12,5,1,p);c.drawCircle(12,12,1,p);c.drawCircle(12,19,1,p);}
        }c.restore();
    }
}
