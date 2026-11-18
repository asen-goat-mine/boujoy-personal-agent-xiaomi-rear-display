package dev.boujoy.personalagent;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.*;
import android.widget.*;

/** Shared native sheet: fixed heading/footer, scrollable content, keyboard-aware height. */
final class UiSheet extends Dialog {
    final LinearLayout shell;
    final ScrollView scroll;
    private final Activity activity;
    private static final int INK=0xff242426,MUTED=0xff8a8a92;
    static int dp(Context c,int value){return Math.round(value*c.getResources().getDisplayMetrics().density);}
    static GradientDrawable surface(Context c,int fill,int radius,int stroke){GradientDrawable d=new GradientDrawable();d.setColor(fill);d.setCornerRadius(dp(c,radius));if(stroke!=0)d.setStroke(dp(c,1),stroke);return d;}
    static LinearLayout column(Context c){LinearLayout v=new LinearLayout(c);v.setOrientation(LinearLayout.VERTICAL);return v;}
    static TextView label(Context c,String value,int size,int color){TextView v=new TextView(c);v.setText(value);v.setTextSize(size);v.setTextColor(color);v.setIncludeFontPadding(false);v.setLineSpacing(dp(c,3),1);return v;}
    static Button button(Context c,String value,Runnable action){Button b=new Button(c);b.setText(value);b.setTextSize(14);b.setAllCaps(false);b.setTextColor(INK);b.setMinHeight(dp(c,44));b.setMinimumHeight(dp(c,44));b.setMinWidth(0);b.setMinimumWidth(0);b.setPadding(dp(c,12),0,dp(c,12),0);b.setStateListAnimator(null);b.setElevation(0);b.setBackgroundTintList(null);b.setBackground(surface(c,Color.WHITE,10,0xffe6e6e9));b.setOnClickListener(v->action.run());return b;}
    static void primary(Context c,Button b){b.setTextColor(Color.WHITE);b.setBackground(surface(c,INK,12,0));}
    static EditText input(Context c,String label){EditText v=new EditText(c);v.setTextSize(15);v.setTextColor(INK);v.setHintTextColor(MUTED);v.setContentDescription(label);v.setGravity(Gravity.TOP|Gravity.START);v.setPadding(dp(c,12),dp(c,12),dp(c,12),dp(c,12));v.setMinimumHeight(dp(c,48));v.setBackground(surface(c,0xfffaf9fc,12,0xffe6e3ec));return v;}
    static LinearLayout actionRow(Context c,String title,String subtitle,Runnable action){
        LinearLayout row=new LinearLayout(c);row.setGravity(Gravity.CENTER_VERTICAL);row.setMinimumHeight(dp(c,56));row.setPadding(dp(c,14),dp(c,12),dp(c,12),dp(c,12));row.setFocusable(true);row.setOnClickListener(v->action.run());row.setBackground(surface(c,Color.WHITE,12,0xffeceaef));
        LinearLayout copy=column(c);TextView name=label(c,title,15,INK);copy.addView(name);if(!subtitle.isBlank()){TextView note=label(c,subtitle,12,MUTED);note.setPadding(0,dp(c,5),0,0);copy.addView(note);}row.addView(copy,new LinearLayout.LayoutParams(0,-2,1));
        UiIcon chevron=new UiIcon(c,"chevron","",()->{});chevron.setInk(MUTED);chevron.setClickable(false);chevron.setFocusable(false);chevron.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(dp(c,18),dp(c,24));p.leftMargin=dp(c,10);row.addView(chevron,p);return row;
    }
    static void spaced(LinearLayout parent,View child,int gap){LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.topMargin=dp(parent.getContext(),gap);parent.addView(child,p);}
    static void section(LinearLayout parent,String title){Context c=parent.getContext();TextView v=label(c,title,12,MUTED);v.setPadding(0,dp(c,22),0,dp(c,10));parent.addView(v);}
    static LinearLayout footer(Context c,Button secondary,Button primary){LinearLayout row=new LinearLayout(c);row.setPadding(dp(c,20),dp(c,12),dp(c,20),dp(c,20));for(Button b:new Button[]{secondary,primary}){b.setMinimumHeight(dp(c,48));LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(0,-2,1);if(b==primary)p.leftMargin=dp(c,10);row.addView(b,p);}return row;}
    UiSheet(Activity activity,String title,View content,View footer){
        super(activity);this.activity=activity;requestWindowFeature(Window.FEATURE_NO_TITLE);
        shell=new LinearLayout(activity){@Override protected void onMeasure(int widthSpec,int heightSpec){int available=MeasureSpec.getMode(heightSpec)==MeasureSpec.UNSPECIFIED?getResources().getDisplayMetrics().heightPixels:MeasureSpec.getSize(heightSpec);int limit=Math.min(available,getResources().getDisplayMetrics().heightPixels-dp(getContext(),48));super.onMeasure(widthSpec,MeasureSpec.makeMeasureSpec(Math.max(1,limit),MeasureSpec.AT_MOST));}};shell.setOrientation(LinearLayout.VERTICAL);shell.setFocusableInTouchMode(true);
        GradientDrawable bg=surface(activity,Color.WHITE,0,0);float corner=dp(activity,24);bg.setCornerRadii(new float[]{corner,corner,corner,corner,0,0,0,0});shell.setBackground(bg);
        View handle=new View(activity);handle.setBackground(surface(activity,0xffe2e1e6,3,0));LinearLayout.LayoutParams hp=new LinearLayout.LayoutParams(dp(activity,38),dp(activity,5));hp.gravity=Gravity.CENTER_HORIZONTAL;hp.topMargin=dp(activity,8);shell.addView(handle,hp);
        LinearLayout heading=new LinearLayout(activity);heading.setGravity(Gravity.CENTER_VERTICAL);heading.setPadding(dp(activity,20),dp(activity,6),dp(activity,10),dp(activity,6));TextView name=label(activity,title,18,INK);name.setTypeface(Typeface.create(Typeface.DEFAULT,600,false));heading.addView(name,new LinearLayout.LayoutParams(0,-2,1));UiIcon close=new UiIcon(activity,"close","关闭"+title,this::dismiss);heading.addView(close,new LinearLayout.LayoutParams(dp(activity,44),dp(activity,44)));shell.addView(heading);
        View divider=new View(activity);divider.setBackgroundColor(0xffefedf2);shell.addView(divider,new LinearLayout.LayoutParams(-1,dp(activity,1)));
        scroll=new ScrollView(activity);scroll.setClipToPadding(false);scroll.setFillViewport(false);scroll.addView(content);shell.addView(scroll,new LinearLayout.LayoutParams(-1,-2,1));if(footer!=null)shell.addView(footer);setContentView(shell);shell.requestFocus();
        Window w=getWindow();if(w!=null){w.setBackgroundDrawableResource(android.R.color.transparent);w.setDimAmount(.18f);w.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);w.setGravity(Gravity.BOTTOM);w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE|WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);}
    }
    @Override public void show(){super.show();Window w=getWindow();if(w!=null)w.setLayout(Math.min(activity.getResources().getDisplayMetrics().widthPixels,dp(activity,560)),WindowManager.LayoutParams.WRAP_CONTENT);}
}
