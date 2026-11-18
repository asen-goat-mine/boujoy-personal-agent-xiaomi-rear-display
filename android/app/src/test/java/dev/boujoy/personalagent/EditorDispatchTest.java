package dev.boujoy.personalagent;
import org.junit.Test;
import static org.junit.Assert.*;
public class EditorDispatchTest {
    @Test public void timeoutBeforeCommitPreventsEveryLateCommit() {
        EditorDispatch d=new EditorDispatch();assertTrue(d.stopBeforeCommit());assertFalse(d.beginCommit());assertFalse(d.mayHaveCommitted());assertFalse(d.beginCommit());
    }
    @Test public void onceCommitCanBeSentTimeoutCannotCallItUnsentOrPermitASecondCommit() {
        EditorDispatch d=new EditorDispatch();assertTrue(d.beginCommit());assertFalse(d.stopBeforeCommit());assertTrue(d.mayHaveCommitted());assertFalse(d.beginCommit());
    }
}
