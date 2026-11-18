package dev.boujoy.personalagent;

import java.net.*;
import javax.net.ssl.*;
import java.io.EOFException;

/** Fixed error categories only: exception messages may contain private endpoints or credentials. */
public final class ConnectionProblem {
    private ConnectionProblem() {}
    public static String classify(Throwable error,int httpStatus) {
        if(httpStatus==401||httpStatus==403)return "relay_rejected";
        if(httpStatus>0&&httpStatus!=101)return "relay_http";
        String tlsFailure=null;
        for(int depth=0;error!=null&&depth<8;depth++,error=error.getCause()) {
            if(error instanceof EOFException)return "response_eof";
            if(error instanceof org.json.JSONException)return "response_json";
            if(error instanceof GatewayClient.ProtocolFailure||error instanceof NumberFormatException)return "http_framing";
            if(error instanceof SSLPeerUnverifiedException||error instanceof java.security.cert.CertificateException||error instanceof java.security.cert.CertPathValidatorException)return "tls_identity";
            if(error instanceof SSLHandshakeException)tlsFailure="tls_handshake";
            else if(error instanceof SSLException&&tlsFailure==null)tlsFailure="tls_transport";
            if(error instanceof UnknownHostException)return "dns_unavailable";
            if(error instanceof SocketTimeoutException)return "network_timeout";
            if(error instanceof ConnectException||error instanceof NoRouteToHostException)return "network_unreachable";
        }
        return tlsFailure==null?"connection_failed":tlsFailure;
    }
    /** Only exact public protocol phrases become diagnostic labels. Never log raw close text. */
    static String closeReason(String reason){
        if(reason==null||reason.isBlank())return "none";
        return switch(reason){
            case "connection replaced" -> "connection_replaced";
            case "authentication timeout" -> "authentication_timeout";
            case "Authentication rejected" -> "authentication_rejected";
            case "protocol rejected","Invalid protocol frame","Invalid binary frame" -> "protocol_rejected";
            case "buffer limit" -> "buffer_limit";
            default -> "other";
        };
    }
    static String webSocketClose(int code,String reason){
        String known=closeReason(reason);
        if(known.equals("connection_replaced"))return "connection_replaced";
        if(known.equals("authentication_timeout"))return "network_timeout";
        if(known.equals("authentication_rejected"))return "relay_rejected";
        if(code==1002||known.equals("protocol_rejected"))return "protocol_invalid";
        if(code==1009||known.equals("buffer_limit"))return "relay_capacity";
        // 1008 also represents replacement/protocol errors on the relay. A policy
        // close without explicit authentication evidence does not prove bad binding.
        return code==1008?"relay_closed":"disconnected";
    }
    static String closeDiagnostic(String lane,int code,String reason){
        String safeLane="control".equals(lane)?"control":"data".equals(lane)?"data":"unknown";
        return "lane="+safeLane+" closeCode="+code+" closeReason="+closeReason(reason);
    }
    static String streamCloseReason(String reason){
        return reason!=null&&java.util.Set.of("closed","open_failed","phone_unavailable","locally_paused","stale_control_epoch",
                "socket_closed","stream_closed","transport_lost","peer_offline","relay_error","backpressure").contains(reason)?reason:"other";
    }
    public static String diagnostic(Throwable error){
        StringBuilder out=new StringBuilder();int frames=0;
        for(int depth=0;error!=null&&depth<8;depth++,error=error.getCause()){
            if(depth>0)out.append(" <- ");out.append(error.getClass().getName());
            if(error instanceof GatewayClient.TransportFailure transport){out.append(" phase=").append(transport.phase).append(" receivedBytes=").append(transport.receivedBytes);if(!transport.streamDiagnostic.isEmpty())out.append(' ').append(transport.streamDiagnostic);}
            for(StackTraceElement frame:error.getStackTrace())if(frames<6&&frame.getClassName().startsWith("dev.boujoy.personalagent.")){
                out.append(" at ").append(frame.getClassName()).append('.').append(frame.getMethodName()).append(':').append(frame.getLineNumber());frames++;
            }
        }
        return out.toString();
    }
    public static String message(String code) {
        return switch(code) {
            case "tls_identity" -> "云连接证书校验失败";
            case "tls_handshake" -> "云端加密握手未完成，正在重连";
            case "tls_transport" -> "云端加密连接中断，正在重连";
            case "relay_rejected" -> "云端拒绝连接，请核实设备绑定";
            case "connection_replaced" -> "云端连接已更新，正在重新连接";
            case "relay_closed" -> "云端关闭了当前连接，正在重连";
            case "relay_capacity" -> "云端连接暂时拥堵，正在重连";
            case "relay_http" -> "云连接入口暂不可用，正在重连";
            case "dns_unavailable","network_unreachable" -> "手机暂时无法访问云端，正在重连";
            case "network_timeout" -> "云连接超时，正在重试";
            case "protocol_invalid" -> "云连接协议校验失败";
            case "response_eof" -> "电脑响应未完整收到，正在重连";
            case "response_json","http_framing" -> "电脑响应格式异常，正在重试";
            default -> "正在恢复电脑连接";
        };
    }
}
