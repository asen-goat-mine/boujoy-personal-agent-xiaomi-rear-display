import {DISTRIBUTION,ANDROID_PACKAGE} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {RemoteService} from '../src/remote/service.mjs';
import {RemoteState,spkiPin} from '../src/remote/state.mjs';
import {createGateway} from '../src/remote/gateway.mjs';
import {identities,request} from './helpers/remote-tls.mjs';

async function fixture(t){
 const identity=identities(),store=new Store(identity.dir,{lock:false}),state=new RemoteState(identity.dir),deviceId=randomUUID();
 const engine={active:new Map(),creates:0,resumes:0,create(){this.creates++;throw Error('No task may be replayed');},async continue(){this.resumes++;throw Error('No task may be resumed');},async stop(){}};
 const gateway=createGateway({identity:identity.server,state,store,engine,phone:{lease:null},dataDir:identity.dir}),port=await gateway.listen();
 t.after(async()=>{await gateway.close();store.close();identity.cleanup();});
 const call=(pathname,body,who=identity.client)=>request({port,identity:who,pin:spkiPin(identity.server.cert),pathname,method:body?'POST':'GET',body});
 const pairing=state.issuePairing({deviceId});assert.equal((await call('/v1/pair',{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,pairToken:pairing.pairToken})).status,200);
 const control=(epoch,body={})=>call('/v1/device/control',{messageId:randomUUID(),controlEpoch:epoch,paused:false,...body});
 const pauseForMaintenance=()=>RemoteService.prototype.pauseForMaintenance.call({phone:{},state,clock:Date.now,connector:{pause(){}}});
 return {state,store,engine,gateway,call,control,pauseForMaintenance};
}

test('maintenance resume uses a newly authenticated generation and never resumes tasks or unknown actions',async t=>{
 const f=await fixture(t);assert.equal((await f.control(7)).status,200);
 f.store.data.tasks.push({id:'old-task',status:'paused',remoteControlEpoch:7,messages:[]});
 f.store.data.actions.push({id:'unknown-tap',taskId:'old-task',tool:'phone_tap',status:'unknown'});
 const tasks=structuredClone(f.store.data.tasks),actions=structuredClone(f.store.data.actions);
 f.pauseForMaintenance();assert.equal(f.state.data.control.controlEpoch,8);assert.equal(f.state.data.control.maintenanceResumeEpoch,7);
 const automatic={reason:'maintenance_reconnected',maintenanceEpoch:8};
 assert.equal((await f.control(9,automatic)).body.error.code,'maintenance_resume_changed','a relay/TLS connection alone is insufficient');
 const overview=await f.call('/v1/state');assert.equal(overview.body.device.reason,'maintenance');assert.equal(overview.body.device.maintenanceResumeEpoch,7);
 assert.equal((await f.control(10,automatic)).status,400,'automatic recovery cannot jump generations');
 const response=await f.control(9,automatic);assert.equal(response.status,200);assert.equal(response.body.paused,false);
 assert.deepEqual(f.state.data.control,{controlEpoch:9,paused:false});assert.deepEqual(f.store.data.tasks,tasks);assert.deepEqual(f.store.data.actions,actions);assert.equal(f.engine.creates,0);assert.equal(f.engine.resumes,0);
});

test('screen lock, user stop, and legacy unknown pauses cannot become maintenance grants',async t=>{
 const f=await fixture(t);
 for(const reason of ['screen_off','user_stop','user_takeover',undefined]){
  f.state.update(s=>{s.control={controlEpoch:20,paused:true,...(reason?{reason}:{})};});
  f.pauseForMaintenance();f.pauseForMaintenance();
  assert.equal(f.state.data.control.controlEpoch,22);assert.equal(f.state.data.control.reason,reason);assert.equal(f.state.data.control.maintenanceResumeEpoch,undefined);
  await f.call('/v1/state');assert.equal((await f.control(23,{reason:'maintenance_reconnected',maintenanceEpoch:22})).status,400);assert.equal(f.state.data.control.paused,true);
 }
});

