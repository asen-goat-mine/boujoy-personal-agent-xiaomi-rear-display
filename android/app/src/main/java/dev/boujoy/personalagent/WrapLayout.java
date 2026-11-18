package dev.boujoy.personalagent;

import android.content.Context;
import android.view.View;
import android.view.ViewGroup;

/** Keeps complete controls on a new row when screen width or font scale changes. */
public final class WrapLayout extends ViewGroup {
    private final int gap;
    public WrapLayout(Context context){this(context,0);}
    WrapLayout(Context context,int gap){super(context);this.gap=gap;}
    @Override protected LayoutParams generateDefaultLayoutParams(){return new LayoutParams(LayoutParams.WRAP_CONTENT,LayoutParams.WRAP_CONTENT);}
    @Override protected void onMeasure(int widthSpec,int heightSpec){
        int available=MeasureSpec.getMode(widthSpec)==MeasureSpec.UNSPECIFIED?Integer.MAX_VALUE:Math.max(0,MeasureSpec.getSize(widthSpec)-getPaddingLeft()-getPaddingRight());
        int x=0,y=0,rowHeight=0,used=0,state=0;
        for(int i=0;i<getChildCount();i++){View child=getChildAt(i);if(child.getVisibility()==GONE)continue;measureChild(child,widthSpec,heightSpec);int w=child.getMeasuredWidth(),h=child.getMeasuredHeight();if(x>0&&x+gap+w>available){used=Math.max(used,x);y+=rowHeight+gap;x=0;rowHeight=0;}if(x>0)x+=gap;x+=w;rowHeight=Math.max(rowHeight,h);state=combineMeasuredStates(state,child.getMeasuredState());}
        used=Math.max(used,x);setMeasuredDimension(resolveSizeAndState(used+getPaddingLeft()+getPaddingRight(),widthSpec,state),resolveSizeAndState(y+rowHeight+getPaddingTop()+getPaddingBottom(),heightSpec,state<<MEASURED_HEIGHT_STATE_SHIFT));
    }
    @Override protected void onLayout(boolean changed,int left,int top,int right,int bottom){
        int available=right-left-getPaddingLeft()-getPaddingRight(),x=0,y=getPaddingTop(),rowHeight=0;
        for(int i=0;i<getChildCount();i++){View child=getChildAt(i);if(child.getVisibility()==GONE)continue;int w=child.getMeasuredWidth(),h=child.getMeasuredHeight();if(x>0&&x+gap+w>available){y+=rowHeight+gap;x=0;rowHeight=0;}if(x>0)x+=gap;int start=getLayoutDirection()==LAYOUT_DIRECTION_RTL?right-left-getPaddingRight()-x-w:getPaddingLeft()+x;child.layout(start,y,start+w,y+h);x+=w;rowHeight=Math.max(rowHeight,h);}
    }
}
