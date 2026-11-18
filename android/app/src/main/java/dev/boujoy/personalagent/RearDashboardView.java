package dev.boujoy.personalagent;

import android.animation.ValueAnimator;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.SystemClock;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.List;

/** Compact rear-display presentation. Execution and stop authority stay in the activity. */
final class RearDashboardView extends LinearLayout {
    private static final int INK = Color.WHITE, MUTED = 0xffaaaaaa;
    private final Typeface pixelFont;
    final TextView status, title, phase, updated;
    final Button stop, handoffTake, handoffDismiss;
    final LinearLayout handoffActions;
    interface ApprovalActions { void decide(RearApproval.Scope scope, boolean allow); void retryDetails(RearApproval.Scope scope); }
    private final LinearLayout steps, scrollContent, approvals, approvalFooter, approvalDetails, headerBody;
    private final ScrollView scroll;
    private List<RearApproval.Card> currentApprovals = List.of();
    private ApprovalActions currentApprovalActions;
    private RearApproval.Scope selectedApproval;
    private boolean approvalExpanded;
    private String approvalKey = "";
    private final FrameLayout portrait;
    private final LinearLayout companion;
    private Insets safeInsets = Insets.NONE;
    private boolean compact, taskMotionBound;
    private BotAvatar avatar;
    private String stepKey = "", portraitKey = "", botColor = "violet";
    // Mood drives the robot's actions and the small effects around it; there is no background.
    private final RearPixelArt.Effects effects;
    private final RearPixelArt.Rule rule;
    private String taskMood = "idle", stepMood = "idle";
    private boolean motionAllowed;

