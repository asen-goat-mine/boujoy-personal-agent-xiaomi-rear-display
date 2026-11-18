package dev.boujoy.personalagent;

import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import javax.net.ssl.*;
import java.util.zip.GZIPInputStream;

/** Restricted HTTP over an inner mTLS socket. An actual loopback socket keeps Android JSSE portable. */
public final class GatewayClient {
    public record Response(int status,byte[] body,String contentType,Map<String,String> headers){
        public Response(int status,byte[] body,String contentType){this(status,body,contentType,Map.of());}
        public JSONObject json()throws Exception{try{return new JSONObject(new String(body,StandardCharsets.UTF_8));}catch(org.json.JSONException e){throw new TransportFailure("json",body.length,e);}}
    }
    /** Only static phase names and byte counts may leave the transport diagnostics. */
    public static final class TransportFailure extends IOException {
        public final String phase;public final int receivedBytes;public final String streamDiagnostic;
        TransportFailure(String phase,int receivedBytes,Exception cause){this(phase,receivedBytes,cause,null);}
        TransportFailure(String phase,int receivedBytes,Exception cause,Tunnel.Stream stream){super("电脑响应暂未就绪，正在重试",cause);this.phase=phase;this.receivedBytes=receivedBytes;this.streamDiagnostic=stream==null?"":stream.transportDiagnostic();}
    }
    private static final class IntegrityFailure extends IOException {IntegrityFailure(){super("文件校验失败，请重新下载");}}
    public static final class ProtocolFailure extends IOException {ProtocolFailure(){super("Invalid gateway HTTP framing");}}
    private static final String TYPING_POLL = "/v1/device/typing?typingProtocol=2";
    private static final String DISPLAY_POLL = "/v1/device/display?protocol=1";
    private final Tunnel tunnel;
    private final SSLContext tls;
    public GatewayClient(Tunnel tunnel,Binding binding)throws Exception{this.tunnel=tunnel;tls=new DeviceIdentity(binding.identityAlias).context(binding.gatewayPin);}
    GatewayClient(Tunnel tunnel,SSLContext context){this.tunnel=tunnel;tls=context;}
    public Response request(String method,String path,JSONObject value,boolean control)throws Exception{
        boolean typingPoll = "GET".equals(method) && control && value == null && TYPING_POLL.equals(path);
        boolean displayPoll = "GET".equals(method) && !control && value == null && DISPLAY_POLL.equals(path);
        if(!Set.of("GET","POST").contains(method) || (!typingPoll && !displayPoll && !path.matches("/v1/[A-Za-z0-9/_-]+")))
            throw new IllegalArgumentException("Unsupported remote request");
        byte[] body=value==null?new byte[0]:value.toString().getBytes(StandardCharsets.UTF_8);
        if(body.length>(path.equals("/v1/messages")||path.equals("/v1/voice/transcribe")?12:6)*1024*1024)throw new IOException("附件超过上传限制");
        return exchange(method,path,new ByteArrayInputStream(body),body.length,"application/json","",control,null,8L*1024*1024);
    }
    public JSONObject upload(File file,String name,String mime)throws Exception{
        if(file.length()<=0||file.length()>AttachmentDrafts.limit(mime))throw new IOException("附件超过上传限制");
        if(name==null||name.isBlank()||name.length()>200||mime==null||!mime.matches("[\\w.+-]+/[\\w.+-]+"))throw new IOException("附件格式无效");
        try(InputStream input=new FileInputStream(file)){
            Response response=exchange("POST","/v1/uploads",input,file.length(),mime,"X-File-Name: "+java.net.URLEncoder.encode(name,StandardCharsets.UTF_8).replace("+","%20")+"\r\n",false,null,8L*1024*1024);
            return checked(response);
        }
    }
    public interface Progress {void update(long received,long total);}
    public long download(String id,File file)throws Exception{return download(id,file,(received,total)->{});}
    public long download(String id,File file,Progress progress)throws Exception{
        if(id==null||!id.matches("[A-Za-z0-9_-]{1,128}"))throw new IllegalArgumentException("Invalid artifact");
        final long chunkSize=1024L*1024,maxSize=600L*1024*1024;
        boolean complete=false;long offset=0,total=-1;String expected=null;
        try{
            do{
                Response response=null;long before=offset;progress.update(offset,total);
                for(int attempt=0;attempt<3;attempt++){
                    try(RandomAccessFile reset=new RandomAccessFile(file,"rw")){reset.setLength(offset);}
                    try(OutputStream output=new FileOutputStream(file,true)){
                        response=exchange("GET","/v1/artifacts/"+id,new ByteArrayInputStream(new byte[0]),0,"application/json",
                            "Range: bytes="+offset+"-"+(offset+chunkSize-1)+"\r\n"+(expected==null?"":"If-Match: \""+expected+"\"\r\n"),false,new ProgressOutput(output,offset,total,progress),maxSize-offset);
                        break;
                    }catch(TransportFailure failure){if(attempt==2||failure.getCause() instanceof ProtocolFailure||failure.getCause() instanceof IntegrityFailure||failure.getCause() instanceof SSLHandshakeException)throw failure;}
                }
                if(response==null)throw new IOException("文件读取未完成");
                if(response.status()==200&&offset==0){complete=true;return file.length();} // Older desktop builds retain full-body downloads.
                if(response.status()!=206){if(response.status()<200||response.status()>=300)checked(response);throw new IOException("文件分段响应无效");}
                java.util.regex.Matcher range=java.util.regex.Pattern.compile("bytes (\\d+)-(\\d+)/(\\d+)").matcher(response.headers().getOrDefault("content-range",""));
                if(!range.matches())throw new IOException("文件分段范围无效");
                long start=Long.parseLong(range.group(1)),end=Long.parseLong(range.group(2)),length=Long.parseLong(range.group(3));
                String checksum=response.headers().getOrDefault("x-artifact-sha256","");
                if(start!=offset||end<start||end-start>=chunkSize||length<=end||length>maxSize||(total>=0&&total!=length)||file.length()!=end+1||!checksum.matches("[a-fA-F0-9]{64}")||(expected!=null&&!expected.equalsIgnoreCase(checksum)))throw new IOException("文件已变化或分段校验失败，请重新下载");
                expected=checksum;total=length;offset=end+1;
                if(offset<=before)throw new IOException("文件读取未推进");
            }while(offset<total);
            java.security.MessageDigest digest=java.security.MessageDigest.getInstance("SHA-256");
            try(InputStream input=new FileInputStream(file)){byte[] buffer=new byte[32768];int count;while((count=input.read(buffer))!=-1)digest.update(buffer,0,count);}
            if(!hex(digest.digest()).equalsIgnoreCase(expected))throw new IntegrityFailure();
            complete=true;return file.length();
        }finally{if(!complete)file.delete();}
    }
    public long downloadPreview(String id,File file)throws Exception{return download(id,file,true);}
    private long download(String id,File file,boolean preview)throws Exception{
        if(id==null||!id.matches("[A-Za-z0-9_-]{1,128}"))throw new IllegalArgumentException("Invalid artifact");
        boolean complete=false;try(OutputStream output=new FileOutputStream(file)){
            Response response=exchange("GET","/v1/artifacts/"+id+(preview?"/preview":""),new ByteArrayInputStream(new byte[0]),0,"application/json","",false,output,(preview?2L:600L)*1024*1024);
            if(response.status()<200||response.status()>=300)checked(response);output.flush();complete=true;
        }finally{if(!complete)file.delete();}return file.length();
    }
    private Response exchange(String method,String path,InputStream body,long bodyLength,String mime,String extraHeaders,boolean control,OutputStream destination,long limit)throws Exception{
        int responseTimeout=destination!=null||path.equals("/v1/uploads")?120000:path.equals("/v1/voice/transcribe")||path.endsWith("/speech")?70000:15000;
        Tunnel.Stream stream;try{stream=tunnel.openChat(control);}catch(Exception e){throw new TransportFailure("stream_open",0,e);}
        Socket endpoint=null;SSLSocket secure=null;
        String phase="tls";ByteArrayOutputStream result=new ByteArrayOutputStream();BoundedOutput received=null;
        try(ServerSocket listener=new ServerSocket(0,1,InetAddress.getByName("127.0.0.1"))){
            endpoint=new Socket("127.0.0.1",listener.getLocalPort());Socket pump=listener.accept();
            endpoint.setTcpNoDelay(true);endpoint.setSoTimeout(responseTimeout);pump.setTcpNoDelay(true);stream.bridge(pump);
            secure=(SSLSocket)tls.getSocketFactory().createSocket(endpoint,"boujoy.gateway",443,true);
            secure.setEnabledProtocols(new String[]{"TLSv1.3"});secure.setUseClientMode(true);secure.setSoTimeout(responseTimeout);
            secure.startHandshake();phase="http_write";
            OutputStream output=secure.getOutputStream();
            String headers=method+" "+path+" HTTP/1.1\r\nHost: boujoy.gateway\r\nAccept: application/json\r\nConnection: close\r\nContent-Type: "+mime+"\r\nContent-Length: "+bodyLength+"\r\n"+extraHeaders+(destination==null?"Accept-Encoding: gzip\r\n":"")+"\r\n";
            output.write(headers.getBytes(StandardCharsets.US_ASCII));copy(body,output,bodyLength);output.flush();
            BufferedInputStream input=new BufferedInputStream(secure.getInputStream());
            phase="http_status";String statusLine=line(input);String[] parts=statusLine.split(" ",3);if(parts.length<2||!parts[0].startsWith("HTTP/1."))throw new ProtocolFailure();
            int status=Integer.parseInt(parts[1]),headerBytes=0;Map<String,String> responseHeaders=new HashMap<>();
            phase="http_headers";for(String header;(header=line(input)).length()>0;){headerBytes+=header.length();if(headerBytes>16384)throw new ProtocolFailure();int colon=header.indexOf(':');if(colon<1)throw new ProtocolFailure();String key=header.substring(0,colon).toLowerCase(Locale.ROOT);if(responseHeaders.put(key,header.substring(colon+1).trim())!=null&&Set.of("content-length","transfer-encoding","content-encoding").contains(key))throw new ProtocolFailure();}
            phase="http_body";String encoding=responseHeaders.get("transfer-encoding");
            if(encoding!=null&&(!"chunked".equalsIgnoreCase(encoding)||responseHeaders.containsKey("content-length")))throw new ProtocolFailure();
            boolean toFile=destination!=null&&status>=200&&status<300;
            String contentEncoding=responseHeaders.getOrDefault("content-encoding","identity");
            if(!"identity".equalsIgnoreCase(contentEncoding)&&(!"gzip".equalsIgnoreCase(contentEncoding)||toFile))throw new ProtocolFailure();
            received=new BoundedOutput(toFile?destination:result,toFile?limit:8L*1024*1024);
            if("chunked".equalsIgnoreCase(encoding)){
                while(true){String chunk=line(input).split(";",2)[0];long size=Long.parseLong(chunk,16);if(size==0){int trailers=0;while(!line(input).isEmpty())if(++trailers>32)throw new ProtocolFailure();break;}copy(input,received,size);if(!line(input).isEmpty())throw new ProtocolFailure();}
            }else if(responseHeaders.containsKey("content-length"))copy(input,received,Long.parseLong(responseHeaders.get("content-length")));
            else {byte[] buffer=new byte[32768];int count;while((count=input.read(buffer))!=-1)received.write(buffer,0,count);}
            if(toFile){String expected=responseHeaders.get("x-content-sha256");if(expected!=null&&!hex(received.hash.digest()).equalsIgnoreCase(expected))throw new IntegrityFailure();}
            byte[] decoded=result.toByteArray();
            if("gzip".equalsIgnoreCase(contentEncoding)){
                phase="http_decode";ByteArrayOutputStream expanded=new ByteArrayOutputStream();
                BoundedOutput bounded=new BoundedOutput(expanded,8L*1024*1024);
                try(GZIPInputStream gzip=new GZIPInputStream(new ByteArrayInputStream(decoded))){byte[] buffer=new byte[32768];int count;while((count=gzip.read(buffer))!=-1)bounded.write(buffer,0,count);}
                decoded=expanded.toByteArray();
            }
            return new Response(status,decoded,responseHeaders.getOrDefault("content-type","application/octet-stream"),Map.copyOf(responseHeaders));
        }catch(Exception e){throw new TransportFailure(phase,received==null?0:(int)Math.min(Integer.MAX_VALUE,received.count),e,stream);
        }finally{try{if(secure!=null)secure.close();else if(endpoint!=null)endpoint.close();}catch(IOException ignored){}stream.close();}
    }
    private static final class ProgressOutput extends FilterOutputStream {
        final Progress progress;final long total;long received,lastAt;
        ProgressOutput(OutputStream output,long offset,long total,Progress progress){super(output);received=offset;this.total=total;this.progress=progress;}
        @Override public void write(int value)throws IOException{out.write(value);report(1);}
        @Override public void write(byte[] bytes,int offset,int count)throws IOException{out.write(bytes,offset,count);report(count);}
        private void report(int count){received+=count;long now=System.nanoTime();if(now-lastAt>=200000000L){lastAt=now;progress.update(received,total);}}
    }
    private static final class BoundedOutput extends OutputStream {
        final OutputStream out;final long limit;long count;final java.security.MessageDigest hash;
        BoundedOutput(OutputStream out,long limit)throws Exception{this.out=out;this.limit=limit;hash=java.security.MessageDigest.getInstance("SHA-256");}
        @Override public void write(int b)throws IOException{write(new byte[]{(byte)b},0,1);}
        @Override public void write(byte[] b,int off,int len)throws IOException{if(count+len>limit)throw new IOException("Gateway response exceeds limit");out.write(b,off,len);hash.update(b,off,len);count+=len;}
    }
    JSONObject pollTyping()throws Exception{
        return json("GET",TYPING_POLL,null,true);
    }
    JSONObject pollDisplay()throws Exception{
        return json("GET",DISPLAY_POLL,null,false);
    }
    public JSONObject json(String method,String path,JSONObject value,boolean control)throws Exception{
        return checked(request(method,path,value,control));
    }
    private static JSONObject checked(Response response)throws Exception{JSONObject result=response.json();
        if(response.status<200||response.status>=300){JSONObject error=result.optJSONObject("error");throw new GatewayError(response.status,error==null?"request_rejected":error.optString("code","request_rejected"),error==null?result.optString("message","请求未被电脑接受"):error.optString("message","请求未被电脑接受"));}
        return result;
    }
    public JSONObject pair(Binding pending)throws Exception{
        if(pending==null||pending.pairToken.isBlank())throw new IllegalStateException("缺少原绑定凭证，请在电脑检查绑定状态");
        // Imports still require an unexpired code. A persisted pending binding may
        // have committed before its reply was lost: reuse this pinned mTLS client
        // and original token, letting the Mac distinguish recovery from expiry.
        JSONObject result=json("POST","/v1/pair",Tunnel.json("pairToken",pending.pairToken,"clientName",BuildConfig.PRODUCT_NAME,"edition",BuildConfig.EDITION,"androidApplicationId",BuildConfig.APPLICATION_ID),true);
        if(!Boolean.TRUE.equals(result.opt("paired"))||!pending.deviceId.equals(result.optString("deviceId")))
            throw new IOException("电脑绑定回执与当前设备不一致，已停止连接");
        return result;
    }
    public static final class GatewayError extends IOException{public final int status;public final String code;GatewayError(int status,String code,String message){super(message);this.status=status;this.code=code;}}
    private static String hex(byte[] bytes){StringBuilder text=new StringBuilder(bytes.length*2);for(byte b:bytes)text.append(Character.forDigit((b&255)>>>4,16)).append(Character.forDigit(b&15,16));return text.toString();}
    private static void copy(InputStream input,OutputStream output,long bytes)throws IOException{
        if(bytes<0||bytes>600L*1024*1024)throw new ProtocolFailure();
        if(output instanceof BoundedOutput bounded&&bounded.count+bytes>bounded.limit)throw new IOException("Gateway response exceeds limit");
        byte[] buffer=new byte[32768];long remaining=bytes;
        while(remaining>0){int count=input.read(buffer,0,(int)Math.min(buffer.length,remaining));if(count<0)throw new EOFException();output.write(buffer,0,count);remaining-=count;}
    }
    private static String line(InputStream input)throws IOException{
        ByteArrayOutputStream buffer=new ByteArrayOutputStream();int value;
        while((value=input.read())!=-1){if(value==10){byte[] bytes=buffer.toByteArray();if(bytes.length==0||bytes[bytes.length-1]!=13)throw new ProtocolFailure();return new String(bytes,0,bytes.length-1,StandardCharsets.US_ASCII);}buffer.write(value);if(buffer.size()>8192)throw new ProtocolFailure();}
        throw new EOFException("Gateway closed before response");
    }
}
