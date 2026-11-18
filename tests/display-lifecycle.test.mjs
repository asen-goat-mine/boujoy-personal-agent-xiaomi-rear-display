import {DISTRIBUTION,ANDROID_PACKAGE,BACKGROUND_SUPPORTED} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {getEventListeners} from 'node:events';
import {randomUUID} from 'node:crypto';
import {DisplayCommands} from '../src/remote/display-commands.mjs';
import {createGateway} from '../src/remote/gateway.mjs';
import {RemoteState} from '../src/remote/state.mjs';
import {Store} from '../src/core/store.mjs';
import {identities,request,eventually} from './helpers/remote-tls.mjs';

const DEVICE='11111111-2222-4333-8444-555555555555';
const SESSION={sessionId:'11111111-2222-4333-8444-666666666666',generation:1,displayId:2};
const input={deviceId:DEVICE,op:'status',controlEpoch:1,timeoutMs:500};

test('an already cancelled poll never consumes a queued command',async t=>{
 const queue=new DisplayCommands({pollMs:10});t.after(()=>queue.close());const result=queue.request(input);const abort=new AbortController();abort.abort();
 assert.equal(await queue.wait(DEVICE,{signal:abort.signal}),null);assert.equal(queue.queue.length,1);
 const command=await queue.wait(DEVICE);queue.complete(DEVICE,command.id,{ok:true});assert.deepEqual(await result,{ok:true});
});

test('cancelling a pending poll immediately removes its waiter and listener',async t=>{
 const queue=new DisplayCommands({pollMs:1000});t.after(()=>queue.close());const abort=new AbortController();const poll=queue.wait(DEVICE,{signal:abort.signal});
 abort.abort();assert.equal(await poll,null);assert.equal(queue.waiters.length,0);assert.equal(getEventListeners(abort.signal,'abort').length,0);
 const result=queue.request(input),command=await queue.wait(DEVICE);queue.complete(DEVICE,command.id,{});await result;
});

test('a timed-out request detaches its task abort listener',async t=>{
 const queue=new DisplayCommands({pollMs:10});t.after(()=>queue.close());const abort=new AbortController();
 await assert.rejects(queue.request({...input,signal:abort.signal}),error=>error.dispatchState==='not_sent');
 assert.equal(getEventListeners(abort.signal,'abort').length,0);assert.equal(queue.pending.size,0);assert.equal(queue.queue.length,0);
});

test('close settles pollers immediately and is terminal for new work',async()=>{
 const queue=new DisplayCommands({pollMs:60000}),abort=new AbortController();let settled=false;
 const poll=queue.wait(DEVICE,{signal:abort.signal}).then(value=>{settled=true;return value;});queue.close();queue.close();await Promise.resolve();
 assert.equal(settled,true);assert.equal(await poll,null);assert.equal(queue.waiters.length,0);assert.equal(getEventListeners(abort.signal,'abort').length,0);
 assert.throws(()=>queue.request(input),error=>error.code==='display_backend_unavailable'&&error.dispatchState==='not_sent');assert.equal(await queue.wait(DEVICE),null);
});

for(const stop of ['abort','close'])test(`a delivered effect stays unknown after ${stop} and is never requeued`,async()=>{
 const queue=new DisplayCommands({pollMs:10}),abort=new AbortController();
 const result=queue.request({...input,op:'tap',session:SESSION,signal:abort.signal});const rejected=assert.rejects(result,error=>error.code==='outcome_unknown'&&error.dispatchState==='unknown');
 const command=await queue.wait(DEVICE);if(stop==='abort')abort.abort();else queue.close();await rejected;
 assert.equal(queue.queue.length,0);assert.equal(await queue.wait(DEVICE),null);assert.throws(()=>queue.complete(DEVICE,command.id,{}),error=>error.code==='display_expired');queue.close();
});

test('real mTLS disconnect removes the dead display poll before one-time delivery to a new poll',async t=>{
 const id=identities(),store=new Store(id.dir,{lock:false}),state=new RemoteState(id.dir),deviceId=randomUUID();
 const gateway=createGateway({identity:id.server,state,store,engine:{active:new Map(),broker:null,async stop(){}},phone:{lease:null},dataDir:id.dir});
 t.after(async()=>{await gateway.close();store.close();id.cleanup();});const port=await gateway.listen();gateway.display.pollMs=150;
 const call=(pathname,body)=>request({port,identity:id.client,pathname,method:body?'POST':'GET',body});
 const pairing=state.issuePairing({deviceId});assert.equal((await call('/v1/pair',{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,pairToken:pairing.pairToken})).status,200);
 assert.equal((await call('/v1/device/control',{messageId:randomUUID(),controlEpoch:1,paused:false,reason:'new_task'})).status,200);
 if(!BACKGROUND_SUPPORTED){const rejected=await call('/v1/device/display?protocol=1');assert.equal(rejected.status,400);assert.equal(rejected.body.error.code,'background_not_supported');assert.equal(gateway.display.waiters.length,0);assert.equal(gateway.display.queue.length,0);return;}
 const disconnected=new Promise(resolve=>gateway.server.once('request',(_request,response)=>response.once('close',resolve)));
 const dead=https.get({hostname:'127.0.0.1',port,path:'/v1/device/display?protocol=1',headers:{Host:'boujoy.gateway'},key:id.client.key,cert:id.client.cert,rejectUnauthorized:false,agent:false});dead.on('error',()=>{});t.after(()=>dead.destroy());
 await eventually(()=>gateway.display.waiters.length===1);dead.destroy();await disconnected;
 assert.equal(gateway.display.waiters.length,0,'disconnect must remove the waiter without waiting for the poll timeout');
 const outcome=gateway.display.request({...input,deviceId,op:'tap',session:SESSION});
 const received=await call('/v1/device/display?protocol=1'),command=received.body.command;assert.equal(command.op,'tap');assert.equal(gateway.display.pending.get(command.id).delivered,true);
 gateway.display.complete(deviceId,command.id,{ok:true});assert.deepEqual(await outcome,{ok:true});
 assert.equal((await call('/v1/device/display?protocol=1')).body.command,null,'the next live poll must not redeliver the effect');
});
