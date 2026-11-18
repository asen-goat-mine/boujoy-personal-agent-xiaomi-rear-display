package dev.boujoy.personalagent;

import java.util.concurrent.*;

/** Slow background I/O must not block local message durability or an explicit control request. */
public final class MobileWorkers implements AutoCloseable {
    public final ScheduledExecutorService connection=Executors.newSingleThreadScheduledExecutor();
    public final ExecutorService maintenance=Executors.newSingleThreadExecutor();
    public final ExecutorService telemetry=Executors.newSingleThreadExecutor();
    public final ExecutorService notifications=Executors.newSingleThreadExecutor();
    public final ExecutorService receipts=Executors.newSingleThreadExecutor();
    public final ExecutorService messages=Executors.newSingleThreadExecutor();
    public final ExecutorService persistence=Executors.newSingleThreadExecutor();
    public final ExecutorService control=Executors.newSingleThreadExecutor();
    public final ExecutorService files=Executors.newSingleThreadExecutor();
    public final ExecutorService voice=Executors.newSingleThreadExecutor();
    public final ExecutorService history=Executors.newFixedThreadPool(2);
    public final ExecutorService display=Executors.newSingleThreadExecutor();
    public final ExecutorService rearProgress=Executors.newSingleThreadExecutor();
    public final ExecutorService typing=Executors.newSingleThreadExecutor();
    @Override public void close(){connection.shutdownNow();maintenance.shutdownNow();telemetry.shutdownNow();notifications.shutdownNow();receipts.shutdownNow();messages.shutdownNow();persistence.shutdownNow();control.shutdownNow();files.shutdownNow();voice.shutdownNow();history.shutdownNow();typing.shutdownNow();display.shutdownNow();rearProgress.shutdownNow();}
}