    RearDashboardView(Context context) {
        super(context);
        pixelFont = getResources().getFont(R.font.fusion_pixel_12);
        setOrientation(VERTICAL); setBackgroundColor(Color.BLACK);
        setPadding(dp(18), dp(12), dp(18), dp(12));
        setClipChildren(false);
        // Only the body scrolls; the stop footer remains outside this viewport.
        scroll = new ScrollView(context) {
            @Override protected void dispatchDraw(Canvas canvas) {
                int save = canvas.save();
                canvas.clipRect(getScrollX(), getScrollY(), getScrollX()+getWidth(), getScrollY()+getHeight());
                super.dispatchDraw(canvas); canvas.restoreToCount(save);
            }
        };
        scroll.setClipChildren(true); scroll.setClipToPadding(true); scroll.setFillViewport(true);
        scroll.setVerticalScrollBarEnabled(false); scroll.setHorizontalScrollBarEnabled(false);
        scroll.setOverScrollMode(OVER_SCROLL_NEVER);
        addView(scroll, new LayoutParams(-1, 0, 1));
        LinearLayout body = new LinearLayout(context); headerBody = body; body.setOrientation(HORIZONTAL); body.setGravity(Gravity.CENTER_VERTICAL);
        scrollContent = new LinearLayout(context); scrollContent.setOrientation(VERTICAL); scrollContent.setGravity(Gravity.CENTER_VERTICAL);
        scroll.addView(scrollContent, new ScrollView.LayoutParams(-1, -2));
        scrollContent.addView(body, new LayoutParams(-1, -2));
        LinearLayout copy = new LinearLayout(context); copy.setOrientation(VERTICAL); copy.setGravity(Gravity.CENTER_VERTICAL);
        body.addView(copy, new LayoutParams(0, -2, 1));
        status = label(16, INK); status.setMaxLines(1); status.setEllipsize(TextUtils.TruncateAt.END);
        copy.addView(status, new LayoutParams(-1, -2));
        title = label(12, INK); title.setMaxLines(1); title.setEllipsize(TextUtils.TruncateAt.END); add(copy, title, 4);
        phase = label(12, MUTED); phase.setMaxLines(2); phase.setEllipsize(TextUtils.TruncateAt.END); add(copy, phase, 5);
        rule = new RearPixelArt.Rule(context); rule.setVisibility(GONE);
        LayoutParams ruleLayout = new LayoutParams(-1, dp(1)); ruleLayout.topMargin = dp(7); copy.addView(rule, ruleLayout);
        steps = new LinearLayout(context); steps.setOrientation(VERTICAL); steps.setVisibility(GONE); add(copy, steps, 5);
        updated = label(9, 0xff777777); updated.setMaxLines(1); updated.setEllipsize(TextUtils.TruncateAt.END); add(copy, updated, 5);

        companion = new LinearLayout(context); companion.setOrientation(VERTICAL); companion.setGravity(Gravity.CENTER);
        LayoutParams companionLayout = new LayoutParams(dp(112), -2); companionLayout.leftMargin = dp(10); body.addView(companion, companionLayout);
        portrait = new FrameLayout(context); portrait.setClipChildren(false); portrait.setClipToPadding(false);
        effects = new RearPixelArt.Effects(context);
        companion.addView(portrait, new LayoutParams(dp(112), dp(112)));
        setPortrait("violet", false);
        approvals = new LinearLayout(context); approvals.setOrientation(VERTICAL); approvals.setVisibility(GONE); add(copy, approvals, 5);
        approvalDetails = new LinearLayout(context); approvalDetails.setOrientation(VERTICAL); approvalDetails.setVisibility(GONE); scrollContent.addView(approvalDetails, new LayoutParams(-1,-2));
        approvalFooter = new LinearLayout(context); approvalFooter.setOrientation(HORIZONTAL); approvalFooter.setVisibility(GONE);
        LayoutParams approvalFooterLayout = new LayoutParams(-1,dp(40)); approvalFooterLayout.topMargin=dp(8); addView(approvalFooter,approvalFooterLayout);

        handoffActions = new LinearLayout(context); handoffActions.setOrientation(HORIZONTAL); handoffActions.setVisibility(GONE);
        handoffTake = button("在主屏接手", false); handoffDismiss = button("不用了", false);
        LayoutParams take = new LayoutParams(0, dp(40), 1); take.rightMargin = dp(6);
        handoffActions.addView(handoffTake, take); handoffActions.addView(handoffDismiss, new LayoutParams(0, dp(40), 1));
        LayoutParams handoffLayout = new LayoutParams(-1, dp(40)); handoffLayout.topMargin = dp(8); addView(handoffActions, handoffLayout);
        stop = button("停止任务", true);
        stop.setContentDescription("停止任务并立即暂停手机操作");
        LayoutParams stopLayout = new LayoutParams(-1, dp(40)); stopLayout.topMargin = dp(8); addView(stop, stopLayout);
        setOnApplyWindowInsetsListener((view, insets) -> {
            safeInsets = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            requestLayout();
            return insets;
        });
    }

