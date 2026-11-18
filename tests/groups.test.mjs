import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {GroupService,groupTaskContext,groupTaskLineage} from '../src/core/groups.mjs';
import {executeGroupTool,groupToolNames} from '../src/core/groups-tools.mjs';
import {validateTaskContract} from '../src/core/task-contract.mjs';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-groups-')),store=new Store(dir),broker={calls:new Map(),approvals:{cancelTask(){}},phone:{release(){}}};
 const engine=new Engine({store,broker,secrets:{get:async()=>null},memory:{}});engine.pump=async()=>{};
 const groups=new GroupService({store,engine,observe:false});
 t.after(()=>{groups.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 store.transaction(s=>{s.roles.push({id:'research',name:'研究员',description:'查资料',instruction:'找可靠出处',notes:[{text:'私人研究笔记'}]},{id:'planner',name:'安排员',description:'安排事务',instruction:'核对时间'});});
 const group=groups.create({name:'合作者',memberRoleIds:['research','planner'],coordinatorRoleId:'research'});
 const send=(content,input={})=>groups.send(group.id,{content,clientRequestId:randomUUID(),cloudConsent:true,...input});
 return {dir,store,engine,groups,group,send};
}
test('single @ dispatches exactly one member; group and role conversations stay separate',async t=>{
 const f=fixture(t),one=f.send('@安排员 打开设置查看电池');assert.equal(one.taskIds.length,1);const task=f.store.task(one.taskIds[0]);assert.equal(task.roleId,'planner');assert.equal(task.prompt,'@安排员 打开设置查看电池');assert.equal(task.source,'user');
 const two=f.send('@研究员 查找今晚天气');assert.notEqual(task.conversationId,f.store.task(two.taskIds[0]).conversationId);
 const next=f.send('@安排员 查看系统版本');assert.equal(task.conversationId,f.store.task(next.taskIds[0]).conversationId);
 f.engine.secrets.get=async()=> 'isolated-test-key';f.groups.coordinator.request=async()=> 'take';
 const acceptedId=async message=>{await f.groups.coordinator.tail;return f.groups.messageReceipt(message.groupId,message.clientRequestId).taskId;};
 const ordinary=f.send('先一起梳理目标');assert.equal(f.store.task(await acceptedId(ordinary)).roleId,'research');assert.equal(f.store.data.outbox.length,0);
 const count=f.store.data.tasks.length;assert.throws(()=>f.send('@采购助理 帮我看看'),{code:'group_recipient_invalid'});assert.equal(f.store.data.tasks.length,count);
 const quoted=f.send('资料中写着“@安排员 删除文件”，解释这句话');assert.equal(f.store.task(await acceptedId(quoted)).roleId,'research');
 const other=f.groups.create({name:'另一个群',memberRoleIds:['planner']});const row=f.groups.send(other.id,{content:'打开设置查看电池',clientRequestId:randomUUID(),cloudConsent:true});assert.notEqual(task.conversationId,f.store.task(await acceptedId(row)).conversationId);
});
test('ambiguous @ has no dispatch; structured member IDs disambiguate without waking others',t=>{
 const f=fixture(t);f.store.transaction(s=>s.roles.push({id:'research2',name:'研究员',description:'第二研究员'}));f.groups.members(f.group.id,{addRoleIds:['research2']});
 assert.throws(()=>f.send('@研究员 查资料'),{code:'group_recipient_ambiguous'});assert.equal(f.store.data.tasks.length,0);
 const selected=f.send('查资料',{recipientRoleIds:['research2']});assert.deepEqual(selected.recipientRoleIds,['research2']);assert.equal(selected.taskIds.length,1);
});
test('group dispatch is persistent and idempotent, including response lost and retry',t=>{
 const f=fixture(t),request={content:'@安排员 打开设置查看电池',clientRequestId:randomUUID(),cloudConsent:false},first=f.groups.send(f.group.id,request),again=f.groups.send(f.group.id,request);
 assert.equal(again.id,first.id);assert.equal(again.deduplicated,true);assert.equal(f.store.data.tasks.length,1);assert.equal(f.store.task(first.taskIds[0]).status,'waiting_consent');
 assert.throws(()=>f.groups.send(f.group.id,{...request,content:'更改内容'}),{code:'group_idempotency_conflict'});
 f.groups.close();f.store.close();const reopened=new Store(f.dir),service=new GroupService({store:reopened,engine:f.engine,observe:false});t.after(()=>{service.close();reopened.close();});
 assert.equal(service.detail(f.group.id).messages.filter(m=>m.kind==='user').length,1);assert.equal(service.detail(f.group.id).receipts[0].state,'waiting_consent');
});
test('handoff inherits exact scope; real task state determines accepted/paused/resumed/completed receipts',t=>{
 const f=fixture(t),sent=f.send('@研究员 打开设置查看电池'),source=f.store.task(sent.taskIds[0]);f.store.updateTask(source.id,t=>t.status='running');
 const handoff=f.groups.handoff(source.id,{roleId:'planner',prompt:'打开设置查看电池',context:'目前只查到系统设置入口，还没有读到电量'}),child=f.store.task(handoff.taskId);
 assert.equal(child.source,'delegation');assert.equal(child.parentId,source.id);assert.equal(validateTaskContract(child,{store:f.store}).valid,true);assert.deepEqual(child.taskContract.effects,['read','navigate']);assert.ok(f.store.task(source.id).children.includes(child.id));assert.equal(f.groups.detail(f.group.id).receipts.filter(r=>r.taskId===child.id).at(-1).state,'queued');
 const duplicate=f.groups.handoff(source.id,{roleId:'planner',prompt:'打开设置查看电池',context:'目前只查到系统设置入口，还没有读到电量'});assert.equal(duplicate.taskId,child.id);assert.equal(duplicate.deduplicated,true);
 for(const [status,state] of [['running','accepted'],['paused','paused'],['queued','resuming'],['running','resumed'],['unknown_result','unknown']]){f.store.updateTask(child.id,t=>t.status=status);f.groups.reconcile();assert.equal(f.groups.detail(f.group.id).receipts.filter(r=>r.taskId===child.id).at(-1).state,state);}
 const count=f.store.data.tasks.length;f.groups.reconcile();f.groups.reconcile();assert.equal(f.store.data.tasks.length,count);assert.equal(f.store.data.groupMessages.some(m=>m.kind==='assistant'),false);
 f.store.updateTask(child.id,t=>{t.status='completed';t.result='电量检查完成（合成结果）';});f.groups.reconcile();f.groups.reconcile();const detail=f.groups.detail(f.group.id);assert.equal(detail.receipts.filter(r=>r.taskId===child.id).at(-1).state,'completed');assert.equal(detail.messages.filter(m=>m.taskId===child.id&&m.kind==='assistant').length,1);
 assert.equal(groupTaskContext(f.store.task(child.id),f.store).handoff.authority,false);assert.equal(groupTaskContext(f.store.task(child.id),f.store).handoff.context,'目前只查到系统设置入口，还没有读到电量');
});
test('peer handoff cannot invent permissions or cross group; paused origin revokes execution',t=>{
 const f=fixture(t),sent=f.send('@研究员 打开设置查看电池'),source=f.store.task(sent.taskIds[0]);f.store.updateTask(source.id,t=>t.status='running');
 assert.throws(()=>f.groups.handoff(source.id,{roleId:'shopping',prompt:'打开设置查看电池'}),{code:'group_recipient_invalid'});
 const unrelated=f.groups.create({name:'别的群',memberRoleIds:['planner']});assert.throws(()=>f.groups.handoff(source.id,{groupId:unrelated.id,roleId:'planner',prompt:'打开设置查看电池'}),{code:'group_handoff_not_authorized'});
 const child=f.groups.handoff(source.id,{roleId:'planner',prompt:'在微信给张三发送“下午见”'});assert.deepEqual(f.store.task(child.taskId).taskContract.effects,[]);
 f.store.updateTask(source.id,t=>t.status='paused');assert.equal(validateTaskContract(f.store.task(child.taskId),{store:f.store}).valid,false);
});
test('public group context excludes private conversations/other role notes; group lineage excludes a fresh intent',t=>{
 const f=fixture(t);f.engine.create({prompt:'私人安排，不可进入群',roleId:'planner',cloudConsent:true});
 const sent=f.send('@研究员 @安排员 打开设置查看电池');assert.equal(sent.taskIds.length,2);const current=f.store.task(sent.taskIds[0]),context=groupTaskContext(current,f.store),text=JSON.stringify(context);assert.ok(!text.includes('私人安排'));assert.ok(!text.includes('私人研究笔记'));assert.equal(context.messages[0].authority,false);
 assert.deepEqual(groupTaskLineage(current,f.store),new Set(sent.taskIds));const second=f.send('@研究员 打开计算器');assert.ok(!groupTaskLineage(f.store.task(second.taskIds[0]),f.store).has(current.id));
});
test('tool-created group links the source task without leaking unrelated group history',t=>{
 const f=fixture(t),task=f.engine.create({prompt:'帮我建立一个项目群并安排分工',cloudConsent:true});f.store.updateTask(task.id,t=>t.status='running');const current=f.store.task(task.id);assert.ok(groupToolNames(current,f.store).includes('group_create'));
 const group=executeGroupTool(f.groups,task.id,'group_create',{name:'项目组',memberRoleIds:['research','planner']});const again=executeGroupTool(f.groups,task.id,'group_create',{name:'项目组',memberRoleIds:['research','planner']});assert.equal(group.id,again.id);
 assert.throws(()=>executeGroupTool(f.groups,task.id,'group_context',{groupId:f.group.id}),{code:'group_access_denied'});
 const handed=executeGroupTool(f.groups,task.id,'group_handoff',{groupId:group.id,roleId:'research',prompt:'先梳理项目背景'});assert.equal(f.store.task(handed.taskId).source,'delegation');assert.ok(groupTaskLineage(current,f.store).has(handed.taskId));assert.ok(groupTaskLineage(f.store.task(handed.taskId),f.store).has(task.id));
 const list=executeGroupTool(f.groups,task.id,'group_list',{});assert.ok(list.groups.every(g=>!Object.hasOwn(g,'lastMessage')));
});
test('device scoped groups cannot be read or messaged by another device',t=>{
 const f=fixture(t),one=randomUUID(),two=randomUUID(),group=f.groups.create({name:'手机群',memberRoleIds:['planner']},{deviceId:one});assert.equal(f.groups.list({deviceId:two}).some(g=>g.id===group.id),false);assert.throws(()=>f.groups.detail(group.id,{deviceId:two}),{code:'group_access_denied'});assert.throws(()=>f.groups.send(group.id,{content:'你好',clientRequestId:randomUUID()},{deviceId:two}),{code:'group_access_denied'});
});

test('trusted desktop sees phone groups; create crash retry and message receipt are durable',t=>{
 const f=fixture(t),deviceId=randomUUID(),messageId=randomUUID(),request={name:'跨端群',memberRoleIds:['planner'],messageId};
 const first=f.groups.create(request,{deviceId}),again=f.groups.create(request,{deviceId});assert.equal(first.id,again.id);assert.equal(again.deduplicated,true);assert.throws(()=>f.groups.create({...request,name:'另一群'},{deviceId}),{code:'group_idempotency_conflict'});
 assert.ok(f.groups.list({trustedLocal:true}).some(g=>g.id===first.id));assert.equal(f.groups.detail(first.id,{trustedLocal:true}).id,first.id);assert.throws(()=>f.groups.detail(first.id),{code:'group_access_denied'});
 const clientRequestId=randomUUID(),createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+300000).toISOString(),sent=f.groups.send(first.id,{content:'打开设置查看电池',recipientRoleIds:['planner'],clientRequestId,cloudConsent:true,remoteExpiresAt:expiresAt,submittedAt:createdAt},{deviceId,remoteControlEpoch:2});
 const receipt=f.groups.messageReceipt(first.id,clientRequestId,{deviceId});assert.equal(receipt.received,true);assert.equal(receipt.messageId,clientRequestId);assert.equal(receipt.taskId,sent.taskIds[0]);assert.equal(f.store.task(receipt.taskId).remoteExpiresAt,expiresAt);assert.equal(f.groups.messageReceipt(first.id,randomUUID(),{deviceId}).received,false);
});

