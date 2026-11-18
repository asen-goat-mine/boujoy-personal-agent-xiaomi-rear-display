package dev.boujoy.personalagent;

import org.json.JSONObject;
import java.util.Set;

/** Displayed actions follow the actual deadline; an expired continue never becomes a silent retry. */
public final class TaskActions {
    public enum Action { NONE, STOP, CONTINUE, RESTART, CONSENT, RECONCILE }
    private static final Set<String> ACTIVE=Set.of("running","queued","waiting_children","waiting_approval");
    private static final Set<String> PAUSED=Set.of("paused","blocked","failed","interrupted","waiting_user","waiting_setup","stopped","expired","needs_review");
    private TaskActions() {}
    public static Action primary(JSONObject task,long serverNow){
        String state=ChatPresenter.string(task,"status");
        if(ACTIVE.contains(state))return Action.STOP;
        if("unknown_result".equals(state)&&task.optBoolean("canReconcile"))return Action.RECONCILE;
        if("waiting_consent".equals(state))return Action.CONSENT;
        if(!PAUSED.contains(state))return Action.NONE;
        long deadline=Binding.parseTime(task.opt("deadlineAt"));
        if("expired".equals(state)||deadline>0&&deadline<=serverNow)return ChatPresenter.string(task,"restartKey").isBlank()?Action.NONE:Action.RESTART;
        return Action.CONTINUE;
    }
    public static String label(Action action){return switch(action){case STOP->"停止";case CONTINUE->"继续";case RESTART->"重新执行";case CONSENT->"允许本次使用 DeepSeek";case RECONCILE->"核实现场";default->"";};}
}