    @Override protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        // HyperOS either gives us the whole display plus a left camera cutout, or an
        // already clipped window with zero cutout inset. Work from the actual viewport
        // and delivered insets so the camera is avoided exactly once in both cases.
        int usableWidth = Math.max(0, MeasureSpec.getSize(widthMeasureSpec) - safeInsets.left - safeInsets.right);
        boolean narrow = usableWidth < dp(260);
        int horizontal = dp(narrow ? 12 : 18), vertical = dp(narrow ? 10 : 12);
        setPadding(horizontal + safeInsets.left, vertical + safeInsets.top, horizontal + safeInsets.right, vertical + safeInsets.bottom);
        if (compact != narrow) {
            compact = narrow;
            pixelTextSize(status, currentApprovals.isEmpty() ? 16 : 10); pixelTextSize(title, compact ? 11 : 12); pixelTextSize(phase, compact ? 11 : 12);
            LayoutParams companionLayout = (LayoutParams) companion.getLayoutParams();
            companionLayout.width = dp(compact ? 84 : 112); companionLayout.leftMargin = dp(compact ? 4 : 10);
            companion.getLayoutParams().width = companionLayout.width;
            ((LayoutParams) handoffActions.getLayoutParams()).topMargin = dp(compact ? 6 : 8);
            if (stop.getParent() == this) ((LayoutParams) stop.getLayoutParams()).topMargin = dp(compact ? 6 : 8);
            ((LayoutParams) approvalFooter.getLayoutParams()).topMargin = dp(compact ? 6 : 8);
            ((LayoutParams) steps.getLayoutParams()).topMargin = dp(compact ? 4 : 5);
            ((LayoutParams) rule.getLayoutParams()).topMargin = dp(compact ? 5 : 7);
            styleRows();
        }
        updated.setVisibility(approvals.getVisibility() == VISIBLE || compact || updated.getText().length() == 0 ? GONE : VISIBLE);
        int bodyHeight = MeasureSpec.getSize(heightMeasureSpec) - getPaddingTop() - getPaddingBottom();
        for (View footer : new View[]{handoffActions, approvalFooter, stop}) if (footer.getParent() == this && footer.getVisibility() != GONE) {
            LayoutParams params = (LayoutParams) footer.getLayoutParams(); bodyHeight -= params.height + params.topMargin + params.bottomMargin;
        }
        int portraitSize = Math.min(dp(!currentApprovals.isEmpty() ? 48 : compact ? 84 : 112), Math.max(dp(48), bodyHeight));
        portrait.getLayoutParams().width = portraitSize; portrait.getLayoutParams().height = portraitSize;
        super.onMeasure(widthMeasureSpec, heightMeasureSpec);
    }

    private void styleRows() {
        for (int i = 0; i < steps.getChildCount(); i++) {
            LinearLayout row = (LinearLayout) steps.getChildAt(i); row.setMinimumHeight(dp(compact ? 20 : 24));
            View glyph = row.getChildAt(0); glyph.getLayoutParams().width = dp(compact ? 14 : 16); glyph.getLayoutParams().height = dp(compact ? 14 : 16);
            TextView text = (TextView) row.getChildAt(1); pixelTextSize(text, compact ? 11 : 12);
            text.setMaxLines(compact && !"completed".equals(row.getTag()) ? 2 : 1);
            ((LayoutParams) text.getLayoutParams()).leftMargin = dp(compact ? 6 : 8);
        }
    }

    void showSteps(List<RearProgress.Step> values, String color, boolean animate) {
        List<RearProgress.Step> visible = values == null ? List.of() : values.subList(0, Math.min(3, values.size()));
        setPortrait(color, animate);
        StringBuilder key = new StringBuilder(Boolean.toString(animate));
        for (RearProgress.Step step : visible) key.append('\u0000').append(step.id()).append('\u0001').append(step.label()).append('\u0001').append(step.state());
        steps.setVisibility(visible.isEmpty() ? GONE : VISIBLE);
        rule.setVisibility(visible.isEmpty() || !currentApprovals.isEmpty() ? GONE : VISIBLE);
        if (!visible.isEmpty()) phase.setVisibility(GONE);
        stepMood = visible.stream().anyMatch(step -> "running".equals(step.state())) ? "work"
                : visible.stream().anyMatch(step -> "waiting".equals(step.state())) ? "wait" : "idle";
        if (!taskMotionBound) motionAllowed = animate;
        applyMood();
        if (stepKey.equals(key.toString())) return;
        stepKey = key.toString(); steps.removeAllViews();
        for (RearProgress.Step step : visible) {
            boolean completed = "completed".equals(step.state()), running = "running".equals(step.state());
            LinearLayout row = new LinearLayout(getContext()); row.setOrientation(HORIZONTAL); row.setGravity(Gravity.CENTER_VERTICAL); row.setTag(step.state()); row.setMinimumHeight(dp(compact ? 20 : 24));
            ProgressGlyph glyph = new ProgressGlyph(getContext(), step.state(), animate && running);
            row.addView(glyph, new LayoutParams(dp(compact ? 14 : 16), dp(compact ? 14 : 16)));
            TextView text = label(compact ? 11 : 12, completed ? MUTED : INK);
            text.setText(step.label()); text.setMaxLines(compact && !completed ? 2 : 1); text.setEllipsize(TextUtils.TruncateAt.END);
            LayoutParams textLayout = new LayoutParams(0, -2, 1); textLayout.leftMargin = dp(compact ? 6 : 8); row.addView(text, textLayout);
            row.setContentDescription((completed ? "已完成，" : running ? "正在进行，" : "等待处理，") + step.label());
            row.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);
            glyph.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO); text.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
            steps.addView(row, new LayoutParams(-1, -2));
        }
    }

    void showApprovals(List<RearApproval.Card> cards, ApprovalActions actions) {
        if (cards == null || cards.isEmpty()) { clearApprovals(); return; }
        List<RearApproval.Card> remaining = cards.stream().filter(card -> !"accepted".equals(card.requestStatus()) && !"unconfirmed".equals(card.requestStatus())).toList();
        if (remaining.isEmpty()) {
            boolean uncertain = cards.stream().anyMatch(card -> "unconfirmed".equals(card.requestStatus()));
            clearApprovals(); status.setText(uncertain ? "结果待核实" : "已收到决定"); return;
        }
        cards = remaining;
        currentApprovals = List.copyOf(cards); currentApprovalActions = actions; applyMood();
        RearApproval.Card selected = cards.stream().filter(card -> card.scope().equals(selectedApproval)).findFirst().orElse(null);
        if (selected == null) { selected = cards.get(0); selectedApproval = selected.scope(); approvalExpanded = false; }
        RearApproval.Card card = selected;
        steps.setVisibility(GONE); rule.setVisibility(GONE); phase.setVisibility(GONE); updated.setVisibility(GONE); title.setVisibility(GONE);
        approvals.setVisibility(VISIBLE); approvalFooter.setVisibility(VISIBLE);
        headerBody.setVisibility(approvalExpanded ? GONE : VISIBLE); approvalDetails.setVisibility(approvalExpanded ? VISIBLE : GONE);
        scrollContent.setGravity(approvalExpanded ? Gravity.TOP : Gravity.CENTER_VERTICAL);
        String message = switch (card.requestStatus()) {
            case "sending" -> "等待电脑回执"; case "accepted" -> "已收到决定"; case "unconfirmed" -> "结果待核实"; default -> "需要确认";
        };
        status.setText(message); status.setTextColor(MUTED); pixelTextSize(status,10);
        // The Activity refreshes its ordinary stop state on every tick. Reapply the
        // approval presentation even when this card's content did not change.
        stop.setVisibility(GONE);
        String key = cards.toString() + selectedApproval + approvalExpanded; if (key.equals(approvalKey)) return;
        approvalKey = key; approvals.removeAllViews(); approvalDetails.removeAllViews(); scroll.scrollTo(0,0);
        // Remove any pressed target before rebinding a different card. A down on the old
        // approval can never become an up/click on a newly selected request.
        for (int i = approvalFooter.getChildCount()-1; i >= 0; i--) {
            View child = approvalFooter.getChildAt(i); if (child == stop) continue;
            child.setEnabled(false); child.setPressed(false); child.cancelPendingInputEvents(); approvalFooter.removeViewAt(i);
        }
        Button allow = button("允许", true), deny = button("拒绝", false); compactApprovalButton(allow); compactApprovalButton(deny);
        allow.setEnabled(card.canAllow()); deny.setEnabled(card.canDeny());
        allow.setContentDescription("允许这一次操作：" + card.summary()); deny.setContentDescription("拒绝这一次操作：" + card.summary());
        LayoutParams choice = new LayoutParams(0, dp(40), 1); choice.rightMargin=dp(6); approvalFooter.addView(allow,0,choice);
        LayoutParams rejection = new LayoutParams(0, dp(40), 1); approvalFooter.addView(deny,1,rejection);
        allow.setOnClickListener(v -> { allow.setEnabled(false); deny.setEnabled(false); actions.decide(card.scope(),true); });
        deny.setOnClickListener(v -> { allow.setEnabled(false); deny.setEnabled(false); actions.decide(card.scope(),false); });
        TextView summary = label(12,INK); summary.setText(card.summary().isBlank() ? "正在核对操作内容" : card.summary());
        summary.setMaxLines(4); summary.setEllipsize(TextUtils.TruncateAt.END); approvals.addView(summary,new LayoutParams(-1,-2));
        Button content = button(card.verified() ? "查看内容" : card.detailError().isBlank() ? "正在核对" : "重新核对",false);
        textEntry(content); content.setEnabled(card.verified() || !card.detailError().isBlank());
        content.setOnClickListener(v -> { if(card.verified()){approvalExpanded=true;approvalKey="";showApprovals(currentApprovals,currentApprovalActions);}else actions.retryDetails(card.scope()); });
        add(approvals,content,6);
        if (cards.size()>1) {
            List<RearApproval.Card> choices=currentApprovals;int index=choices.indexOf(card); LinearLayout navigation=new LinearLayout(getContext()); navigation.setGravity(Gravity.CENTER_VERTICAL);
            Button previous=button("上个",false),next=button("下个",false);previous.setEnabled(index>0);next.setEnabled(index<cards.size()-1);
            TextView count=label(9,MUTED);count.setGravity(Gravity.CENTER);count.setText((index+1)+" / "+cards.size());
            navigation.addView(previous,new LayoutParams(0,dp(40),1));navigation.addView(count,new LayoutParams(dp(36),-2));navigation.addView(next,new LayoutParams(0,dp(40),1));add(approvals,navigation,6);
            previous.setOnClickListener(v->selectApproval(choices.get(index-1).scope()));next.setOnClickListener(v->selectApproval(choices.get(index+1).scope()));
        }
        if (approvalExpanded) {
            Button back=button("返回摘要",false);textEntry(back);back.setOnClickListener(v->{approvalExpanded=false;approvalKey="";showApprovals(currentApprovals,currentApprovalActions);});approvalDetails.addView(back,new LayoutParams(-1,dp(40)));
            TextView fullSummary=label(12,INK);fullSummary.setText(card.summary());fullSummary.setTextIsSelectable(true);add(approvalDetails,fullSummary,8);
            if(!card.details().isBlank()){TextView detail=label(12,MUTED);detail.setText(card.details());detail.setTextIsSelectable(true);add(approvalDetails,detail,8);}
            TextView deadline=label(9,MUTED);deadline.setText(ApprovalPresentation.label(Tunnel.json("expiresAt",card.scope().expiresAt()),0));add(approvalDetails,deadline,8);
        }
        requestLayout();
    }
    private void selectApproval(RearApproval.Scope scope) { selectedApproval=scope;approvalExpanded=false;approvalKey="";showApprovals(currentApprovals,currentApprovalActions); }
    boolean showingApprovals() { return !currentApprovals.isEmpty(); }
    void clearApprovals() {
        boolean wasShowing=!currentApprovals.isEmpty();
        approvalKey="";currentApprovals=List.of();currentApprovalActions=null;selectedApproval=null;approvalExpanded=false;
        status.setTextColor(INK);pixelTextSize(status,16);pixelTextSize(stop,12);
        approvals.removeAllViews();approvals.setVisibility(GONE);approvalDetails.removeAllViews();approvalDetails.setVisibility(GONE);headerBody.setVisibility(VISIBLE);
        if(wasShowing)stop.setVisibility(VISIBLE);
        for(int i=0;i<approvalFooter.getChildCount();i++){View child=approvalFooter.getChildAt(i);child.setEnabled(false);child.setPressed(false);child.cancelPendingInputEvents();}
        approvalFooter.removeAllViews();approvalFooter.setVisibility(GONE);scrollContent.setGravity(Gravity.CENTER_VERTICAL);
        if(steps.getVisibility()==VISIBLE)rule.setVisibility(VISIBLE);
        applyMood();
    }

    void clearSteps() {
        stepKey = ""; steps.removeAllViews(); steps.setVisibility(GONE); rule.setVisibility(GONE); taskMotionBound = false; setPortrait(botColor, false);
        avatar.taskMotion("", "", false);
        taskMood = "idle"; stepMood = "idle"; motionAllowed = false; applyMood();
    }

    /** Task identity/status come from the authenticated snapshot, never from the number of checkmarks. */
    void showTaskMotion(String taskId, String status, boolean allowed) {
        taskMotionBound = true;
        avatar.taskMotion(taskId, status, allowed);
        taskMood = RearPixelArt.moodOf(status); motionAllowed = allowed; applyMood();
    }

    /** A user decision (approval or handoff) outranks the task; an unknown task status falls back to its steps. */
    void refreshMood() { applyMood(); }
    private void applyMood() {
        if (effects == null || avatar == null) return;
        boolean userTurn = !currentApprovals.isEmpty() || handoffActions != null && handoffActions.getVisibility() == VISIBLE;
        String mood = userTurn ? "wait" : !"idle".equals(taskMood) ? taskMood : stepMood;
        avatar.setMood(mood);
        effects.set(mood, BotAvatar.color(botColor), motionAllowed);
    }

    private void setPortrait(String color, boolean animate) {
        botColor = color == null || color.isBlank() ? "violet" : color;
        if (!portraitKey.equals(botColor)) {
            portraitKey = botColor; portrait.removeAllViews();
            avatar = new BotAvatar(getContext(), botColor).withoutGroundShadow().breathingLevel();
            avatar.setOnClickListener(null); avatar.setClickable(false); avatar.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
            portrait.addView(avatar, new FrameLayout.LayoutParams(-1, -1, Gravity.CENTER));
            if (effects != null) { if (effects.getParent() != null) portrait.removeView(effects); portrait.addView(effects, new FrameLayout.LayoutParams(-1, -1, Gravity.CENTER)); }
            applyMood();
        }
        if (!taskMotionBound) avatar.setMotionActive(animate);
    }

    private Button button(String text, boolean primary) {
        Button button = new Button(getContext()); button.setText(text); button.setAllCaps(false); pixelTextSize(button, 12);
        button.setTypeface(pixelFont); button.getPaint().setAntiAlias(false); button.getPaint().setFakeBoldText(true); button.setIncludeFontPadding(false);
        button.setMinHeight(dp(40)); button.setMinimumHeight(dp(40)); button.setMinWidth(0); button.setMinimumWidth(0); button.setPadding(dp(10), 0, dp(10), 0);
        button.setSingleLine(true); button.setEllipsize(TextUtils.TruncateAt.END); button.setStateListAnimator(null); button.setElevation(0);
        styleButton(button, primary, false); return button;
    }
    private void compactApprovalButton(Button button) {
        pixelTextSize(button,10);
        button.setBackground(new android.graphics.drawable.InsetDrawable(button.getBackground(),0,dp(4),0,dp(4)));
    }
    private void textEntry(Button button) {
        pixelTextSize(button,10);button.setGravity(Gravity.LEFT|Gravity.CENTER_VERTICAL);button.setPadding(0,0,0,0);
        button.setTextColor(MUTED);button.setBackground(new RippleDrawable(ColorStateList.valueOf(0x20ffffff),new android.graphics.drawable.ColorDrawable(Color.TRANSPARENT),rounded(Color.WHITE,8,0)));
    }
    private void styleButton(Button button, boolean primary, boolean outline) {
        if(outline){
            button.setTextColor(INK);button.setBackgroundTintList(null);
            button.setBackground(new RippleDrawable(ColorStateList.valueOf(0x20ffffff),rounded(Color.BLACK,14,0xff555555),rounded(Color.WHITE,14,0)));return;
        }
        int[][] states = {new int[]{-android.R.attr.state_enabled}, new int[]{}};
        button.setTextColor(new ColorStateList(states, new int[]{0xff888888, primary ? Color.BLACK : INK}));
        StateListDrawable fills = new StateListDrawable();
        fills.addState(states[0], rounded(0xff222222, 14, 0));
        fills.addState(states[1], rounded(primary ? Color.WHITE : outline ? Color.BLACK : 0xff202020, 14, primary ? 0 : 0xff555555));
        button.setBackgroundTintList(null);
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(primary ? 0x30000000 : 0x30ffffff), fills, rounded(Color.WHITE, 14, 0)));
        button.refreshDrawableState(); button.getBackground().setState(button.getDrawableState());
    }

    private GradientDrawable rounded(int color, int radius, int border) {
        GradientDrawable shape = new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(radius));
        if (border != 0) shape.setStroke(dp(1), border);
        return shape;
    }
    private TextView label(int size, int color) {
        TextView view = new TextView(getContext()); view.setTypeface(pixelFont); view.getPaint().setAntiAlias(false); view.getPaint().setFakeBoldText(true); pixelTextSize(view, size); view.setTextColor(color); view.setIncludeFontPadding(false); view.setLineSpacing(dp(1), 1); return view;
    }
    private void pixelTextSize(TextView view, int sp) {
        // The font has a 12-pixel design grid. Integer physical-pixel scaling keeps
        // its square strokes crisp on both main and 450 dpi rear displays.
        float px = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, sp, getResources().getDisplayMetrics());
        view.setTextSize(TypedValue.COMPLEX_UNIT_PX, Math.max(12, Math.round(px / 12f) * 12));
    }
    private void add(LinearLayout parent, View view, int gap) { LayoutParams params = new LayoutParams(-1, -2); params.topMargin = dp(gap); parent.addView(view, params); }
    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private static final class ProgressGlyph extends View {
        private static final int[][] CHECK_PIXELS = {{2, 5}, {3, 6}, {4, 7}, {5, 6}, {6, 5}, {7, 4}, {8, 3}, {9, 2}};
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF arcBounds = new RectF();
        private final String state;
        private final boolean animate;
        ProgressGlyph(Context context, String state, boolean animate) { super(context); this.state = state; this.animate = animate; }
        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            float size = Math.min(getWidth(), getHeight()), cx = getWidth() / 2f, cy = getHeight() / 2f, radius = size * .39f;
            paint.setStrokeWidth(size * .105f); paint.setStrokeCap(Paint.Cap.ROUND); paint.setStrokeJoin(Paint.Join.ROUND);
            if ("completed".equals(state)) {
                // A small, unboxed pixel check, matching the companion and type.
                paint.setStyle(Paint.Style.FILL); paint.setColor(INK); paint.setAntiAlias(false);
                float unit = Math.max(1, (float) Math.floor(size / 12));
                float left = Math.round(cx - unit * 6), top = Math.round(cy - unit * 6);
                for (int[] point : CHECK_PIXELS) canvas.drawRect(left + point[0] * unit, top + point[1] * unit,
                        left + (point[0] + 2) * unit, top + (point[1] + 2) * unit, paint);
            } else {
                paint.setAntiAlias(true); paint.setStyle(Paint.Style.STROKE); paint.setColor("running".equals(state) ? 0xff383838 : 0xff777777); canvas.drawCircle(cx, cy, radius, paint);
                if ("running".equals(state)) {
                    boolean moving = animate && ValueAnimator.areAnimatorsEnabled();
                    float angle = moving ? (SystemClock.uptimeMillis() % 1100) * 360f / 1100f : -60f;
                    paint.setColor(INK); arcBounds.set(cx - radius, cy - radius, cx + radius, cy + radius);
                    canvas.drawArc(arcBounds, angle, 90, false, paint);
                    if (moving && isAttachedToWindow() && isShown() && getWindowVisibility() == VISIBLE) postInvalidateOnAnimation();
                }
            }
        }
        @Override protected void onWindowVisibilityChanged(int visibility) { super.onWindowVisibilityChanged(visibility); if (visibility == VISIBLE) invalidate(); }
        @Override public void onVisibilityAggregated(boolean visible) { super.onVisibilityAggregated(visible); if (visible) invalidate(); }
    }
}
