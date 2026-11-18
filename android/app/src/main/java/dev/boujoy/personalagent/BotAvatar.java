package dev.boujoy.personalagent;

import android.content.Context;
import android.graphics.*;
import android.view.View;
import java.util.Random;

/** Original artwork with quiet, intermittent gestures; task feedback uses confirmed state transitions. */
public final class BotAvatar extends View {
    // Same twelve colors as the Mac app, so every bot keeps its color on both screens.
    public static final String[] COLORS={"violet","amber","green","blue","pink","coral","teal","silver","gold","sky","orchid","lime"};
    public static final String[] LABELS={"紫晶","暖橙","翠绿","海蓝","莓粉","珊瑚红","湖绿","银灰","柠黄","天青","兰紫","青柠"};
    private static final int[] TINTS={0xff7e64c4,0xffd06a2c,0xff3d9443,0xff3f74cc,0xffc25290,0xffcf4f55,0xff169a8a,0xff85858f,0xffb59410,0xff1f9cc6,0xffa457b8,0xff6f9a1c};
    private static final android.util.SparseArray<Bitmap> ART=new android.util.SparseArray<>();
    private static final int[] EYE_X={108,148};
    private static final android.util.SparseArray<Bitmap> FACE_ART=new android.util.SparseArray<>();
    private static final RectF FACE_BOUNDS=new RectF(100,154,168,194);
    // Pixel-art coordinates stay 256x256 even when a cached bitmap crosses main/rear display densities.
    private static final RectF ART_BOUNDS=new RectF(0,0,256,256);
    private static final Shader GROUND=new RadialGradient(0,0,100,0x30241c30,0x00241c30,Shader.TileMode.CLAMP);
    private static final Shader FACE=new LinearGradient(100,154,168,194,0xfff5efdc,0xffe5dcc7,Shader.TileMode.CLAMP);
    private final Paint paint=new Paint();private final Bitmap head,cleanFace;private final int eyeInk;
    private final Rect eyeSource=new Rect();private final RectF eyeDestination=new RectF();
    private final int tint;private int expression;private boolean breathe,sway=true,groundShadow=true,motionActive=true;
    private android.animation.ValueAnimator idle;
    private final Random random=new Random();
    private final long motionOffset=random.nextInt(60_000);
    private final Rect visibleBounds=new Rect();
    private float bob,look,blink,jump,tilt,happy;
    private float scaleX=1,scaleY=1,leftEyeOpen=1,rightEyeOpen=1;
    private final Pose motionPose=new Pose();
    static final long CELEBRATION_MS=1000;
    private static final long GESTURE_PERIOD_MS=20_000;
    /** Pure pose coordinates use the original 256px artwork, never View transforms. */
    static final class Pose {
        float bob,look,blink,jump,tilt,happy;
        float scaleX=1,scaleY=1,leftEyeOpen=1,rightEyeOpen=1;
        String gesture="rest";
    }
    private long celebrationStarted=-1;
    private String observedTask="",observedStatus="";
    private boolean observedAllowed,working;
    /** Rear-only: when set, the pose follows the task mood instead of the quiet list gestures. */
    private String mood;private long moodSince;
    static final long MOOD_TRANSITION_MS=280;
    static final long DONE_FAST_END_MS=7000;
    private final Pose moodFrom=new Pose();
    private long moodBlendStarted=-1;
    private boolean systemMotionEnabled=true,motionSettingsObserved;
    private final android.database.ContentObserver motionSettingsObserver=new android.database.ContentObserver(new android.os.Handler(android.os.Looper.getMainLooper())){
        @Override public void onChange(boolean selfChange){refreshMotion();}
    };
    private final android.view.ViewTreeObserver.OnScrollChangedListener viewportChanged=this::refreshMotion;
    private final Runnable reset=()->{expression=0;invalidate();};
    /** A soft tint of the bot's color for badges behind it. */
    public static int soft(String key){int c=color(key);float k=.86f;return Color.rgb(Math.round(Color.red(c)+(255-Color.red(c))*k),Math.round(Color.green(c)+(255-Color.green(c))*k),Math.round(Color.blue(c)+(255-Color.blue(c))*k));}
    public static int color(String key){for(int i=0;i<COLORS.length;i++)if(COLORS[i].equals(key))return TINTS[i];return TINTS[0];}
    public BotAvatar(Context context){this(context,"violet");}
    public BotAvatar(Context context,String color){
        super(context);tint=color(color);
        int resource=switch(color==null?"":color){case "green"->R.drawable.robot_green;case "teal"->R.drawable.robot_teal;case "amber"->R.drawable.robot_amber;case "pink"->R.drawable.robot_pink;case "silver"->R.drawable.robot_silver;case "blue"->R.drawable.robot_blue;case "coral"->R.drawable.robot_coral;case "gold"->R.drawable.robot_gold;case "sky"->R.drawable.robot_sky;case "orchid"->R.drawable.robot_orchid;case "lime"->R.drawable.robot_lime;default->R.drawable.robot_violet;};
        Bitmap cached=ART.get(resource);if(cached==null){BitmapFactory.Options options=new BitmapFactory.Options();options.inScaled=false;cached=BitmapFactory.decodeResource(getResources(),resource,options);ART.put(resource,cached);}head=cached;
        eyeInk=head.getPixel(110,168);
        Bitmap face=FACE_ART.get(resource);
        if(face==null){
            // Keep every original face pixel except the two eye rectangles. The neutral
            // pose draws those exact pixels back; blinking never swaps to a flat-color face.
            int[] pixels=new int[68*40];head.getPixels(pixels,0,68,100,154,68,40);
            for(int y=160;y<188;y++)for(int i=0;i<EYE_X.length;i++){
                int background=head.getPixel(EYE_X[i]-4,y);
                for(int x=EYE_X[i];x<EYE_X[i]+12;x++)pixels[(y-154)*68+x-100]=background;
            }
            face=Bitmap.createBitmap(68,40,Bitmap.Config.ARGB_8888);face.setPixels(pixels,0,68,0,0,68,40);FACE_ART.put(resource,face);
        }
        cleanFace=face;
        setContentDescription("轻触机器人切换表情");setOnClickListener(v->{expression=1+random.nextInt(3);removeCallbacks(reset);postDelayed(reset,1400);invalidate();});
    }
    private void rect(Canvas c,float x,float y,float w,float h,int color){paint.setColor(color);c.drawRect(x,y,x+w,y+h,paint);}
    @Override protected void onDraw(Canvas canvas){
        super.onDraw(canvas);float scale=Math.min(getWidth(),getHeight())/256f;
        canvas.save();canvas.translate((getWidth()-256*scale)/2,(getHeight()-256*scale)/2);canvas.scale(scale,scale);
        // The rear portrait deliberately does not clip children, so keep even the existing
        // soft list shadow inside this View. The artwork itself is fitted before drawing.
        canvas.clipRect(0,0,256,256);
        if(groundShadow){paint.setAntiAlias(true);paint.setColor(Color.WHITE);paint.setShader(GROUND);canvas.save();canvas.translate(128,244);canvas.scale(1-.12f*jump,.15f);canvas.drawCircle(0,0,100,paint);canvas.restore();paint.setShader(null);}
        // All twelve PNGs have alpha bounds (16,16)-(240,240). Fit the complete rotated,
        // scaled drawing into (4,4)-(252,252), rather than cropping the flag at a hop peak.
        float base=breathe?.96f:1f,sx=scaleX*base,sy=scaleY*base;
        float angle=sway||mood!=null||moodBlendStarted>=0?tilt:0,cos=(float)Math.cos(Math.toRadians(angle)),sin=(float)Math.sin(Math.toRadians(angle));
        float centerX=128+64*sy*sin,centerY=192-64*sy*cos;
        float halfX=112*(Math.abs(cos)*sx+Math.abs(sin)*sy);
        float halfY=112*(Math.abs(sin)*sx+Math.abs(cos)*sy);
        float x=clamp(look*6,4-centerX+halfX,252-centerX-halfX);
        float y=clamp(bob-jump*10,4-centerY+halfY,252-centerY-halfY);
        canvas.save();canvas.translate(x,y);canvas.rotate(angle,128,192);canvas.scale(sx,sy,128,192);
        paint.setAntiAlias(false);paint.setFilterBitmap(false);paint.setAlpha(255);canvas.drawBitmap(head,null,ART_BOUNDS,paint);
        if(expression!=0){
            paint.setShader(FACE);paint.setColor(Color.WHITE);canvas.drawRect(100,154,168,194,paint);paint.setShader(null);
            for(int eye:EYE_X){
                if(expression==1){rect(canvas,eye,168,16,4,tint);rect(canvas,eye-4,172,4,8,tint);rect(canvas,eye+16,172,4,8,tint);}
                else if(expression==2){rect(canvas,eye+4,156,8,28,tint);rect(canvas,eye-4,166,24,8,tint);}
                else if(expression==3)rect(canvas,eye,172,16,8,tint);
            }
        }else{
            canvas.drawBitmap(cleanFace,null,FACE_BOUNDS,paint);
            for(int i=0;i<EYE_X.length;i++){
                float openness=Math.min(1-blink,i==0?leftEyeOpen:rightEyeOpen);
                float height=Math.max(2,28*openness*(1-happy)+4*happy);
                // Three original four-pixel columns bend gently into a smile. Nearest
                // sampling retains their highlights; no threshold swaps eye shapes.
                for(int column=0;column<3;column++){
                    int left=EYE_X[i]+column*4;
                    float eyeLeft=left+look*5,eyeTop=174-height/2+happy*(column==1?-3:1);
                    eyeSource.set(left,160,left+4,188);eyeDestination.set(eyeLeft,eyeTop,eyeLeft+4,eyeTop+height);
                    canvas.drawBitmap(head,eyeSource,eyeDestination,paint);
                }
            }
        }
        rect(canvas,92,184,12,6,0xd9f2a7b6);rect(canvas,164,184,12,6,0xd9f2a7b6);canvas.restore();canvas.restore();
    }
    /** Bare artwork for the rear display; list avatars keep their existing shadow. */
    public BotAvatar withoutGroundShadow(){groundShadow=false;invalidate();return this;}
    /** Level artwork for the header/rear; it may look around without rotating. */
    public BotAvatar breathingLevel(){sway=false;return breathing();}
    public BotAvatar breathing(){breathe=true;refreshMotion();return this;}
    /** A disabled presentation consumes transitions but never queues a celebration for later. */
    public void taskMotion(String taskId,String status,boolean allowed){
        String nextTask=taskId==null?"":taskId,nextStatus=status==null?"":status;
        boolean celebrate=allowed&&observedAllowed&&!nextTask.isBlank()&&nextTask.equals(observedTask)
                &&isWorking(observedStatus)&&("completed".equals(nextStatus)||"succeeded".equals(nextStatus));
        if(!nextTask.equals(observedTask)||!("completed".equals(nextStatus)||"succeeded".equals(nextStatus)))celebrationStarted=-1;
        observedTask=nextTask;observedStatus=nextStatus;observedAllowed=allowed;
        working=isWorking(nextStatus);breathe=true;motionActive=allowed;
        if(celebrate&&motionVisible()&&animationsEnabled())celebrationStarted=android.os.SystemClock.uptimeMillis();
        if(!allowed)celebrationStarted=-1;
        refreshMotion();
    }
    private static boolean isWorking(String status){return "running".equals(status)||"waiting_children".equals(status);}
    void setMotionActive(boolean value){motionActive=value;if(!value)celebrationStarted=-1;refreshMotion();}
    private boolean animationsEnabled(){
        return android.animation.ValueAnimator.areAnimatorsEnabled()&&systemMotionEnabled;
    }
    private boolean motionVisible(){return isAttachedToWindow()&&getWindowVisibility()==VISIBLE&&isShown()&&getGlobalVisibleRect(visibleBounds);}
    private void refreshMotion(){
        // Read on lifecycle/state/setting changes, never in the animation frame callback.
        systemMotionEnabled=android.provider.Settings.Global.getFloat(getContext().getContentResolver(),android.provider.Settings.Global.ANIMATOR_DURATION_SCALE,1f)>0f;
        if(breathe&&motionActive&&motionVisible()&&animationsEnabled())startIdle();else stopIdle();
    }
    private void startIdle(){
        if(idle!=null)return;
        idle=android.animation.ValueAnimator.ofFloat(0f,1f);idle.setDuration(1000);idle.setRepeatCount(android.animation.ValueAnimator.INFINITE);
        idle.setInterpolator(new android.view.animation.LinearInterpolator());
        idle.addUpdateListener(a->{if(!motionActive||!motionVisible()||!animationsEnabled()){stopIdle();return;}updateMotion(android.os.SystemClock.uptimeMillis());});
        idle.start();
    }
    /** Deterministic sampling for motion review; runtime reuses motionPose without allocations. */
    static Pose samplePose(long timeMs,boolean working,long celebrationAgeMs,boolean level){
        Pose pose=new Pose();fillPose(pose,timeMs,working,celebrationAgeMs,level);return pose;
    }
    private static void fillPose(Pose pose,long timeMs,boolean working,long age,boolean level){
        pose.bob=(float)(-Math.sin(Math.floorMod(timeMs,3600)*Math.PI*2/3600)*2.0);
        pose.look=pose.blink=pose.jump=pose.tilt=pose.happy=0;
        pose.scaleX=pose.scaleY=pose.leftEyeOpen=pose.rightEyeOpen=1;pose.gesture="rest";
        // Status receipts must not change the underlying pose amplitude at completion.
        float energy=1f;
        long at=Math.floorMod(timeMs,GESTURE_PERIOD_MS);
        float direction=Math.floorMod(Math.floorDiv(timeMs,GESTURE_PERIOD_MS),2)==0?1:-1;
        if(at>=1400&&at<1880){
            pose.gesture="double_blink";pose.blink=Math.max(pulse(at,1400,180),pulse(at,1660,180));
        }else if(at>=3000&&at<3700){
            pose.gesture="wink";float wink=window(at,3000,700,150,190);
            if(direction>0)pose.rightEyeOpen=1-wink;else pose.leftEyeOpen=1-wink;
            pose.tilt=direction*1.2f*wink*energy;pose.scaleX=1+.012f*wink;pose.scaleY=1-.012f*wink;
        }else if(at>=5500&&at<6700||at>=15900&&at<17100){
            boolean other=at>=15900;pose.gesture=other?"peek_other":"peek";
            float peek=window(at,other?15900:5500,1200,260,380)*energy;
            pose.look=direction*(other?-1:1)*peek;pose.tilt=pose.look*2.2f;
            pose.bob-=peek*1.8f;pose.scaleY=1+.012f*peek;pose.scaleX=1-.006f*peek;
        }else if(at>=8700&&at<9400){
            pose.gesture="nod";float nod=pulse(at,8700,700)*energy;
            pose.bob+=nod*4f;pose.scaleY=1-.026f*nod;pose.scaleX=1+.013f*nod;
            pose.leftEyeOpen=pose.rightEyeOpen=1-.18f*nod;
        }else if(at>=12000&&at<12800){
            pose.gesture="hop";float anticipation=pulse(at,12000,130)*energy;
            pose.jump=flight(at,12130,390)*1.35f*energy;
            float landing=pulse(at,12520,260)*energy;
            pose.bob+=(anticipation+landing)*1.7f;
            pose.scaleY=1-.035f*anticipation-.038f*landing+.008f*pose.jump;
            pose.scaleX=1+.025f*anticipation+.027f*landing-.01f*pose.jump;
        }
        pose.leftEyeOpen=Math.min(pose.leftEyeOpen,1-pose.blink);
        pose.rightEyeOpen=Math.min(pose.rightEyeOpen,1-pose.blink);
        if(level)pose.tilt=0;
        if(age>=0&&age<CELEBRATION_MS){
            // Blend with the actual current idle pose, including an in-flight peek/hop.
            // Both the weight and its velocity vanish at the two handover boundaries.
            float weight=window(age,0,CELEBRATION_MS,120,180);
            float anticipation=pulse(age,0,100),first=flight(age,100,360),between=pulse(age,460,110);
            float second=flight(age,570,310),landing=pulse(age,880,120);
            float celebrationJump=first*1.65f+second*1.20f;
            float compression=anticipation*.045f+between*.035f+landing*.025f;
            pose.gesture="celebration";
            pose.bob=mix(pose.bob,(anticipation+between+landing)*2f,weight);
            pose.look*=1-weight;pose.blink*=1-weight;
            pose.jump=mix(pose.jump,celebrationJump,weight);pose.tilt*=1-weight;
            pose.scaleX=mix(pose.scaleX,1+compression*.75f-celebrationJump*.012f,weight);
            pose.scaleY=mix(pose.scaleY,1-compression+celebrationJump*.006f,weight);
            pose.leftEyeOpen=mix(pose.leftEyeOpen,1,weight);pose.rightEyeOpen=mix(pose.rightEyeOpen,1,weight);
            pose.happy=window(age,70,870,140,160)*weight;
        }
    }
    private static float mix(float start,float end,float weight){return start+(end-start)*weight;}
    private static float clamp(float value,float low,float high){return Math.max(low,Math.min(high,value));}
    /** Smooth anticipation/settle with zero velocity at both ends. */
    private static float pulse(long time,long start,long duration){
        if(time<start||time>=start+duration)return 0;
        double sine=Math.sin((time-start)*Math.PI/duration);return (float)(sine*sine);
    }
    private static float flight(long time,long start,long duration){
        if(time<start||time>=start+duration)return 0;
        double sine=Math.sin((time-start)*Math.PI/duration);return (float)(sine*sine);
    }
    private static float window(long time,long start,long duration,long enter,long exit){
        long at=time-start;if(at<0||at>=duration)return 0;
        float amount=at<enter?(float)at/enter:at>duration-exit?(float)(duration-at)/exit:1;
        return amount*amount*(3-2*amount);
    }
    void applyPose(Pose pose){
        bob=pose.bob;look=pose.look;blink=pose.blink;jump=pose.jump;tilt=pose.tilt;happy=pose.happy;
        scaleX=pose.scaleX;scaleY=pose.scaleY;leftEyeOpen=pose.leftEyeOpen;rightEyeOpen=pose.rightEyeOpen;invalidate();
    }
    private void updateMotion(long now){
        long age=celebrationStarted>=0?now-celebrationStarted:-1;
        if(age>=CELEBRATION_MS){celebrationStarted=-1;age=-1;}
        if(mood!=null)fillMoodPose(motionPose,now+motionOffset,mood,now-moodSince);
        else fillPose(motionPose,now+motionOffset,working,age,!sway);
        if(moodBlendStarted>=0){
            long elapsed=Math.max(0,now-moodBlendStarted);
            if(elapsed>=MOOD_TRANSITION_MS)moodBlendStarted=-1;
            else{
                float progress=(float)elapsed/MOOD_TRANSITION_MS,weight=progress*progress*(3-2*progress);
                blendPose(motionPose,moodFrom,weight);
            }
        }
        applyPose(motionPose);
    }
    /** Rear display: idle, work, wait, done or warn. Null keeps the list behaviour. */
    void setMood(String value){
        if(value==null?mood==null:value.equals(mood))return;
        // Start from the pose that was actually displayed, including an unfinished
        // previous blend. Rapid status changes never snap back to an older mood.
        moodFrom.bob=bob;moodFrom.look=look;moodFrom.blink=blink;moodFrom.jump=jump;moodFrom.tilt=tilt;moodFrom.happy=happy;
        moodFrom.scaleX=scaleX;moodFrom.scaleY=scaleY;moodFrom.leftEyeOpen=leftEyeOpen;moodFrom.rightEyeOpen=rightEyeOpen;
        mood=value;moodSince=android.os.SystemClock.uptimeMillis();celebrationStarted=-1;
        moodBlendStarted=idle!=null?moodSince:-1;
        invalidate();
    }
    private static void blendPose(Pose pose,Pose from,float weight){
        pose.bob=mix(from.bob,pose.bob,weight);pose.look=mix(from.look,pose.look,weight);
        pose.blink=mix(from.blink,pose.blink,weight);pose.jump=mix(from.jump,pose.jump,weight);
        pose.tilt=mix(from.tilt,pose.tilt,weight);pose.happy=mix(from.happy,pose.happy,weight);
        pose.scaleX=mix(from.scaleX,pose.scaleX,weight);pose.scaleY=mix(from.scaleY,pose.scaleY,weight);
        pose.leftEyeOpen=mix(from.leftEyeOpen,pose.leftEyeOpen,weight);pose.rightEyeOpen=mix(from.rightEyeOpen,pose.rightEyeOpen,weight);
    }
    static Pose sampleMoodPose(long timeMs,String mood,long moodAgeMs){Pose pose=new Pose();fillMoodPose(pose,timeMs,mood,moodAgeMs);return pose;}
    /** Every term is a smooth periodic function, so moods never jump between frames of one mood. */
    private static void fillMoodPose(Pose pose,long t,String mood,long age){
        pose.bob=pose.look=pose.blink=pose.jump=pose.tilt=pose.happy=0;
        pose.scaleX=pose.scaleY=pose.leftEyeOpen=pose.rightEyeOpen=1;pose.gesture=mood;
        long a=Math.max(0,age);
        switch(mood){
            case "work"->{
                // Busy: quick bounce, eyes read left to right, a nod every few seconds.
                pose.bob=(float)(-Math.sin(Math.floorMod(t,900)*Math.PI*2/900)*1.6);
                pose.look=(float)Math.sin(Math.floorMod(t,4200)*Math.PI*2/4200)*.8f;
                pose.tilt=pose.look*2f;
                long n=Math.floorMod(t,6300);float nod=pulse(n,5500,600);
                pose.bob+=nod*4f;pose.scaleY=1-.03f*nod;pose.scaleX=1+.015f*nod;
                long b=Math.floorMod(t,3700);pose.blink=Math.max(pulse(b,0,170),pulse(b,260,170));
            }
            case "wait"->{
                // Waiting for the user: looks toward the text, head tilted, small hops.
                pose.look=-.9f;pose.tilt=-3f+(float)Math.sin(Math.floorMod(t,2600)*Math.PI*2/2600)*1.5f;
                pose.bob=(float)(-Math.sin(Math.floorMod(t,2400)*Math.PI*2/2400)*1.5);
                long h=Math.floorMod(t,2600);float ready=pulse(h,0,120),landing=pulse(h,480,200);
                pose.jump=flight(h,120,360);pose.bob+=(ready+landing)*1.8f;
                pose.scaleY=1-.035f*ready-.035f*landing+.008f*pose.jump;pose.scaleX=1+.025f*ready+.025f*landing-.01f*pose.jump;
                long b=Math.floorMod(t,3100);pose.blink=pulse(b,1500,180);
            }
            case "done"->{
                // Finished: smiling eyes, a little dance, and hops that start the moment it lands here.
                pose.happy=1;pose.tilt=(float)Math.sin(Math.floorMod(t,1400)*Math.PI*2/1400)*3f;
                double bounce=Math.sin(Math.floorMod(t,700)*Math.PI*2/700);
                pose.bob=(float)(-bounce*bounce*2.2);
                // Finish the fifth fast cycle before slowing down. Both schedules meet
                // at h=0 with zero hop/compression and zero velocity, never mid-flight.
                long h=a<DONE_FAST_END_MS?Math.floorMod(a,1400):Math.floorMod(a-DONE_FAST_END_MS,4000);
                float ready=pulse(h,0,110),landing=pulse(h,470,180);
                pose.jump=flight(h,110,360)*1.4f;pose.bob+=(ready+landing)*1.8f;
                pose.scaleY=1-.035f*ready-.03f*landing;pose.scaleX=1+.025f*ready+.02f*landing;
            }
            case "warn"->{
                // Something went wrong: shakes its head, then droopy eyes.
                long s=Math.floorMod(t,3200);float shake=window(s,0,900,150,150)*(float)Math.sin(s*Math.PI*2/300);
                pose.look=shake*.9f;pose.tilt=shake*4f;
                pose.bob=(float)(-Math.sin(Math.floorMod(t,3200)*Math.PI*2/3200)*1.2);
                pose.leftEyeOpen=pose.rightEyeOpen=.55f;
            }
            default->{
                // Idle: dozing, slow deep breaths, opens its eyes now and then.
                float breath=(float)Math.sin(Math.floorMod(t,3200)*Math.PI*2/3200);
                pose.bob=-breath*2.5f;pose.scaleY=1+.015f*breath;pose.scaleX=1-.01f*breath;
                float wake=window(Math.floorMod(t,9000),6000,1100,250,300);
                pose.leftEyeOpen=pose.rightEyeOpen=.14f+.86f*wake;pose.look=wake*.5f;
            }
        }
        pose.leftEyeOpen=Math.min(pose.leftEyeOpen,1-pose.blink);
        pose.rightEyeOpen=Math.min(pose.rightEyeOpen,1-pose.blink);
    }
    private void stopIdle(){
        if(idle!=null){android.animation.ValueAnimator old=idle;idle=null;old.cancel();}
        removeCallbacks(reset);expression=0;observedAllowed=false;celebrationStarted=-1;moodBlendStarted=-1;bob=look=blink=jump=tilt=happy=0;scaleX=scaleY=leftEyeOpen=rightEyeOpen=1;invalidate();
    }
    @Override protected void onAttachedToWindow(){
        super.onAttachedToWindow();getViewTreeObserver().addOnScrollChangedListener(viewportChanged);
        getContext().getContentResolver().registerContentObserver(android.provider.Settings.Global.getUriFor(android.provider.Settings.Global.ANIMATOR_DURATION_SCALE),false,motionSettingsObserver);
        motionSettingsObserved=true;refreshMotion();
    }
    @Override protected void onSizeChanged(int width,int height,int oldWidth,int oldHeight){super.onSizeChanged(width,height,oldWidth,oldHeight);refreshMotion();}
    @Override protected void onWindowVisibilityChanged(int visibility){super.onWindowVisibilityChanged(visibility);refreshMotion();}
    @Override public void onVisibilityAggregated(boolean visible){super.onVisibilityAggregated(visible);if(visible)refreshMotion();else stopIdle();}
    @Override protected void onDetachedFromWindow(){
        if(getViewTreeObserver().isAlive())getViewTreeObserver().removeOnScrollChangedListener(viewportChanged);
        if(motionSettingsObserved){getContext().getContentResolver().unregisterContentObserver(motionSettingsObserver);motionSettingsObserved=false;}
        stopIdle();super.onDetachedFromWindow();
    }
}
