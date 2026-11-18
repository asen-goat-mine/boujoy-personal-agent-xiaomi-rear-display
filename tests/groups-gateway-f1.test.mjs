import {DISTRIBUTION,ANDROID_PACKAGE} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID,X509Certificate} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {Broker} from '../src/tools/broker.mjs';
import {RemoteState} from '../src/remote/state.mjs';
import {createGateway} from '../src/remote/gateway.mjs';
import {identities} from './helpers/remote-tls.mjs';
// Invoke the real HTTP handler without opening a socket. This exercises API,
// certificate ownership, persisted requests and Engine; it is not a TLS test.
async function fixture(t){
 const identity=identities(),store=new Store(identity.dir,{lock:false}),state=new RemoteState(identity.dir),broker=new Broker({store,dataDir:identity.dir,memory:{},phone:{release(){}},approvals:{cancelTask(){}}}),engine=new Engine({store,broker,memory:{},secrets:{get:async()=>null}});engine.pump=async()=>{};
 const gateway=createGateway({identity:identity.server,state,store,engine,phone:{lease:null},dataDir:identity.dir});
 t.after(async()=>{await gateway.close();engine.groups.close();store.close();identity.cleanup();});
 function call(url,body,cert=identity.client.cert){return new Promise(resolve=>{
  const req={url,method:body?'POST':'GET',headers:{host:'boujoy.gateway'},socket:{getPeerCertificate:()=>({raw:new X509Certificate(cert).raw})},async *[Symbol.asyncIterator](){if(body)yield Buffer.from(JSON.stringify(body));}};
  const res=new EventEmitter();res.headersSent=false;res.writeHead=(status)=>{res.status=status;res.headersSent=true;};res.end=raw=>resolve({status:res.status,body:JSON.parse(raw)});res.destroy=()=>resolve({status:500});gateway.server.emit('request',req,res);
 });}
 const deviceId=randomUUID(),pairing=state.issuePairing({deviceId});assert.equal((await call('/v1/pair',{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,pairToken:pairing.pairToken})).status,200);assert.equal((await call('/v1/device/control',{messageId:randomUUID(),controlEpoch:1,paused:false})).status,200);
 return {store,state,engine,call,deviceId};
}
const envelope=()=>({messageId:randomUUID(),createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+120000).toISOString(),controlEpoch:1});
test('native group HTTP flow creates, invites, dispatches once, pauses/resumes and retains replies after lost response',async t=>{
 const f=await fixture(t),create={messageId:randomUUID(),name:'接口验证群',memberRoleIds:['life']},created=await f.call('/v1/groups',create);assert.equal(created.status,200);const id=created.body.id;
 assert.equal((await f.call('/v1/groups/'+id+'/members',{messageId:randomUUID(),addRoleIds:['work']})).status,200);
 f.store.transaction(s=>s.settings.chatCloudConsent=true);
 const input={...envelope(),content:'@工作伙伴 打开设置查看电池'},sent=await f.call('/v1/groups/'+id+'/messages',input);assert.equal(sent.status,200);assert.equal(sent.body.taskIds.length,1);const taskId=sent.body.taskId;assert.equal(f.store.task(taskId).roleId,'work');
 assert.equal((await f.call('/v1/state')).body.groups[0].id,id);
 f.state.update(s=>s.messages={});assert.equal((await f.call('/v1/groups',create)).body.id,id);assert.equal((await f.call('/v1/groups/'+id+'/messages',input)).body.taskId,taskId);assert.equal(f.store.data.tasks.length,1);
 f.store.updateTask(taskId,t=>t.status='running');await Promise.resolve();const paused=await f.call('/v1/groups/'+id+'/tasks/'+taskId+'/pause',{messageId:randomUUID(),controlEpoch:1});assert.equal(paused.status,200);assert.equal(paused.body.status,'paused');assert.equal(f.state.data.control.paused,false);
 await f.call('/v1/device/control',{messageId:randomUUID(),controlEpoch:2,paused:false});const resume={messageId:randomUUID(),controlEpoch:2};const resumed=await f.call('/v1/groups/'+id+'/tasks/'+taskId+'/resume',resume);assert.equal(resumed.status,200);assert.equal(resumed.body.status,'queued');assert.equal(f.store.task(taskId).remoteControlEpoch,2);
 f.state.update(s=>{s.messages={};s.control.paused=true;s.control.controlEpoch=3;});assert.equal((await f.call('/v1/groups/'+id+'/tasks/'+taskId+'/resume',resume)).body.id,resumed.body.id);
 const detail=await f.call('/v1/groups/'+id);assert.ok(detail.body.receipts.some(r=>r.state==='accepted'));assert.ok(detail.body.receipts.some(r=>r.state==='paused'));assert.ok(detail.body.receipts.some(r=>r.state==='resuming'));
});
test('native group requests cannot grant model consent or dispatch stale/invalid @ messages',async t=>{
 const f=await fixture(t),group=(await f.call('/v1/groups',{messageId:randomUUID(),name:'未授权群',memberRoleIds:['life','work']})).body;
 const stale=await f.call('/v1/groups/'+group.id+'/messages',{...envelope(),controlEpoch:0,content:'@工作伙伴 整理计划'});assert.equal(stale.status,400);
 const unknown=await f.call('/v1/groups/'+group.id+'/messages',{...envelope(),content:'@不存在 整理计划'});assert.equal(unknown.body.error.code,'group_recipient_invalid');assert.equal(f.store.data.tasks.length,0);
 const sent=await f.call('/v1/groups/'+group.id+'/messages',{...envelope(),content:'@工作伙伴 整理计划',cloudConsent:true});assert.equal(sent.status,200);assert.equal(f.store.task(sent.body.taskId).status,'waiting_consent');
 const consent=await f.call('/v1/tasks/'+sent.body.taskId+'/consent',{messageId:randomUUID(),cloudConsent:true,controlEpoch:1});assert.equal(consent.status,200);assert.equal(f.store.task(sent.body.taskId).status,'queued');
});
