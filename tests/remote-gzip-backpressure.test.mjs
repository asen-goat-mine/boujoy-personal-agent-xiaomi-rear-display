import {DISTRIBUTION,ANDROID_PACKAGE} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import https from 'node:https';
import tls from 'node:tls';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {Store} from '../src/core/store.mjs';
import {RemoteState,spkiPin} from '../src/remote/state.mjs';
import {createGateway} from '../src/remote/gateway.mjs';
import {createRelay} from '../src/remote/relay.mjs';
import {RelayClient,MacConnector,pipeSocket} from '../src/remote/transport.mjs';
import {hash} from '../src/remote/protocol.mjs';
import {identities,eventually,request} from './helpers/remote-tls.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const digest=value=>createHash('sha256').update(value).digest('hex');
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});
const closeServer=server=>new Promise(resolve=>server.close(resolve));
function delaySocketWrites(socket,ms){
 const write=socket._write;
 socket._write=function(chunk,encoding,done){
  setTimeout(()=>{if(this.destroyed){done(Error('fixture socket destroyed before pending write'));return;}write.call(this,chunk,encoding,done);},ms);
 };
}

// Use the actual TunnelStream returned by RelayClient.open. Its owner is a
// controlled protocol sink; pipeSocket and its destination are real TCP sockets.
for(const bytes of [16384+311,3*16384+311])test(`pipeSocket drains ${bytes} ordered bytes before downstream TCP close`,{timeout:8000},async t=>{
 const sockets=new Set(),chunks=[];let ended;
 const received=new Promise(resolve=>{ended=resolve;});
 const sink=net.createServer(socket=>{sockets.add(socket);socket.on('data',chunk=>chunks.push(chunk));socket.on('error',()=>{});socket.on('end',()=>{socket.end();ended();});socket.on('close',()=>{sockets.delete(socket);ended();});});
 const port=await listen(sink),owner=new RelayClient({url:'ws://127.0.0.1:1/v1/tunnel',deviceId:'fixture-local-stream',routeToken:'fixture-token-not-used-for-network',role:'android',allowLoopback:true,reconnect:false});
 owner.connected=true;owner.peerOnline=true;owner.send=()=>true;
 const stream=owner.open('chat',0);stream.markOpened();
 const originalPipe=stream.pipe;
 stream.pipe=function(socket,...args){sockets.add(socket);socket.on('close',()=>sockets.delete(socket));delaySocketWrites(socket,35);return originalPipe.call(this,socket,...args);};
 t.after(async()=>{stream.destroy();owner.close();for(const socket of sockets)socket.destroy();await closeServer(sink);});
 await pipeSocket(stream,{port});const payload=randomBytes(bytes);
 stream.receive(payload);stream.endRemote(); // Exactly the ordered binary -> close receive path.
 await received;
 assert.equal(Buffer.concat(chunks).length,payload.length,'ordered EOF must not discard downstream pending writes');
 assert.equal(digest(Buffer.concat(chunks)),digest(payload));
});

