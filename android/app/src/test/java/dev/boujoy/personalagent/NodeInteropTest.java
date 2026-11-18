package dev.boujoy.personalagent;

import okhttp3.*;
import okhttp3.tls.*;
import org.json.*;
import org.junit.Test;
import static org.junit.Assert.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.*;

/** Cross-language contract: the real Java transport talks to the repository's real Node services. */
public class NodeInteropTest {
    interface Check{boolean get()throws Exception;}
    static void eventually(Check check)throws Exception{long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);while(System.nanoTime()<end){if(check.get())return;Thread.sleep(20);}assertTrue("Condition did not become true",check.get());}
    static final class Fixture implements AutoCloseable{
        final Path dir=Files.createTempDirectory("boujoy-java-node-interop-");
        final ExecutorService readers=Executors.newSingleThreadExecutor();
        final Process process;final BufferedReader fromNode;final BufferedWriter toNode;
        final Binding binding;final Tunnel tunnel;final GatewayClient gateway;
        final ControlState gate=new ControlState(new ControlStateTest.Memory());
        final HeldCertificate clientCert=new HeldCertificate.Builder().commonName("Java actual client").build();
        Fixture()throws Exception{this(false);}
        Fixture(boolean voiceRuntime)throws Exception{
            HeldCertificate outer=new HeldCertificate.Builder().commonName("127.0.0.1").addSubjectAlternativeName("127.0.0.1").build();
            HeldCertificate inner=new HeldCertificate.Builder().commonName("boujoy.gateway").build();
            Files.write(dir.resolve("outer.crt"),outer.certificatePem().getBytes(StandardCharsets.UTF_8));Files.write(dir.resolve("outer.key"),outer.privateKeyPkcs8Pem().getBytes(StandardCharsets.UTF_8));
            Files.write(dir.resolve("gateway.crt"),inner.certificatePem().getBytes(StandardCharsets.UTF_8));Files.write(dir.resolve("gateway.key"),inner.privateKeyPkcs8Pem().getBytes(StandardCharsets.UTF_8));
            Path root=Path.of(System.getProperty("user.dir")).toAbsolutePath();while(root!=null&&!Files.exists(root.resolve("src/remote/gateway.mjs")))root=root.getParent();
            if(root==null)throw new IOException("Cannot find real Node gateway source");
            ProcessBuilder builder=new ProcessBuilder(System.getenv().getOrDefault("BOUJOY_NODE_BINARY","node"),root.resolve("tests/remote-interop-fixture.mjs").toString(),dir.toString()).directory(root.toFile());
            if(voiceRuntime)builder.environment().put("BOUJOY_TEST_VOICE_RUNTIME",Path.of(System.getProperty("user.home"),"Library/Application Support/Boujoy Personal Agent/build-tools/voice").toString());
            builder.environment().put("NODE_EXTRA_CA_CERTS",dir.resolve("outer.crt").toString());builder.redirectError(dir.resolve("node-stderr.log").toFile());process=builder.start();
            fromNode=new BufferedReader(new InputStreamReader(process.getInputStream(),StandardCharsets.UTF_8));toNode=new BufferedWriter(new OutputStreamWriter(process.getOutputStream(),StandardCharsets.UTF_8));
            JSONObject first=read();assertEquals("ready",first.optString("type"));binding=new Binding(first.getJSONObject("binding"),true);
            HandshakeCertificates outerTrust=new HandshakeCertificates.Builder().addTrustedCertificate(outer.certificate()).build();
            OkHttpClient outerClient=new OkHttpClient.Builder().sslSocketFactory(outerTrust.sslSocketFactory(),outerTrust.trustManager()).build();
            tunnel=new Tunnel(binding,gate,()->{},outerClient);tunnel.start();eventually(tunnel::connected);gateway=client(clientCert);
        }
        GatewayClient client(HeldCertificate identity)throws Exception{
            HandshakeCertificates keys=new HandshakeCertificates.Builder().heldCertificate(identity).build();
            SSLContext context=SSLContext.getInstance("TLSv1.3");context.init(new KeyManager[]{keys.keyManager()},new TrustManager[]{DeviceIdentity.pinnedTrust(binding.gatewayPin)},new SecureRandom());return new GatewayClient(tunnel,context);
        }
        JSONObject read()throws Exception{
            String value=readers.submit(fromNode::readLine).get(12,TimeUnit.SECONDS);
            if(value==null)throw new IOException("Node fixture exited: "+new String(Files.readAllBytes(dir.resolve("node-stderr.log")),StandardCharsets.UTF_8));return new JSONObject(value);
        }
        synchronized JSONObject command(String op,Object... values)throws Exception{
            JSONObject request=Tunnel.json(values).put("op",op).put("id",UUID.randomUUID().toString());toNode.write(request.toString());toNode.newLine();toNode.flush();JSONObject result=read();assertEquals(request.getString("id"),result.getString("id"));assertTrue(result.optString("error"),result.getBoolean("ok"));return result;
        }
        JSONObject pair()throws Exception{return gateway.pair(binding);}
        Binding expiredPending()throws Exception{
            JSONObject saved=Tunnel.json("edition",BuildConfig.EDITION,"androidApplicationId",BuildConfig.APPLICATION_ID,"relayUrl",binding.relayUrl,"deviceId",binding.deviceId,"routeToken",binding.routeToken,"gatewayPin",binding.gatewayPin,"pairToken",binding.pairToken,"expiresAt",1,"paired",false);
            Path persisted=dir.resolve("pending-binding.json");Files.write(persisted,saved.toString().getBytes(StandardCharsets.UTF_8));
            return new Binding(new JSONObject(new String(Files.readAllBytes(persisted),StandardCharsets.UTF_8)),false);
        }
        JSONObject control(boolean paused,String requestId)throws Exception{
            return gateway.json("POST","/v1/device/control",Tunnel.json("messageId",requestId,"controlEpoch",gate.epoch(),"paused",paused,"reason",paused?"user_opened_chat":"user_resume"),true);
        }
        JSONObject message(String text,JSONArray attachments)throws Exception{return Tunnel.json("messageId",Protocol.id(),"text",text,"controlEpoch",gate.epoch(),"createdAt",Instant.now().toString(),"expiresAt",Instant.now().plusSeconds(299).toString(),"attachments",attachments);}
        @Override public void close()throws Exception{
            tunnel.close();try{toNode.close();}catch(Exception ignored){}if(!process.waitFor(3,TimeUnit.SECONDS))process.destroyForcibly();readers.shutdownNow();
            try(var files=Files.walk(dir)){for(Path file:files.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(file);}
        }
    }
    @Test public void actualNodeLargeGzipStateSurvivesBackpressureWithConcurrentControl()throws Exception{
        try(Fixture f=new Fixture()){
            f.pair();JSONObject expected=f.command("largeGzipState");f.command("backpressure","milliseconds",8);
            String before=f.command("snapshot").getJSONObject("control").toString();
            ExecutorService parallel=Executors.newSingleThreadExecutor();
            try{
                for(int round=0;round<5;round++){
                    Future<JSONObject> control=parallel.submit(()->f.gateway.json("GET","/v1/voice/status",null,true));
                    JSONObject state=f.gateway.json("GET","/v1/state",null,false);
                    JSONArray tasks=state.getJSONArray("tasks");assertEquals(expected.getInt("tasks"),tasks.length());
                    StringBuilder results=new StringBuilder();
                    for(int n=0;n<tasks.length();n++){if(n>0)results.append('\n');results.append(tasks.getJSONObject(n).getString("result"));}
                    byte[] digest=java.security.MessageDigest.getInstance("SHA-256").digest(results.toString().getBytes(StandardCharsets.UTF_8));
                    assertEquals(expected.getString("resultHash"),java.util.HexFormat.of().formatHex(digest));
                    assertTrue(control.get(8,TimeUnit.SECONDS).has("transcriptionReady"));
                }
                assertEquals(before,f.command("snapshot").getJSONObject("control").toString());
                assertTrue(f.tunnel.connected());assertEquals(0,f.command("snapshot").getInt("creates"));
            }finally{parallel.shutdownNow();}
        }
    }
    @Test public void typingPollReceivesTypeAndReadOnlyVerificationOverBoundMutualTls()throws Exception{
        try(Fixture f=new Fixture()){
            f.pair();
            assertTrue(f.gateway.pollTyping().isNull("job")); // A paused phone cannot receive jobs.
            f.gate.resumeExplicitly();
            f.control(false,Protocol.id());
            GatewayClient stranger=f.client(new HeldCertificate.Builder().commonName("Unbound typing fixture").build());
            f.command("startTyping");
            GatewayClient.GatewayError denied=assertThrows(GatewayClient.GatewayError.class,stranger::pollTyping);
            assertEquals(403,denied.status);
            JSONObject type=f.gateway.pollTyping().getJSONObject("job");
            assertEquals("type",ConnectionService.decodeTypingOperation(type));
            assertEquals("联通样例",type.getString("text"));
            assertEquals("com.example.fixture",type.getString("packageName"));
            String first=type.getString("id");
            JSONObject ack=Tunnel.json("messageId",Protocol.id(),"id",first,"status","typed","diagnostic","readback_verified");
            assertEquals(403,assertThrows(GatewayClient.GatewayError.class,()->stranger.json("POST","/v1/device/typing",ack,true)).status);
            assertTrue(f.gateway.json("POST","/v1/device/typing",ack,true).getBoolean("accepted"));
            JSONObject typed=f.command("typingReceipt").getJSONObject("receipt");
            assertEquals(first,typed.getString("id"));assertEquals("typed",typed.getString("status"));

            f.command("startTyping","referenceId",first);
            JSONObject verify=f.gateway.pollTyping().getJSONObject("job");
            assertEquals("verify_replace",ConnectionService.decodeTypingOperation(verify));
            assertEquals(first,verify.getString("referenceId"));
            assertEquals(f.gate.epoch(),verify.getLong("controlEpoch"));
            JSONObject proof=Tunnel.json("referenceId",first,"controlEpoch",f.gate.epoch(),"editorIdentity","a".repeat(64),"exact",true,"reads",2);
            JSONObject verifiedAck=Tunnel.json("messageId",Protocol.id(),"id",verify.getString("id"),"status","verified","proof",proof);
            assertTrue(f.gateway.json("POST","/v1/device/typing",verifiedAck,true).getBoolean("accepted"));
            JSONObject result=f.command("typingReceipt").getJSONObject("receipt");
            assertEquals(verify.getString("id"),result.getString("id"));assertEquals("verified",result.getString("status"));
            assertEquals(first,result.getJSONObject("proof").getString("referenceId"));assertEquals(0,f.command("snapshot").getInt("creates"));
        }
    }
    @Test public void consumedPairingCanRecoverLostReceiptOnlyWithOriginalCertificate()throws Exception{
        try(Fixture f=new Fixture()){
            f.command("dropPair");assertThrows(Exception.class,f::pair);assertEquals(1,f.command("snapshot").getInt("devices"));
            assertTrue(f.pair().getBoolean("paired"));
            GatewayClient other=f.client(new HeldCertificate.Builder().commonName("Unbound identity").build());
            assertThrows(GatewayClient.GatewayError.class,()->other.json("POST","/v1/pair",Tunnel.json("pairToken",f.binding.pairToken),true));
            assertEquals(1,f.command("snapshot").getInt("devices"));
        }
    }
    @Test public void persistedExpiredPendingRecoversCommittedLostReplyOnlyWithOriginalCertificateAfterReconnect()throws Exception{
        try(Fixture f=new Fixture()){
            f.command("dropPair");assertThrows(Exception.class,f::pair);
            assertEquals(1,f.command("snapshot").getInt("devices"));
            Binding pending=f.expiredPending();assertTrue(pending.expiresAt<System.currentTimeMillis());
            assertEquals(f.binding.pairToken,pending.pairToken);assertEquals(f.binding.gatewayPin,pending.gatewayPin);assertEquals(f.binding.relayUrl,pending.relayUrl);assertEquals(f.binding.routeToken,pending.routeToken);
            f.tunnel.reconnect();eventually(f.tunnel::connected);
            GatewayClient originalIdentity=f.client(f.clientCert);JSONObject receipt=originalIdentity.pair(pending);
            assertTrue(receipt.getBoolean("paired"));assertEquals(f.binding.deviceId,receipt.getString("deviceId"));assertTrue(receipt.getBoolean("paused"));
            JSONObject snapshot=f.command("snapshot");assertEquals(1,snapshot.getInt("devices"));assertTrue(snapshot.getBoolean("paired"));assertEquals(0,snapshot.getInt("creates"));assertEquals(0,snapshot.getJSONArray("tasks").length());assertTrue(snapshot.getJSONObject("control").getBoolean("paused"));
            GatewayClient other=f.client(new HeldCertificate.Builder().commonName("Different recovery identity").build());
            assertThrows(GatewayClient.GatewayError.class,()->other.pair(pending));assertEquals(1,f.command("snapshot").getInt("devices"));
        }
    }
    @Test public void expiredPersistedPendingNeverCommittedIsRejectedByActualMacWithoutBindingOrDispatch()throws Exception{
        try(Fixture f=new Fixture()){
            assertTrue(f.command("expirePair").getBoolean("pairingPresent"));Binding pending=f.expiredPending();
            assertTrue(pending.expiresAt<System.currentTimeMillis());
            GatewayClient.GatewayError rejection=assertThrows(GatewayClient.GatewayError.class,()->f.gateway.pair(pending));assertEquals(400,rejection.status);assertEquals("request_rejected",rejection.code);
            GatewayClient.GatewayError unbound=assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("GET","/v1/state",null,true));assertEquals(403,unbound.status);assertEquals("device_unbound",unbound.code);
            JSONObject snapshot=f.command("snapshot");assertEquals(0,snapshot.getInt("devices"));assertFalse(snapshot.getBoolean("paired"));assertEquals(0,snapshot.getInt("creates"));assertEquals(0,snapshot.getJSONArray("tasks").length());assertTrue(snapshot.getJSONObject("control").getBoolean("paused"));
        }
    }
    private static JSONObject workspaceBody(Fixture f,JSONObject session){return Tunnel.json("messageId",Protocol.id(),"sessionId",session.optString("sessionId"),"controlEpoch",f.gate.epoch());}
    @Test public void actualGatewaySummaryAndMessagesPopulateHistoryCacheWithoutDuplicatingPhoneOutbox()throws Exception{
        try(Fixture f=new Fixture()){
            f.pair();f.gate.resumeExplicitly();f.control(false,Protocol.id());
            JSONObject sent=f.message("这是一条真实协议的合成问题",new JSONArray());
            JSONObject receipt=f.gateway.json("POST","/v1/messages",sent,false);String id=receipt.getString("taskId");
            f.command("taskStatus","taskId",id,"status","completed","result","合成回答来自Mac任务详情");
            JSONObject state=f.gateway.json("GET","/v1/state",null,false);assertFalse(state.getJSONArray("tasks").getJSONObject(0).has("messages"));
            TaskDetailCache cache=new TaskDetailCache();cache.update(state.getJSONArray("tasks"));TaskDetailCache.Request request=cache.requests(1,2).get(0);
            JSONObject detail=f.gateway.json("GET","/v1/tasks/"+id,null,false);assertTrue(cache.complete(request,detail,2));
            JSONObject outbox=Tunnel.json(sent.getString("messageId"),Tunnel.json("message",sent,"receipt",receipt,"status","received"));
            JSONObject snapshot=Tunnel.json("state",state,"outbox",outbox,"taskDetails",cache.snapshot(),"paired",true);
            assertEquals(List.of("这是一条真实协议的合成问题","合成回答来自Mac任务详情"),ChatPresenterTest.conversation(snapshot));
            String before=ChatPresenter.present(snapshot).fingerprint();state=f.gateway.json("GET","/v1/state",null,false);snapshot.put("state",state);
            cache.update(state.getJSONArray("tasks"));assertTrue(cache.requests(10,2).isEmpty());assertEquals(before,ChatPresenter.present(snapshot).fingerprint());
        }
    }
    private static String workspaceTask(Fixture f)throws Exception{
        f.pair();f.gate.resumeExplicitly();f.control(false,Protocol.id());String task=f.gateway.json("POST","/v1/messages",f.message("查看已有电脑工作页",new JSONArray()),false).getString("taskId");f.command("browserPage","taskId",task);f.gate.pause();f.control(true,Protocol.id());return task;
    }
    @Test public void actualBrowserPageCanBeViewedClickedFilledAndExplicitlyHandedBackThroughJavaMutualTls()throws Exception{
        try(Fixture f=new Fixture()){
            String task=workspaceTask(f),base="/v1/tasks/"+task+"/browser/";
            assertTrue(f.gateway.json("GET","/v1/tasks/"+task,null,false).getBoolean("browserWorkspaceAvailable"));
            JSONObject session=f.gateway.json("POST",base+"begin",Tunnel.json("messageId",Protocol.id(),"controlEpoch",f.gate.epoch()),true);
            assertEquals("paused",f.gateway.json("GET","/v1/tasks/"+task,null,false).getString("status"));assertTrue(f.command("browserText","taskId",task).getBoolean("locked"));
            JSONObject frame=f.gateway.json("POST",base+"frame",workspaceBody(f,session),false);
            assertEquals("image/jpeg",frame.getString("mime"));byte[] image=Base64.getDecoder().decode(frame.getString("imageBase64"));assertTrue(image.length>1000);assertEquals(255,image[0]&255);assertEquals(216,image[1]&255);
            JSONObject click=workspaceBody(f,session).put("frameId",frame.getString("frameId")).put("action","click").put("index",0);
            assertTrue(f.gateway.json("POST",base+"act",click,false).getBoolean("accepted"));assertTrue(f.command("browserText","taskId",task).getString("text").contains("Clicked once"));
            assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST",base+"act",click.put("messageId",Protocol.id()),false));
            frame=f.gateway.json("POST",base+"frame",workspaceBody(f,session),false);
            assertTrue(f.gateway.json("POST",base+"act",workspaceBody(f,session).put("frameId",frame.getString("frameId")).put("action","fill").put("index",1).put("text","typed by user"),false).getBoolean("accepted"));
            assertTrue(f.gateway.json("POST",base+"end",workspaceBody(f,session),true).getBoolean("paused"));assertFalse(f.command("browserText","taskId",task).getBoolean("locked"));
            assertEquals("paused",f.gateway.json("GET","/v1/tasks/"+task,null,false).getString("status"));
            f.gate.resumeExplicitly();f.control(false,Protocol.id());f.gateway.json("POST","/v1/tasks/"+task+"/continue",Tunnel.json("messageId",Protocol.id(),"controlEpoch",f.gate.epoch()),true);
            assertEquals("waiting_consent",f.gateway.json("GET","/v1/tasks/"+task,null,false).getString("status"));
        }
    }
    @Test public void actualBrowserWorkspaceRejectsCredentialIframeStaleEpochExpiredSessionAndDisconnectedTransport()throws Exception{
        try(Fixture f=new Fixture()){
            String task=workspaceTask(f),base="/v1/tasks/"+task+"/browser/";
            JSONObject session=f.gateway.json("POST",base+"begin",Tunnel.json("messageId",Protocol.id(),"controlEpoch",f.gate.epoch()),true);
            f.command("browserSensitive","taskId",task);GatewayClient.GatewayError protectedPage=assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST",base+"frame",workspaceBody(f,session),false));assertEquals("credential_boundary",protectedPage.code);
            f.gate.pause();f.control(true,Protocol.id());assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST",base+"frame",workspaceBody(f,session),false));assertFalse(f.command("browserText","taskId",task).getBoolean("locked"));
            f.command("browserPage","taskId",task);JSONObject expiring=f.gateway.json("POST",base+"begin",Tunnel.json("messageId",Protocol.id(),"controlEpoch",f.gate.epoch()),true);f.command("browserExpire");assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST",base+"frame",workspaceBody(f,expiring),false));
            JSONObject disconnecting=f.gateway.json("POST",base+"begin",Tunnel.json("messageId",Protocol.id(),"controlEpoch",f.gate.epoch()),true);f.command("disconnectAndroid");eventually(()->!f.tunnel.connected());eventually(f.tunnel::connected);
            assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST",base+"frame",workspaceBody(f,disconnecting),false));assertFalse(f.command("browserText","taskId",task).getBoolean("locked"));
            JSONObject revoked=f.gateway.json("POST",base+"begin",Tunnel.json("messageId",Protocol.id(),"controlEpoch",f.gate.epoch()),true);f.command("revoke");assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST",base+"frame",workspaceBody(f,revoked),false));assertFalse(f.command("browserText","taskId",task).getBoolean("locked"));
        }
    }
    @Test public void realMacSpeechReturnsPlayableWavAndTranscriptionNeverDispatchesTaskOrGrantsConsent()throws Exception{
        try(Fixture f=new Fixture(true)){
            f.pair();JSONObject voice=f.gateway.json("GET","/v1/voice/status",null,false);assertTrue(voice.getBoolean("localOnly"));assertTrue(voice.getBoolean("speechReady"));
            f.gate.resumeExplicitly();f.control(false,Protocol.id());String task=f.gateway.json("POST","/v1/messages",f.message("语音接口本机验收",new JSONArray()),false).getString("taskId");f.command("taskStatus","taskId",task,"status","completed","result","Local voice test.");
            f.gate.pause();f.control(true,Protocol.id());JSONObject before=f.command("snapshot");
            JSONObject artifact=f.gateway.json("POST","/v1/tasks/"+task+"/messages/result/speech",Tunnel.json("messageId",Protocol.id()),false);assertEquals("audio/wav",artifact.getString("mime"));assertTrue(artifact.getBoolean("localOnly"));
            GatewayClient.Response audio=f.gateway.request("GET","/v1/artifacts/"+artifact.getString("id"),null,false);assertEquals(200,audio.status());assertTrue(audio.body().length>44);assertEquals("RIFF",new String(audio.body(),0,4,StandardCharsets.US_ASCII));
            byte[] digest=java.security.MessageDigest.getInstance("SHA-256").digest(audio.body());StringBuilder hex=new StringBuilder();for(byte value:digest)hex.append(String.format(Locale.ROOT,"%02x",value&255));
            JSONObject draft=Tunnel.json("messageId",Protocol.id(),"bytesBase64",Base64.getEncoder().encodeToString(audio.body()),"sha256",hex.toString(),"language","en","mime","audio/wav","cloudConsent",true);
            assertTrue("Offline transcription runtime required for this integration test",voice.getBoolean("transcriptionReady"));JSONObject transcription=f.gateway.json("POST","/v1/voice/transcribe",draft,false);assertTrue(transcription.getBoolean("localOnly"));assertTrue(transcription.getBoolean("editable"));assertTrue(transcription.getString("text"),transcription.getString("text").toLowerCase(Locale.ROOT).contains("local voice test"));
            JSONObject after=f.command("snapshot");assertEquals(before.getInt("creates"),after.getInt("creates"));assertEquals(before.getInt("messageReceipts"),after.getInt("messageReceipts"));assertEquals(before.getJSONObject("control").toString(),after.getJSONObject("control").toString());
            GatewayClient other=f.client(new HeldCertificate.Builder().commonName("Unbound voice client").build());assertThrows(GatewayClient.GatewayError.class,()->other.json("POST","/v1/voice/transcribe",draft,false));
        }
    }
    @Test public void taskScopedAttachmentTransferMatchesRealNodeContractAndNeverReplaysDispatch()throws Exception{
        try(Fixture f=new Fixture()){
            f.pair();f.gate.resumeExplicitly();f.control(false,Protocol.id());JSONObject created=f.command("attachmentTask"),job=f.gateway.json("GET","/v1/device/files/next",null,true).getJSONObject("job");
            assertEquals("com.tencent.mobileqq",job.getString("targetPackage"));
            JSONObject legacyWechat=new JSONObject(job.toString()).put("targetPackage","com.tencent.mm");
            assertTrue(ShareJob.permitsTarget(legacyWechat.getString("targetPackage")));
            ShareJob.validate(job,f.gate.epoch(),System.currentTimeMillis());String base="/v1/device/files/"+job.getString("jobId");
            GatewayClient.Response file=f.gateway.request("GET",base+"/bytes",null,false);assertEquals(200,file.status());ShareJob.verifyBytes(job,file.body());assertArrayEquals(Base64.getDecoder().decode(created.getString("bytesBase64")),file.body());
            JSONObject wrong=new JSONObject(job.toString()).put("sha256","0".repeat(64));assertThrows(IOException.class,()->ShareJob.verifyBytes(wrong,file.body()));
            assertEquals("prepared",f.gateway.json("POST",base+"/status",ShareJob.receipt(job,"prepared"),true).getString("status"));
            job.put("dispatchAttemptId",Protocol.id());assertEquals("dispatching",f.gateway.json("POST",base+"/status",ShareJob.receipt(job,"dispatching"),true).getString("status"));
            JSONObject duplicate=new JSONObject(job.toString()).put("dispatchAttemptId",Protocol.id());assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST",base+"/status",ShareJob.receipt(duplicate,"dispatching"),true));
            JSONObject sent=f.gateway.json("POST",base+"/status",ShareJob.receipt(job,"intent_dispatched"),true);assertTrue(sent.has("dispatchedAt"));assertFalse(sent.has("contentOpenedByTargetAt"));
            assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST",base+"/status",ShareJob.receipt(job,"content_opened").put("targetPackage","com.whatsapp"),true));
            f.gateway.json("POST",base+"/status",ShareJob.receipt(job,"content_opened").put("targetPackage",job.getString("targetPackage")),true);
            JSONObject status=f.command("attachmentStatus","jobId",job.getString("jobId"));assertEquals("intent_dispatched",status.getString("status"));assertTrue(status.has("contentOpenedByTargetAt"));assertFalse(status.has("sent"));
            f.gate.pause();f.control(true,Protocol.id());assertTrue(f.gateway.json("GET","/v1/device/files/next",null,true).isNull("job"));assertTrue(f.gateway.request("GET",base+"/bytes",null,false).status()>=400);
            JSONObject unknown=f.command("attachmentStatus","jobId",job.getString("jobId"));assertEquals("unknown_result",unknown.getString("status"));assertEquals("intent_dispatched",unknown.getString("lastKnownStatus"));assertTrue(unknown.getBoolean("requiresReconciliation"));assertTrue(unknown.getBoolean("authorizationExpired"));assertEquals(job.getString("dispatchAttemptId"),unknown.getString("dispatchAttemptId"));assertEquals(status.getString("dispatchedAt"),unknown.getString("dispatchedAt"));assertTrue(unknown.has("contentOpenedByTargetAt"));assertFalse(unknown.has("sent"));
            // ConnectionService.pollShare invalidates its payload on job=null;
            // ShareFiles.invalidate retains its durable dispatch ledger. An
            // explicit resume must not make this old Intent eligible again.
            f.gate.resumeExplicitly();f.control(false,Protocol.id());assertTrue(f.gateway.json("GET","/v1/device/files/next",null,true).isNull("job"));assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST",base+"/status",ShareJob.receipt(job,"prepared"),true));
        }
    }
    @Test public void attachmentTicketsExpireOnDeadlineDisconnectRevokeAndTaskStop()throws Exception{
        try(Fixture f=new Fixture()){
            f.pair();f.gate.resumeExplicitly();f.control(false,Protocol.id());JSONObject first=f.command("attachmentTask").getJSONObject("job");f.command("attachmentExpire","jobId",first.getString("jobId"));assertTrue(f.gateway.json("GET","/v1/device/files/next",null,true).isNull("job"));
            JSONObject second=f.command("attachmentTask").getJSONObject("job");f.command("taskStatus","taskId",second.getString("taskId"),"status","paused");assertTrue(f.gateway.json("GET","/v1/device/files/next",null,true).isNull("job"));
            // Mark its ticket expired through the same read-only status used by Phone before a new transfer.
            f.command("attachmentStatus","jobId",second.getString("jobId"));JSONObject third=f.command("attachmentTask").getJSONObject("job");f.command("disconnectAndroid");eventually(()->!f.tunnel.connected());eventually(f.tunnel::connected);assertTrue(f.gateway.json("GET","/v1/device/files/next",null,true).isNull("job"));assertEquals("expired",f.command("attachmentStatus","jobId",third.getString("jobId")).getString("status"));
            JSONObject fourth=f.command("attachmentTask").getJSONObject("job");f.command("revoke");assertTrue(f.gateway.request("GET","/v1/device/files/"+fourth.getString("jobId")+"/bytes",null,false).status()>=400);
        }
    }
    @Test public void explicitlyStartedDemonstrationUsesActualGatewayPauseAndCreatesOnlyAnUnverifiedWorkflowDraft()throws Exception{
        try(Fixture f=new Fixture()){
            f.pair();f.gate.pause();f.control(true,Protocol.id());String task=f.command("demoTask").getString("taskId");JSONObject started=f.gateway.json("POST","/v1/demonstrations/start",Tunnel.json("messageId",Protocol.id(),"taskId",task,"controlEpoch",f.gate.epoch()),true);assertEquals("recording",started.getString("status"));
            f.command("demoPage","label","下一步");JSONObject stopped=f.gateway.json("POST","/v1/demonstrations/stop",Tunnel.json("messageId",Protocol.id(),"sessionId",started.getString("id")),true);assertEquals(stopped.toString(),"draft_created",stopped.getString("status"));assertTrue(stopped.getInt("pageCount")>=1);
            JSONObject draft=f.command("demoDraft","draftId",stopped.getString("draftId")).getJSONObject("draft");assertEquals("draft",draft.getString("status"));assertFalse(draft.getJSONObject("demonstration").getBoolean("actionsRecorded"));assertFalse(draft.getJSONObject("demonstration").getBoolean("authorization"));assertTrue(f.command("snapshot").getJSONObject("control").getBoolean("paused"));
            JSONObject again=f.gateway.json("POST","/v1/demonstrations/start",Tunnel.json("messageId",Protocol.id(),"taskId",task,"controlEpoch",f.gate.epoch()),true);f.command("demoPage","label","输入支付密码");JSONObject sensitive=f.gateway.json("GET","/v1/demonstrations/current",null,true).getJSONObject("demonstration");assertEquals("sensitive_screen",sensitive.getString("stopReason"));assertNotEquals("recording",sensitive.getString("status"));
            GatewayClient other=f.client(new HeldCertificate.Builder().commonName("Unbound demonstration client").build());assertThrows(GatewayClient.GatewayError.class,()->other.json("POST","/v1/demonstrations/start",Tunnel.json("messageId",Protocol.id(),"taskId",task,"controlEpoch",f.gate.epoch()),true));
        }
    }
    @Test public void notificationDeliveryIsAuthenticatedQueryableAndQuietIsAnExplicitPreference()throws Exception{
        try(Fixture f=new Fixture()){
            f.pair();f.gate.resumeExplicitly();f.control(false,Protocol.id());String task=f.gateway.json("POST","/v1/messages",f.message("通知投递本机验收",new JSONArray()),false).getString("taskId");
            assertTrue(f.gateway.json("POST","/v1/notifications/preferences",Tunnel.json("messageId",Protocol.id(),"quiet",true),true).getBoolean("quiet"));
            JSONArray delivered=new JSONArray().put(Tunnel.json("taskId",task,"fingerprint","fixture-fingerprint","status","permission_denied","attempts",0,"updatedAt",System.currentTimeMillis()));
            f.gateway.json("POST","/v1/notifications/delivery",Tunnel.json("messageId",Protocol.id(),"deliveries",delivered),true);JSONObject report=f.gateway.json("GET","/v1/notifications/delivery",null,true);assertEquals("permission_denied",report.getJSONObject("delivery").getJSONArray("rows").getJSONObject(0).getString("status"));
            delivered.getJSONObject(0).put("status","posted").put("attempts",1);f.gateway.json("POST","/v1/notifications/delivery",Tunnel.json("messageId",Protocol.id(),"deliveries",delivered),true);assertEquals("posted",f.gateway.json("GET","/v1/notifications/delivery",null,true).getJSONObject("delivery").getJSONArray("rows").getJSONObject(0).getString("status"));
            assertFalse(f.gateway.json("POST","/v1/notifications/preferences",Tunnel.json("messageId",Protocol.id(),"quiet",false),true).getBoolean("quiet"));assertFalse(f.gateway.json("GET","/v1/state",null,true).getJSONObject("notificationPreferences").getBoolean("quiet"));
            GatewayClient other=f.client(new HeldCertificate.Builder().commonName("Unbound notification client").build());assertThrows(GatewayClient.GatewayError.class,()->other.json("GET","/v1/notifications/delivery",null,true));
        }
    }
    @Test public void realGatewayPreservesEpochReceiptAttachmentsApprovalAndHandoffContracts()throws Exception{
        try(Fixture f=new Fixture()){
            f.pair();f.gate.resumeExplicitly();String oldControlId=Protocol.id();JSONObject old=f.control(false,oldControlId);
            f.command("control","epoch",80,"paused",true);
            JSONObject remote=f.gateway.json("GET","/v1/state",null,false).getJSONObject("device");
            f.gate.observeRemote(remote.getLong("controlEpoch"),remote.getBoolean("paused"));assertTrue(f.gate.paused());assertEquals(80,f.gate.epoch());
            JSONObject stale=f.gateway.json("POST","/v1/device/control",Tunnel.json("messageId",oldControlId,"controlEpoch",1,"paused",false,"reason","user_resume"),true);
            f.gate.observeRemote(stale.getLong("controlEpoch"),stale.getBoolean("paused"));assertEquals(80,f.gate.epoch());assertTrue(f.gate.paused());
            f.gate.resumeExplicitly();f.control(false,Protocol.id());
            byte[] bytes=new byte[150000];new Random(43).nextBytes(bytes);
            JSONObject request=f.message("分析这个附件",new JSONArray().put(Tunnel.json("name","fixture.bin","mime","application/octet-stream","base64",Base64.getEncoder().encodeToString(bytes))));
            f.command("dropMessage");assertThrows(Exception.class,()->f.gateway.json("POST","/v1/messages",request,false));
            JSONObject receipt=f.gateway.json("GET","/v1/messages/"+request.getString("messageId"),null,true);assertTrue(receipt.getBoolean("received"));assertEquals(1,f.command("snapshot").getInt("creates"));String taskId=receipt.getString("taskId");
            JSONObject detail=f.gateway.json("GET","/v1/tasks/"+taskId,null,false);assertEquals("分析这个附件",detail.getString("title"));
            JSONObject artifact=detail.getJSONArray("artifacts").getJSONObject(0);assertEquals(bytes.length,artifact.getLong("size"));
            GatewayClient.Response file=f.gateway.request("GET","/v1/artifacts/"+artifact.getString("id"),null,false);assertEquals(new String(file.body(),StandardCharsets.UTF_8),200,file.status());assertArrayEquals(bytes,file.body());
            JSONObject escaped=f.command("symlinkArtifact","taskId",taskId);
            assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("GET","/v1/artifacts/"+escaped.getString("artifactId"),null,false));
            TaskNotifications.Update baseline=TaskNotifications.consume(new JSONObject(),f.gateway.json("GET","/v1/state",null,false).getJSONArray("tasks"));
            f.command("approval","taskId",taskId);detail=f.gateway.json("GET","/v1/tasks/"+taskId,null,false);JSONObject approval=detail.getJSONArray("approvals").getJSONObject(0);
            assertFalse(approval.getString("summary").isBlank());assertEquals(64,approval.getString("fingerprint").length());
            JSONObject decision=Tunnel.json("messageId",Protocol.id(),"controlEpoch",f.gate.epoch(),"allow",true,"fingerprint","wrong-fingerprint");
            assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST","/v1/approvals/"+approval.getString("id"),decision,true));
            f.gate.pause();f.tunnel.pausePhoneData();f.control(true,Protocol.id());
            decision.put("messageId",Protocol.id()).put("fingerprint",approval.getString("fingerprint")).put("controlEpoch",f.gate.epoch());
            assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST","/v1/approvals/"+approval.getString("id"),decision,true));
            f.gate.resumeExplicitly();f.control(false,Protocol.id());decision.put("messageId",Protocol.id()).put("controlEpoch",f.gate.epoch());
            assertTrue(f.gateway.json("POST","/v1/approvals/"+approval.getString("id"),decision,true).getBoolean("resolved"));
            assertEquals(f.gate.epoch(),f.command("snapshot").getJSONArray("tasks").getJSONObject(0).getLong("remoteControlEpoch"));
            f.command("taskStatus","taskId",taskId,"status","ready_for_user","result","测试中的已核验付款交接");
            JSONArray tasks=f.gateway.json("GET","/v1/state",null,false).getJSONArray("tasks");TaskNotifications.Update ready=TaskNotifications.consume(baseline.ledger(),tasks);
            assertEquals(1,ready.alerts().size());assertEquals("已准备好，请你接着付款",ready.alerts().get(0).title());assertTrue(TaskNotifications.consume(TaskNotifications.outcome(ready.ledger(),ready.alerts().get(0),"posted",System.currentTimeMillis()),tasks).alerts().isEmpty());
        }
    }
    @Test public void localForegroundTakeoverCutsPhoneDataButPreservesIndependentControl()throws Exception{
        try(ServerSocket phone=new ServerSocket(8443,20,InetAddress.getByName("127.0.0.1"));Fixture f=new Fixture()){
            ExecutorService echo=Executors.newCachedThreadPool();AtomicInteger accepted=new AtomicInteger();Set<Socket> sockets=ConcurrentHashMap.newKeySet();
            echo.execute(()->{try{while(!phone.isClosed()){Socket socket=phone.accept();sockets.add(socket);accepted.incrementAndGet();echo.execute(()->{try{byte[] b=new byte[4096];int n;while((n=socket.getInputStream().read(b))!=-1){socket.getOutputStream().write(b,0,n);socket.getOutputStream().flush();}}catch(Exception ignored){}finally{sockets.remove(socket);try{socket.close();}catch(Exception ignored){}}});}}catch(Exception ignored){}});
            try{
                f.pair();f.gate.resumeExplicitly();f.control(false,Protocol.id());assertEquals("before-pause",f.command("phoneProbe","lane","data","payload","before-pause").getString("received"));
                int before=accepted.get();
                // This is the exact admission gate operation called by onResume/pauseLocal.
                // It tests foreground takeover logic, not physical touchscreen event detection.
                f.gate.pause();f.tunnel.pausePhoneData();
                assertEquals("",f.command("phoneProbe","lane","data","payload","must-not-enter").getString("received"));assertEquals(before,accepted.get());
                assertEquals("cancel-query",f.command("phoneProbe","lane","control","payload","cancel-query").getString("received"));
                f.control(true,Protocol.id());assertTrue(f.command("snapshot").getJSONObject("control").getBoolean("paused"));
                f.command("disconnectMac");eventually(()->!f.tunnel.connected());
            }finally{phone.close();for(Socket socket:sockets)socket.close();echo.shutdownNow();}
        }
    }
    @Test public void networkReplacementRecoversFreshAuthenticationWithoutGrantingPhoneControl()throws Exception{
        try(Fixture f=new Fixture()){
            f.pair();assertTrue(f.gateway.json("GET","/v1/state",null,false).getJSONObject("device").getBoolean("paused"));
            f.command("disconnectAndroid");eventually(()->!f.tunnel.connected());eventually(f.tunnel::connected);
            for(int i=0;i<8;i++)f.tunnel.reconnect();eventually(f.tunnel::connected);
            Thread.sleep(900);assertTrue("Stale reconnect timers must not replace a healthy generation",f.tunnel.connected());
            assertTrue(f.gateway.json("GET","/v1/state",null,true).getJSONObject("device").getBoolean("paused"));assertTrue(f.gate.paused());assertEquals(0,f.command("snapshot").getInt("creates"));
        }
    }
    @Test public void largeStateResponseSurvivesTheRealRelayWithoutTruncatingHistoryOrGrantingControl()throws Exception{
        try(Fixture f=new Fixture()){
            f.pair();assertEquals(240,f.command("largeState").getInt("tasks"));assertEquals(8,f.command("backpressure","milliseconds",8).getInt("milliseconds"));
            for(int n=0;n<4;n++){
                GatewayClient.Response response=f.gateway.request("GET","/v1/state",null,false);
                assertEquals(200,response.status());assertTrue(response.body().length>200000);
                JSONObject state=response.json();assertEquals(150,state.getJSONArray("tasks").length());assertEquals("Synthetic history 239",state.getJSONArray("tasks").getJSONObject(149).getString("title"));assertTrue(state.getJSONObject("device").getBoolean("paused"));
            }
            assertTrue(f.gate.paused());assertEquals(0,f.command("snapshot").getInt("creates"));
        }
    }
    @Test public void delayedStopCannotClobberNewResumeAndStaleContinueCannotBorrowIt()throws Exception{
        try(Fixture f=new Fixture()){
            f.pair();f.gate.resumeExplicitly();f.control(false,Protocol.id());
            JSONObject task=f.gateway.json("POST","/v1/messages",f.message("测试队列控制",new JSONArray()),false);String taskId=task.getString("taskId");
            assertEquals(f.gate.epoch(),f.command("snapshot").getJSONArray("tasks").getJSONObject(0).getLong("remoteControlEpoch"));
            long oldEpoch=f.gate.pause();f.tunnel.pausePhoneData();f.command("stopDelay","milliseconds",300);
            ExecutorService requests=Executors.newSingleThreadExecutor();
            try{
                Future<JSONObject> stopping=requests.submit(()->f.gateway.json("POST","/v1/tasks/"+taskId+"/stop",Tunnel.json("messageId",Protocol.id(),"controlEpoch",oldEpoch),true));
                eventually(()->f.command("snapshot").getBoolean("stopEntered"));
                long newer=f.gate.resumeExplicitly();JSONObject resumed=f.control(false,Protocol.id());stopping.get(5,TimeUnit.SECONDS);
                assertEquals(newer,resumed.getLong("controlEpoch"));assertFalse(resumed.getBoolean("paused"));
                assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST","/v1/tasks/"+taskId+"/stop",Tunnel.json("messageId",Protocol.id(),"controlEpoch",oldEpoch),true));
                assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST","/v1/tasks/"+taskId+"/continue",Tunnel.json("messageId",Protocol.id(),"controlEpoch",oldEpoch),true));
                assertFalse(f.command("snapshot").getJSONObject("control").getBoolean("paused"));
                f.gateway.json("POST","/v1/tasks/"+taskId+"/continue",Tunnel.json("messageId",Protocol.id(),"controlEpoch",newer),true);
                assertEquals(newer,f.command("snapshot").getJSONArray("tasks").getJSONObject(0).getLong("remoteControlEpoch"));
            }finally{requests.shutdownNow();}
        }
    }
    @Test public void authenticatedMaintenanceHandoffRestoresOnlyNewControlAndNeverOverridesLocalStop()throws Exception{
        try(Fixture f=new Fixture()){
            f.pair();long original=f.gate.resumeExplicitly();f.control(false,Protocol.id());
            JSONObject maintenance=f.command("maintenance").getJSONObject("control");long pausedEpoch=maintenance.getLong("controlEpoch");
            JSONObject request=Tunnel.json("messageId",Protocol.id(),"reason","maintenance_reconnected","controlEpoch",pausedEpoch+1,"maintenanceEpoch",pausedEpoch,"paused",false);
            // Merely knowing a generation is not a fresh authenticated read of it.
            assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST","/v1/device/control",request,true));
            JSONObject device=f.gateway.json("GET","/v1/state",null,false).getJSONObject("device");
            assertEquals("maintenance",device.getString("reason"));assertEquals(original,device.getLong("maintenanceResumeEpoch"));
            assertTrue(f.gate.observeMaintenance(pausedEpoch,original));assertFalse(f.gate.permitsData(pausedEpoch+1));
            ControlState.Snapshot expected=f.gate.snapshot();request.put("messageId",Protocol.id());
            JSONObject reply=f.gateway.json("POST","/v1/device/control",request,true);
            assertTrue(f.gate.acknowledgeMaintenance(expected,original,reply.getLong("controlEpoch"),reply.getBoolean("paused")));
            assertTrue(f.gate.permitsData(pausedEpoch+1));assertFalse(f.gate.permitsData(original));
            f.gate.pause("screen_off");f.gateway.json("POST","/v1/device/control",Tunnel.json("messageId",Protocol.id(),"controlEpoch",f.gate.epoch(),"paused",true,"reason","screen_off"),true);
            f.command("maintenance");JSONObject stopped=f.gateway.json("GET","/v1/state",null,false).getJSONObject("device");
            assertEquals("screen_off",stopped.getString("reason"));assertFalse(stopped.has("maintenanceResumeEpoch"));
            assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST","/v1/device/control",Tunnel.json("messageId",Protocol.id(),"controlEpoch",stopped.getLong("controlEpoch")+1,"maintenanceEpoch",stopped.getLong("controlEpoch"),"paused",false,"reason","maintenance_reconnected"),true));
            assertTrue(f.gate.paused());assertEquals(0,f.command("snapshot").getInt("creates"));
        }
    }
    @Test public void openingChatInvalidatesOldPhoneApprovalAndCannotRestartStoppedTask()throws Exception{
        try(Fixture f=new Fixture()){
            f.pair();f.gate.resumeExplicitly();f.control(false,Protocol.id());
            String taskId=f.gateway.json("POST","/v1/messages",f.message("需要精确批准的测试",new JSONArray()),false).getString("taskId");
            JSONObject old=f.command("approval","taskId",taskId).getJSONObject("approval");f.command("phoneLease","taskId",taskId);
            f.gate.pause();f.tunnel.pausePhoneData();f.control(true,Protocol.id());
            JSONObject detail=f.gateway.json("GET","/v1/tasks/"+taskId,null,false);assertEquals("paused",detail.getString("status"));assertEquals(0,detail.getJSONArray("approvals").length());
            f.gate.resumeExplicitly();f.control(false,Protocol.id());
            GatewayClient.GatewayError error=assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST","/v1/approvals/"+old.getString("id"),Tunnel.json("messageId",Protocol.id(),"controlEpoch",f.gate.epoch(),"allow",true,"fingerprint",old.getString("fingerprint")),true));
            assertEquals("approval_expired",error.code);assertEquals("paused",f.gateway.json("GET","/v1/tasks/"+taskId,null,false).getString("status"));
        }
    }
    @Test public void explicitTaskConsentCrossesRealGatewayWithoutChangingDefaultsOrMemory()throws Exception{
        try(Fixture f=new Fixture()){
            f.pair();f.gate.resumeExplicitly();f.control(false,Protocol.id());
            JSONObject request=f.message("仅此任务使用 DeepSeek 的测试",new JSONArray()).put("cloudConsent",true).put("memoryConsent",true);
            String taskId=f.gateway.json("POST","/v1/messages",request,false).getString("taskId");
            JSONObject original=f.command("snapshot");assertFalse(original.getJSONArray("tasks").getJSONObject(0).getBoolean("cloudConsent"));
            f.command("taskStatus","taskId",taskId,"status","waiting_consent");
            f.gate.pause();f.tunnel.pausePhoneData();f.control(true,Protocol.id());long stale=f.gate.epoch();
            JSONObject consent=Tunnel.json("messageId",Protocol.id(),"controlEpoch",stale,"cloudConsent",true);
            assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST","/v1/tasks/"+taskId+"/consent",consent,true));
            f.gate.resumeExplicitly();f.control(false,Protocol.id());
            assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST","/v1/tasks/"+taskId+"/consent",consent.put("messageId",Protocol.id()),true));
            consent.put("messageId",Protocol.id()).put("controlEpoch",f.gate.epoch());
            JSONObject accepted=f.gateway.json("POST","/v1/tasks/"+taskId+"/consent",consent,true);assertEquals("queued",accepted.getString("status"));
            JSONObject finalState=f.command("snapshot"),task=finalState.getJSONArray("tasks").getJSONObject(0);assertTrue(task.getBoolean("cloudConsent"));assertFalse(task.getBoolean("memoryConsent"));assertEquals(original.getJSONObject("defaults").toString(),finalState.getJSONObject("defaults").toString());assertEquals(1,finalState.getInt("creates"));
            assertEquals(accepted.getString("taskId"),f.gateway.json("POST","/v1/tasks/"+taskId+"/consent",consent,true).getString("taskId"));
            assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST","/v1/tasks/"+taskId+"/consent",consent.put("messageId",Protocol.id()),true));
        }
    }
    @Test public void deviceTimezoneUsesBoundMutualTlsControlStreamAndCannotGrantControl()throws Exception{
        try(Fixture f=new Fixture()){
            JSONObject status=Tunnel.json("edition",BuildConfig.EDITION,"androidApplicationId",BuildConfig.APPLICATION_ID,"timezone","Asia/Shanghai","observedAt",Instant.now().toString(),"deviceId","spoofed","source","model","paused",false,"controlEpoch",9999);
            assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST","/v1/device/status",status,true));
            f.pair();JSONObject before=f.command("snapshot");long earliest=System.currentTimeMillis();
            assertTrue(f.gateway.json("POST","/v1/device/status",status,true).getBoolean("accepted"));
            JSONObject after=f.command("snapshot"),telemetry=after.getJSONObject("deviceTelemetry");
            assertEquals(BuildConfig.EDITION,telemetry.getString("edition"));assertEquals(BuildConfig.APPLICATION_ID,telemetry.getString("androidApplicationId"));
            assertEquals("Asia/Shanghai",telemetry.getString("timezone"));assertEquals(f.binding.deviceId,telemetry.getString("deviceId"));
            assertEquals("boujoy_android_authenticated",telemetry.getString("source"));assertEquals(64,telemetry.getString("certificateFingerprint").length());
            assertTrue(Instant.parse(telemetry.getString("receivedAt")).toEpochMilli()>=earliest);
            assertEquals(before.getJSONObject("control").toString(),after.getJSONObject("control").toString());assertEquals(0,after.getInt("creates"));assertEquals(before.getInt("messageReceipts"),after.getInt("messageReceipts"));
            assertThrows(GatewayClient.GatewayError.class,()->f.gateway.json("POST","/v1/device/status",status.put("timezone","Not/A_Timezone"),true));
            assertTrue(f.command("snapshot").getJSONObject("deviceTelemetry").isNull("timezone"));
            GatewayClient other=f.client(new HeldCertificate.Builder().commonName("Unbound telemetry client").build());
            assertThrows(GatewayClient.GatewayError.class,()->other.json("POST","/v1/device/status",status.put("timezone","UTC"),true));
        }
    }
}
