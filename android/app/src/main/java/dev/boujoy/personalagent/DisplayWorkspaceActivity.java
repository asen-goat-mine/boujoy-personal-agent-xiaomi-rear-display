package dev.boujoy.personalagent;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Display;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

/** A real, noninteractive first window for a newly created Boujoy display session. */
public final class DisplayWorkspaceActivity extends Activity {
    static final String EXPECTED_DISPLAY_ID = "expectedDisplayId";
    static final String EXPECTED_SESSION_ID = "sessionId";
    static boolean acceptsDisplay(int expected,int actual,String sessionId,String displayName) {
        return expected>Display.DEFAULT_DISPLAY&&expected==actual&&ShellDisplayService.validSessionUuid(sessionId)
                &&ShellDisplayService.sessionDisplayName(sessionId).equals(displayName);
    }
    /** Display.FLAG_ALWAYS_UNLOCKED (hidden). Read from the real Display, never from the intent. */
    static final int DISPLAY_FLAG_ALWAYS_UNLOCKED=1<<9;
    /** A locked phone only hides this page on a display the system keeps unlocked for background work. */
    static boolean keyguardAllows(boolean deviceLocked,boolean keyguardLocked,int displayFlags){
        return !deviceLocked&&!keyguardLocked||(displayFlags&DISPLAY_FLAG_ALWAYS_UNLOCKED)!=0;
    }
    private boolean validDestination() {
        if(!BuildConfig.BACKGROUND_SUPPORTED)return false;
        try {
            Display display=getDisplay();
            int expected=getIntent()==null?-1:getIntent().getIntExtra(EXPECTED_DISPLAY_ID,-1);
            String sessionId=getIntent()==null?null:getIntent().getStringExtra(EXPECTED_SESSION_ID);
            if(display==null||!acceptsDisplay(expected,display.getDisplayId(),sessionId,display.getName())||!display.isValid())return false;
            KeyguardManager keyguard=getSystemService(KeyguardManager.class);
            return keyguard!=null&&keyguardAllows(keyguard.isDeviceLocked(),keyguard.isKeyguardLocked(),display.getFlags());
        }catch(RuntimeException unavailable){return false;}
    }
    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        // Do not create a visible content window if the OS placed this on another display.
        if(!validDestination()){finish();return;}
        LinearLayout body=new LinearLayout(this);body.setOrientation(LinearLayout.VERTICAL);body.setGravity(Gravity.CENTER);
        int padding=Math.round(28*getResources().getDisplayMetrics().density);body.setPadding(padding,padding,padding,padding);
        body.setBackgroundColor(Color.rgb(20,28,40));
        TextView title=new TextView(this);title.setText("Boujoy 后台显示已就绪");title.setTextColor(Color.WHITE);title.setTextSize(23);title.setGravity(Gravity.CENTER);
        TextView description=new TextView(this);description.setText("等待打开任务应用");description.setTextColor(Color.rgb(180,192,208));description.setTextSize(16);description.setGravity(Gravity.CENTER);description.setPadding(0,padding/2,0,0);
        body.addView(title,new LinearLayout.LayoutParams(-1,-2));body.addView(description,new LinearLayout.LayoutParams(-1,-2));setContentView(body);
    }
    @Override protected void onResume(){super.onResume();if(!validDestination())finish();}
    @Override public void onConfigurationChanged(Configuration configuration){super.onConfigurationChanged(configuration);if(!validDestination())finish();}
}
