import {DISTRIBUTION,ANDROID_PACKAGE} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {getEventListeners} from 'node:events';
import {randomUUID} from 'node:crypto';
import {PhoneTyping} from '../src/remote/phone-typing.mjs';
import {createGateway} from '../src/remote/gateway.mjs';
import {RemoteState} from '../src/remote/state.mjs';
import {Store} from '../src/core/store.mjs';
import {identities,request,eventually} from './helpers/remote-tls.mjs';

const DEVICE='11111111-2222-4333-8444-555555555555',input={deviceId:DEVICE,text:'synthetic fixture'};

test('an already aborted typing poll cannot consume a queued input',async t=>{
 const typing=new PhoneTyping({pollMs:10,timeoutMs:500});t.after(()=>typing.close());const pending=typing.request(input),abort=new AbortController();abort.abort();
 assert.equal(await typing.wait(DEVICE,{signal:abort.signal}),null);assert.equal(typing.results.values().next().value.delivered,false);
 const job=await typing.wait(DEVICE);typing.complete(DEVICE,job.id,'typed');assert.equal((await pending).status,'typed');
});

test('a disconnected typing poll releases its waiter and abort listener immediately',async t=>{
 const typing=new PhoneTyping({pollMs:60000,timeoutMs:500});t.after(()=>typing.close());const abort=new AbortController(),dead=typing.wait(DEVICE,{signal:abort.signal});
 abort.abort();assert.equal(await dead,null);assert.equal(typing.waiters.length,0);assert.equal(getEventListeners(abort.signal,'abort').length,0);
 const pending=typing.request(input),job=await typing.wait(DEVICE);typing.complete(DEVICE,job.id,'typed');await pending;
});

test('closing a typing channel settles long polls and rejects undelivered input',async()=>{
 const typing=new PhoneTyping({pollMs:60000,timeoutMs:60000}),abort=new AbortController();
 const poll=typing.wait('different-device',{signal:abort.signal});const pending=typing.request(input),rejected=assert.rejects(pending,error=>error.dispatchState==='not_sent');
 typing.close();typing.close();await rejected;assert.equal(await poll,null);assert.equal(typing.waiters.length,0);assert.equal(typing.results.size,0);assert.equal(typing.pending,null);assert.equal(getEventListeners(abort.signal,'abort').length,0);
 assert.throws(()=>typing.request(input),error=>error.code==='phone_input_unavailable'&&error.dispatchState==='not_sent');assert.equal(await typing.wait(DEVICE),null);
});

for(const operation of ['type','verify_replace'])test(`closing after ${operation} delivery preserves the unverified receipt without replay`,async()=>{
 const typing=new PhoneTyping({pollMs:10,timeoutMs:60000});
 const pending=typing.request({...input,...(operation==='verify_replace'?{operation,mode:'replace',referenceId:randomUUID(),controlEpoch:8,packageName:'com.example.app'}:{})});
 const job=await typing.wait(DEVICE,{protocol:2});typing.close();const result=await pending;
 assert.equal(result.status,operation==='verify_replace'?'unverified':'submitted');assert.equal(result.proof,undefined);assert.equal(await typing.wait(DEVICE),null);
 const late=typing.complete(DEVICE,job.id,operation==='verify_replace'?'unverified':'typed');assert.equal(late.duplicate,true);assert.equal(late.status,result.status);
});

test('real mTLS typing disconnect leaves the next input for one live poll only',async t=>{
 const id=identities(),store=new Store(id.dir,{lock:false}),state=new RemoteState(id.dir),deviceId=randomUUID();
 const gateway=createGateway({identity:id.server,state,store,engine:{active:new Map(),broker:null,async stop(){}},phone:{lease:null},dataDir:id.dir});
 t.after(async()=>{await gateway.close();store.close();id.cleanup();});const port=await gateway.listen();gateway.typing.pollMs=150;gateway.typing.timeoutMs=1000;
 const call=(pathname,body)=>request({port,identity:id.client,pathname,method:body?'POST':'GET',body});
 const pairing=state.issuePairing({deviceId});assert.equal((await call('/v1/pair',{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,pairToken:pairing.pairToken})).status,200);
 assert.equal((await call('/v1/device/control',{messageId:randomUUID(),controlEpoch:1,paused:false,reason:'new_task'})).status,200);
 const disconnected=new Promise(resolve=>gateway.server.once('request',(_request,response)=>response.once('close',resolve)));
 const dead=https.get({hostname:'127.0.0.1',port,path:'/v1/device/typing',headers:{Host:'boujoy.gateway'},key:id.client.key,cert:id.client.cert,rejectUnauthorized:false,agent:false});dead.on('error',()=>{});t.after(()=>dead.destroy());
 await eventually(()=>gateway.typing.waiters.length===1);dead.destroy();await disconnected;
 assert.equal(gateway.typing.waiters.length,0,'remove the dead waiter at disconnect, not eleven seconds later');
 const pending=gateway.typing.request({...input,deviceId}),received=await call('/v1/device/typing'),job=received.body.job;
 assert.equal(job.text,input.text);assert.equal(gateway.typing.results.get(job.id).delivered,true);
 const receipt=await call('/v1/device/typing',{messageId:randomUUID(),id:job.id,status:'typed'});assert.equal(receipt.status,200);assert.equal((await pending).status,'typed');
 assert.equal((await call('/v1/device/typing')).body.job,null,'the effect is delivered only once');
 const closed=gateway.typing.request({...input,deviceId}),rejected=assert.rejects(closed,error=>error.dispatchState==='not_sent');await gateway.close();await rejected;assert.equal(gateway.typing.closed,true);
});