async function fixture(t,{sendDelayMs=0}={}){
 const identity=identities(),store=new Store(identity.dir,{lock:false}),state=new RemoteState(identity.dir),engine={active:new Map()};
 const gateway=createGateway({identity:identity.server,state,store,engine,phone:{},dataDir:identity.dir}),port=await gateway.listen();
 const deviceId=randomUUID(),tokens={mac:randomBytes(32).toString('hex'),android:randomBytes(32).toString('hex')};
 const relay=createRelay({routes:{[deviceId]:{macTokenHash:hash(tokens.mac),androidTokenHash:hash(tokens.android)}}}),address=await relay.listen(),url=`ws://127.0.0.1:${address.port}/v1/tunnel`;
 const mac=new MacConnector({config:{relayUrl:url,deviceId,macRouteToken:tokens.mac,allowLoopback:true},gatewayPort:port,controlState:()=>state.data.control});await mac.start();
 const android=new RelayClient({url,deviceId,routeToken:tokens.android,role:'android',lane:'data',allowLoopback:true,reconnect:false});android.start();
 const sockets=new Set();
 // Extra loopback pair models the Android TLS endpoint independently of its
 // WebSocket stream. Normal EOF ends output; explicit errors still abort it.
 const proxy=net.createServer(socket=>{
  sockets.add(socket);const stream=android.open('chat',0);
  socket.on('error',()=>stream.destroy());socket.on('close',()=>{sockets.delete(socket);stream.destroy();});
  stream.on('error',()=>socket.destroy());stream.on('close',()=>{if(stream.errored)socket.destroy();else if(!socket.writableEnded)socket.end();});
  delaySocketWrites(socket,4);socket.pipe(stream);stream.pipe(socket);
 });
 const proxyPort=await listen(proxy);
 t.after(async()=>{for(const socket of sockets)socket.destroy();await closeServer(proxy);android.close();await mac.close();await gateway.close();await relay.close();store.close();identity.cleanup();});
 await eventually(()=>android.peerOnline&&mac.clients.data.peerOnline);
 const challenge=state.issuePairing({deviceId});
 assert.equal((await request({port:proxyPort,identity:identity.client,pin:spkiPin(identity.server.cert),pathname:'/v1/pair',method:'POST',body:{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,pairToken:challenge.pairToken}})).status,200);
 if(sendDelayMs){const send=mac.clients.data.sendBinary.bind(mac.clients.data);mac.clients.data.sendBinary=async(...args)=>{await send(...args);await delay(sendDelayMs);};}
 return {identity,store,state,gateway,mac,android,proxyPort};
}
function slowGzipRequest({port,identity,pin}){
 return new Promise((resolve,reject)=>{
  const agent=new https.Agent({keepAlive:false});
  agent.createConnection=(options,callback)=>{
   const socket=tls.connect({host:'127.0.0.1',port,key:identity.key,cert:identity.cert,rejectUnauthorized:false,minVersion:'TLSv1.3',maxVersion:'TLSv1.3'});
   socket.once('error',reject);socket.once('secureConnect',()=>{if(spkiPin(socket.getPeerCertificate().raw)!==pin){socket.destroy();callback(Error('fixture pin mismatch'));return;}callback(null,socket);});
  };
  const req=https.request({host:'boujoy.gateway',path:'/v1/state',agent,headers:{Host:'boujoy.gateway',Connection:'close','Accept-Encoding':'gzip'}},res=>{
   const chunks=[];res.on('data',chunk=>{chunks.push(chunk);res.pause();setTimeout(()=>res.resume(),12);});res.on('error',reject);
   res.on('end',()=>{agent.destroy();resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)});});
  });
  req.setTimeout(6000,()=>req.destroy(Error('fixture response timed out')));req.on('error',error=>{agent.destroy();reject(error);});req.end();
 });
}
for(const sendDelayMs of [0,8])test(`large gzip gateway reply survives socket-pair slow reads and ${sendDelayMs}ms relay write delay`,{timeout:20000},async t=>{
 const f=await fixture(t,{sendDelayMs}),tail='SYNTHETIC-GZIP-LAST-ROW';
 f.store.transaction(s=>{for(let i=0;i<32;i++)s.tasks.push({id:randomUUID(),roleId:'concierge',title:'Synthetic state '+i,prompt:'Fixture only',status:'completed',result:randomBytes(3000).toString('base64')+(i===31?tail:''),messages:[],events:[],updatedAt:new Date().toISOString()});});
 const before=JSON.stringify(f.state.data.control),receivedBefore=f.android.traffic.receivedBytes,sentBefore=f.mac.clients.data.traffic.sentBytes;
 const response=await slowGzipRequest({port:f.proxyPort,identity:f.identity.client,pin:spkiPin(f.identity.server.cert)});
 assert.equal(response.status,200);assert.equal(response.headers['content-encoding'],'gzip');assert.ok(response.body.length>48*1024);
 assert.equal(response.body.length,Number(response.headers['content-length']));const decoded=JSON.parse(gunzipSync(response.body));
 assert.equal(decoded.tasks.length,32);assert.ok(decoded.tasks.at(-1).result.endsWith(tail));assert.equal(JSON.stringify(f.state.data.control),before);
 await eventually(()=>f.mac.clients.data.streams.size===0&&f.android.streams.size===0);
 assert.equal(f.android.traffic.receivedBytes-receivedBefore,f.mac.clients.data.traffic.sentBytes-sentBefore,'all encrypted response bytes reach the peer');
 t.diagnostic('compressed bytes='+response.body.length+', encrypted bytes='+(f.android.traffic.receivedBytes-receivedBefore));
 const follow=await request({port:f.proxyPort,identity:f.identity.client,pin:spkiPin(f.identity.server.cert),pathname:'/v1/voice/status'});
 assert.equal(follow.status,200);assert.equal(f.android.peerOnline,true);assert.equal(f.mac.clients.data.peerOnline,true);
});
