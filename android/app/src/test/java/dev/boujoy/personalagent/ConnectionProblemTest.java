package dev.boujoy.personalagent;
import org.junit.Test;
import static org.junit.Assert.*;
import java.net.*;
import javax.net.ssl.*;
public class ConnectionProblemTest {
    @Test public void categoriesNeverExposeExceptionTextOrUrl() {
        String secret="https://private.invalid?token=private-secret";
        assertEquals("tls_identity",ConnectionProblem.classify(new SSLPeerUnverifiedException(secret),0));
        assertEquals("tls_handshake",ConnectionProblem.classify(new SSLHandshakeException(secret),0));
        assertEquals("network_timeout",ConnectionProblem.classify(new RuntimeException(secret,new SocketTimeoutException(secret)),0));
        assertEquals("dns_unavailable",ConnectionProblem.classify(new UnknownHostException(secret),0));
        assertEquals("relay_rejected",ConnectionProblem.classify(new Exception(secret),403));
        assertEquals("relay_http",ConnectionProblem.classify(new Exception(secret),503));
        assertEquals("connection_failed",ConnectionProblem.classify(new Exception(secret),0));
        assertFalse(ConnectionProblem.message(secret).contains(secret));
    }
    @Test public void responseDiagnosticsKeepOnlyPhaseCountsTypesAndApplicationFrames(){
        String secret="private-token-and-message-body";
        Exception eof=new java.io.EOFException(secret);eof.setStackTrace(new StackTraceElement[]{new StackTraceElement("dev.boujoy.personalagent.GatewayClient","copy","GatewayClient.java",90),new StackTraceElement("external.example.Private",secret,"private-file",1)});
        GatewayClient.TransportFailure failure=new GatewayClient.TransportFailure("http_body",180000,eof);
        String diagnostic=ConnectionProblem.diagnostic(failure);
        assertEquals("response_eof",ConnectionProblem.classify(failure,0));assertTrue(diagnostic.contains("phase=http_body"));assertTrue(diagnostic.contains("receivedBytes=180000"));
        assertTrue(diagnostic.contains("GatewayClient.copy:90"));assertFalse(diagnostic.contains(secret));assertFalse(diagnostic.contains("private-file"));
        assertEquals("response_json",ConnectionProblem.classify(new GatewayClient.TransportFailure("json",12,new org.json.JSONException(secret)),0));
        assertEquals("http_framing",ConnectionProblem.classify(new GatewayClient.TransportFailure("http_headers",0,new GatewayClient.ProtocolFailure()),0));
        assertFalse(ConnectionProblem.diagnostic(new org.json.JSONException(secret)).contains(secret));
    }
    @Test public void websocketPolicyCloseDoesNotAssumeBindingFailure(){
        assertEquals("connection_replaced",ConnectionProblem.webSocketClose(1008,"connection replaced"));
        assertEquals("protocol_invalid",ConnectionProblem.webSocketClose(1008,"protocol rejected"));
        assertEquals("network_timeout",ConnectionProblem.webSocketClose(1008,"authentication timeout"));
        assertEquals("relay_closed",ConnectionProblem.webSocketClose(1008,"private token"));
        assertEquals("relay_rejected",ConnectionProblem.webSocketClose(1008,"Authentication rejected"));
        assertEquals("protocol_invalid",ConnectionProblem.webSocketClose(1002,"anything"));
        assertEquals("relay_capacity",ConnectionProblem.webSocketClose(1009,"buffer limit"));
        assertFalse(ConnectionProblem.message("connection_replaced").contains("绑定"));
        assertFalse(ConnectionProblem.message("relay_closed").contains("绑定"));
    }
    @Test public void websocketCloseDiagnosticsNeverEchoArbitraryReasonOrLane(){
        String secret="wss://private.invalid?token=private-secret";
        String safe=ConnectionProblem.closeDiagnostic(secret,1008,secret);
        assertEquals("lane=unknown closeCode=1008 closeReason=other",safe);assertFalse(safe.contains(secret));
        assertEquals("lane=data closeCode=1008 closeReason=connection_replaced",ConnectionProblem.closeDiagnostic("data",1008,"connection replaced"));
        assertEquals("none",ConnectionProblem.closeReason(null));assertEquals("other",ConnectionProblem.streamCloseReason(secret));
    }
    @Test public void handshakeEofIsNotLabeledACertificateFailure(){
        SSLHandshakeException interrupted=new SSLHandshakeException("private handshake text");interrupted.initCause(new java.io.EOFException("private eof text"));
        assertEquals("response_eof",ConnectionProblem.classify(interrupted,0));
        assertFalse(ConnectionProblem.message("tls_handshake").contains("证书"));
        SSLHandshakeException certificate=new SSLHandshakeException("private certificate text");certificate.initCause(new java.security.cert.CertificateException("private certificate"));
        assertEquals("tls_identity",ConnectionProblem.classify(certificate,0));
    }

}
