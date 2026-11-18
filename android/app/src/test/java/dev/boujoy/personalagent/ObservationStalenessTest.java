package dev.boujoy.personalagent;
import static org.junit.Assert.*;
import android.view.accessibility.AccessibilityEvent;
import org.junit.Test;
/** Window/package replacement is checked separately; only a newly covering pane expires a window. */
public class ObservationStalenessTest {
    @Test public void onlyNewPaneContentEventsInvalidate() {
        assertTrue(BoujoyDisplayService.invalidatesObservation(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED, AccessibilityEvent.CONTENT_CHANGE_TYPE_PANE_APPEARED));
        assertTrue(BoujoyDisplayService.invalidatesObservation(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED, AccessibilityEvent.CONTENT_CHANGE_TYPE_TEXT|AccessibilityEvent.CONTENT_CHANGE_TYPE_PANE_APPEARED));
        assertTrue(BoujoyDisplayService.invalidatesObservation(AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED, AccessibilityEvent.CONTENT_CHANGE_TYPE_PANE_APPEARED));
    }
    @Test public void ordinaryWindowAndContentNotificationsDoNotExpireSameWindow() {
        for(int type:new int[]{AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,AccessibilityEvent.TYPE_WINDOWS_CHANGED,AccessibilityEvent.TYPE_VIEW_SCROLLED,AccessibilityEvent.TYPE_VIEW_FOCUSED})assertFalse(BoujoyDisplayService.invalidatesObservation(type,0));
        for(int changes:new int[]{AccessibilityEvent.CONTENT_CHANGE_TYPE_TEXT,AccessibilityEvent.CONTENT_CHANGE_TYPE_SUBTREE,AccessibilityEvent.CONTENT_CHANGE_TYPE_PANE_DISAPPEARED,AccessibilityEvent.CONTENT_CHANGE_TYPE_PANE_TITLE})assertFalse(BoujoyDisplayService.invalidatesObservation(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,changes));
    }
}
