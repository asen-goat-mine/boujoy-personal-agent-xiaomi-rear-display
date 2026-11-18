import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {randomUUID,createHash,X509Certificate} from 'node:crypto';
import {Store} from '../src/core/store.mjs';import {Engine} from '../src/core/engine.mjs';import {RemoteState} from '../src/remote/state.mjs';import {createGateway} from '../src/remote/gateway.mjs';
import {identities,request} from './helpers/remote-tls.mjs';
async function fixture(t){
 const identities_=identities(),dir=path.join(identities_.dir,'runtime'),store=new Store(dir,{lock:false}),state=new RemoteState(dir),phone={lease:null,async close(){}},broker={phone,browser:{async close(){}}},engine=new Engine({store,broker,secrets:{get:async()=>null},memory:{},origin:'http://127.0.0.1:1'});
 const deviceId=randomUUID(),pair=state.issuePairing({deviceId}),fp=createHash('sha256').update(new X509Certificate(identities_.client.cert).raw).digest('hex');state.bind(fp,{pairToken:pair.pairToken});
 const gateway=createGateway({identity:identities_.server,state,store,engine,phone,dataDir:dir});const port=await gateway.listen();
 t.after(async()=>{await engine.shutdown();await gateway.close();store.close();identities_.cleanup();});
 const call=(pathname,body)=>request({port,identity:identities_.client,pathname,method:body?'POST':'GET',body});
 return {store,state,engine,call,deviceId,port};
}
test('bound phone group dispatch has expiry, control admission and durable per-message receipt across lost gateway acknowledgement',async t=>{
 const f=await fixture(t),id=randomUUID();const create={messageId:id,name:'隔离联调群',memberRoleIds:['life','work']};
 const group=await f.call('/v1/groups',create);assert.equal(group.status,200);const gid=group.body.id;
 assert.equal((await f.call('/v1/groups',create)).body.id,gid);assert.equal(f.store.data.groups.length,1);
 const list=await f.call('/v1/groups');assert.equal(list.body.groups[0].id,gid);
 const input={messageId:randomUUID(),content:'@生活管家 比较候选，暂不执行外部操作',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),controlEpoch:1};
 const rejected=await f.call(`/v1/groups/${gid}/messages`,input);assert.equal(rejected.body.error.code,'phone_paused');assert.equal(f.store.data.tasks.length,0);
 const control=await f.call('/v1/device/control',{messageId:randomUUID(),controlEpoch:1,paused:false});assert.equal(control.status,200);
 const accepted=await f.call(`/v1/groups/${gid}/messages`,input);assert.equal(accepted.status,200,JSON.stringify(accepted.body));assert.equal(accepted.body.received,true);assert.equal(accepted.body.taskIds.length,1);
 const task=f.store.task(accepted.body.taskId);assert.equal(task.roleId,'life');assert.equal(task.remoteDeviceId,f.deviceId);assert.equal(task.remoteExpiresAt,input.expiresAt);assert.equal(task.memoryConsent,false);
 const check=await f.call(`/v1/groups/${gid}/messages/${input.messageId}`);assert.equal(check.body.taskId,task.id);
 // The group transaction has landed but the separate HTTP receipt may not have.
 f.state.update(s=>{delete s.messages[f.deviceId+':'+input.messageId];});
 const again=await f.call(`/v1/groups/${gid}/messages`,input);assert.equal(again.body.taskId,task.id);assert.equal(f.store.data.tasks.length,1);
 const conflict=await f.call(`/v1/groups/${gid}/messages`,{...input,content:'另一目标'});assert.ok(conflict.status>=400);assert.equal(f.store.data.tasks.length,1);
 const expired=await f.call(`/v1/groups/${gid}/messages`,{...input,messageId:randomUUID(),createdAt:new Date(Date.now()-120000).toISOString(),expiresAt:new Date(Date.now()-60000).toISOString()});assert.equal(expired.status,410);
 assert.equal(f.store.data.tasks.length,1);assert.equal(f.store.data.outbox.length,0);
});
test('group control cannot mutate by GET or target an unrelated task; old unknown does not block a new message',async t=>{
 const f=await fixture(t),group=(await f.call('/v1/groups',{messageId:randomUUID(),name:'边界检查',memberRoleIds:['work']})).body;
 await f.call('/v1/device/control',{messageId:randomUUID(),controlEpoch:1,paused:false});
 const send=()=>f.call(`/v1/groups/${group.id}/messages`,{messageId:randomUUID(),content:'整理公开资料',recipientRoleIds:['work'],createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),controlEpoch:1});
 const first=await send(),id=first.body.taskId;f.store.updateTask(id,t=>{t.status='unknown_result';});
 const read=await f.call(`/v1/groups/${group.id}/tasks/${id}/pause`);assert.equal(read.status,404);assert.equal(f.store.task(id).status,'unknown_result');
 const resume=await f.call(`/v1/groups/${group.id}/tasks/${id}/resume`,{messageId:randomUUID(),controlEpoch:1});assert.ok(resume.status>=400);assert.equal(f.store.task(id).status,'unknown_result');
 const next=await send();assert.equal(next.status,200);assert.notEqual(next.body.taskId,id);
 const other=f.engine.create({prompt:'不属于群的任务',cloudConsent:false});const invalid=await f.call(`/v1/groups/${group.id}/tasks/${other.id}/pause`,{messageId:randomUUID(),controlEpoch:1});assert.ok(invalid.status>=400);assert.equal(f.store.task(other.id).status,other.status);
});

