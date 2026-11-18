package dev.boujoy.personalagent;

import java.util.*;

/** A request stays in flight until its receipt or failure; duplicate producers cannot dispatch it twice. */
public final class RequestFlights {
    private final Set<String> pending=new LinkedHashSet<>();
    public synchronized boolean begin(String task){return pending.add(task);}
    public synchronized void end(String task){pending.remove(task);}
    public synchronized boolean contains(String task){return pending.contains(task);}
    public synchronized List<String> snapshot(){return List.copyOf(pending);}
}