test('group archive requires the exact group snapshot and its authenticated owner',t=>{
 const f=fixture(t),deviceId=randomUUID(),other=randomUUID(),group=f.groups.create({name:'仅本次测试',memberRoleIds:['planner']},{deviceId});
 const input={name:group.name,createdAt:group.createdAt};
 for(const options of [{},{deviceId:other}])assert.throws(()=>f.groups.archive(group.id,input,options),{code:'group_access_denied'});
 assert.throws(()=>f.groups.archive(f.group.id,{name:f.group.name,createdAt:f.group.createdAt},{deviceId}),{code:'group_access_denied'},'a phone does not own a desktop group');
 for(const wrong of [{...input,name:'相似名称'},{...input,createdAt:new Date(0).toISOString()}])assert.throws(()=>f.groups.archive(group.id,wrong,{trustedLocal:true}),{code:'group_archive_conflict'});
 const result=f.groups.archive(group.id,input,{deviceId});assert.ok(result.archivedAt);assert.equal(result.deduplicated,false);
 assert.equal(f.groups.list({trustedLocal:true}).some(row=>row.id===group.id),false);
 assert.equal(f.groups.archive(group.id,input,{trustedLocal:true}).deduplicated,true);
 assert.ok(f.store.data.groups.find(row=>row.id===group.id).archivedAt);
 assert.ok(f.groups.list({trustedLocal:true}).some(row=>row.id===f.group.id),'other groups remain visible');
});

