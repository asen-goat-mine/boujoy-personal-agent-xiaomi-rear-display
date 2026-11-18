import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {RelayClient,MacConnector,pipeSocket} from '../src/remote/transport.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+2500;while(!check()){assert.ok(Date.now()<deadline,'fixture deadline');await delay(5);}}
function ownerFor(kind='chat'){
 const owner=new RelayClient({url:'ws://127.0.0.1:1/v1/tunnel',deviceId:'fixture-local-stream',routeToken:'fixture-token-not-used',role:kind==='phone-data'?'mac':'android',allowLoopback:true,reconnect:false});
 owner.connected=true;owner.peerOnline=true;owner.send=()=>true;owner.sendBinary=async()=>{};return owner;
}
async function pendingSocket(t,kind='chat'){
 const owner=ownerFor(kind),chunks=[],sockets=new Set();let finish,linked;
 const received=new Promise(resolve=>{finish=resolve;});
 const sink=net.createServer(socket=>{sockets.add(socket);socket.on('data',chunk=>chunks.push(chunk));socket.on('error',()=>{});socket.on('end',()=>{socket.end();finish();});socket.on('close',()=>{sockets.delete(socket);finish();});});
 sink.listen(0,'127.0.0.1');await once(sink,'listening');
 const stream=owner.open(kind,0);stream.markOpened();const pipe=stream.pipe;
 stream.pipe=function(socket,...args){linked=socket;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));const write=socket._write;socket._write=function(chunk,encoding,done){setTimeout(()=>{if(this.destroyed){done(Error('fixture pending write aborted'));return;}write.call(this,chunk,encoding,done);},90);};return pipe.call(this,socket,...args);};
 t.after(async()=>{owner.close();stream.destroy();for(const socket of sockets)socket.destroy();await new Promise(resolve=>sink.close(resolve));});
 await pipeSocket(stream,{port:sink.address().port});
 return {owner,stream,linked,chunks,received};
}
for(const operation of ['pause','disconnect','close'])test(`${operation} immediately aborts TCP drain even after remote EOF retires the stream`,{timeout:5000},async t=>{
 const f=await pendingSocket(t,operation==='pause'?'phone-data':'chat'),payload=randomBytes(49463),closed=once(f.stream,'close');
 f.stream.receive(payload);f.stream.endRemote();await closed;
 assert.equal(f.owner.streams.size,0);assert.equal(f.owner.linkedSockets.size,1);assert.equal(f.linked.destroyed,false);assert.ok(f.linked.writableLength>0);
 if(operation==='pause')f.owner.pauseData();else if(operation==='close')f.owner.close();else f.owner.dropStreams('peer_offline');
 assert.equal(f.linked.destroyed,true,'revocation must not wait for normal drain');await f.received;await delay(110);
 assert.equal(Buffer.concat(f.chunks).length,0,'pending data must not be delivered after revocation');
 const diagnostics=f.owner.diagnostics();assert.equal(diagnostics.linkedSockets,0);assert.equal(diagnostics.recentStreams[0].incomingBytes,payload.length);assert.equal(diagnostics.recentStreams[0].firstClose.source,'remote_close');
 assert.equal(diagnostics.recentStreams[0].socketAbort,operation==='pause'?'local_pause':operation==='close'?'local_stop':'peer_offline');
});
test('pauseData preserves a chat response already draining normally',{timeout:5000},async t=>{
 const f=await pendingSocket(t),payload=randomBytes(16695),closed=once(f.stream,'close');f.stream.receive(payload);f.stream.endRemote();await closed;
 f.owner.pauseData();assert.equal(f.linked.destroyed,false);await f.received;assert.deepEqual(Buffer.concat(f.chunks),payload);
 await until(()=>f.owner.linkedSockets.size===0);assert.equal(f.owner.diagnostics().recentStreams[0].socketDrain,'finished');
});
test('local stream error aborts pending TCP bytes instead of treating them as remote EOF',{timeout:5000},async t=>{
 const f=await pendingSocket(t),payload=randomBytes(16695);f.stream.receive(payload);
 f.stream.destroy(Object.assign(Error('SENSITIVE_FIXTURE_CONTENT_MUST_NOT_APPEAR'),{code:'ECONNRESET'}));await f.received;await delay(110);
 assert.equal(Buffer.concat(f.chunks).length,0);const result=f.owner.diagnostics();assert.equal(result.recentStreams[0].firstClose.source,'stream_error');assert.equal(result.recentStreams[0].errorCode,'ECONNRESET');assert.ok(!JSON.stringify(result).includes('SENSITIVE_FIXTURE'));
});
test('stream diagnostic ring is bounded, counts confirmed writes and snapshots cannot mutate it',async()=>{
 const owner=ownerFor();
 for(let i=0;i<15;i++){const stream=owner.open('chat',0);stream.markOpened();await new Promise((resolve,reject)=>stream.write(Buffer.alloc(i+1),error=>error?reject(error):resolve()));stream.destroy();}
 const connector=new MacConnector();connector.clients.data=owner;
 const before=connector.status().transportDiagnostics.data;assert.equal(before.recentStreams.length,12);assert.equal(before.recentStreams[0].outgoingBytes,4);assert.equal(before.recentStreams.at(-1).outgoingBytes,15);
 before.recentStreams[0].outgoingBytes=0;assert.equal(owner.diagnostics().recentStreams[0].outgoingBytes,4);owner.close();
});
for(const mode of ['remote_close','remote_abort','protocol_rejected'])test(`WebSocket ${mode} survives in status as safe close metadata`,async t=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');let peer;
 server.on('connection',ws=>{peer=ws;ws.on('message',()=>{ws.send(JSON.stringify({type:'hello',version:1,accepted:true}));ws.send(JSON.stringify({type:'peer',online:true}));});});
 const client=new RelayClient({url:`ws://127.0.0.1:${server.address().port}/v1/tunnel`,deviceId:'fixture-close-metadata',routeToken:'fixture-token-not-used',role:'android',allowLoopback:true,reconnect:false});
 t.after(async()=>{client.close();for(const socket of server.clients)socket.terminate();await new Promise(resolve=>server.close(resolve));});client.start();await until(()=>client.peerOnline);
 if(mode==='remote_abort')peer.terminate();else if(mode==='protocol_rejected')peer.send(JSON.stringify({type:'SENSITIVE_FIXTURE_CONTENT'}));else peer.close(1000,'SENSITIVE_FIXTURE_CONTENT');
 await until(()=>client.lastWsClose);const result=client.diagnostics();assert.equal(result.lastWsClose.code,mode==='remote_abort'?1006:mode==='protocol_rejected'?1008:1000);assert.equal(result.lastWsClose.classification,mode==='remote_abort'?'abnormal':mode==='protocol_rejected'?'policy':'normal');assert.equal(result.lastWsClose.source,mode==='protocol_rejected'?'protocol_rejected':'remote_ws_close');assert.ok(!JSON.stringify(result).includes('SENSITIVE_FIXTURE'));
});

