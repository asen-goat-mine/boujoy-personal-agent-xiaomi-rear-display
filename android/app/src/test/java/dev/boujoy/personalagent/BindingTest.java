package dev.boujoy.personalagent;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class BindingTest {
    JSONObject good()throws Exception{return new JSONObject().put("edition",BuildConfig.EDITION).put("androidApplicationId",BuildConfig.APPLICATION_ID).put("relayUrl","wss://relay.example.test/v1/tunnel")
            .put("deviceId","test-device").put("routeToken","x".repeat(32)).put("gatewayPin","sha256/"+"a".repeat(43)+"=")
            .put("pairToken","y".repeat(32)).put("expiresAt",System.currentTimeMillis()+60000);}
    @Test public void pinnedWssBindingAccepted()throws Exception{assertEquals("wss://relay.example.test/v1/tunnel",new Binding(good(),true).endpoint());}
    @Test public void noPlaintextOrCredentialBearingRelay()throws Exception{
        for(String value:new String[]{"ws://relay.example.test","wss://user:pass@relay.example.test","wss://relay.example.test?token=secret"}){
            JSONObject input=good().put("relayUrl",value);assertThrows(IllegalArgumentException.class,()->new Binding(input,true));
        }
    }
    @Test public void expiresOnlyBootstrapNotEstablishedIdentity()throws Exception{
        JSONObject input=good().put("expiresAt",1);assertThrows(IllegalArgumentException.class,()->new Binding(input,true));assertNotNull(new Binding(input,false));
    }
    @Test public void importUsesSameIdentityAndPathRulesAsProductionRelay()throws Exception{
        for(JSONObject input:new JSONObject[]{good().put("deviceId","x:y"),good().put("routeToken","x".repeat(24)),good().put("relayUrl","wss://relay.example.test/arbitrary-path")}){
            assertThrows(IllegalArgumentException.class,()->new Binding(input,true));
        }
    }
    @Test public void anotherEditionPrivatePackageAndMissingIdentityAreRejected()throws Exception{
        for(JSONObject value:new JSONObject[]{good().put("edition","other"),good().put("androidApplicationId","dev.boujoy.personalagent"),good().put("edition",JSONObject.NULL),good().put("androidApplicationId",JSONObject.NULL)}){
            assertThrows(IllegalArgumentException.class,()->new Binding(value,true));
            assertThrows(IllegalArgumentException.class,()->new Binding(value,false));
        }
    }
}
