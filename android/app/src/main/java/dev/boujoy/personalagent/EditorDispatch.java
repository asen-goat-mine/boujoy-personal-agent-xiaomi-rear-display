package dev.boujoy.personalagent;
import java.util.concurrent.atomic.AtomicInteger;
/** Atomically separates definitely-unsent timeouts from a possible text commit. */
public final class EditorDispatch {
    private final AtomicInteger phase = new AtomicInteger(); // 0 preparing, 1 commit possible, 2 stopped before commit
    public boolean beginCommit() { return phase.compareAndSet(0, 1); }
    public boolean stopBeforeCommit() { return phase.compareAndSet(0, 2); }
    public boolean mayHaveCommitted() { return phase.get() == 1; }
}
