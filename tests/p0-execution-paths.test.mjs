import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {Broker} from '../src/tools/broker.mjs';
import {generalAppGrant} from '../src/adapters/phone-general-navigation.mjs';
import {deriveDelegation} from '../src/core/delegation.mjs';
import {validateTaskContract} from '../src/core/task-contract.mjs';
import {collaborationLineage,withCollaborationMutation,assertCollaborationClear,collaborationEffect,assertCollaborationEffect} from '../src/core/collaboration-roster.mjs';
const parse=out=>JSON.parse(out.content[0].text);
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-p0-paths-')),store=new Store(dir);
 const broker=new Broker({store,dataDir:dir,phone:{release(){},close(){}},browser:{close(){}},approvals:{cancelTask(){}},memory:{}}),engine=new Engine({store,broker,secrets:{get:async()=>null},memory:{}});engine.pump=async()=>{};
 const task=(prompt,options={})=>{const row=engine.create({prompt,cloudConsent:true,...options});store.updateTask(row.id,t=>t.status='running');return store.task(row.id);};
 t.after(()=>{engine.groups?.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});return {store,broker,engine,task};
}
test('a research worker sees and executes a web tool while its live parent still bounds authority',async t=>{
 const f=fixture(t),parent=f.task('查一下今晚有哪些合适的晚餐菜谱'),child=f.engine.create(deriveDelegation(parent,{prompt:'检索适合晚餐的菜谱',roleId:'life'},f.store));f.store.updateTask(child.id,r=>r.status='running');
 assert.deepEqual(child.taskContract.effects,['read']);assert.deepEqual(child.taskContract.allowedApps,[]);assert.equal(validateTaskContract(child,{store:f.store}).valid,true);
 let requests=0;f.broker.web={search:async()=>{requests++;return {results:[{title:'read-only fixture'}]};}};
 for(const name of ['web_search','web_fetch'])assert.ok(f.broker.catalog(child).some(d=>d.name===name),name);
 await f.broker.execute(child.id,'web_search',{query:'晚餐菜谱'});assert.equal(requests,1);
 f.store.updateTask(parent.id,r=>r.status='paused');await assert.rejects(f.broker.execute(child.id,'web_search',{query:'晚餐菜谱'}),{code:'delegation_not_authorized'});assert.equal(requests,1);
});
test('conversation task control is callable through the actual broker and cannot reach another conversation',async t=>{
 const f=fixture(t),old=f.task('整理下载里的说明文档'),caller=f.task('先暂停那件整理工作',{conversationId:old.conversationId}),other=f.task('另一个对话');
 assert.ok(f.broker.catalog(caller).some(d=>d.name==='conversation_task'));
 const status=parse(await f.broker.execute(caller.id,'conversation_task',{action:'status'}));assert.ok(status.tasks.some(r=>r.taskId===old.id));assert.ok(!status.tasks.some(r=>r.taskId===other.id));
 const receipt=parse(await f.broker.execute(caller.id,'conversation_task',{action:'pause',taskId:old.id}));assert.equal(receipt.status,'paused');assert.equal(f.store.task(old.id).status,'paused');
 await assert.rejects(f.broker.execute(caller.id,'conversation_task',{action:'pause',taskId:other.id}),/目标不在/);assert.equal(f.store.task(other.id).status,'running');
});
test('a group uses the same lock and effect identity for one multi-mention, while a new message is independent',async t=>{
 const f=fixture(t),group=f.engine.groups.create({name:'隔离验收群',memberRoleIds:['life','shopping']}),send=()=>f.engine.groups.send(group.id,{clientRequestId:randomUUID(),content:'@生活管家 @采购助理 在微信给张三发送“到了”',cloudConsent:true}),first=send();
 for(const id of first.taskIds)f.store.updateTask(id,r=>r.status='running');
 const [a,b]=first.taskIds.map(id=>f.store.task(id)),lineage=collaborationLineage(a,{store:f.store});assert.ok(lineage.ids.has(b.id));
 let release;const gate=new Promise(resolve=>release=resolve),running=withCollaborationMutation(f.store,a.id,()=>gate);await Promise.resolve();
 await assert.rejects(withCollaborationMutation(f.store,b.id,async()=>{}),{code:'collaboration_action_busy'});release();await running;
 const plan={kind:'send',recipient:'张三',content:'到了'},effectA=collaborationEffect(a,{store:f.store,packageName:'com.tencent.mm',plan,kind:'effect_send'}),effectB=collaborationEffect(b,{store:f.store,packageName:'com.tencent.mm',plan,kind:'effect_send'});assert.equal(effectA.key,effectB.key);
 f.store.transaction(s=>s.actions.push({id:'attempt',taskId:a.id,tool:'phone_action',status:'completed',phoneEffect:{kind:'effect_send',packageName:'com.tencent.mm'},collaborationEffect:effectA}));
 assert.throws(()=>assertCollaborationEffect(f.store,b.id,effectB,{commitKinds:new Set(['effect_send'])}),{code:'collaboration_effect_already_attempted'});
 f.store.updateTask(a.id,r=>r.status='unknown_result');f.store.transaction(s=>s.actions[0].status='unknown');assert.throws(()=>assertCollaborationClear(f.store,b.id),{code:'collaboration_result_unresolved'});
 const second=send();assert.doesNotThrow(()=>assertCollaborationClear(f.store,second.taskIds[0]));assert.ok(!collaborationLineage(f.store.task(second.taskIds[0]),{store:f.store}).ids.has(a.id));
});
test('group tools never expose private conversation summaries and private lookup stays within its role',async t=>{
 const f=fixture(t),privateA=f.task('生活专职私聊',{roleId:'life'}),privateB=f.task('采购专职私聊',{roleId:'shopping'}),caller=f.task('查看先前进度',{roleId:'life'});
 f.store.updateTask(privateA.id,r=>{r.result='生活私有结果';r.status='completed';});f.store.updateTask(privateB.id,r=>{r.result='采购私有结果';r.status='completed';});
 const lookup=parse(await f.broker.execute(caller.id,'task_lookup',{}));assert.ok(lookup.tasks.some(r=>r.taskId===privateA.id));assert.ok(!lookup.tasks.some(r=>r.taskId===privateB.id));
 const group=f.engine.groups.create({name:'公开群',memberRoleIds:['life','shopping']}),message=f.engine.groups.send(group.id,{clientRequestId:randomUUID(),content:'@生活管家 看看群里的进度',cloudConsent:true});const id=message.taskIds[0];f.store.updateTask(id,r=>r.status='running');
 assert.ok(!f.broker.catalog(f.store.task(id)).some(d=>d.name==='task_lookup'));await assert.rejects(f.broker.execute(id,'task_lookup',{}),{code:'task_lookup_not_authorized'});
 const context=parse(await f.broker.execute(id,'group_context',{}));assert.equal(context.groupId,group.id);assert.ok(!JSON.stringify(context).includes('私有结果'));
});