test('repeated maintenance retains eligibility but a newer user takeover defeats a queued automatic resume',async t=>{
 const f=await fixture(t);await f.control(40);f.pauseForMaintenance();f.pauseForMaintenance();
 assert.equal(f.state.data.control.controlEpoch,42);assert.equal(f.state.data.control.maintenanceResumeEpoch,40);
 await f.call('/v1/state');await f.gateway.pause();
 assert.equal(f.state.data.control.reason,'user_takeover');assert.equal(f.state.data.control.maintenanceResumeEpoch,undefined);
 assert.equal((await f.control(43,{reason:'maintenance_reconnected',maintenanceEpoch:42})).status,400);
 await f.call('/v1/state');assert.equal((await f.control(44,{reason:'maintenance_reconnected',maintenanceEpoch:43})).status,400);assert.equal(f.state.data.control.paused,true);
 // The unchanged explicit user path still works after a takeover.
 assert.equal((await f.control(44,{reason:'user_resume'})).status,200);
});

test('maintenance challenge rejects a stale authenticated state read',async t=>{
 const f=await fixture(t);await f.control(3);f.pauseForMaintenance();await f.call('/v1/state');
 const original=Date.now;let extra=31000;t.mock.method(Date,'now',()=>original()+extra);
 assert.equal((await f.control(5,{reason:'maintenance_reconnected',maintenanceEpoch:4})).body.error.code,'maintenance_resume_changed');
 extra=0;await f.call('/v1/state');assert.equal((await f.control(5,{reason:'maintenance_reconnected',maintenanceEpoch:4})).status,200);
});

test('gateway distinguishes delivered snapshots, phone-confirmed sync, failure stages, and TLS failures without retaining payload text',async t=>{
 const f=await fixture(t),before=JSON.stringify(f.state.data.control);await f.call('/v1/state');
 const received=f.gateway.diagnostics();assert.equal(received.stateResponses,1);assert(received.lastStateResponseAt);assert.equal(received.lastSuccessfulSyncAt,null,'an HTTP response is not proof of parsed mobile state');
 const at=new Date().toISOString();
 let result=await f.call('/v1/device/status',{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,timezone:'Asia/Shanghai',observedAt:at,syncDiagnostics:{lastStateSyncAt:at,lastFailedStep:'notifications',lastFailureAt:at,failures:2,body:'SECRET-CREDENTIAL-OR-MESSAGE'}});
 assert.equal(result.status,200);let value=f.gateway.diagnostics();assert.equal(value.lastSuccessfulSyncAt,at);assert.equal(value.lastFailedStep,'notifications');assert.equal(value.phoneStateFailures,2);
 result=await f.call('/v1/device/status',{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,timezone:'Asia/Shanghai',observedAt:at,syncDiagnostics:{lastStateSyncAt:'not a date',lastFailedStep:'SECRET-CREDENTIAL-OR-MESSAGE',lastFailureAt:at,failures:'SECRET-CREDENTIAL-OR-MESSAGE'}});
 assert.equal(result.status,200);value=f.gateway.diagnostics();assert.equal(value.lastFailedStep,'notifications');assert.equal(JSON.stringify(value).includes('SECRET'),false);assert.equal(JSON.stringify(f.state.data.control),before);
 f.gateway.server.emit('tlsClientError',{code:'ERR_TLS_HANDSHAKE_TIMEOUT',message:'SECRET-CREDENTIAL-OR-MESSAGE'},{bytesRead:7,bytesWritten:9,destroy(){}});
 value=f.gateway.diagnostics();assert.equal(value.failed,1);assert.equal(value.lastFailure.code,'ERR_TLS_HANDSHAKE_TIMEOUT');assert.equal(JSON.stringify(value).includes('SECRET'),false);
});

test('revoking a device removes maintenance eligibility and never restores it on restart',async t=>{
 const f=await fixture(t);await f.control(5);f.pauseForMaintenance();assert.equal(f.state.data.control.maintenanceResumeEpoch,5);
 const id=Object.values(f.state.data.devices).find(d=>d.active).id;f.state.revoke(id);
 assert.equal(f.state.data.control.reason,'device_revoked');assert.equal(f.state.data.control.maintenanceResumeEpoch,undefined);f.pauseForMaintenance();
 assert.equal(f.state.data.control.reason,'device_revoked');assert.equal(f.state.data.control.maintenanceResumeEpoch,undefined);assert.equal((await f.call('/v1/state')).status,403);
});
