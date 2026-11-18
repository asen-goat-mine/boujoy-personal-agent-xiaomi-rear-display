package dev.boujoy.personalagent;
import org.json.JSONObject;
/** Delivery state follows receipt evidence; it never grants permission to replay. */
public final class MessageDelivery {
    private MessageDelivery() {}
    public static String statusAfterLookup(JSONObject receipt,JSONObject message,long now){
        if(receipt.optBoolean("received"))return "received";
        long expires=Binding.parseTime(message.opt("expiresAt"));
        return "not_received".equals(receipt.optString("status"))&&expires>0&&expires<=now?"not_received":"unconfirmed";
    }
    public static String statusAfterFailure(Exception error){
        return error instanceof GatewayClient.GatewayError e&&"invalid_private_conversation".equals(e.code)?"not_received":"unconfirmed";
    }
}