test('pause owns the reverse drain after both remote EOF and local TCP close',{timeout:5000},async t=>{
 const owner=ownerFor('phone-data'),payload=randomBytes(49463),sent=[];let release,writeStarted,linked,peer;
 const firstWrite=new Promise(resolve=>{writeStarted=resolve;});
 owner.sendBinary=async(id,part)=>{sent.push(Buffer.from(part));if(sent.length===1){writeStarted();await new Promise(resolve=>{release=resolve;});}};
 const sockets=new Set(),sink=net.createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));peer=socket;socket.write(payload.subarray(0,16384));});
 sink.listen(0,'127.0.0.1');await once(sink,'listening');const stream=owner.open('phone-data',0);stream.markOpened();
 const pipe=stream.pipe;stream.pipe=function(socket,...args){linked=socket;return pipe.call(this,socket,...args);};
 t.after(async()=>{release?.();owner.close();stream.destroy();for(const socket of sockets)socket.destroy();await new Promise(resolve=>sink.close(resolve));});
 await pipeSocket(stream,{port:sink.address().port});const localEnd=once(linked,'end');await firstWrite;
 // firstWrite only proves the first TCP chunk reached the WSS writer. Queue
 // the deliberately split remainder and await its FIN before remote EOF;
 // otherwise allowHalfOpen=false correctly rejects later TCP writes.
 peer.end(payload.subarray(16384));await localEnd;
 assert.equal(linked.bytesRead,payload.length,'the full reverse payload reached the socket');
 assert.equal(stream.writableLength,payload.length,'all reverse bytes remain queued behind the first WSS write');
 stream.endRemote();
 await until(()=>linked.destroyed);assert.equal(owner.streams.size,0);assert.equal(stream.destroyed,false,'first WSS write is deliberately still pending');
 owner.pauseData();assert.equal(stream.destroyed,true,'stop must still own the retired reverse drain');release();await delay(30);
 assert.equal(sent.length,1,'no later chunk may be sent after pause');await until(()=>owner.linkedSockets.size===0);
});
