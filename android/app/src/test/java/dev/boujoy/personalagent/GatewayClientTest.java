package dev.boujoy.personalagent;

import okhttp3.*;
import okhttp3.mockwebserver.*;
import okhttp3.tls.*;
import okio.ByteString;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;
import java.io.*;
import java.net.Socket;
import java.security.*;
import java.util.*;
import java.util.concurrent.*;
import javax.net.ssl.*;

/** Real TLS 1.3 + client certificate + HTTP through both layers of the Java transport. */
public class GatewayClientTest {
    private static final class Fixture implements AutoCloseable {
        final MockWebServer relay=new MockWebServer(),gateway=new MockWebServer();
        final HeldCertificate gatewayCert=new HeldCertificate.Builder().commonName("boujoy.gateway").build();
        final HeldCertificate clientCert=new HeldCertificate.Builder().commonName("Boujoy test client").build();
        final ExecutorService io=Executors.newCachedThreadPool();
        final Set<Socket> sockets=ConcurrentHashMap.newKeySet();
        final List<String> streamKinds=new CopyOnWriteArrayList<>();
        final Tunnel tunnel;
        final HandshakeCertificates clientKeys;
        Fixture()throws Exception{
            HandshakeCertificates gatewayKeys=new HandshakeCertificates.Builder().heldCertificate(gatewayCert).addTrustedCertificate(clientCert.certificate()).build();
            gateway.useHttps(gatewayKeys.sslSocketFactory(),false);gateway.requireClientAuth();gateway.start();
            clientKeys=new HandshakeCertificates.Builder().heldCertificate(clientCert).addTrustedCertificate(gatewayCert.certificate()).build();
            HeldCertificate relayCert=new HeldCertificate.Builder().commonName("localhost").addSubjectAlternativeName("localhost").build();
            HandshakeCertificates relayKeys=new HandshakeCertificates.Builder().heldCertificate(relayCert).build();
            HandshakeCertificates outerClientKeys=new HandshakeCertificates.Builder().addTrustedCertificate(relayCert.certificate()).build();
            relay.useHttps(relayKeys.sslSocketFactory(),false);
            for(int i=0;i<2;i++)relay.enqueue(new MockResponse().withWebSocketUpgrade(new WebSocketListener(){
                final Map<Integer,Socket> streams=new ConcurrentHashMap<>();
                @Override public void onMessage(WebSocket ws,String value){try{
                    JSONObject p=new JSONObject(value);String type=p.optString("type");
                    if(type.equals("hello")){ws.send("{\"type\":\"hello\",\"version\":1,\"accepted\":true}");ws.send("{\"type\":\"peer\",\"online\":true}");}
                    if(type.equals("open")){
                        streamKinds.add(p.getString("kind"));
                        int id=p.getInt("streamId");Socket socket=new Socket("127.0.0.1",gateway.getPort());sockets.add(socket);streams.put(id,socket);
                        ws.send("{\"type\":\"opened\",\"streamId\":"+id+"}");
                        io.execute(()->{try{byte[] buffer=new byte[Protocol.MAX_CHUNK];int count;InputStream input=socket.getInputStream();while((count=input.read(buffer))!=-1)ws.send(ByteString.of(Protocol.encode(id,buffer,0,count)));}
                            catch(Exception ignored){}finally{ws.send("{\"type\":\"close\",\"streamId\":"+id+"}");streams.remove(id);sockets.remove(socket);try{socket.close();}catch(Exception ignored){}}});
                    }
                    if(type.equals("close")){Socket socket=streams.remove(p.getInt("streamId"));if(socket!=null)socket.close();}
                }catch(Exception e){ws.close(1011,"Fixture failure");}}
                @Override public void onMessage(WebSocket ws,ByteString bytes){try{Protocol.Frame frame=Protocol.decode(bytes.toByteArray());Socket socket=streams.get(frame.streamId());if(socket!=null){socket.getOutputStream().write(frame.payload());socket.getOutputStream().flush();}}catch(Exception e){ws.close(1011,"Fixture forwarding failure");}}
            }));
            relay.start();
            Binding binding=new Binding(new JSONObject().put("edition",BuildConfig.EDITION).put("androidApplicationId",BuildConfig.APPLICATION_ID).put("relayUrl",relay.url("/v1/tunnel").toString().replace("https:","wss:"))
                    .put("deviceId","fixture-device").put("routeToken","x".repeat(32)).put("gatewayPin",pin()),false);
            OkHttpClient outer=new OkHttpClient.Builder().sslSocketFactory(outerClientKeys.sslSocketFactory(),outerClientKeys.trustManager()).build();
            tunnel=new Tunnel(binding,new ControlState(new ControlStateTest.Memory()),()->{},outer);tunnel.start();
            long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);while(!tunnel.connected()&&System.nanoTime()<deadline)Thread.sleep(10);assertTrue(tunnel.connected());
        }
        String pin()throws Exception{return "sha256/"+Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(gatewayCert.certificate().getPublicKey().getEncoded()));}
        GatewayClient client(String pin)throws Exception{
            SSLContext context=SSLContext.getInstance("TLSv1.3");context.init(new KeyManager[]{clientKeys.keyManager()},new TrustManager[]{DeviceIdentity.pinnedTrust(pin)},new SecureRandom());return new GatewayClient(tunnel,context);
        }
        @Override public void close()throws Exception{
            tunnel.close();for(Socket socket:sockets)socket.close();io.shutdownNow();relay.shutdown();gateway.shutdown();
        }
    }
    @Test public void rejectsUnapprovedQueryVariantsBeforeAnyTunnelAccess(){
        GatewayClient client=new GatewayClient(null,(SSLContext)null);
        String poll="/v1/device/typing?typingProtocol=2";
        for(String path:new String[]{poll+"&extra=1",poll+"#fragment",poll+"\r\nInjected: yes","/v1/device/typing?typingProtocol=1","/v1/state?typingProtocol=2","/v1/../state","https://other.invalid/v1/state"})
            assertThrows(IllegalArgumentException.class,()->client.request("GET",path,null,true));
        assertThrows(IllegalArgumentException.class,()->client.request("POST",poll,new JSONObject(),true));
        assertThrows(IllegalArgumentException.class,()->client.request("GET",poll,new JSONObject(),true));
        assertThrows(IllegalArgumentException.class,()->client.request("GET",poll,null,false));
    }
    @Test public void displayPollOnlyAllowsExactDataChannelProtocol()throws Exception{
        GatewayClient client=new GatewayClient(null,(SSLContext)null);
        String poll="/v1/device/display?protocol=1";
        for(String path:new String[]{poll+"&extra=1",poll+"#fragment",poll+"\r\nInjected: yes","/v1/device/display?protocol=2","/v1/state?protocol=1"})
            assertThrows(IllegalArgumentException.class,()->client.request("GET",path,null,false));
        assertThrows(IllegalArgumentException.class,()->client.request("POST",poll,new JSONObject(),false));
        assertThrows(IllegalArgumentException.class,()->client.request("GET",poll,new JSONObject(),false));
        assertThrows(IllegalArgumentException.class,()->client.request("GET",poll,null,true));
        // An allowed request reaches the transport; malformed variants above never do.
        GatewayClient.TransportFailure failure=assertThrows(GatewayClient.TransportFailure.class,client::pollDisplay);
        assertEquals("stream_open",failure.phase);
    }
    @Test public void displayPollAndReceiptTravelThroughAuthenticatedDataLane()throws Exception{
        try(Fixture f=new Fixture()){
            GatewayClient client=f.client(f.pin());
            f.gateway.enqueue(new MockResponse().setHeader("Content-Type","application/json").setBody("{\"command\":null,\"serverTime\":1}"));
            assertTrue(client.pollDisplay().isNull("command"));
            RecordedRequest poll=f.gateway.takeRequest(5,TimeUnit.SECONDS);assertNotNull(poll);assertEquals("GET",poll.getMethod());assertEquals("/v1/device/display?protocol=1",poll.getPath());
            assertEquals(TlsVersion.TLS_1_3,poll.getHandshake().tlsVersion());assertEquals(1,poll.getHandshake().peerCertificates().size());
            f.gateway.enqueue(new MockResponse().setHeader("Content-Type","application/json").setBody("{\"accepted\":true}"));
            assertTrue(client.json("POST","/v1/device/display",new JSONObject().put("messageId","receipt").put("id","command").put("result",new JSONObject()),false).getBoolean("accepted"));
            RecordedRequest receipt=f.gateway.takeRequest(5,TimeUnit.SECONDS);assertEquals("/v1/device/display",receipt.getPath());assertEquals(List.of("chat","chat"),f.streamKinds);
        }
    }
    @Test public void realMutualTlsRequestAndStructuredErrorTravelThroughRelay()throws Exception{
        try(Fixture f=new Fixture()){
            f.gateway.enqueue(new MockResponse().setHeader("Content-Type","application/json").setBody("{\"paired\":true,\"deviceId\":\"fixture\"}"));
            GatewayClient client=f.client(f.pin());
            JSONObject result=client.json("POST","/v1/pair",new JSONObject().put("pairToken","fixture-token"),true);assertTrue(result.getBoolean("paired"));
            RecordedRequest request=f.gateway.takeRequest(5,TimeUnit.SECONDS);assertNotNull(request);assertEquals("boujoy.gateway",request.getHeader("Host"));assertEquals("/v1/pair",request.getPath());
            assertNotNull(request.getHandshake());assertEquals(TlsVersion.TLS_1_3,request.getHandshake().tlsVersion());assertEquals(1,request.getHandshake().peerCertificates().size());
            f.gateway.enqueue(new MockResponse().setResponseCode(409).setHeader("Content-Type","application/json").setBody("{\"error\":{\"code\":\"phone_paused\",\"message\":\"请先交还手机控制\"}}"));
            GatewayClient.GatewayError error=assertThrows(GatewayClient.GatewayError.class,()->client.json("POST","/v1/device/control",new JSONObject(),true));
            assertEquals(409,error.status);assertEquals("请先交还手机控制",error.getMessage());
        }
    }
    @Test public void incorrectGatewayPinStopsBeforeHttpPayload()throws Exception{
        try(Fixture f=new Fixture()){
            GatewayClient client=f.client("0".repeat(64));
            assertThrows(Exception.class,()->client.json("POST","/v1/pair",new JSONObject().put("pairToken","must-not-reach-server"),true));
            RecordedRequest request=f.gateway.takeRequest(1,TimeUnit.SECONDS);
            // MockWebServer may record the failed TLS handshake, but never an HTTP request.
            assertTrue(request==null||request.getRequestLine().isEmpty());
        }
    }
    @Test public void pendingPairingRejectsMismatchedOrNonaffirmativeReceiptsBeforeServiceCanPersistPaired()throws Exception{
        try(Fixture f=new Fixture()){
            GatewayClient client=f.client(f.pin());
            Binding pending=new Binding(Tunnel.json("edition",BuildConfig.EDITION,"androidApplicationId",BuildConfig.APPLICATION_ID,"relayUrl",f.relay.url("/v1/tunnel").toString().replace("https:","wss:"),"deviceId","fixture-device","routeToken","x".repeat(32),"gatewayPin",f.pin(),"pairToken","y".repeat(32),"expiresAt",1),false);
            for(String body:new String[]{"{\"paired\":true,\"deviceId\":\"wrong-device\"}","{\"paired\":false,\"deviceId\":\"fixture-device\"}","{\"paired\":\"true\",\"deviceId\":\"fixture-device\"}","{\"deviceId\":\"fixture-device\"}"}){
                f.gateway.enqueue(new MockResponse().setHeader("Content-Type","application/json").setBody(body));assertThrows(IOException.class,()->client.pair(pending));
                RecordedRequest request=f.gateway.takeRequest(5,TimeUnit.SECONDS);assertNotNull(request);assertEquals("/v1/pair",request.getPath());assertEquals(pending.pairToken,new JSONObject(request.getBody().readUtf8()).getString("pairToken"));
            }
        }
    }
    @Test public void binaryArtifactSurvivesInnerTlsAndOrderedClose()throws Exception{
        try(Fixture f=new Fixture()){
            byte[] bytes=new byte[150000];new Random(17).nextBytes(bytes);
            f.gateway.enqueue(new MockResponse().setHeader("Content-Type","application/octet-stream").setBody(new okio.Buffer().write(bytes)));
            GatewayClient.Response response=f.client(f.pin()).request("GET","/v1/artifacts/fixture-id",null,false);
            assertEquals(200,response.status());assertArrayEquals(bytes,response.body());assertEquals("application/octet-stream",response.contentType());
        }
    }

    @Test public void uploadsRawFileAndStreamsArtifactAboveOldEightMegabyteLimit()throws Exception{
        try(Fixture f=new Fixture()){
            GatewayClient client=f.client(f.pin());byte[] bytes=new byte[9*1024*1024];new Random(23).nextBytes(bytes);File source=File.createTempFile("boujoy-upload-",".mp4"),target=File.createTempFile("boujoy-download-",".mp4");
            try{java.nio.file.Files.write(source.toPath(),bytes);
                f.gateway.enqueue(new MockResponse().setHeader("Content-Type","application/json").setBody("{\"uploadId\":\"one\"}"));assertEquals("one",client.upload(source,"测试 视频.mp4","video/mp4").getString("uploadId"));
                RecordedRequest sent=f.gateway.takeRequest(5,TimeUnit.SECONDS);assertEquals("/v1/uploads",sent.getPath());assertEquals("video/mp4",sent.getHeader("Content-Type"));assertArrayEquals(bytes,sent.getBody().readByteArray());assertEquals("测试 视频.mp4",java.net.URLDecoder.decode(sent.getHeader("X-File-Name"),java.nio.charset.StandardCharsets.UTF_8));
                f.gateway.enqueue(new MockResponse().setHeader("Content-Type","video/mp4").setHeader("X-Content-SHA256",java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes))).setChunkedBody(new okio.Buffer().write(bytes),32768));
                assertEquals(bytes.length,client.download("artifact-one",target));assertArrayEquals(bytes,java.nio.file.Files.readAllBytes(target.toPath()));
            }finally{source.delete();target.delete();}
        }
    }
    @Test public void corruptOrRejectedDownloadLeavesNoPreviewFile()throws Exception{
        try(Fixture f=new Fixture()){
            GatewayClient client=f.client(f.pin());File target=File.createTempFile("boujoy-corrupt-",".media");
            f.gateway.enqueue(new MockResponse().setHeader("X-Content-SHA256","0".repeat(64)).setBody("truncated media"));assertThrows(IOException.class,()->client.download("one",target));assertFalse(target.exists());
            f.gateway.enqueue(new MockResponse().setResponseCode(403).setBody("{\"error\":{\"code\":\"denied\",\"message\":\"拒绝访问\"}}"));assertThrows(GatewayClient.GatewayError.class,()->client.download("one",target));assertFalse(target.exists());
        }
    }
    @Test public void rangedDownloadRetriesOnlyBrokenChunkAndVerifiesCompleteMedia()throws Exception{
        try(Fixture f=new Fixture()){
            byte[] bytes=new byte[2*1024*1024+137];new Random(37).nextBytes(bytes);
            String sha=java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
            java.util.List<String> ranges=new java.util.concurrent.CopyOnWriteArrayList<>();java.util.concurrent.atomic.AtomicBoolean broke=new java.util.concurrent.atomic.AtomicBoolean();
            f.gateway.setDispatcher(new okhttp3.mockwebserver.Dispatcher(){@Override public MockResponse dispatch(RecordedRequest request){try{
                String range=request.getHeader("Range");ranges.add(range);String[] parts=range.substring(6).split("-");int start=Integer.parseInt(parts[0]),end=Math.min(Integer.parseInt(parts[1]),bytes.length-1);
                if(start>0)assertEquals("\""+sha+"\"",request.getHeader("If-Match"));
                byte[] chunk=Arrays.copyOfRange(bytes,start,end+1);
                MockResponse response=new MockResponse().setResponseCode(206).setHeader("Content-Range","bytes "+start+"-"+end+"/"+bytes.length).setHeader("X-Artifact-SHA256",sha).setHeader("X-Content-SHA256",java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(chunk))).setBody(new okio.Buffer().write(chunk));
                if(start==1024*1024&&broke.compareAndSet(false,true))response.setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY);
                return response;
            }catch(Exception e){return new MockResponse().setResponseCode(500);}}});
            File target=File.createTempFile("boujoy-resume-",".media");try{assertEquals(bytes.length,f.client(f.pin()).download("media",target));assertArrayEquals(bytes,java.nio.file.Files.readAllBytes(target.toPath()));assertEquals(List.of("bytes=0-1048575","bytes=1048576-2097151","bytes=1048576-2097151","bytes=2097152-3145727"),ranges);}finally{target.delete();}
        }
    }
    @Test public void invalidRangeOrChangingFileNeverBecomesAnAttachment()throws Exception{
        try(Fixture f=new Fixture()){
            GatewayClient client=f.client(f.pin());File target=File.createTempFile("boujoy-wrong-range-",".media");
            for(String range:new String[]{"bytes 1-3/4","bytes 0-3/9","invalid"}){
                f.gateway.enqueue(new MockResponse().setResponseCode(206).setHeader("Content-Range",range).setHeader("X-Artifact-SHA256","0".repeat(64)).setBody("bad"));
                assertThrows(IOException.class,()->client.download("media",target));assertFalse(target.exists());
            }
        }
    }
    private static byte[] gzip(byte[] input)throws Exception{
        ByteArrayOutputStream out=new ByteArrayOutputStream();
        try(java.util.zip.GZIPOutputStream gz=new java.util.zip.GZIPOutputStream(out)){gz.write(input);}return out.toByteArray();
    }
    @Test public void compressedStateSurvivesTlsWithLengthAndChunkedFraming()throws Exception{
        try(Fixture f=new Fixture()){
            GatewayClient client=f.client(f.pin());String value="中文完整状态".repeat(30000);
            byte[] packed=gzip(new JSONObject().put("value",value).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            for(boolean chunked:new boolean[]{false,true}){
                MockResponse response=new MockResponse().setHeader("Content-Encoding","gzip").setHeader("Content-Type","application/json");
                if(chunked)response.setChunkedBody(new okio.Buffer().write(packed),127);else response.setBody(new okio.Buffer().write(packed));
                f.gateway.enqueue(response);assertEquals(value,client.json("GET","/v1/state",null,false).getString("value"));
                assertEquals("gzip",f.gateway.takeRequest(5,TimeUnit.SECONDS).getHeader("Accept-Encoding"));
            }
        }
    }
    @Test(timeout=60000) public void largeIncompressibleGzipStateSurvivesTlsRecordsAndOrderedClose()throws Exception{
        try(Fixture f=new Fixture()){
            GatewayClient client=f.client(f.pin());java.util.concurrent.atomic.AtomicReference<byte[]> packed=new java.util.concurrent.atomic.AtomicReference<>();
            java.util.concurrent.atomic.AtomicBoolean chunked=new java.util.concurrent.atomic.AtomicBoolean();
            f.gateway.setDispatcher(new okhttp3.mockwebserver.Dispatcher(){
                @Override public MockResponse dispatch(RecordedRequest request){
                    MockResponse response=new MockResponse().setHeader("Content-Type","application/json").setHeader("Connection","close").setSocketPolicy(SocketPolicy.DISCONNECT_AT_END);
                    if("/v1/control".equals(request.getPath()))return response.setBody("{\"ok\":true}");
                    assertEquals("/v1/state",request.getPath());assertEquals("gzip",request.getHeader("Accept-Encoding"));
                    response.setHeader("Content-Encoding","gzip");byte[] bytes=packed.get();
                    return chunked.get()?response.setChunkedBody(new okio.Buffer().write(bytes),16384):response.setBody(new okio.Buffer().write(bytes));
                }
            });
            ExecutorService callers=Executors.newSingleThreadExecutor();
            try{
                int sequence=0;
                for(boolean useChunks:new boolean[]{false,true})for(int size:new int[]{16000,16800,32200,33400,150000}){
                    byte[] noise=new byte[size];new Random(100+sequence++).nextBytes(noise);
                    String value=Base64.getEncoder().encodeToString(noise);byte[] raw=new JSONObject().put("value",value).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    packed.set(gzip(raw));chunked.set(useChunks);assertTrue("Fixture must cross TLS record boundaries",packed.get().length>15000);
                    Future<JSONObject> bulk=callers.submit(()->client.json("GET","/v1/state",null,false));
                    assertTrue(client.json("GET","/v1/control",null,true).getBoolean("ok"));
                    assertEquals(value,bulk.get(15,TimeUnit.SECONDS).getString("value"));assertTrue(f.tunnel.connected());
                }
            }finally{callers.shutdownNow();}
        }
    }
    @Test public void truncatedBodyFailureIdentifiesTheActualTunnelStream()throws Exception{
        try(Fixture f=new Fixture()){
            byte[] bytes=new byte[150000];new Random(77).nextBytes(bytes);
            f.gateway.enqueue(new MockResponse().setHeader("Content-Type","application/octet-stream").setHeader("Connection","close")
                    .setBody(new okio.Buffer().write(bytes)).setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY));
            GatewayClient.TransportFailure error=assertThrows(GatewayClient.TransportFailure.class,()->f.client(f.pin()).request("GET","/v1/artifacts/fixture",null,false));
            assertEquals("http_body",error.phase);assertTrue(error.receivedBytes>0);assertTrue(error.receivedBytes<bytes.length);
            String diagnostic=ConnectionProblem.diagnostic(error);assertTrue(diagnostic.contains("streamId=1 lane=data kind=chat"));
            assertTrue(diagnostic.contains("receivedCipherBytes="));assertTrue(diagnostic.contains("socketWrittenBytes="));assertTrue(diagnostic.contains("queuedBytes="));
        }
    }
    @Test public void rejectsTruncatedGzipAndDecodedPayloadBeyondEightMiB()throws Exception{
        try(Fixture f=new Fixture()){
            GatewayClient client=f.client(f.pin());byte[] packed=gzip("{\"value\":true}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            for(byte[] body:new byte[][]{Arrays.copyOf(packed,packed.length-4),gzip(new byte[8*1024*1024+1])}){
                f.gateway.enqueue(new MockResponse().setHeader("Content-Encoding","gzip").setBody(new okio.Buffer().write(body)));
                GatewayClient.TransportFailure error=assertThrows(GatewayClient.TransportFailure.class,()->client.json("GET","/v1/state",null,false));assertEquals("http_decode",error.phase);
            }
        }
    }

}
