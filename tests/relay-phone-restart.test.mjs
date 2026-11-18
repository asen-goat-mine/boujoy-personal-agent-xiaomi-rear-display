import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createRelay} from '../src/remote/relay.mjs';
import {RelayClient} from '../src/remote/transport.mjs';
import {hash} from '../src/remote/protocol.mjs';
import {eventually} from './helpers/remote-tls.mjs';

// A phone app update restarts the process: a new connection arrives for the same
// role and lane while the old socket may still look open, and the new process
// starts numbering its streams from 1 again. Both lanes must recover without a
// Mac restart, and reused stream ids must be accepted on the fresh connection.
async function relay(t){const deviceId=randomUUID(),mac=randomBytes(32).toString('hex'),android=randomBytes(32).toString('hex');const server=createRelay({routes:{[deviceId]:{macTokenHash:hash(mac),androidTokenHash:hash(android)}}});const addr=await server.listen();t.after(()=>server.close());return {server,deviceId,mac,android,url:`ws://127.0.0.1:${addr.port}/v1/tunnel`};}

test('a restarted phone replaces both lanes and may reuse stream ids without a Mac restart',async t=>{
 const r=await relay(t),opened={data:[],control:[]};
 const mac={};for(const lane of ['data','control']){mac[lane]=new RelayClient({url:r.url,deviceId:r.deviceId,routeToken:r.mac,lane,allowLoopback:true,reconnect:true,onStream:stream=>{opened[lane].push(stream.id);return true;}});mac[lane].start();}
 t.after(()=>{for(const client of Object.values(mac))client.close();});
 const phone=()=>{const lanes={};for(const lane of ['data','control']){lanes[lane]=new RelayClient({url:r.url,deviceId:r.deviceId,routeToken:r.android,role:'android',lane,allowLoopback:true,reconnect:false});lanes[lane].start();}return lanes;};
 const before=phone();
 await eventually(()=>before.data.peerOnline&&before.control.peerOnline&&mac.data.peerOnline&&mac.control.peerOnline);
 for(const lane of ['data','control']){const stream=before[lane].open(lane==='control'?'chat-control':'chat',0);await stream.ready;}
 assert.deepEqual(opened,{data:[1],control:[1]});
 // The old process dies without a clean close (its sockets are simply abandoned).
 const after=phone();t.after(()=>{for(const client of [...Object.values(before),...Object.values(after)])client.close();});
 await eventually(()=>after.data.peerOnline&&after.control.peerOnline&&mac.data.peerOnline&&mac.control.peerOnline);
 for(const lane of ['data','control']){const stream=after[lane].open(lane==='control'?'chat-control':'chat',0);assert.equal(stream.id,1,'a new process restarts at stream 1');await stream.ready;}
 assert.deepEqual(opened,{data:[1,1],control:[1,1]});
});
