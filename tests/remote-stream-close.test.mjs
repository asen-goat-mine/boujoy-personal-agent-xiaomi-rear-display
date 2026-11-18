import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {createRelay} from '../src/remote/relay.mjs';
import {RelayClient} from '../src/remote/transport.mjs';
import {hash,binaryFrame,parseBinary} from '../src/remote/protocol.mjs';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label='condition'){const end=Date.now()+2500;while(!fn()){if(Date.now()>end)throw Error('Timed out: '+label);await delay(5);}}
async function fixture(t,{relayOptions={},clientOptions={},accept,lanes=['data']}={}){
 const deviceId=randomUUID(),tokens={mac:randomBytes(32).toString('hex'),android:randomBytes(32).toString('hex')};
 const relay=createRelay({...relayOptions,routes:{[deviceId]:{macTokenHash:hash(tokens.mac),androidTokenHash:hash(tokens.android)}}});
 const address=await relay.listen(),url=`ws://127.0.0.1:${address.port}/v1/tunnel`,clients={},incoming=new Map(),closes=[];
 t.after(async()=>{for(const client of Object.values(clients)){client.ws?._socket?.resume();client.close();}await relay.close();});
 for(const lane of lanes)for(const role of ['mac','android']){
  const client=new RelayClient({...clientOptions,url,deviceId,routeToken:tokens[role],role,lane,allowLoopback:true,reconnect:false,onStream:stream=>{incoming.set(lane+':'+stream.id,stream);return accept?accept(stream,lane):true;}});
  clients[lane+':'+role]=client;client.start();client.ws.on('close',(code,reason)=>closes.push({role,lane,code,reason:String(reason)}));
 }
 await until(()=>Object.values(clients).every(c=>c.peerOnline),'all peers');
 return {relay,clients,incoming,closes,deviceId,lane:name=>relay.lanes.get(deviceId+':'+name),async open(lane='data'){const stream=clients[lane+':android'].open(lane==='data'?'chat':'chat-control',0);await stream.ready;return stream;}};
}
async function roundTrip(f,stream,text){const arrived=[];const listener=b=>arrived.push(b);stream.on('data',listener);f.incoming.get(stream.owner.lane+':'+stream.id).write(Buffer.from(text));await until(()=>Buffer.concat(arrived).toString()===text,'unrelated stream reply');stream.off('data',listener);assert.equal(stream.destroyed,false);}

for(const lane of ['data','control'])test(`closed ${lane} stream reverse bytes do not break an active or new stream or the other lane`,async t=>{
 const f=await fixture(t,{lanes:['data','control']}),mac=f.clients[lane+':mac'],android=f.clients[lane+':android'];
 const closed=await f.open(lane),other=await f.open(lane),otherLane=await f.open(lane==='data'?'control':'data');await roundTrip(f,other,'before');
 mac.ws._socket.pause();closed.destroy();await until(()=>!f.lane(lane).streams.has(closed.id));
 const reverse=f.incoming.get(lane+':'+closed.id);assert.equal(reverse.remoteClosed,false);reverse.write(Buffer.from('legitimate reverse tail before close was observed'));
 let received=false;f.lane(lane).peers.mac.once('message',()=>received=true);await until(()=>received,'late binary processed');
 mac.ws._socket.resume();await until(()=>reverse.remoteClosed);await roundTrip(f,other,'after');await roundTrip(f,await f.open(lane),'new chat');await roundTrip(f,otherLane,'other lane');
 assert.equal(android.peerOnline,true);assert.equal(mac.peerOnline,true);assert.deepEqual(f.closes,[]);
});

test('already forwarded bytes arriving after local close are dropped without closing RelayClient',async t=>{
 const f=await fixture(t),android=f.clients['data:android'],closed=await f.open(),other=await f.open();await roundTrip(f,other,'baseline');
 android.ws._socket.pause();let forwarded=false;
 f.lane('data').peers.mac.on('message',(raw,binary)=>{if(binary&&parseBinary(raw).id===closed.id)forwarded=true;});
 f.incoming.get('data:'+closed.id).write(Buffer.from('valid bytes already in transit'));await until(()=>forwarded);
 closed.destroy();await until(()=>!f.lane('data').streams.has(closed.id));android.ws._socket.resume();
 await roundTrip(f,other,'still alive');await roundTrip(f,await f.open(),'new request');assert.deepEqual(f.closes,[]);
});

test('relay accepts one delayed opened for an actually cancelled pending stream then drops its bytes',async t=>{
 let accept;const f=await fixture(t,{accept:()=>new Promise(r=>accept=r)}),mac=f.clients['data:mac'],android=f.clients['data:android'];
 const stream=android.open('chat',0);await until(()=>accept);mac.ws._socket.pause();stream.destroy();await until(()=>f.lane('data').closedStreams.has(stream.id));
 assert.equal(f.lane('data').closedStreams.get(stream.id).opened,false);accept(true);await until(()=>f.incoming.get('data:'+stream.id).opened);
 await until(()=>f.lane('data').closedStreams.get(stream.id).opened);f.incoming.get('data:'+stream.id).write(Buffer.from('tail from just accepted stream'));
 mac.ws._socket.resume();await until(()=>f.incoming.get('data:'+stream.id).remoteClosed);assert.equal(mac.peerOnline,true);assert.equal(android.peerOnline,true);assert.deepEqual(f.closes,[]);
});

