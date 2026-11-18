package dev.boujoy.personalagent;
import org.junit.Test;
import static org.junit.Assert.*;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.Arrays;

public class ProtocolTest {
    @Test public void frameMatchesNodeWireFormat()throws Exception{
        byte[] encoded=Protocol.encode(0x01020305,new byte[]{10,20,30},0,3);
        assertArrayEquals(new byte[]{1,1,2,3,5,10,20,30},encoded);
        assertEquals(0x01020305,Protocol.decode(encoded).streamId());
        assertArrayEquals(new byte[]{10,20,30},Protocol.decode(encoded).payload());
    }
    @Test public void acceptsNode64kFrames()throws Exception{
        byte[] frame=new byte[65536+5];frame[0]=1;ByteBuffer.wrap(frame,1,4).putInt(2);
        assertEquals(65536,Protocol.decode(frame).payload().length);
    }
    @Test public void rejectsMalformedFrames(){
        for(byte[] value:new byte[][]{new byte[0],new byte[]{1,0,0,0,1},new byte[]{2,0,0,0,1,8},new byte[]{1,0,0,0,0,8},new byte[65542]}){
            assertThrows(IOException.class,()->Protocol.decode(value));
        }
    }
    @Test public void urgentLaneCannotAdmitPhoneData(){
        assertTrue(Protocol.kindAllowed("control","phone-control"));
        assertTrue(Protocol.kindAllowed("control","chat-control"));
        assertFalse(Protocol.kindAllowed("control","phone-data"));
        assertFalse(Protocol.kindAllowed("data","phone-control"));
        assertFalse(Protocol.kindAllowed("other","chat"));
    }
}