test('bound phone archives only its named idle group, keeps history, and cannot revive archived group work through single chat',async t=>{
 const f=await fixture(t),group=(await f.call('/v1/groups',{messageId:randomUUID(),name:'上线验收临时群',memberRoleIds:['work']})).body;
 const endpoint='/v1/groups/'+group.id+'/archive',envelope={messageId:randomUUID(),name:group.name,createdAt:group.createdAt};
 assert.equal((await f.call(endpoint)).status,404);
 assert.equal((await f.call(endpoint,{...envelope,name:'wrong'})).body.error.code,'group_archive_conflict');
 const control=()=>f.call('/v1/device/control',{messageId:randomUUID(),controlEpoch:1,paused:false});await control();
 const sent=await f.call('/v1/groups/'+group.id+'/messages',{messageId:randomUUID(),content:'只整理公开资料，不执行外部操作',recipientRoleIds:['work'],createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),controlEpoch:1});
 const task=f.store.task(sent.body.taskId);f.store.updateTask(task.id,t=>{t.status='paused';});
 assert.equal((await f.call('/v1/tasks/'+task.id+'/continue',{messageId:randomUUID(),controlEpoch:1})).body.error.code,'group_task_entry_required');
 assert.equal((await f.call(endpoint,envelope)).body.error.code,'group_busy');
 f.store.updateTask(task.id,t=>{t.status='completed';});const history=JSON.stringify({tasks:f.store.data.tasks,messages:f.store.data.groupMessages,receipts:f.store.data.groupReceipts});
 const archived=await f.call(endpoint,envelope);assert.equal(archived.status,200);assert(archived.body.archivedAt);assert.deepEqual((await f.call(endpoint,envelope)).body,archived.body);
 assert.equal((await f.call('/v1/groups')).body.groups.length,0);assert.equal((await f.call('/v1/groups/'+group.id)).status,404);
 assert.equal(JSON.stringify({tasks:f.store.data.tasks,messages:f.store.data.groupMessages,receipts:f.store.data.groupReceipts}),history);
 // Losing the HTTP receipt is still idempotent at the archive transaction.
 f.state.update(s=>{delete s.messages[f.deviceId+':'+envelope.messageId];});assert.equal((await f.call(endpoint,envelope)).body.deduplicated,true);
 f.store.updateTask(task.id,t=>{t.status='waiting_consent';});assert.equal((await f.call('/v1/tasks/'+task.id+'/consent',{messageId:randomUUID(),controlEpoch:1,cloudConsent:true})).body.error.code,'group_not_found');
 const desktop=f.engine.groups.create({name:'用户原有桌面群',memberRoleIds:['work']});assert.equal((await f.call('/v1/groups/'+desktop.id+'/archive',{messageId:randomUUID(),name:desktop.name,createdAt:desktop.createdAt})).body.error.code,'group_access_denied');
});