test('RelayClient handles queued opened then bytes after it locally cancelled the pending stream',async t=>{
 let accept;const f=await fixture(t,{accept:()=>new Promise(r=>accept=r)}),android=f.clients['data:android'];
 const stream=android.open('chat',0);await until(()=>accept);android.ws._socket.pause();accept(true);
 await until(()=>f.lane('data').streams.get(stream.id)?.opened);let forwarded=false;
 f.lane('data').peers.mac.on('message',(raw,binary)=>{if(binary&&parseBinary(raw).id===stream.id)forwarded=true;});
 f.incoming.get('data:'+stream.id).write(Buffer.from('queued after opened'));await until(()=>forwarded);stream.destroy();assert.equal(android.closedStreams.get(stream.id).opened,false);
 android.ws._socket.resume();await until(()=>android.closedStreams.get(stream.id)?.opened);assert.equal(android.peerOnline,true);assert.deepEqual(f.closes,[]);
});

for(const kind of ['binary','opened'])test(`relay still rejects never-opened ${kind}; an unsolicited close grants nothing`,async t=>{
 const f=await fixture(t),mac=f.clients['data:mac'];mac.send({type:'close',streamId:999});
 if(kind==='binary')await mac.sendBinary(999,Buffer.from('unknown'));else mac.send({type:'opened',streamId:999});
 await until(()=>f.closes.some(x=>x.role==='mac'));assert.equal(f.closes.find(x=>x.role==='mac').code,1008);
});

test('relay rejects bytes for a pending cancelled stream before it was opened',async t=>{
 const f=await fixture(t,{accept:()=>new Promise(()=>{})}),mac=f.clients['data:mac'],android=f.clients['data:android'];
 const stream=android.open('chat',0);await until(()=>f.incoming.has('data:'+stream.id));stream.destroy();await until(()=>f.lane('data').closedStreams.has(stream.id));
 await mac.sendBinary(stream.id,Buffer.from('not yet opened'));await until(()=>f.closes.some(x=>x.role==='mac'));assert.equal(f.closes.find(x=>x.role==='mac').code,1008);
});

for(const role of ['mac','android'])test(`relay rejects ${role==='mac'?'duplicate':'wrong-owner'} late opened`,async t=>{
 const f=await fixture(t),stream=await f.open();stream.destroy();await until(()=>f.lane('data').closedStreams.has(stream.id));f.clients['data:'+role].send({type:'opened',streamId:stream.id});
 await until(()=>f.closes.some(x=>x.role===role));assert.equal(f.closes.find(x=>x.role===role).code,1008);
});

test('recent stream ids cannot be reused by local or remote open',async t=>{
 const f=await fixture(t),android=f.clients['data:android'],stream=await f.open();stream.destroy();await until(()=>f.lane('data').closedStreams.has(stream.id));
 android.nextId=stream.id;assert.throws(()=>android.open('chat',0),/Invalid protocol/);
 android.send({type:'open',streamId:stream.id,kind:'chat',epoch:0});await until(()=>f.closes.some(x=>x.role==='android'));assert.equal(f.closes.find(x=>x.role==='android').code,1008);
});

test('relay capacity is bounded and evicted late ids are rejected',async t=>{
 const f=await fixture(t,{relayOptions:{maxClosedStreams:2}}),ids=[];
 for(let i=0;i<3;i++){const s=await f.open();ids.push(s.id);s.destroy();await until(()=>!f.lane('data').streams.has(s.id));}
 assert.equal(f.lane('data').closedStreams.size,2);assert.equal(f.lane('data').closedStreams.has(ids[0]),false);
 await f.clients['data:mac'].sendBinary(ids[0],Buffer.from('evicted'));await until(()=>f.closes.some(x=>x.role==='mac'));assert.equal(f.closes.find(x=>x.role==='mac').code,1008);
});

test('relay TTL is not refreshed by repeated close and expired bytes are rejected',async t=>{
 const f=await fixture(t,{relayOptions:{closedStreamTtlMs:120}}),s=await f.open(),mac=f.clients['data:mac'];s.destroy();await until(()=>f.lane('data').closedStreams.has(s.id));
 const at=f.lane('data').closedStreams.get(s.id).closedAt;mac.send({type:'close',streamId:s.id});await delay(30);assert.equal(f.lane('data').closedStreams.get(s.id).closedAt,at);
 await delay(130);await mac.sendBinary(s.id,Buffer.from('expired'));await until(()=>f.closes.some(x=>x.role==='mac'));assert.equal(f.closes.find(x=>x.role==='mac').code,1008);
});

test('peer loss clears both relay and client retirement records without replay',async t=>{
 const f=await fixture(t),android=f.clients['data:android'],mac=f.clients['data:mac'],s=await f.open();s.destroy();await until(()=>mac.closedStreams.has(s.id));assert.ok(f.lane('data').closedStreams.size);
 mac.ws.terminate();await until(()=>!android.peerOnline);assert.equal(android.closedStreams.size,0);assert.equal(f.lane('data').closedStreams.size,0);assert.equal(android.streams.size,0);
});

