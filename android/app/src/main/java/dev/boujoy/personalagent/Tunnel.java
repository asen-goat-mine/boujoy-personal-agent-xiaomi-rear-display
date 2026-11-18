package dev.boujoy.personalagent;

import okhttp3.*;
import okio.ByteString;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Two physical WSS lanes. Only authenticated Phone Use TLS bytes cross phone streams. */
public final class Tunnel implements AutoCloseable {
    public interface Listener { void changed(); }
    private final Binding binding;
    private final ControlState gate;
    private final Listener listener;
    private final OkHttpClient client;
    private final long helloTimeoutMs;
    private final ExecutorService io = Executors.newCachedThreadPool();
    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(2);
    private final Map<String,Lane> lanes = new ConcurrentHashMap<>();
    private final AtomicInteger ids = new AtomicInteger(1);
    private final AtomicLong lastStreamDiagnosticNanos=new AtomicLong();
    private volatile boolean closed;
    public Tunnel(Binding binding, ControlState gate, Listener listener) {
        this(binding,gate,listener,new OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS)
                .connectTimeout(10, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS)
                .followRedirects(false).followSslRedirects(false).build());
    }
    Tunnel(Binding binding, ControlState gate, Listener listener,OkHttpClient client) {
        this(binding,gate,listener,client,8000);
    }
    Tunnel(Binding binding, ControlState gate, Listener listener,OkHttpClient client,long helloTimeoutMs) {
        if(helloTimeoutMs<10||helloTimeoutMs>60000)throw new IllegalArgumentException("Invalid authentication timeout");
        this.binding = binding; this.gate = gate; this.listener = listener;
        this.client=client;this.helloTimeoutMs=helloTimeoutMs;
        lanes.put("data", new Lane("data")); lanes.put("control", new Lane("control"));
    }
    public void start() { lanes.values().forEach(Lane::connect); }
    public boolean connected() { return lanes.values().stream().allMatch(lane -> lane.ready&&lane.peerOnline); }
    public String status() {
        if (connected()) return "连接已建立";
        for (String name : new String[]{"control", "data"}) {
            Lane lane=lanes.get(name);
            if (!lane.problem.isEmpty()) return ConnectionProblem.message(lane.problem);
        }
        if(lanes.values().stream().allMatch(lane->lane.ready))return "正在等待电脑连接";
        return "正在恢复电脑连接";
    }
    public void reconnect() { if (!closed) lanes.values().forEach(lane -> lane.disconnectAndRetry()); }
    public void pausePhoneData() {
        Lane data = lanes.get("data");
        for (Stream stream : new ArrayList<>(data.streams.values())) if (stream.kind.equals("phone-data")) stream.close("locally_paused");
    }
    public Stream openChat(boolean control) throws Exception {
        Lane lane = lanes.get(control ? "control" : "data");
        Stream stream;
        // Admission must stay in one lane session; retry/reset uses the same monitor.
        synchronized(lane) {
            if (closed || !lane.ready || !lane.peerOnline) throw new IOException("电脑连接尚未就绪");
            int id = ids.getAndAdd(2); if (id <= 0) throw new IOException("连接编号已耗尽，请重新连接");
            stream = new Stream(lane, id, control ? "chat-control" : "chat", gate.epoch());
            try {
                lane.streams.put(id, stream);
                lane.json(json("type", "open", "streamId", id, "kind", stream.kind, "epoch", stream.epoch));
            } catch (Exception error) { stream.finish("open_failed",false,"local"); throw error; }
        }
        // Callbacks and reconnect must remain free while the peer acknowledges.
        try { stream.opened.get(12, TimeUnit.SECONDS); return stream; }
        catch (Exception error) { stream.close("open_failed"); throw error; }
    }
    @Override public void close() {
        closed = true;
        lanes.values().forEach(Lane::disconnectAndRetry);
        scheduler.shutdownNow(); io.shutdownNow(); client.dispatcher().executorService().shutdown(); client.connectionPool().evictAll();
    }
    static JSONObject json(Object... pairs) {
        JSONObject object = new JSONObject();
        try { for (int i=0;i<pairs.length;i+=2) object.put((String)pairs[i], pairs[i+1]); }
        catch (Exception e) { throw new IllegalArgumentException(e); } return object;
    }
    private final class Lane extends WebSocketListener {
        final String name;
        final ConcurrentMap<Integer,Stream> streams = new ConcurrentHashMap<>();
        final ClosedStreams retired = new ClosedStreams();
        final AtomicLong streamSession = new AtomicLong();
        volatile WebSocket socket;
        volatile boolean ready,peerOnline;
        volatile String problem="";
        private final AtomicBoolean connecting = new AtomicBoolean();
        private final AtomicLong generation = new AtomicLong();
        private int failures;
        private ScheduledFuture<?> helloDeadline,retryWork;
        Lane(String name) { this.name=name; }
        synchronized void connect() {
            if (closed || ready || !connecting.compareAndSet(false,true)) return;
            long currentGeneration=generation.incrementAndGet();
            // A cancelled network handshake may still callback after a replacement starts.
            // Gate every callback by its connection generation before it touches this lane.
            WebSocketListener listener=new WebSocketListener(){
                private boolean current(){return generation.get()==currentGeneration&&!closed;}
                @Override public void onOpen(WebSocket ws,Response response){if(current())Lane.this.onOpen(ws,response);else ws.cancel();}
                @Override public void onMessage(WebSocket ws,String value){if(current())Lane.this.onMessage(ws,value);}
                @Override public void onMessage(WebSocket ws,ByteString value){if(current())Lane.this.onMessage(ws,value);}
                @Override public void onClosing(WebSocket ws,int code,String reason){if(current())Lane.this.onClosing(ws,code,reason);else ws.cancel();}
                @Override public void onClosed(WebSocket ws,int code,String reason){if(current())Lane.this.onClosed(ws,code,reason);}
                @Override public void onFailure(WebSocket ws,Throwable error,Response response){if(current())Lane.this.onFailure(ws,error,response);}
            };
            try { WebSocket opened=client.newWebSocket(new Request.Builder().url(binding.endpoint()).build(),listener);if(generation.get()==currentGeneration)socket=opened;else opened.cancel(); }
            catch (Exception error) { problem=ConnectionProblem.classify(error,0);retry(); }
        }
        void json(JSONObject value) { WebSocket current=socket; if(current==null || !current.send(value.toString())) throw new IllegalStateException("连接已中断"); }
        @Override public synchronized void onOpen(WebSocket ws, Response response) {
            if(closed||ws!=socket){ws.cancel();return;}
            long currentGeneration=generation.get();
            // Ping/pong proves the socket is alive, not that the route authenticated.
            // Retire a silent hello without changing binding or replaying requests.
            helloDeadline=scheduler.schedule(()->{
                synchronized(Lane.this){
                    if(closed||generation.get()!=currentGeneration||socket!=ws||ready)return;
                    problem="network_timeout";retry();
                }
            },helloTimeoutMs,TimeUnit.MILLISECONDS);
            json(Tunnel.json("type","hello","version",1,"role","android","deviceId",binding.deviceId,"routeToken",binding.routeToken,"lane",name));
        }
        @Override public synchronized void onMessage(WebSocket ws, String message) {
            if(ws!=socket||closed)return;
            try {
                if(message.length()>16384)throw new IOException("Oversized control frame");
                JSONObject data=new JSONObject(message); String type=data.optString("type");
                switch(type){
                    case "hello":
                        if(!data.optBoolean("accepted")||data.optInt("version")!=1)throw new IOException("Relay rejected binding");
                        if(helloDeadline!=null)helloDeadline.cancel(false);
                        problem=""; ready=true; failures=0; connecting.set(false); listener.changed(); break;
                    case "peer": case "peer_status":
                        peerOnline=data.optBoolean("online");if(!peerOnline)resetStreams("peer_offline");
                        listener.changed(); break;
                    case "open": accept(data); break;
                    case "opened": {int id=data.getInt("streamId");if(id<=0||(id&1)==0)throw new IOException("Opened from wrong stream owner");Stream s=streams.get(id);if(s!=null&&s.markOpened())break;if(!retired.acceptLateOpened(id))throw new IOException("Unknown or duplicate opened stream");break;}
                    case "close": {Stream s=streams.get(data.getInt("streamId"));if(s!=null)s.finish(data.optString("reason","closed"),false,"remote");break;}
                    case "error": failStreams("relay_error"); break;
                    case "ping": json(Tunnel.json("type","pong")); break;
                    default: break;
                }
            } catch(Exception error){ ws.close(1002,"Invalid protocol frame"); }
        }
        @Override public synchronized void onMessage(WebSocket ws, ByteString bytes) {
            if(ws!=socket||closed)return;
            try { Protocol.Frame frame=Protocol.decode(bytes.toByteArray()); Stream stream=streams.get(frame.streamId());
                if(stream==null){if(retired.ignoreBinary(frame.streamId()))return;throw new IOException("Unknown binary stream");}
                if(!stream.established)throw new IOException("Stream has not opened");
                if(stream.kind.equals("phone-data")&&!gate.permitsData(stream.epoch)){stream.close("stale_control_epoch");return;}
                stream.accept(frame.payload());
            } catch(Exception error){ws.close(1002,"Invalid binary frame");}
        }
        void accept(JSONObject data) throws Exception {
            int id=data.getInt("streamId"); String kind=data.getString("kind"); long epoch=data.optLong("epoch",-1);
            if(id<=0||(id&1)!=0||streams.containsKey(id)||retired.contains(id)||streams.size()>=16||!Protocol.kindAllowed(name,kind)||!kind.startsWith("phone-")){
                json(Tunnel.json("type","close","streamId",id,"code","stream_denied","reason","Invalid incoming stream"));return;
            }
            if(kind.equals("phone-data")&&!gate.permitsData(epoch)){
                json(Tunnel.json("type","close","streamId",id,"code","phone_paused","reason","Phone locally paused or epoch stale"));return;
            }
            Stream stream=new Stream(this,id,kind,epoch);streams.put(id,stream);
            io.execute(()->{
                Socket phone=null;
                try {
                    phone=new Socket(); phone.connect(new InetSocketAddress("127.0.0.1",8443),3000);
                    phone.setTcpNoDelay(true); stream.socket=phone;
                    if(kind.equals("phone-data")&&!gate.permitsData(epoch))throw new IOException("Locally paused");
                    if(!stream.markOpened())throw new IOException("Stream already closed");json(Tunnel.json("type","opened","streamId",id));
                    stream.bridge(phone);
                }catch(Exception e){try{if(phone!=null)phone.close();}catch(IOException ignored){}stream.close("phone_unavailable");}
            });
        }
        @Override public synchronized void onClosing(WebSocket ws,int code,String reason){if(ws==socket)ws.close(code,reason);else ws.cancel();}
        @Override public synchronized void onClosed(WebSocket ws,int code,String reason){if(ws==socket){
            problem=ConnectionProblem.webSocketClose(code,reason);
            android.util.Log.w("BoujoyTunnel",ConnectionProblem.closeDiagnostic(name,code,reason)+" problem="+problem+" authenticated="+ready+" peerOnline="+peerOnline+" streams="+streams.size());
            retry();
        }}
        @Override public synchronized void onFailure(WebSocket ws,Throwable t,Response response){if(ws==socket){problem=ConnectionProblem.classify(t,response==null?0:response.code());android.util.Log.w("BoujoyTunnel",name+":"+problem);retry();}}
        void failStreams(String reason){for(Stream s:new ArrayList<>(streams.values()))s.finish(reason,false);}
        void resetStreams(String reason){streamSession.incrementAndGet();failStreams(reason);retired.clear();}
        // Connectivity callbacks describe a new route, not eight failed handshakes.
        // A burst must replace the pending retry without escalating its backoff to 30s.
        synchronized void disconnectAndRetry(){failures=0;retry();}
        synchronized void retry(){
            generation.incrementAndGet();
            if(helloDeadline!=null){helloDeadline.cancel(false);helloDeadline=null;}
            if(retryWork!=null){retryWork.cancel(false);retryWork=null;}
            WebSocket previous=socket;socket=null;if(previous!=null)previous.cancel();
            ready=false;peerOnline=false;connecting.set(false);resetStreams("transport_lost");listener.changed();
            if(closed)return;
            long delay=Math.min(30000,500L<<Math.min(6,failures++))+ThreadLocalRandom.current().nextInt(250);
            try{retryWork=scheduler.schedule(this::connect,delay,TimeUnit.MILLISECONDS);}catch(RejectedExecutionException error){if(!closed)throw error;}
        }
    }
    private void streamDiagnostic(Stream stream,String phase,Exception error){
        long now=System.nanoTime(),last=lastStreamDiagnosticNanos.get();
        if((last!=0&&now-last<TimeUnit.SECONDS.toNanos(1))||!lastStreamDiagnosticNanos.compareAndSet(last,now))return;
        android.util.Log.w("BoujoyTunnel","streamPhase="+phase+" problem="+(error==null?"stream_closed":ConnectionProblem.classify(error,0))+" "+stream.transportDiagnostic());
    }
    public final class Stream extends InputStream {
        final Lane lane;final int id;final String kind;final long epoch,session;
        final CompletableFuture<Boolean> opened=new CompletableFuture<>();
        final BlockingQueue<byte[]> incoming=new ArrayBlockingQueue<>(128);
        final AtomicBoolean ended=new AtomicBoolean();
        final AtomicInteger queuedBytes=new AtomicInteger();
        final AtomicLong receivedCipherBytes=new AtomicLong(),sentCipherBytes=new AtomicLong(),socketWrittenBytes=new AtomicLong();
        private volatile String finishOrigin="open",finishReason="none";
        private byte[] current;private int offset;
        private final Object writeLock=new Object();
        volatile Socket socket;
        volatile boolean established;
        Stream(Lane lane,int id,String kind,long epoch){this.lane=lane;this.id=id;this.kind=kind;this.epoch=epoch;this.session=lane.streamSession.get();}
        synchronized boolean markOpened(){if(ended.get()||established||session!=lane.streamSession.get())return false;established=true;opened.complete(true);return true;}
        void accept(byte[] value)throws IOException{
            if(ended.get())return;
            // Apply pressure to this data lane rather than dropping encrypted bytes.
            // Control has its own WebSocket, so stop/takeover remains responsive.
            long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(10);
            while(queuedBytes.get()+value.length>2*1024*1024||incoming.remainingCapacity()==0){
                if(ended.get())return;if(System.nanoTime()>until)throw new IOException("Stream receive timeout");
                try{Thread.sleep(2);}catch(InterruptedException e){Thread.currentThread().interrupt();throw new IOException("Interrupted",e);}
            }
            if(ended.get())return;queuedBytes.addAndGet(value.length);
            if(!incoming.offer(value)){queuedBytes.addAndGet(-value.length);throw new IOException("Stream receive interrupted");}
            receivedCipherBytes.addAndGet(value.length);
        }
        @Override public int read()throws IOException{byte[] one=new byte[1];int count=read(one);return count<0?-1:one[0]&255;}
        @Override public int read(byte[] bytes,int start,int length)throws IOException{
            if(length==0)return 0;
            while(current==null||offset>=current.length){
                if(ended.get()&&incoming.isEmpty())return -1;
                try {current=incoming.poll(60,TimeUnit.SECONDS);offset=0;if(current==null)throw new SocketTimeoutException("Tunnel read timeout");queuedBytes.addAndGet(-current.length);if(current.length==0)return -1;}
                catch(InterruptedException e){Thread.currentThread().interrupt();throw new IOException("Interrupted",e);}
            }
            int count=Math.min(length,current.length-offset);System.arraycopy(current,offset,bytes,start,count);offset+=count;return count;
        }
        public void write(byte[] bytes,int offset,int length)throws IOException{synchronized(writeLock){
            if(ended.get()||!lane.ready)throw new IOException("Tunnel closed");
            if(kind.equals("phone-data")&&!gate.permitsData(epoch))throw new IOException("Phone locally paused");
            for(int at=offset;at<offset+length;){
                int count=Math.min(Protocol.MAX_CHUNK,offset+length-at);
                WebSocket ws=lane.socket;
                long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);
                while(ws!=null&&ws.queueSize()>256*1024){
                    if(ended.get()||!lane.ready||lane.socket!=ws||kind.equals("phone-data")&&!gate.permitsData(epoch)||System.nanoTime()>until)throw new IOException("Tunnel upload interrupted");
                    try{Thread.sleep(2);}catch(InterruptedException e){Thread.currentThread().interrupt();throw new IOException("Interrupted",e);}
                }
                if(ws==null||ended.get()||!ws.send(ByteString.of(Protocol.encode(id,bytes,at,count)))){
                    close("backpressure");throw new IOException("Tunnel write failed");
                }sentCipherBytes.addAndGet(count);at+=count;
            }
        }}
        public void bridge(Socket target){
            socket=target;
            io.execute(()->{try{byte[] buffer=new byte[Protocol.MAX_CHUNK];int n;InputStream input=target.getInputStream();while((n=input.read(buffer))!=-1)write(buffer,0,n);}catch(Exception error){if(!ended.get())streamDiagnostic(this,"socket_read",error);}finally{close("socket_closed");}});
            io.execute(()->{try{byte[] buffer=new byte[Protocol.MAX_CHUNK];int n;OutputStream output=target.getOutputStream();while((n=read(buffer))!=-1){if(kind.equals("phone-data")&&!gate.permitsData(epoch))throw new IOException("Paused");output.write(buffer,0,n);output.flush();socketWrittenBytes.addAndGet(n);}}catch(Exception error){if(!ended.get())streamDiagnostic(this,"socket_write",error);}finally{try{target.close();}catch(IOException ignored){}close("stream_closed");}});
        }
        public void close(String reason){finish(reason,true);}
        void finish(String reason,boolean notify){finish(reason,notify,notify?"local":"transport");}
        synchronized void finish(String reason,boolean notify,String origin){
            if(!ended.compareAndSet(false,true))return;
            finishOrigin=origin;finishReason=ConnectionProblem.streamCloseReason(reason);
            if(session==lane.streamSession.get())lane.retired.remember(id,established,(id&1)==1);
            lane.streams.remove(id,this);opened.completeExceptionally(new IOException(reason));
            // An ordered remote close follows the last data frame. Drain that data before EOF.
            // Local stop is different: immediately discard and close the socket admission path.
            if(notify)incoming.clear();incoming.offer(new byte[0]);
            try{if(notify&&socket!=null)socket.close();}catch(IOException ignored){}
            if(notify&&lane.ready)try{lane.json(Tunnel.json("type","close","streamId",id,"reason",reason));}catch(Exception ignored){}
            if(Set.of("open_failed","phone_unavailable","transport_lost","peer_offline","relay_error","backpressure","other").contains(finishReason))streamDiagnostic(this,"finish",null);
        }
        // Counts describe accepted ciphertext, not user text. sentCipherBytes means
        // accepted by the WSS sender; socketWrittenBytes means copied to loopback.
        String transportDiagnostic(){
            long queued=0;for(byte[] bytes:incoming)queued+=bytes.length;
            return "streamId="+id+" lane="+lane.name+" kind="+kind+" finishOrigin="+finishOrigin+" finishReason="+finishReason
                    +" receivedCipherBytes="+receivedCipherBytes.get()+" sentCipherBytes="+sentCipherBytes.get()
                    +" socketWrittenBytes="+socketWrittenBytes.get()+" queuedBytes="+queued;
        }
        @Override public void close(){close("closed");}
    }
}