test('a hand-off from the user\'s own request reads under the root task\'s switches, not a derived keyword scope',async t=>{
 // The parent could call these read tools itself; its member gets the same reach.
 // Scheduled and event chains keep the derived scope (see the routine tests).
 const f=fixture(t),parent=f.task('打开设置查看电池'),child=f.engine.create(deriveDelegation(parent,{prompt:'帮我查一下这款手机的电池保养建议',roleId:'life'},f.store));f.store.updateTask(child.id,r=>r.status='running');
 let requests=0;f.broker.web={search:async()=>{requests++;return {results:[]};}};
 await f.broker.execute(child.id,'web_search',{query:'手机电池保养'}).catch(error=>{assert.notEqual(error.code,'delegation_not_authorized');});
 assert.equal(requests,1);
 f.store.updateTask(parent.id,r=>r.status='paused');await assert.rejects(f.broker.execute(child.id,'web_search',{query:'again'}),{code:'delegation_not_authorized'},'a paused root still stops its members');assert.equal(requests,1);
});

test('in the user\'s own group the bot\'s notes and personal memory are available through broker tools',async t=>{
 const f=fixture(t);f.store.transaction(s=>{s.settings.memoryEnabled=true;s.roles.find(r=>r.id==='life').notes=[{id:'private-note',text:'私聊里说过的偏好',at:new Date().toISOString()}];});
 const group=f.engine.groups.create({name:'自己的助理群',memberRoleIds:['life','shopping']}),message=f.engine.groups.send(group.id,{clientRequestId:randomUUID(),content:'@生活管家 看看计划',cloudConsent:true,memoryConsent:true,memoryMode:'default'}),id=message.taskIds[0];f.store.updateTask(id,r=>r.status='running');
 assert.equal(f.store.task(id).memoryConsent,true);assert.equal(f.store.task(id).memoryMode,'default');
 const names=f.broker.catalog(f.store.task(id)).map(t=>t.name);for(const name of ['bot_memory','memory_context','memory_propose'])assert.ok(names.includes(name),name);assert.ok(!names.includes('task_lookup'),'other private chats stay out');
 const listed=parse(await f.broker.execute(id,'bot_memory',{action:'list'}));assert.ok(JSON.stringify(listed).includes('私聊里说过的偏好'));
 await assert.rejects(f.broker.execute(id,'task_lookup',{}),{code:'task_lookup_not_authorized'});
 let memoryCalls=0;f.broker.memory.context=async()=>{memoryCalls++;return {context:'PRIVATE_CORE'};};
 await f.broker.execute(id,'memory_context',{query:'个人偏好'}).catch(error=>assert.notEqual(error.code,'group_memory_not_allowed'));
 assert.ok(memoryCalls>0);
 const child=f.engine.groups.handoff(id,{roleId:'shopping',prompt:'查询公开计划'});assert.equal(f.store.task(child.taskId).memoryConsent,true,'a hand-off keeps the root\'s memory consent');
});
test('group standing lists and controls use persisted origin membership, never a conversation prefix',async t=>{
 const f=fixture(t),privateTask=f.task('私聊跟进',{roleId:'life'}),group=f.engine.groups.create({name:'群跟进隔离',memberRoleIds:['life','shopping']}),other=f.engine.groups.create({name:'另一个群',memberRoleIds:['life','shopping']});
 const send=groupId=>f.engine.groups.send(groupId,{clientRequestId:randomUUID(),content:'@生活管家 列出跟进并停下',cloudConsent:true}).taskIds[0];
 const id=send(group.id),otherId=send(other.id);f.store.updateTask(id,r=>r.status='running');
 f.store.transaction(s=>{
  s.watches=[['own',id],['private',privateTask.id],['other',otherId],['orphan','missing']].map(([key,originTaskId])=>({id:'watch-'+key,goal:key,status:'active',roleId:'life',originTaskId,conversationId:f.store.task(id).conversationId,check:{kind:'web'},intervalMinutes:10,expiresAt:new Date(Date.now()+600000).toISOString()}));
  s.routines=[['own',id],['private',privateTask.id],['other',otherId],['orphan','missing']].map(([key,originTaskId])=>({id:'routine-'+key,name:key,prompt:key,enabled:true,roleId:'life',originTaskId,conversationId:f.store.task(id).conversationId,kind:'daily',time:'22:00',timezone:'UTC',createdAt:new Date().toISOString(),revision:1,history:[]}));
 });
 assert.deepEqual(parse(await f.broker.execute(id,'watch_list',{})).watches.map(r=>r.id),['watch-own']);assert.deepEqual(parse(await f.broker.execute(id,'routine_list',{})).routines.map(r=>r.id),['routine-own']);
 for(const key of ['private','other','orphan']){await assert.rejects(f.broker.execute(id,'watch_cancel',{id:'watch-'+key}),{code:'standing_not_allowed'});await assert.rejects(f.broker.execute(id,'routine_pause',{id:'routine-'+key}),{code:'standing_not_allowed'});}
 assert.equal(parse(await f.broker.execute(id,'watch_cancel',{id:'watch-own'})).cancelled,true);assert.equal(parse(await f.broker.execute(id,'routine_pause',{id:'routine-own'})).paused,true);
 for(const key of ['private','other','orphan']){assert.equal(f.store.data.watches.find(w=>w.id==='watch-'+key).status,'active');assert.equal(f.store.data.routines.find(w=>w.id==='routine-'+key).enabled,true);}
 const names=f.broker.catalog(f.store.task(id)).map(d=>d.name);assert.ok(!names.includes('watch_create'));assert.ok(!names.includes('routine_create'));
 await assert.rejects(f.broker.execute(id,'watch_create',{goal:'持续跟进天气',kind:'web'}),{code:'group_standing_unavailable'});
 await assert.rejects(f.broker.execute(id,'routine_create',{name:'提醒',prompt:'提醒喝水',kind:'daily',time:'22:00'}),{code:'group_standing_unavailable'});
 assert.equal(f.store.data.watches.length,4);assert.equal(f.store.data.routines.length,4);
});


