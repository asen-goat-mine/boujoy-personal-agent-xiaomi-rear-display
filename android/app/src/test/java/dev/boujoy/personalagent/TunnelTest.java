package dev.boujoy.personalagent;

import okhttp3.*;
import okhttp3.mockwebserver.*;
import okhttp3.tls.*;
import okio.ByteString;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;
import java.nio.ByteBuffer;
import java.lang.reflect.Field;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

/** Exercises the actual Android transport Java implementation over local TLS WebSockets. */
public class TunnelTest {
    private static final class Fixture implements AutoCloseable {
        final MockWebServer server=new MockWebServer();
        final BlockingQueue<JSONObject> events=new LinkedBlockingQueue<>();
        final BlockingQueue<Integer> closeCodes=new LinkedBlockingQueue<>();
        final ConcurrentMap<String,WebSocket> sockets=new ConcurrentHashMap<>();
        final AtomicInteger hellos=new AtomicInteger();
        volatile boolean replyToHello=true;
        volatile boolean replyToOpen=true;
        final ControlState gate=new ControlState(new ControlStateTest.Memory());
        final Tunnel tunnel;
        Fixture()throws Exception{this(8000);}
        Fixture(long helloTimeoutMs)throws Exception{
            HeldCertificate certificate=new HeldCertificate.Builder().commonName("localhost").addSubjectAlternativeName("localhost").build();
            HandshakeCertificates serverKeys=new HandshakeCertificates.Builder().heldCertificate(certificate).build();
            HandshakeCertificates clientKeys=new HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate()).build();
            server.useHttps(serverKeys.sslSocketFactory(),false);
            for(int i=0;i<16;i++)server.enqueue(new MockResponse().withWebSocketUpgrade(new WebSocketListener(){
                @Override public void onMessage(WebSocket ws,String value){try{
                    JSONObject object=new JSONObject(value);events.offer(object);
                    if(object.optString("type").equals("hello")){sockets.put(object.getString("lane"),ws);hellos.incrementAndGet();if(replyToHello){ws.send("{\"type\":\"hello\",\"version\":1,\"accepted\":true}");ws.send("{\"type\":\"peer\",\"online\":true}");}}
                    if(object.optString("type").equals("open")&&replyToOpen)ws.send("{\"type\":\"opened\",\"streamId\":"+object.getInt("streamId")+"}");
                }catch(Exception e){throw new AssertionError(e);}}
                @Override public void onClosing(WebSocket ws,int code,String reason){closeCodes.offer(code);ws.close(code,reason);}
            }));
            server.start();
            Binding binding=new Binding(new JSONObject().put("edition",BuildConfig.EDITION).put("androidApplicationId",BuildConfig.APPLICATION_ID).put("relayUrl",server.url("/v1/tunnel").toString().replace("https:","wss:"))
                    .put("deviceId","fixture-device").put("routeToken","x".repeat(32)).put("gatewayPin","a".repeat(64)),false);
            OkHttpClient client=new OkHttpClient.Builder().sslSocketFactory(clientKeys.sslSocketFactory(),clientKeys.trustManager()).build();
            tunnel=new Tunnel(binding,gate,()->{},client,helloTimeoutMs);tunnel.start();
            long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);while(!tunnel.connected()&&System.nanoTime()<deadline)Thread.sleep(10);
            assertTrue("Both real WSS lanes should authenticate",tunnel.connected());
        }
        JSONObject event(String type)throws Exception{long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);while(System.nanoTime()<end){JSONObject next=events.poll(100,TimeUnit.MILLISECONDS);if(next!=null&&next.optString("type").equals(type))return next;}throw new AssertionError("Missing event "+type);}
        void flushData()throws Exception{sockets.get("data").send("{\"type\":\"ping\"}");event("pong");}
        void bytes(int id,String value){byte[] data=value.getBytes(java.nio.charset.StandardCharsets.UTF_8);sockets.get("data").send(ByteString.of(Protocol.encode(id,data,0,data.length)));}
        @Override public void close()throws Exception{tunnel.close();server.shutdown();}
    }
    private static void eventually(java.util.function.BooleanSupplier condition)throws Exception{
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);
        while(!condition.getAsBoolean()&&System.nanoTime()<deadline)Thread.sleep(10);
        assertTrue("Connection transition deadline",condition.getAsBoolean());
    }
    private static Object field(Object object,String name)throws Exception{
        Field field=object.getClass().getDeclaredField(name);field.setAccessible(true);return field.get(object);
    }
    private static void field(Object object,String name,Object value)throws Exception{
        Field field=object.getClass().getDeclaredField(name);field.setAccessible(true);field.set(object,value);
    }
    private static final class AdmissionBarrier extends ConcurrentHashMap<Integer,Tunnel.Stream>{
        final CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);
        final AtomicBoolean first=new AtomicBoolean(true);
        @Override public Tunnel.Stream put(Integer id,Tunnel.Stream stream){
            if(first.compareAndSet(true,false)){
                entered.countDown();
                try{if(!release.await(10,TimeUnit.SECONDS))throw new AssertionError("Admission barrier deadline");}
                catch(InterruptedException e){Thread.currentThread().interrupt();throw new AssertionError(e);}
            }
            return super.put(id,stream);
        }
    }
    @Test public void outboundAdmissionCannotCrossReconnectButOpenedWaitDoesNotHoldLane()throws Exception{
        try(Fixture f=new Fixture()){
            Object lane=((Map<?,?>)field(f.tunnel,"lanes")).get("data");
            AdmissionBarrier barrier=new AdmissionBarrier();field(lane,"streams",barrier);
            ExecutorService callers=Executors.newFixedThreadPool(2);
            try{
                f.replyToOpen=false;
                Future<Tunnel.Stream> pending=callers.submit(()->f.tunnel.openChat(false));
                assertTrue(barrier.entered.await(5,TimeUnit.SECONDS));
                AtomicReference<Thread> resetThread=new AtomicReference<>();
                Future<?> reset=callers.submit(()->{resetThread.set(Thread.currentThread());f.tunnel.reconnect();});
                eventually(()->reset.isDone()||resetThread.get()!=null&&resetThread.get().getState()==Thread.State.BLOCKED);
                assertFalse("Reconnect must not overtake an unregistered outbound Stream",reset.isDone());
                barrier.release.countDown();
                // No opened response is sent: reset can still acquire the lane and revoke it.
                reset.get(5,TimeUnit.SECONDS);
                assertThrows(ExecutionException.class,()->pending.get(5,TimeUnit.SECONDS));
                f.replyToOpen=true;eventually(f.tunnel::connected);
                try(Tunnel.Stream fresh=f.tunnel.openChat(false)){f.bytes(fresh.id,"R");assertEquals('R',fresh.read());}
                f.flushData();assertTrue("No valid opened response may kill the replacement lane",f.closeCodes.isEmpty());
            }finally{barrier.release.countDown();callers.shutdownNow();}
        }
    }
    @Test public void rejectedOutboundOpenSendDoesNotLeaveAnUnownedPendingStream()throws Exception{
        try(Fixture f=new Fixture()){
            Object lane=((Map<?,?>)field(f.tunnel,"lanes")).get("data");
            WebSocket original=(WebSocket)field(lane,"socket");
            WebSocket rejecting=new WebSocket(){
                public Request request(){return original.request();}
                public long queueSize(){return original.queueSize();}
                public boolean send(String value){return false;}
                public boolean send(ByteString value){return original.send(value);}
                public boolean close(int code,String reason){return original.close(code,reason);}
                public void cancel(){original.cancel();}
            };
            field(lane,"socket",rejecting);
            try{
                assertThrows(IllegalStateException.class,()->f.tunnel.openChat(false));
                assertTrue("Rejected send must clean the pending Stream",((Map<?,?>)field(lane,"streams")).isEmpty());
            }finally{field(lane,"socket",original);}
            try(Tunnel.Stream fresh=f.tunnel.openChat(false)){f.bytes(fresh.id,"R");assertEquals('R',fresh.read());}
        }
    }
    @Test public void silentAuthenticationRetiresWssAndRecoversWithoutReplayingStreams()throws Exception{
        try(Fixture f=new Fixture(250);Tunnel.Stream old=f.tunnel.openChat(false)){
            f.event("open");f.events.clear();f.replyToHello=false;f.tunnel.reconnect();
            eventually(()->f.hellos.get()>=4);assertFalse(f.tunnel.connected());
            assertThrows(java.io.IOException.class,()->old.write(new byte[]{1},0,1));
            // MockWebServer still answers WebSocket pings; only hello is missing.
            eventually(()->f.hellos.get()>=6);f.replyToHello=true;
            eventually(f.tunnel::connected);
            assertTrue(f.events.stream().noneMatch(e->e.optString("type").equals("open")));
            try(Tunnel.Stream fresh=f.tunnel.openChat(false)){assertNotEquals(old.id,fresh.id);f.bytes(fresh.id,"R");assertEquals('R',fresh.read());}
        }
    }
    @Test public void acceptedAuthenticationCancelsDeadlineAndCloseCancelsPendingRetry()throws Exception{
        try(Fixture f=new Fixture(250)){
            Thread.sleep(700);assertEquals(2,f.hellos.get());assertTrue(f.tunnel.connected());
            f.replyToHello=false;f.tunnel.reconnect();eventually(()->f.hellos.get()>=4);
            f.tunnel.close();int before=f.hellos.get();Thread.sleep(1200);
            assertEquals(before,f.hellos.get());assertFalse(f.tunnel.connected());
        }
    }
    @Test public void orderedRemoteClosePreservesFinal64KiBResponse()throws Exception{
        try(Fixture f=new Fixture()){
            Tunnel.Stream stream=f.tunnel.openChat(false);
            JSONObject opened=null;long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
            while(System.nanoTime()<deadline){JSONObject next=f.events.poll(1,TimeUnit.SECONDS);if(next!=null&&next.optString("type").equals("open")){opened=next;break;}}
            assertNotNull(opened);int id=opened.getInt("streamId");assertEquals(1,id&1);
            byte[] value=new byte[65536+5];value[0]=1;ByteBuffer.wrap(value,1,4).putInt(id);for(int i=5;i<value.length;i++)value[i]=(byte)i;
            f.sockets.get("data").send(ByteString.of(value));
            f.sockets.get("data").send("{\"type\":\"close\",\"streamId\":"+id+"}");
            Thread.sleep(100);byte[] received=stream.readAllBytes();assertEquals(65536,received.length);assertEquals((byte)5,received[0]);assertEquals((byte)(value.length-1),received[received.length-1]);
        }
    }
    @Test(timeout=30000) public void orderedRemoteCloseDrainsThroughSlowSocketBridge()throws Exception{
        try(Fixture f=new Fixture();Tunnel.Stream stream=f.tunnel.openChat(false);
                java.net.ServerSocket listener=new java.net.ServerSocket(0,1,java.net.InetAddress.getLoopbackAddress());
                java.net.Socket consumer=new java.net.Socket()){
            consumer.setReceiveBufferSize(4096);consumer.connect(new java.net.InetSocketAddress(java.net.InetAddress.getLoopbackAddress(),listener.getLocalPort()));consumer.setSoTimeout(10000);
            java.net.Socket target=listener.accept();target.setSendBufferSize(4096);stream.bridge(target);
            byte[] expected=new byte[512*1024+317];new java.util.Random(59).nextBytes(expected);
            for(int offset=0;offset<expected.length;offset+=Protocol.MAX_CHUNK){int count=Math.min(Protocol.MAX_CHUNK,expected.length-offset);assertTrue(f.sockets.get("data").send(ByteString.of(Protocol.encode(stream.id,expected,offset,count))));}
            f.sockets.get("data").send("{\"type\":\"close\",\"streamId\":"+stream.id+"}");
            eventually(stream.ended::get);
            // Remote EOF is queued while the local bridge is backpressured. Its
            // independent control lane must still work before the bulk data drains.
            try(Tunnel.Stream control=f.tunnel.openChat(true)){
                byte[] marker=new byte[]{42};f.sockets.get("control").send(ByteString.of(Protocol.encode(control.id,marker,0,1)));assertEquals(42,control.read());
            }
            java.io.ByteArrayOutputStream actual=new java.io.ByteArrayOutputStream();byte[] bytes=new byte[1024];int count;
            while((count=consumer.getInputStream().read(bytes))!=-1){actual.write(bytes,0,count);Thread.sleep(1);}
            assertArrayEquals(expected,actual.toByteArray());assertTrue(f.tunnel.connected());
            assertEquals(expected.length,stream.receivedCipherBytes.get());assertEquals(expected.length,stream.socketWrittenBytes.get());
            assertTrue(stream.transportDiagnostic().contains("finishOrigin=remote"));assertTrue(stream.transportDiagnostic().contains("queuedBytes=0"));
        }
    }
    @Test public void streamDiagnosticsContainCountsAndKnownReasonOnly()throws Exception{
        try(Fixture f=new Fixture();Tunnel.Stream stream=f.tunnel.openChat(false)){
            String secret="private-frame-and-token";byte[] sent=secret.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            stream.write(sent,0,sent.length);f.bytes(stream.id,secret);f.flushData();
            f.sockets.get("data").send(Tunnel.json("type","close","streamId",stream.id,"reason",secret).toString());eventually(stream.ended::get);
            String diagnostic=ConnectionProblem.diagnostic(new GatewayClient.TransportFailure("http_body",7,new java.io.EOFException(secret),stream));
            assertTrue(diagnostic.contains("streamId="+stream.id+" lane=data kind=chat"));assertTrue(diagnostic.contains("finishOrigin=remote finishReason=other"));
            assertTrue(diagnostic.contains("receivedCipherBytes="+sent.length));assertTrue(diagnostic.contains("sentCipherBytes="+sent.length));
            assertTrue(diagnostic.contains("socketWrittenBytes=0 queuedBytes="+sent.length));assertFalse(diagnostic.contains(secret));
        }
    }
    @Test public void connectionReplacementIsNotBindingRejection()throws Exception{
        try(Fixture f=new Fixture()){
            f.sockets.get("control").close(1008,"connection replaced");eventually(()->!f.tunnel.connected());
            assertFalse(f.tunnel.status(),f.tunnel.status().contains("绑定"));
        }
    }
    @Test public void phoneDataDeniedLocallyWhileControlLaneStaysUsable()throws Exception{
        try(Fixture f=new Fixture()){
            f.sockets.get("data").send("{\"type\":\"open\",\"streamId\":2,\"kind\":\"phone-data\",\"epoch\":0}");
            JSONObject denied=null;long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
            while(System.nanoTime()<deadline){JSONObject next=f.events.poll(1,TimeUnit.SECONDS);if(next!=null&&next.optString("type").equals("close")){denied=next;break;}}
            assertNotNull(denied);assertEquals("phone_paused",denied.optString("code"));
            try(Tunnel.Stream control=f.tunnel.openChat(true)){assertNotNull(control);assertTrue(f.tunnel.connected());}
        }
    }
    @Test public void lateBytesForClosedKnownStreamDoNotBreakOtherChatsOrReplayContent()throws Exception{
        try(Fixture f=new Fixture();Tunnel.Stream first=f.tunnel.openChat(false);Tunnel.Stream other=f.tunnel.openChat(false)){
            first.close();f.event("close");f.bytes(first.id,"late discarded bytes");f.flushData();
            assertTrue(f.tunnel.connected());assertEquals(-1,first.read());
            f.bytes(other.id,"B");assertEquals('B',other.read());assertTrue(f.closeCodes.isEmpty());
        }
    }
    @Test public void pendingLocalStreamAcceptsExactlyOneLateOpenedAndDiscardsOnlyItsBytes()throws Exception{
        try(Fixture f=new Fixture()){
            ExecutorService caller=Executors.newSingleThreadExecutor();
            try{
                f.replyToOpen=false;Future<Tunnel.Stream> pending=caller.submit(()->f.tunnel.openChat(false));int id=f.event("open").getInt("streamId");
                f.sockets.get("data").send("{\"type\":\"close\",\"streamId\":"+id+"}");assertThrows(ExecutionException.class,()->pending.get(5,TimeUnit.SECONDS));
                f.sockets.get("data").send("{\"type\":\"opened\",\"streamId\":"+id+"}");f.bytes(id,"late");f.flushData();assertTrue(f.tunnel.connected());
                f.replyToOpen=true;try(Tunnel.Stream next=f.tunnel.openChat(false)){assertNotEquals(id,next.id);f.bytes(next.id,"N");assertEquals('N',next.read());}
                f.sockets.get("data").send("{\"type\":\"opened\",\"streamId\":"+id+"}");assertEquals(Integer.valueOf(1002),f.closeCodes.poll(5,TimeUnit.SECONDS));
            }finally{caller.shutdownNow();}
        }
    }
    @Test public void neverOpenedBytesAndOpenedAndUnknownCloseCannotAuthorizeAStream()throws Exception{
        for(boolean opened:new boolean[]{false,true})try(Fixture f=new Fixture()){
            f.sockets.get("data").send("{\"type\":\"close\",\"streamId\":999}");
            if(opened)f.sockets.get("data").send("{\"type\":\"opened\",\"streamId\":999}");else f.bytes(999,"never opened");
            assertEquals(Integer.valueOf(1002),f.closeCodes.poll(5,TimeUnit.SECONDS));
        }
    }
    @Test public void peerSessionChangeClearsRetiredIds()throws Exception{
        try(Fixture f=new Fixture();Tunnel.Stream old=f.tunnel.openChat(false)){
            old.close();f.event("close");f.sockets.get("data").send("{\"type\":\"peer\",\"online\":false}");f.sockets.get("data").send("{\"type\":\"peer\",\"online\":true}");f.flushData();
            f.bytes(old.id,"old session");assertEquals(Integer.valueOf(1002),f.closeCodes.poll(5,TimeUnit.SECONDS));
        }
    }
    @Test public void replacingConnectionClearsRetiredIdsAndDoesNotReplayClosedStreams()throws Exception{
        try(Fixture f=new Fixture();Tunnel.Stream old=f.tunnel.openChat(false)){
            old.close();f.event("close");WebSocket before=f.sockets.get("data");f.tunnel.reconnect();
            long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);while((f.sockets.get("data")==before||!f.tunnel.connected())&&System.nanoTime()<end)Thread.sleep(10);
            assertNotSame(before,f.sockets.get("data"));assertTrue(f.tunnel.connected());f.closeCodes.clear();f.bytes(old.id,"old connection");
            assertEquals(Integer.valueOf(1002),f.closeCodes.poll(5,TimeUnit.SECONDS));
        }
    }
}