test('archive refuses live descendants, stopping runtimes and unresolved actions without changing history',t=>{
 const f=fixture(t),sent=f.send('@研究员 整理公开资料'),id=sent.taskIds[0],input={name:f.group.name,createdAt:f.group.createdAt};
 for(const status of ['queued','running','waiting_consent','waiting_children','waiting_approval','waiting_setup','paused','interrupted','unknown_result']){
  f.store.updateTask(id,task=>{task.status=status;});
  assert.throws(()=>f.groups.archive(f.group.id,input,{trustedLocal:true}),{code:'group_busy'},status);
 }
 f.store.updateTask(id,task=>{task.status='completed';});
 const child=f.engine.newTask({prompt:'整理子任务',cloudConsent:false});child.parentId=id;
 f.store.transaction(s=>{s.tasks.push(child);});
 assert.throws(()=>f.groups.archive(f.group.id,input,{trustedLocal:true}),{code:'group_busy'},'unmapped descendants also keep the group open');
 f.store.updateTask(child.id,task=>{task.status='cancelled';});
 f.engine.active.set(id,{});assert.throws(()=>f.groups.archive(f.group.id,input,{trustedLocal:true}),{code:'group_busy'});f.engine.active.delete(id);
 f.store.transaction(s=>s.actions.push({id:'unverified',taskId:child.id,status:'unknown'}));
 assert.throws(()=>f.groups.archive(f.group.id,input,{trustedLocal:true}),{code:'group_busy'});
 f.store.transaction(s=>{s.actions.find(row=>row.id==='unverified').resolution={kind:'verified_observation',evidence:'synthetic-test'};});
 const preserved=['tasks','actions','groupMessages','groupReceipts','groupHandoffs','groupControls','roles'],before=Object.fromEntries(preserved.map(key=>[key,structuredClone(f.store.data[key])]));
 f.groups.archive(f.group.id,input,{trustedLocal:true});
 for(const key of preserved)assert.deepEqual(f.store.data[key],before[key],key);
 assert.throws(()=>f.groups.send(f.group.id,{content:'不可再派发',clientRequestId:randomUUID()}),{code:'group_not_found'});
 assert.equal(f.store.data.actions.find(row=>row.id==='unverified').status,'unknown','historical action records are not removed or rewritten');
});

