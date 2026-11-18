import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {RelayClient} from '../src/remote/transport.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+5000;while(!fn()){assert.ok(Date.now()<end,'liveness transition deadline');await sleep(10);}}
async function fixture(t,handler,options={}){
 const server=new WebSocketServer({host:'127.0.0.1',port:0,autoPong:false});await new Promise(r=>server.once('listening',r));
 const peers=[],frames=[];server.on('connection',ws=>{peers.push(ws);ws.on('message',raw=>{const p=JSON.parse(raw);frames.push(p);handler(ws,p,peers.length);});});
 const client=new RelayClient({url:`ws://127.0.0.1:${server.address().port}/v1/tunnel`,deviceId:'liveness-fixture',routeToken:'x'.repeat(32),role:'android',allowLoopback:true,heartbeatMs:150,pongTimeoutMs:120,helloTimeoutMs:500,...options});
 const errors=[];client.on('transport-error',e=>errors.push(e.code));
 t.after(async()=>{client.close();for(const ws of server.clients)ws.terminate();await new Promise(r=>server.close(r));});
 client.start();return {client,peers,frames,errors};
}
const hello=ws=>{ws.send(JSON.stringify({type:'hello',version:1,accepted:true}));ws.send(JSON.stringify({type:'peer',online:true}));};
test('silent OPEN connection is retired and reconnect never replays an old stream',async t=>{
 let blackhole=false;
 const f=await fixture(t,(ws,p,generation)=>{if(p.type==='hello'){hello(ws);ws.on('ping',data=>{if(!blackhole||generation>1)ws.pong(data);});}if(p.type==='open')ws.send(JSON.stringify({type:'opened',streamId:p.streamId}));});
 await until(()=>f.client.peerOnline);const stream=f.client.open('chat',0);await stream.ready;blackhole=true;
 await until(()=>f.peers.length>=2&&f.client.peerOnline);assert.ok(stream.destroyed);assert.ok(f.errors.includes('relay_heartbeat_timeout'));
 assert.equal(f.frames.filter(p=>p.type==='open').length,1);assert.equal(f.client.streams.size,0);assert.equal(f.client.lastError,null);
});
test('healthy pongs preserve a single connection and closing stops all retry work',async t=>{
 const f=await fixture(t,(ws,p)=>{if(p.type==='hello'){hello(ws);ws.on('ping',data=>ws.pong(data));}});
 await until(()=>f.client.peerOnline);await sleep(650);assert.equal(f.peers.length,1);assert.equal(f.client.lastError,null);f.client.close();await sleep(400);assert.equal(f.peers.length,1);
});
test('open socket without relay authentication has a bounded timeout and recovers',async t=>{
 const f=await fixture(t,(ws,p,generation)=>{if(p.type==='hello'){ws.on('ping',data=>ws.pong(data));if(generation>1)hello(ws);}},{helloTimeoutMs:250});
 await until(()=>f.peers.length>=2&&f.client.peerOnline);assert.ok(f.errors.includes('relay_auth_timeout'));assert.equal(f.frames.filter(p=>p.type==='open').length,0);
});