test('an id can be deliberately reused only after all retirement windows have expired',async t=>{
 const options={closedStreamTtlMs:100},f=await fixture(t,{relayOptions:options,clientOptions:options}),android=f.clients['data:android'];
 const original=await f.open();original.destroy();await until(()=>f.clients['data:mac'].closedStreams.has(original.id));await delay(120);
 android.nextId=original.id;const replacement=await f.open();assert.equal(replacement.id,original.id);await roundTrip(f,replacement,'only new content');assert.deepEqual(f.closes,[]);
});

// A controlled authenticated relay fixture exercises client-side validation;
// the real relay correctly filters these invalid frames before forwarding them.
async function clientPeer(t,options={}){
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));let peer;const frames=[],closes=[];
 server.on('connection',ws=>{peer=ws;ws.on('message',(raw,binary)=>{if(binary)return;const p=JSON.parse(raw);frames.push(p);if(p.type==='hello'){ws.send(JSON.stringify({type:'hello',version:1,accepted:true}));ws.send(JSON.stringify({type:'peer',online:true}));}if(p.type==='open')ws.send(JSON.stringify({type:'opened',streamId:p.streamId}));});ws.on('close',code=>closes.push(code));});
 const client=new RelayClient({...options,url:`ws://127.0.0.1:${server.address().port}/v1/tunnel`,deviceId:randomUUID(),routeToken:randomBytes(32).toString('hex'),role:'android',allowLoopback:true,reconnect:false});client.start();
 t.after(async()=>{client.close();for(const ws of server.clients)ws.terminate();await new Promise(r=>server.close(r));});await until(()=>client.peerOnline);
 return {client,peer,frames,closes,send:p=>peer.send(JSON.stringify(p))};
}
for(const kind of ['binary','opened'])test(`RelayClient rejects never-opened ${kind} despite unknown close`,async t=>{
 const f=await clientPeer(t);f.send({type:'close',streamId:999});if(kind==='binary')f.peer.send(binaryFrame(999,Buffer.from('invalid')));else f.send({type:'opened',streamId:999});
 await until(()=>f.closes.length);assert.equal(f.closes[0],1008);
});
test('RelayClient retirement capacity and TTL stay bounded and do not refresh on close',async t=>{
 const f=await clientPeer(t,{maxClosedStreams:2,closedStreamTtlMs:150}),ids=[];
 for(let i=0;i<3;i++){const s=f.client.open('chat',0);await s.ready;ids.push(s.id);s.destroy();}
 assert.equal(f.client.closedStreams.size,2);assert.equal(f.client.closedStreams.has(ids[0]),false);const at=f.client.closedStreams.get(ids[2]).closedAt;
 f.send({type:'close',streamId:ids[2]});await delay(30);assert.equal(f.client.closedStreams.get(ids[2]).closedAt,at);
 await delay(160);f.peer.send(binaryFrame(ids[2],Buffer.from('expired')));await until(()=>f.closes.length);assert.equal(f.closes[0],1008);
});
test('RelayClient rejects late binary for an evicted closed id',async t=>{
 const f=await clientPeer(t,{maxClosedStreams:1}),a=f.client.open('chat',0);await a.ready;a.destroy();const b=f.client.open('chat',0);await b.ready;b.destroy();
 f.peer.send(binaryFrame(a.id,Buffer.from('evicted')));await until(()=>f.closes.length);assert.equal(f.closes[0],1008);
});

test('RelayClient rejects duplicate late opened and reuse of a recently closed incoming id',async t=>{
 const f=await clientPeer(t),s=f.client.open('chat',0);await s.ready;s.destroy();f.send({type:'opened',streamId:s.id});await until(()=>f.closes.length);assert.equal(f.closes[0],1008);
});
test('RelayClient cannot accept an incoming open that reuses a recent incoming closed id',async t=>{
 const f=await clientPeer(t);f.send({type:'open',streamId:2,kind:'phone-data',epoch:0});await until(()=>f.client.streams.get(2)?.opened);
 f.send({type:'close',streamId:2});await until(()=>f.client.closedStreams.has(2));f.send({type:'open',streamId:2,kind:'phone-data',epoch:0});await until(()=>f.closes.length);assert.equal(f.closes[0],1008);
});
test('RelayClient clears retirement records when the peer session changes',async t=>{
 const f=await clientPeer(t),s=f.client.open('chat',0);await s.ready;s.destroy();assert.equal(f.client.closedStreams.size,1);
 f.send({type:'peer',online:false});await until(()=>!f.client.peerOnline);assert.equal(f.client.closedStreams.size,0);f.send({type:'peer',online:true});await until(()=>f.client.peerOnline);
 const fresh=f.client.open('chat',1);await fresh.ready;assert.notEqual(fresh.id,s.id);f.peer.send(binaryFrame(s.id,Buffer.from('old session data')));await until(()=>f.closes.length);assert.equal(f.closes[0],1008);
});