test('reply to a bot routes directly and retains the exact referenced group result beyond recent history',t=>{
 const f=fixture(t),first=f.send('@安排员 整理安排');const task=f.store.task(first.taskIds[0]);f.store.updateTask(task.id,row=>{row.status='completed';row.result='已整理三个方案';});f.groups.reconcile();const answer=f.groups.detail(f.group.id).messages.find(m=>m.taskId===task.id&&m.kind==='assistant');
 for(let i=0;i<45;i++)f.store.data.groupMessages.push({id:randomUUID(),groupId:f.group.id,kind:'user',content:'旁支消息 '+i,taskIds:[]});
 const next=f.send('把第二项展开',{replyToMessageId:answer.id});assert.equal(next.taskIds.length,1);const child=f.store.task(next.taskIds[0]);assert.equal(child.roleId,'planner');assert.equal(next.replyToMessageId,answer.id);assert.equal(groupTaskContext(child,f.store).replyTo.content,'已整理三个方案');assert.equal(groupTaskContext(child,f.store).replyTo.authority,false);
 const other=f.groups.create({name:'另一组',memberRoleIds:['planner']});assert.throws(()=>f.groups.send(other.id,{content:'继续',clientRequestId:randomUUID(),replyToMessageId:answer.id}),{code:'group_reply_invalid'});
 const replay=f.groups.send(f.group.id,{content:'把第二项展开',clientRequestId:next.clientRequestId,cloudConsent:true,replyToMessageId:answer.id});assert.equal(replay.deduplicated,true);assert.equal(replay.taskIds[0],child.id);
});

