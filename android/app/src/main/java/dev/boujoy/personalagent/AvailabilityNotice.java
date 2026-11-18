package dev.boujoy.personalagent;

/** Local capability transitions only; no task text or page content enters diagnostics. */
final class AvailabilityNotice {
    record Update(boolean showShizuku, boolean showExecutor, boolean executorDisconnected, boolean shizukuStopped) {}
    private Boolean executorConnected;
    private String shizuku;
    synchronized Update step(boolean background, String currentShizuku, boolean connected) {
        boolean disconnected=Boolean.TRUE.equals(executorConnected)&&!connected;
        boolean stopped="running".equals(shizuku)&&"not_running".equals(currentShizuku);
        executorConnected=connected;shizuku=currentShizuku;
        return new Update(background&&"not_running".equals(currentShizuku),background&&!connected,disconnected,stopped);
    }
}
