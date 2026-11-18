package dev.boujoy.personalagent;

import android.content.Context;
import android.view.*;
import android.widget.ScrollView;
import java.util.*;

/** Restore only after measurement: keyboard/row resizing must not use yesterday's geometry. */
final class ConversationScrollView extends ScrollView {
    private ChatScrollAnchor pending;
    private int previousViewportHeight;
    private boolean laidOut,touchActive;
    private Runnable onTouchFinished;
    ConversationScrollView(Context context){super(context);}
    private List<ChatScrollAnchor.Item> positions(){
        List<ChatScrollAnchor.Item> rows=new ArrayList<>();
        if(getChildCount()>0&&getChildAt(0) instanceof ViewGroup group)for(int i=0;i<group.getChildCount();i++){
            View child=group.getChildAt(i);rows.add(new ChatScrollAnchor.Item(String.valueOf(child.getTag()),child.getTop(),child.getBottom()));
        }
        return rows;
    }
    private int contentHeight(){return getChildCount()==0?0:getChildAt(0).getHeight();}
    private int viewportHeight(){return Math.max(0,getHeight()-getPaddingTop()-getPaddingBottom());}
    private ChatScrollAnchor capture(){return ChatScrollAnchor.capture(positions(),getScrollY(),contentHeight(),laidOut?previousViewportHeight:viewportHeight(),UiSheet.dp(getContext(),48));}
    boolean isNearBottom(){return ChatScrollAnchor.nearBottom(getScrollY(),contentHeight(),viewportHeight(),UiSheet.dp(getContext(),48));}
    boolean isTouchActive(){return touchActive;}
    void setOnTouchFinishedListener(Runnable listener){onTouchFinished=listener;}
    void preserve(boolean follow){
        // A row update must not queue a jump while a child button or drag owns the gesture.
        if(touchActive){pending=null;return;}
        if(follow)pending=new ChatScrollAnchor(null,0,0,true);
        else if(pending==null)pending=capture();
        requestLayout();
    }
    @Override protected void onLayout(boolean changed,int l,int t,int r,int b){
        ChatScrollAnchor anchor=touchActive?null:pending==null?capture():pending;pending=null;
        super.onLayout(changed,l,t,r,b);
        if(anchor!=null)scrollTo(0,anchor.restore(positions(),contentHeight(),viewportHeight()));
        previousViewportHeight=viewportHeight();laidOut=true;
    }
    @Override public boolean dispatchTouchEvent(MotionEvent event){
        int action=event.getActionMasked();
        if(action==MotionEvent.ACTION_DOWN){touchActive=true;pending=null;}
        boolean handled=false;
        try {handled=super.dispatchTouchEvent(event);return handled;}
        finally {
            if(action==MotionEvent.ACTION_UP||action==MotionEvent.ACTION_CANCEL||action==MotionEvent.ACTION_DOWN&&!handled){
                boolean finished=touchActive;touchActive=false;
                // Dispatch is complete, but a child may have posted its click. Callers must post row updates.
                if(finished&&onTouchFinished!=null)onTouchFinished.run();
            }
        }
    }
    @Override protected void onDetachedFromWindow(){touchActive=false;pending=null;super.onDetachedFromWindow();}
}