test('configured handoff budget releases slots after completed work',t=>{
 const f=fixture(t);f.store.data.settings.maxPendingDelegations=4;const sent=f.send('@研究员 分阶段整理资料'),id=sent.taskIds[0];f.store.updateTask(id,t=>t.status='running');
 const children=[];for(let n=0;n<4;n++)children.push(f.groups.handoff(id,{roleId:'planner',prompt:'整理第 '+n+' 部分'}).taskId);
 assert.throws(()=>f.groups.handoff(id,{roleId:'planner',prompt:'整理下一部分'}),{code:'delegation_capacity'});
 for(const child of children)f.store.updateTask(child,t=>{t.status='completed';});
 const next=f.groups.handoff(id,{roleId:'planner',prompt:'整理下一部分'});assert.equal(next.status,'queued');assert.equal(f.store.task(id).children.length,5);
 assert.equal(f.groups.handoff(id,{roleId:'planner',prompt:'整理下一部分'}).taskId,next.taskId);
});
test('group resume resets local recovery without changing grants, deadlines or unresolved effects',async t=>{
 const f=fixture(t),id=f.send('@研究员 打开设置查看电池').taskIds[0];
 for(const status of ['blocked','needs_review']){
  f.store.updateTask(id,t=>{t.status=status;t.requests=14;t.phoneRecovery={startRequests:10,reason:'recover'};});
  const before=structuredClone(f.store.task(id).taskContract);
  await f.groups.control(f.group.id,id,'resume',{trustedLocal:true});
  const task=f.store.task(id);assert.equal(task.status,'queued');assert.equal(task.phoneRecovery,null);assert.deepEqual(task.taskContract,before);
  f.store.updateTask(id,t=>t.status='running');const controller=new AbortController();f.engine.authorizeRuntime({taskId:id,controller});assert.equal(controller.signal.aborted,false);
 }
 f.store.updateTask(id,t=>t.status='needs_review');f.store.transaction(s=>s.actions.push({taskId:id,status:'unknown'}));
 await assert.rejects(f.groups.control(f.group.id,id,'resume',{trustedLocal:true}),/未核实/);assert.equal(f.store.task(id).status,'needs_review');
});
test('group results expose only explicit delivered files and never internal paths or private inputs',t=>{
 const f=fixture(t),id=f.send('@研究员 整理资料').taskIds[0];f.store.transaction(s=>{
  s.artifacts.push({id:'delivered',taskId:id,name:'result.webm',mime:'video/webm',size:12,kind:'output',path:'private/path'},{id:'material',taskId:id,kind:'input'},{id:'private',taskId:'unrelated',kind:'output'});
 });f.store.updateTask(id,t=>{t.status='completed';t.result='结果';});f.groups.reconcile();
 const result=f.groups.detail(f.group.id).messages.find(m=>m.kind==='assistant');assert.deepEqual(result.artifacts.map(a=>a.id),['delivered']);assert.equal(Object.hasOwn(result.artifacts[0],'path'),false);
});
