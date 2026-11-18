import test from 'node:test';
import assert from 'node:assert/strict';
import {Phone} from '../src/adapters/phone.mjs';
import {RemoteService} from '../src/remote/service.mjs';
import {BACKGROUND_SUPPORTED} from '../src/distribution.mjs';

test('each edition preserves ordinary Phone Use and allocates only supported display drivers',async()=>{
 const calls=[],driver={client:{},close:async()=>calls.push('close')};
 const store={data:{settings:{phoneBackend:'phoneuse',phoneExecutionMode:'main',phoneEnabled:true,phoneUseDeviceId:'synthetic-device'}}};
 const phone=new Phone(store,{phoneUse:driver,phoneUseFactory:()=>({client:{},close:async()=>{}})});
 assert.equal(phone.phoneUse,driver);assert.equal(phone.phoneUseDevice(),'synthetic-device');
 assert.equal(Boolean(phone.displayUse),BACKGROUND_SUPPORTED);
 phone.lease='task';phone.release('task');assert.equal(phone.lease,null);
 await phone.close();assert.deepEqual(calls,['close']);
});

test('unsupported stored background mode cannot fall back to main-screen or IME effects',async()=>{
 const calls=[],driver={client:{},call:async()=>calls.push('phone'),close:async()=>{}};
 const store={data:{settings:{phoneBackend:'phoneuse',phoneExecutionMode:'background',phoneEnabled:true,phoneUseDeviceId:'synthetic-device'}}};
 const phone=new Phone(store,{phoneUse:driver,phoneUseFactory:()=>driver});
 phone.ime={request:async()=>calls.push('ime')};
 try{
  if(BACKGROUND_SUPPORTED){assert.equal(phone.isBackground(),true);assert.notEqual(phone.phoneUse,driver);return;}
  const refused=e=>e.code==='background_not_supported'&&e.dispatchState==='not_sent';
  assert.throws(()=>phone.phoneUseDevice(),refused);
  await assert.rejects(phone.typeWithIme({text:'fixture'},null),refused);
  await assert.rejects(RemoteService.prototype.displayRequest.call({},'tap',{}),refused);
  assert.deepEqual(calls,[]);
 }finally{await phone.close();}
});
