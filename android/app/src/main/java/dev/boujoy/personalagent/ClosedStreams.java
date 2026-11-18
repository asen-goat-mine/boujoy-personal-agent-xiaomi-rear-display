package dev.boujoy.personalagent;

import java.util.*;
import java.util.function.LongSupplier;

/** Short-lived transport tombstones; never stores or replays application bytes. */
final class ClosedStreams {
    static final long TTL_MILLIS=30_000;
    static final int MAX_ENTRIES=1024;
    private static final class Entry {
        final long at; final boolean initiated; boolean opened;
        Entry(long at,boolean opened,boolean initiated){this.at=at;this.opened=opened;this.initiated=initiated;}
    }
    private final LinkedHashMap<Integer,Entry> entries=new LinkedHashMap<>();
    private final LongSupplier clock;
    private final long ttl;
    private final int limit;
    ClosedStreams(){this(()->System.nanoTime()/1_000_000,TTL_MILLIS,MAX_ENTRIES);}
    ClosedStreams(LongSupplier clock,long ttl,int limit){
        if(ttl<=0||ttl>TTL_MILLIS||limit<=0||limit>MAX_ENTRIES)throw new IllegalArgumentException("Invalid closed stream limits");
        this.clock=clock;this.ttl=ttl;this.limit=limit;
    }
    private void prune(){long now=clock.getAsLong();entries.entrySet().removeIf(item->now-item.getValue().at>=ttl);}
    synchronized void remember(int id,boolean opened,boolean initiated){
        prune();if(id<=0||entries.containsKey(id))return;
        entries.put(id,new Entry(clock.getAsLong(),opened,initiated));
        while(entries.size()>limit)entries.remove(entries.keySet().iterator().next());
    }
    synchronized boolean contains(int id){prune();return entries.containsKey(id);}
    synchronized boolean ignoreBinary(int id){prune();Entry value=entries.get(id);return value!=null&&value.opened;}
    synchronized boolean acceptLateOpened(int id){
        prune();Entry value=entries.get(id);
        if(value==null||value.opened||!value.initiated)return false;
        value.opened=true;return true;
    }
    synchronized void clear(){entries.clear();}
}