test('actual group handoffs complete without phone proof when device actions were expressly denied',async t=>{
 const f=fixture(t),prompt='请用实际工具创建两个临时专职助手：验算助手只负责核对算术，表达助手只负责把已核实结果写成一句话。将他们加入名为“P0 隔离验收”的群。安排验算助手计算 7 乘 8，并在群里交班给表达助手，让表达助手根据核实结果写一句中文。请实际建群、交班，最后按真实任务回执汇总。所有内容都是本次隔离测试；不操作手机、不访问用户文件、不创建日程、不发送外部消息，不读取或保存记忆。',parent=f.task(prompt);
 f.store.transaction(s=>{s.settings.phoneEnabled=false;s.settings.filesEnabled=false;s.settings.browserEnabled=false;});
 assert.deepEqual(parent.taskContract.allowedApps,[]);assert.deepEqual(parent.taskContract.effects,['read','navigate']);
 const roles=[];for(const name of ['验算助手','表达助手'])roles.push(parse(await f.broker.execute(parent.id,'role_create',{name,description:'隔离计算分工',instruction:'只处理本次分工并报告真实结果'})).roleId);
 const group=parse(await f.broker.execute(parent.id,'group_create',{name:'P0 隔离验收',memberRoleIds:roles}));
 const first=parse(await f.broker.execute(parent.id,'group_handoff',{groupId:group.id,roleId:roles[0],prompt:'核对 7 乘 8'}));f.store.updateTask(first.taskId,r=>r.status='running');
 await f.broker.execute(first.taskId,'finish_task',{outcome:'completed',summary:'7 × 8 = 56',evidence:[]});f.store.updateTask(parent.id,r=>r.status='running');
 const second=parse(await f.broker.execute(parent.id,'group_handoff',{groupId:group.id,roleId:roles[1],prompt:'将已核实的乘法结果写成一句中文',context:f.store.task(first.taskId).result}));f.store.updateTask(second.taskId,r=>r.status='running');
 await f.broker.execute(second.taskId,'finish_task',{outcome:'completed',summary:'七乘以八等于五十六。',evidence:[]});f.store.updateTask(parent.id,r=>r.status='running');
 const receipts=f.store.data.groupReceipts.filter(r=>[first.taskId,second.taskId].includes(r.taskId)),completed=receipts.filter(r=>r.state==='completed');assert.equal(completed.length,2);
 for(const id of [first.taskId,second.taskId])assert.deepEqual(receipts.filter(r=>r.taskId===id).map(r=>r.state),['queued','accepted','completed']);
 // Losing transient tool refs must not lose the actual persisted work receipts.
 f.broker.evidence.clear();const queued=receipts.find(r=>r.state==='queued');await assert.rejects(f.broker.execute(parent.id,'finish_task',{outcome:'completed',summary:'尚不能用排队当结果',evidence:[queued.id]}),/未知证据/);
 const result=parse(await f.broker.execute(parent.id,'finish_task',{outcome:'completed',summary:'两位助手已建群完成交班，核实 7 × 8 = 56。',evidence:[first.taskId,second.id,...completed.map(r=>r.id)]}));
 assert.equal(result.recorded,true);assert.equal(f.store.task(parent.id).status,'completed');assert.equal(f.store.data.actions.length,0);assert.equal(f.store.task(parent.id).phoneUseScope,null);
});
test('private or superseded worker results are not current task completion evidence',async t=>{
 const f=fixture(t),parent=f.task('请核对乘法'),child=f.engine.create(deriveDelegation(parent,{roleId:'life',prompt:'计算 7 乘 8'},f.store));f.store.updateTask(child.id,r=>r.status='running');await f.broker.execute(child.id,'finish_task',{outcome:'completed',summary:'56',evidence:[]});f.store.updateTask(parent.id,r=>r.status='running');
 const unrelated=f.task('另一条独立消息');assert.equal(f.broker.completedTaskEvidence(unrelated,child.id),false);await assert.rejects(f.broker.execute(unrelated.id,'finish_task',{outcome:'completed',summary:'无关结果',evidence:[child.id]}),/未知证据/);
 assert.equal(f.broker.completedTaskEvidence(f.store.task(parent.id),child.id),true);const previous=parent.taskContract.revision;f.store.updateTask(parent.id,r=>r.taskContract.revision=previous+1);assert.equal(f.broker.completedTaskEvidence(f.store.task(parent.id),child.id),false);
});
