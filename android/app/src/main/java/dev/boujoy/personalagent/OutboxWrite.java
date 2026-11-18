package dev.boujoy.personalagent;
import org.json.*;

/** Caller holds the outbox lock. A failed durable insert must not remain eligible for dispatch. */
public final class OutboxWrite {
    public interface Writer { void write(JSONObject rows)throws Exception; }
    private OutboxWrite() {}
    public static void insert(JSONObject rows,String id,JSONObject row,Writer writer)throws Exception{
        if(rows.has(id))throw new IllegalStateException("这条消息已保存，未重复发送");
        rows.put(id,row);try{writer.write(rows);}catch(Exception error){rows.remove(id);throw error;}
    }
}
