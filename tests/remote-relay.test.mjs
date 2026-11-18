import {DISTRIBUTION,ANDROID_PACKAGE} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {createRelay} from '../src/remote/relay.mjs';
import {RelayClient,MacConnector,pipeSocket} from '../src/remote/transport.mjs';
import {hash,parseBinary} from '../src/remote/protocol.mjs';
import {RemoteState,spkiPin} from '../src/remote/state.mjs';
import {createGateway} from '../src/remote/gateway.mjs';
import {identities,eventually,request} from './helpers/remote-tls.mjs';
import {Store} from '../src/core/store.mjs';
async function relay(t){const deviceId=randomUUID(),mac=randomBytes(32).toString('hex'),android=randomBytes(32).toString('hex');const server=createRelay({routes:{[deviceId]:{macTokenHash:hash(mac),androidTokenHash:hash(android)}}});const addr=await server.listen();t.after(()=>server.close());return {server,deviceId,mac,android,url:`ws://127.0.0.1:${addr.port}/v1/tunnel`};}
test('relay rejects wrong credentials and cannot impersonate the other role',async t=>{const r=await relay(t);const ws=new WebSocket(r.url);t.after(()=>ws.terminate());await new Promise(resolve=>ws.once('open',resolve));const closed=new Promise(resolve=>ws.once('close',resolve));ws.send(JSON.stringify({type:'hello',version:1,role:'mac',lane:'data',deviceId:r.deviceId,routeToken:r.android}));assert.equal(await closed,1008);assert.equal(r.server.lanes.size,0);});
test('chat reaches restricted gateway inside unchanged end-to-end TLS over the relay',async t=>{const r=await relay(t),id=identities();t.after(id.cleanup);const store=new Store(id.dir,{lock:false});t.after(()=>store.close());const state=new RemoteState(id.dir);const g=createGateway({identity:id.server,state,store,engine:{active:new Map()},phone:{},dataDir:id.dir});const gatewayPort=await g.listen();t.after(()=>g.close());const mac=new MacConnector({config:{relayUrl:r.url,deviceId:r.deviceId,macRouteToken:r.mac,allowLoopback:true},gatewayPort,controlState:()=>({controlEpoch:0,paused:true})});await mac.start();t.after(()=>mac.close());const android=new RelayClient({url:r.url,deviceId:r.deviceId,routeToken:r.android,role:'android',lane:'data',allowLoopback:true,reconnect:false});t.after(()=>android.close());android.start();await eventually(()=>android.peerOnline&&mac.clients.data.peerOnline);const secret=state.issuePairing({deviceId:r.deviceId});const stream=android.open('chat',0);const result=await request({stream,identity:id.client,pin:spkiPin(id.server.cert),method:'POST',pathname:'/v1/pair',body:{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,pairToken:secret.pairToken,clientName:'test'}});assert.equal(result.status,200);assert.equal(result.body.paired,true);const stateResult=await request({stream:android.open('chat',0),identity:id.client,pin:spkiPin(id.server.cert)});assert.equal(stateResult.status,200);assert.equal(stateResult.body.device.paused,true);});
test('disconnect drops streams and reconnect does not replay old data',async t=>{const r=await relay(t);const mac=new RelayClient({url:r.url,deviceId:r.deviceId,routeToken:r.mac,allowLoopback:true,reconnect:false,onStream:()=>true});const android=new RelayClient({url:r.url,deviceId:r.deviceId,routeToken:r.android,role:'android',allowLoopback:true,reconnect:false});t.after(()=>{mac.close();android.close();});mac.start();android.start();await eventually(()=>mac.peerOnline&&android.peerOnline);const stream=android.open('chat',0);await stream.ready;assert.equal(mac.streams.size,1);mac.ws.terminate();await eventually(()=>stream.destroyed&&!android.peerOnline);assert.equal(android.streams.size,0);assert.equal(r.server.lanes.values().next().value.streams.size,0);});
test('ordered close drains a buffered final payload without truncation',async t=>{
 const r=await relay(t),payload=randomBytes(1024*1024);let incoming;
 const mac=new RelayClient({url:r.url,deviceId:r.deviceId,routeToken:r.mac,allowLoopback:true,reconnect:false,onStream:stream=>{incoming=stream;return true;}});
 const android=new RelayClient({url:r.url,deviceId:r.deviceId,routeToken:r.android,role:'android',allowLoopback:true,reconnect:false});
 t.after(()=>{mac.close();android.close();});mac.start();android.start();await eventually(()=>mac.peerOnline&&android.peerOnline);
 const stream=android.open('chat',0);await stream.ready;stream.end(payload);await eventually(()=>incoming?.remoteClosed);
 const chunks=[];for await(const part of incoming)chunks.push(part);assert.deepEqual(Buffer.concat(chunks),payload);
});
test('control lane delivers while data consumer is stalled',async t=>{
 const r=await relay(t),peers=[],received=[];let stalled;
 for(const lane of ['data','control'])for(const role of ['mac','android']){const client=new RelayClient({url:r.url,deviceId:r.deviceId,routeToken:r[role],role,lane,allowLoopback:true,reconnect:false,onStream:stream=>{if(lane==='data')stalled=stream;else stream.on('data',b=>received.push(b));return true;}});peers.push(client);client.start();}
 t.after(()=>peers.forEach(c=>c.close()));await eventually(()=>peers.every(c=>c.peerOnline));
 const data=peers.find(c=>c.role==='android'&&c.lane==='data').open('chat',1);await data.ready;data.write(randomBytes(3*1024*1024));await eventually(()=>stalled?.readableLength>256*1024);
 const control=peers.find(c=>c.role==='android'&&c.lane==='control').open('chat-control',1);await control.ready;control.write(Buffer.from('stop-now'));await eventually(()=>Buffer.concat(received).toString()==='stop-now');assert.ok(stalled.readableLength>0);
});


test('large Mac reply uses bounded messages and remains complete across ordered close',async t=>{
 const r=await relay(t),payload=randomBytes(1024*1024+31),frames=[];
 const mac=new RelayClient({url:r.url,deviceId:r.deviceId,routeToken:r.mac,allowLoopback:true,reconnect:false,onStream:stream=>{stream.end(payload);return true;}});
 const android=new RelayClient({url:r.url,deviceId:r.deviceId,routeToken:r.android,role:'android',allowLoopback:true,reconnect:false});
 t.after(()=>{mac.close();android.close();});mac.start();android.start();await eventually(()=>mac.peerOnline&&android.peerOnline);
 android.ws.on('message',(bytes,binary)=>{if(binary)frames.push(parseBinary(bytes).payload.length);});
 const stream=android.open('chat',0),chunks=[];for await(const chunk of stream)chunks.push(chunk);
 assert.deepEqual(Buffer.concat(chunks),payload);assert.ok(frames.length>64);assert.ok(frames.every(size=>size<=16*1024));
});
