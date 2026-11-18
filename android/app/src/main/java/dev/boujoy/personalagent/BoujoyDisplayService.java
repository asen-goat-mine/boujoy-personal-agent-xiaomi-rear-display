package dev.boujoy.personalagent;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Rect;
import android.os.Bundle;
import android.util.SparseArray;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;
import org.json.JSONArray;
import org.json.JSONObject;

/** Reads and edits only the explicitly leased Boujoy display. It never uses a global root or IME. */
public final class BoujoyDisplayService extends AccessibilityService {
    private static volatile BoujoyDisplayService connected;
    private static volatile Runnable lifecycleListener;
    private static volatile int sessionDisplay = -1;
    private final Map<Integer, AtomicLong> versions = new ConcurrentHashMap<>();
    private long lastInvalidationLog=-1000;
    private int suppressedInvalidationLogs;
    private static final int MAX_NODES = 1500, MAX_DEPTH = 40, MAX_TEXT = 4000;

    @Override protected void onServiceConnected() { if(!BuildConfig.BACKGROUND_SUPPORTED){disableSelf();return;} connected = this; notifyLifecycle(); }
    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        // Never collect event text or source nodes. Window/package identity is checked on dispatch.
        AtomicLong version = versions.get(event.getWindowId());
        if (sessionDisplay > 0 && version != null && invalidatesObservation(event.getEventType(), event.getContentChangeTypes())) {
            long next=version.incrementAndGet();
            logInvalidation(event.getWindowId(),event.getEventType(),event.getContentChangeTypes(),next);
        }
    }
    /** Same-window redraws do not expire observations; a newly covering pane still does. */
    static boolean invalidatesObservation(int type, int contentChanges) {
        return (type == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED || type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED)
                && (contentChanges & AccessibilityEvent.CONTENT_CHANGE_TYPE_PANE_APPEARED) != 0;
    }
    private void logInvalidation(int windowId,int eventType,int changes,long version) {
        long now=android.os.SystemClock.elapsedRealtime();
        if(now>=lastInvalidationLog&&now-lastInvalidationLog<1000){suppressedInvalidationLogs++;return;}
        android.util.Log.i("BoujoyObservation",Tunnel.json("reason","pane_appeared","displayId",sessionDisplay,
                "windowId",windowId,"eventType",eventType,"contentChangeTypes",changes,"uiVersion",version,
                "suppressedLogs",suppressedInvalidationLogs,"elapsedRealtimeMs",now).toString());
        lastInvalidationLog=now;suppressedInvalidationLogs=0;
    }
    @Override public void onInterrupt() { disconnect(); }
    @Override public boolean onUnbind(android.content.Intent intent) { disconnect(); return super.onUnbind(intent); }
    @Override public void onDestroy() { disconnect(); super.onDestroy(); }
    private void disconnect() { if (connected == this) { connected = null; sessionDisplay = -1; versions.clear(); notifyLifecycle(); } }
    public static boolean isConnected() { return connected != null; }
    public static boolean ready() { return isConnected(); }
    public static void setLifecycleListener(Runnable value) { lifecycleListener = value; }
    private static void notifyLifecycle() { Runnable listener = lifecycleListener; if (listener != null) listener.run(); }
    public static void setSessionDisplay(int id) {
        if (id != sessionDisplay) { sessionDisplay = id > 0 ? id : -1; BoujoyDisplayService service = connected; if (service != null) { service.versions.clear(); } }
    }
    public static final class Frame implements AutoCloseable {
        final BoujoyDisplayService owner;
        public final int displayId, windowId;
        public final String packageName;
        public final long uiVersion;
        public final JSONObject tree;
        public final JSONArray windows;
        final AccessibilityNodeInfo root;
        Frame(BoujoyDisplayService owner, int display, int window, String pkg, long version,
                JSONObject tree, JSONArray windows, AccessibilityNodeInfo root) {
            this.owner=owner; displayId=display; windowId=window; packageName=pkg; uiVersion=version;
            this.tree=tree; this.windows=windows; this.root=root;
        }
        @Override public void close() { if (root != null) root.recycle(); }
        public boolean stillCurrent() { return connected == owner && sessionDisplay == displayId
                && owner.versions.getOrDefault(windowId, new AtomicLong(-1)).get() == uiVersion; }
    }
    public static Frame snapshot(int displayId, boolean includeTree) throws Exception {
        BoujoyDisplayService service = connected;
        if (service == null || displayId <= 0 || sessionDisplay != displayId) throw new DisplayExecutor.BackendException("EXECUTOR_UNAVAILABLE", false);
        return service.collect(displayId, includeTree);
    }
    private Frame collect(int displayId, boolean includeTree) throws Exception {
        long started = System.currentTimeMillis();
        SparseArray<List<AccessibilityWindowInfo>> all = getWindowsOnAllDisplays();
        List<AccessibilityWindowInfo> candidates = all == null ? null : all.get(displayId);
        if (candidates == null) throw new DisplayExecutor.BackendException("NO_ACTIVE_WINDOW", false);
        AccessibilityWindowInfo chosen = null;
        for (AccessibilityWindowInfo window : candidates) {
            if (window.getDisplayId() != displayId || window.getType() != AccessibilityWindowInfo.TYPE_APPLICATION) continue;
            if (chosen == null || window.getLayer() > chosen.getLayer()) chosen = window;
        }
        if (chosen == null) throw new DisplayExecutor.BackendException("NO_ACTIVE_WINDOW", false);
        AccessibilityNodeInfo root = chosen.getRoot();
        if (root == null) throw new DisplayExecutor.BackendException("NO_ACTIVE_WINDOW", false);
        boolean kept = false;
        try {
            if (root.getWindowId() != chosen.getId()) throw new DisplayExecutor.BackendException("WINDOW_CHANGED", false);
            String pkg = text(root.getPackageName());
            if (pkg.isEmpty()) throw new DisplayExecutor.BackendException("NO_ACTIVE_WINDOW", false);
            long version = versions.computeIfAbsent(chosen.getId(), id -> new AtomicLong(1)).get();
            JSONArray windows = new JSONArray();
            // Only the selected application window supplies a package name; other roots are never read.
            for (AccessibilityWindowInfo window : candidates) {
                if (window.getDisplayId() != displayId) continue;
                Rect bounds = new Rect(); window.getBoundsInScreen(bounds);
                windows.put(Tunnel.json("window_id", window.getId(), "display_id", displayId,
                        "package_name", window.getId() == chosen.getId() ? pkg : JSONObject.NULL,
                        "bounds", rect(bounds), "layer", window.getLayer(), "type", window.getType(),
                        "active", window.isActive(), "focused", window.isFocused()));
            }
            JSONArray elements = new JSONArray(); boolean[] truncated = {false}, incomplete = {false};
            CollectionCounters counters=new CollectionCounters();
            if (includeTree) collectNode(root, "0", JSONObject.NULL, elements, truncated, incomplete, counters, 0, chosen.getId(), pkg, false);
            JSONObject tree = Tunnel.json("available", includeTree, "started_at_ms", started, "finished_at_ms", System.currentTimeMillis(),
                    "output", "legacy", "compact", false, "scope_clipped", false, "collection_complete", includeTree && !truncated[0] && !incomplete[0],
                    "collection_truncated", truncated[0], "truncated", truncated[0], "output_nodes", elements.length(),
                    "collected_nodes", elements.length(), "merged_nodes", 0, "elements", elements,"diagnostics",counters.json());
            if (connected != this || sessionDisplay != displayId) throw new DisplayExecutor.BackendException("EXECUTOR_UNAVAILABLE", false);
            kept = true; return new Frame(this, displayId, chosen.getId(), pkg, version, tree, windows, root);
        } finally { if (!kept) root.recycle(); }
    }
    private static Object nativeClass(CharSequence value) {
        String name=value==null?"":value.toString();
        return name.length()>0&&name.length()<=255&&name.matches("[A-Za-z_$][A-Za-z0-9_.$]*")?name:JSONObject.NULL;
    }
    private static String text(CharSequence value) { if (value == null) return ""; String out=value.toString(); return out.length()>MAX_TEXT?out.substring(0,MAX_TEXT):out; }
    private static JSONArray rect(Rect value) { return new JSONArray().put(value.left).put(value.top).put(value.right).put(value.bottom); }
    /** Counts only the branches actually encountered; no page content or omitted-node estimates. */
    private static final class CollectionCounters {
        int missingChildren,foreignPackageNodes,foreignWindowNodes,nodeLimitHits,depthLimitHits;
        JSONObject json(){return Tunnel.json("missing_children",missingChildren,"foreign_package_nodes",foreignPackageNodes,
                "foreign_window_nodes",foreignWindowNodes,"node_limit_hits",nodeLimitHits,"depth_limit_hits",depthLimitHits);}
    }
    private static void collectNode(AccessibilityNodeInfo node, String path, Object parent, JSONArray out,
            boolean[] truncated, boolean[] incomplete, CollectionCounters counters, int depth, int window, String pkg, boolean protectedAncestor) throws Exception {
        if (out.length() >= MAX_NODES) { counters.nodeLimitHits++;truncated[0]=true; return; }
        if (depth > MAX_DEPTH) { counters.depthLimitHits++;truncated[0]=true; return; }
        if (node.getWindowId() != window) { counters.foreignWindowNodes++;incomplete[0]=true; return; }
        if (!pkg.equals(text(node.getPackageName()))) { counters.foreignPackageNodes++;incomplete[0]=true; return; }
        Rect bounds=new Rect(); node.getBoundsInScreen(bounds); JSONArray actions=new JSONArray();
        for (AccessibilityNodeInfo.AccessibilityAction action : node.getActionList()) {
            switch (action.getId()) {
                case AccessibilityNodeInfo.ACTION_CLICK -> actions.put("tap");
                case AccessibilityNodeInfo.ACTION_LONG_CLICK -> actions.put("long_press");
                case AccessibilityNodeInfo.ACTION_SET_TEXT -> { if (!protectedAncestor && !protectedInput(node)) actions.put("set_text"); }
                case AccessibilityNodeInfo.ACTION_SCROLL_FORWARD -> actions.put("scroll_forward");
                case AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD -> actions.put("scroll_backward");
            }
        }
        boolean password=protectedAncestor||protectedInput(node);
        out.put(Tunnel.json("element_id",path,"parent_id",parent,"class",nativeClass(node.getClassName()),"bounds",rect(bounds),
                "actions",actions,"enabled",node.isEnabled(),"visible",node.isVisibleToUser(),"editable",node.isEditable(),
                "password",password,"focused",node.isFocused(),"checkable",node.isCheckable(),"checked",node.isChecked(),
                "selected",node.isSelected(),"content_invalid",node.isContentInvalid(),"text",password?"":text(node.getText()),
                "description",password?"":text(node.getContentDescription()),"hint",password?"":text(node.getHintText())));
        for (int i=0;i<node.getChildCount();i++) {
            if (out.length()>=MAX_NODES) { counters.nodeLimitHits++;truncated[0]=true; break; }
            AccessibilityNodeInfo child=node.getChild(i); if(child==null){counters.missingChildren++;incomplete[0]=true;continue;}
            try { collectNode(child,path+"."+i,path,out,truncated,incomplete,counters,depth+1,window,pkg,password); } finally { child.recycle(); }
        }
    }
    static boolean protectedInput(AccessibilityNodeInfo node) {
        return node.isPassword() || TypingPolicy.password(node.getInputType())
                || text(node.getHintText()).matches("(?i).*(密码|验证码|password|passcode|\\bOTP\\b).*");
    }
    private static AccessibilityNodeInfo resolve(Frame frame, String path) throws Exception {
        if (!path.matches("0(?:\\.(?:0|[1-9][0-9]{0,4})){0,40}")) throw new DisplayExecutor.BackendException("TARGET_MISSING",false);
        AccessibilityNodeInfo node=AccessibilityNodeInfo.obtain(frame.root);
        try {
            String[] parts=path.split("\\.");
            for(int i=1;i<parts.length;i++) {
                if(protectedInput(node))throw new DisplayExecutor.BackendException("PROTECTED_INPUT",false);
                int index=Integer.parseInt(parts[i]);
                if(index>=node.getChildCount()) throw new DisplayExecutor.BackendException("TARGET_MISSING",false);
                AccessibilityNodeInfo child=node.getChild(index);node.recycle();node=child;
                if(node==null) throw new DisplayExecutor.BackendException("TARGET_MISSING",false);
            }
            if(node.getWindowId()!=frame.windowId || !frame.packageName.equals(text(node.getPackageName()))
                    || !node.isEnabled() || !node.isVisibleToUser()) throw new DisplayExecutor.BackendException("TARGET_MISSING",false);
            AccessibilityNodeInfo result=node;node=null;return result;
        } finally {if(node!=null)node.recycle();}
    }
    public static JSONObject nodeArguments(Frame frame, String op, JSONObject args) throws Exception {
        try (Node node = new Node(resolve(frame,args.optString("element_id","")))) {
            if(protectedInput(node.value))throw new DisplayExecutor.BackendException("PROTECTED_INPUT",false);
            if("long_press".equals(op)) {
                Rect b=new Rect();node.value.getBoundsInScreen(b);
                if(b.isEmpty())throw new DisplayExecutor.BackendException("TARGET_MISSING",false);
                return new JSONObject(args.toString()).put("x",b.centerX()).put("y",b.centerY());
            }
            return args;
        }
    }
    public static void nodeEffect(Frame frame, String op, JSONObject args, BooleanSupplier allowed) throws Exception {
        try (Node node = new Node(resolve(frame,args.optString("element_id","")))) {
            AccessibilityNodeInfo target=node.value;
            if(protectedInput(target))throw new DisplayExecutor.BackendException("PROTECTED_INPUT",false);
            int action; Bundle bundle=null;
            if("input_text".equals(op)) {
                if(!target.isEditable() || !TypingPolicy.textAllowed(args.optString("text",null),args.optString("mode","")))
                    throw new DisplayExecutor.BackendException("TARGET_MISSING",false);
                String value=args.getString("text");
                if("insert".equals(args.getString("mode"))) {
                    String before=target.getText()==null?"":target.getText().toString();
                    int start=target.getTextSelectionStart(),end=target.getTextSelectionEnd();
                    if(start<0||end<0||start>before.length()||end>before.length())throw new DisplayExecutor.BackendException("TARGET_MISSING",false);
                    value=before.substring(0,Math.min(start,end))+value+before.substring(Math.max(start,end));
                }
                if(value.length()>20000)throw new DisplayExecutor.BackendException("INVALID_ARGUMENT",false);
                action=AccessibilityNodeInfo.ACTION_SET_TEXT;bundle=new Bundle();bundle.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,value);
            } else {
                String direction=args.optString("direction","");
                if(!"forward".equals(direction)&&!"backward".equals(direction))throw new DisplayExecutor.BackendException("INVALID_ARGUMENT",false);
                action="forward".equals(direction)?AccessibilityNodeInfo.ACTION_SCROLL_FORWARD:AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD;
            }
            boolean supported=false;for(AccessibilityNodeInfo.AccessibilityAction candidate:target.getActionList())if(candidate.getId()==action)supported=true;
            if(!supported)throw new DisplayExecutor.BackendException("TARGET_MISSING",false);
            if(!allowed.getAsBoolean()||!frame.stillCurrent())throw new DisplayExecutor.BackendException("LOCALLY_PAUSED",false);
            // From this point, a lost binder result cannot be called not-executed.
            try { if(!target.performAction(action,bundle))throw new DisplayExecutor.BackendException("ACTION_UNCONFIRMED",true); }
            catch(DisplayExecutor.BackendException error){throw error;}
            catch(RuntimeException error){throw new DisplayExecutor.BackendException("ACTION_UNCONFIRMED",true);}
        }
    }
    private record Node(AccessibilityNodeInfo value) implements AutoCloseable { @Override public void close(){value.recycle();} }
}
