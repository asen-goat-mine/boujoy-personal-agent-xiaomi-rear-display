package dev.boujoy.personalagent;
import org.json.*;import org.junit.Test;import static org.junit.Assert.*;
public class OutboxWriteTest {
    @Test public void failedDiskWriteLeavesNoInMemoryCommandForAFuturePollToSend()throws Exception{
        JSONObject rows=new JSONObject();try{OutboxWrite.insert(rows,"new",Tunnel.json("message","never-send"),value->{assertTrue(value.has("new"));throw new java.io.IOException("disk full");});fail();}catch(java.io.IOException expected){}assertFalse(rows.has("new"));
        OutboxWrite.insert(rows,"new",Tunnel.json("message","explicit retry"),value->{});assertEquals("explicit retry",rows.getJSONObject("new").getString("message"));
    }
    @Test public void duplicateInsertCannotReplaceAnAcceptedCommandOrWriteAgain()throws Exception{
        JSONObject rows=Tunnel.json("same",Tunnel.json("message","original","everSent",true));try{OutboxWrite.insert(rows,"same",Tunnel.json("message","replacement"),value->fail("must not persist duplicate"));fail();}catch(IllegalStateException expected){}assertEquals("original",rows.getJSONObject("same").getString("message"));assertTrue(rows.getJSONObject("same").getBoolean("everSent"));
    }
}
