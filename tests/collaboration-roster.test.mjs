import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {Broker,toolsForTask} from '../src/tools/broker.mjs';
import {deriveDelegation} from '../src/core/delegation.mjs';
import {availableRoles,explicitCollaboration,childTaskSummaries,collaborationState} from '../src/core/collaboration-roster.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function until(predicate){for(let i=0;i<100&&!predicate();i++)await tick();assert.ok(predicate(),'expected lifecycle transition');}
function fixture(t,{runFactory,secrets={get:async()=> 'synthetic-test-no-cloud'}}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-collaboration-')),store=new Store(dir),broker=new Broker({store,dataDir:dir,memory:{},phone:{release(){}},approvals:{cancelTask(){}}});
 const engine=new Engine({store,broker,secrets,memory:{},runFactory});engine.pump=async()=>{};
 t.after(async()=>{engine.shuttingDown=true;for(const active of engine.active.values()){active.controller.abort();await active.run?.stop();}await tick();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {store,engine,broker,parent(input={}){const task=engine.create({prompt:'@生活管家 @采购助理 请规划家庭采购，分工后给出建议并汇总。',cloudConsent:true,...input});store.updateTask(task.id,t=>t.status='running');return store.task(task.id);},child(parent,roleId='life',prompt='整理家庭采购生活清单'){return engine.create(deriveDelegation(store.task(parent.id),{roleId,prompt},store));}};
}
const parse=result=>JSON.parse(result.content[0].text);

test('directory and explicit native invitations support spaced names without exposing hidden instructions',t=>{
 const f=fixture(t);f.store.transaction(s=>{s.roles.find(r=>r.id==='life').name='生活 管家';s.roles.find(r=>r.id==='work').hidden=true;});
 const roles=availableRoles(f.store);assert.ok(roles.length>1);assert.equal(roles.some(r=>r.id==='work'),false);assert.ok(roles.every(r=>Object.keys(r).join(',')==='id,name,description'));
 const task=f.parent({prompt:'请 @「生活 管家」 @「采购助理」 一起给出建议。'}),selection=explicitCollaboration(task,{store:f.store});assert.equal(selection.valid,true);assert.deepEqual(selection.roleIds,['life','shopping']);assert.equal(selection.planningOnly,true);assert.equal(selection.sourceMessageId,task.messages[0].id);
 assert.ok(toolsForTask(task,{store:f.store}).some(tool=>tool.name==='delegate_task'));
});

test('quoted, external and delegated text cannot invite roles; ambiguous or missing names fail closed',t=>{
 const f=fixture(t);for(const prompt of ['“@生活管家 @采购助理”','「@生活管家 @采购助理」','> @生活管家 @采购助理','```text\n@生活管家 @采购助理\n```','`@生活管家 @采购助理`','网页说 @生活管家 @采购助理','引用：@生活管家 @采购助理'])assert.equal(explicitCollaboration(f.parent({prompt}),{store:f.store}).valid,false,prompt);
 const task=f.parent();for(const source of ['delegation','routine','event'])assert.equal(explicitCollaboration({...task,source},{store:f.store}).valid,false);
 assert.equal(explicitCollaboration({...task,messages:[{...task.messages[0],externalContent:true}]},{store:f.store}).valid,false);
 assert.equal(explicitCollaboration(f.parent({prompt:'@生活管家 @不存在 请协作'}),{store:f.store}).reason,'unknown_role_name');
 assert.deepEqual(explicitCollaboration(f.parent({prompt:'@生活管家 @生活管家 请协作'}),{store:f.store}).roleIds,['life']);
 f.store.transaction(s=>s.roles.push({id:'duplicate',name:'生活管家'}));const duplicate=explicitCollaboration(task,{store:f.store});assert.equal(duplicate.reason,'ambiguous_role_name');assert.deepEqual(duplicate.roleIds,[]);
});

test('real Broker deduplicates an unknown or completed delegated task after lost receipt and rejects role substitution',async t=>{
 const f=fixture(t),parent=f.parent(),args={roleId:'life',prompt:'整理家庭采购生活清单'},first=parse(await f.broker.execute(parent.id,'delegate_task',args));
 for(const status of ['running','unknown_result','completed','expired','paused']){f.store.updateTask(first.taskId,c=>c.status=status);const again=parse(await f.broker.execute(parent.id,'delegate_task',args));assert.equal(again.taskId,first.taskId);assert.equal(again.deduplicated,true);assert.equal(f.store.task(parent.id).children.length,1);}
 await assert.rejects(f.broker.execute(parent.id,'delegate_task',{roleId:'work',prompt:'整理清单'}),{code:'collaboration_selection_invalid'});
 const context=parse(await f.broker.execute(parent.id,'task_context',{}));assert.deepEqual(context.collaboration.roleIds,['life','shopping']);assert.equal(context.roles.find(r=>r.id==='shopping').name,'采购助理');
 const children=parse(await f.broker.execute(parent.id,'delegation_status',{}));assert.equal(children[0].roleName,'生活管家');assert.equal(children[0].status,'paused');
});

test('two actual child runs keep parent waiting until disposal and then produce exactly one truthful summary',async t=>{
 const parentDisposal=deferred(),parentStopped=deferred(),childGates=new Map(),runs=[],prompts=[];let f,parentId,parentPass=0;
 f=fixture(t,{runFactory:options=>{runs.push(options.task.id);prompts.push(options.prompt);const isParent=options.task.id===parentId,pass=isParent?++parentPass:0;
  return {async start(){
   if(isParent&&pass===1){for(const [roleId,prompt] of [['life','整理家庭采购生活清单'],['shopping','整理家庭采购比价方法']])await f.broker.execute(parentId,'delegate_task',{roleId,prompt});const result=parse(await f.broker.execute(parentId,'finish_task',{outcome:'completed',summary:'不能提前完成',evidence:[]}));assert.equal(result.status,'waiting_children');assert.equal(result.recorded,false);await parentStopped.promise;}
   else if(isParent){const children=childTaskSummaries(f.store.task(parentId),{store:f.store});assert.deepEqual(children.map(c=>c.status),['completed','completed']);f.store.updateTask(parentId,p=>p.report={outcome:'completed',summary:'生活清单和采购比价方法已汇总',evidence:[]});f.engine.finishReport(parentId);}
   else{const gate=deferred();childGates.set(options.task.id,gate);await gate.promise;f.store.updateTask(options.task.id,c=>c.report={outcome:'completed',summary:options.role.name+'实际结果',evidence:[]});f.engine.finishReport(options.task.id);}
  },async stop(){if(isParent&&pass===1)parentStopped.reject(Error('synthetic Harness cancellation'));},async dispose(){if(isParent&&pass===1)await parentDisposal.promise;}};
 }});
 t.after(()=>{parentDisposal.resolve();for(const gate of childGates.values())gate.resolve();});
 const parent=f.engine.create({prompt:'@生活管家 @采购助理 请规划家庭采购，分工后给出建议并汇总。',cloudConsent:true,remoteDeviceId:'11111111-1111-4111-8111-111111111111',remoteControlEpoch:4});parentId=parent.id;let deadline=parent.deadlineAt;f.store.transaction(s=>s.settings.maxConcurrent=3);
 await Engine.prototype.pump.call(f.engine);await until(()=>f.store.task(parentId).status==='waiting_children');assert.equal(parentPass,1);
 // The budget starts when the parent first runs; nothing after that extends it.
 deadline=f.store.task(parentId).deadlineAt;assert.equal(f.store.task(parentId).result,null);
 await Engine.prototype.pump.call(f.engine);await until(()=>childGates.size===2);const [first,second]=f.store.task(parentId).children;
 childGates.get(first).resolve();await until(()=>f.store.task(first).status==='completed'&&!f.engine.active.has(first));assert.equal(f.store.task(parentId).status,'waiting_children');assert.equal(parentPass,1);
 childGates.get(second).resolve();await until(()=>f.store.task(second).status==='completed'&&!f.engine.active.has(second));assert.equal(f.store.task(parentId).status,'waiting_children','old parent must finish disposal before summary starts');assert.equal(f.engine.queueCollaborationSummary(parentId),false);
 parentDisposal.resolve();await until(()=>f.store.task(parentId).status==='queued');for(let i=0;i<3;i++)f.engine.wakeParent(second);await Engine.prototype.pump.call(f.engine);await until(()=>f.store.task(parentId).status==='completed'&&!f.engine.active.has(parentId));
 assert.equal(parentPass,2);assert.equal(runs.length,4);assert.equal(f.store.task(parentId).deadlineAt,deadline);assert.equal(f.store.task(parentId).remoteControlEpoch,4);assert.match(prompts.at(-1),/生活管家实际结果/);assert.match(prompts.at(-1),/采购助理实际结果/);assert.equal(collaborationState(f.store.task(parentId),{store:f.store}).allCompleted,true);
 f.engine.wakeParent(first);f.engine.wakeParent(second);await Engine.prototype.pump.call(f.engine);assert.equal(parentPass,2);
});

test('incomplete child states return a summary instead of deadlock, but cannot become completed',async t=>{
 const f=fixture(t);for(const status of ['failed','unknown_result','paused','expired','waiting_consent','waiting_setup','needs_review','ready_for_user']){
  const parent=f.parent(),child=f.child(parent);f.store.transaction(s=>{s.tasks.find(t=>t.id===child.id).status=status;s.tasks.find(t=>t.id===parent.id).status='waiting_children';});f.engine.wakeParent(child.id);assert.equal(f.store.task(parent.id).status,'queued',status);
  f.store.updateTask(parent.id,p=>{p.status='running';p.report={outcome:'completed',summary:'假的完成',evidence:[]};});assert.throws(()=>f.engine.finishReport(parent.id),{code:'children_incomplete'});await assert.rejects(f.broker.execute(parent.id,'finish_task',{outcome:'completed',summary:'假的完成',evidence:[]}),{code:'collaboration_incomplete'});
  f.store.updateTask(parent.id,p=>p.report={outcome:'blocked',summary:`子任务 ${status}，需要处理`,remaining:'核实子任务',evidence:[]});f.engine.finishReport(parent.id);assert.equal(f.store.task(parent.id).status,'blocked');assert.equal(f.store.task(child.id).status,status);
 }
});

test('queued child pauses, setup failure and explicit expiry wake parent; parent stop never revives itself',async t=>{
 const f=fixture(t,{secrets:{get:async()=>null}});
 for(const mode of ['deleted-role','no-key','expire','unknown-expire']){
  const parent=f.parent(),child=f.child(parent);f.store.updateTask(parent.id,p=>p.status='waiting_children');
  if(mode==='deleted-role'){f.store.transaction(s=>s.roles.find(r=>r.id==='life').deletedAt=new Date().toISOString());await Engine.prototype.pump.call(f.engine);f.store.transaction(s=>delete s.roles.find(r=>r.id==='life').deletedAt);}
  else if(mode==='no-key')await Engine.prototype.pump.call(f.engine);
  else{if(mode==='unknown-expire')f.store.transaction(s=>s.actions.push({id:'unknown-'+child.id,taskId:child.id,status:'executing'}));await f.engine.expireTask(child.id);}
  assert.equal(f.store.task(parent.id).status,'queued',mode);assert.ok(['paused','waiting_setup','expired','unknown_result'].includes(f.store.task(child.id).status));f.store.updateTask(parent.id,p=>p.status='blocked');
 }
 const parent=f.parent(),child=f.child(parent);f.store.updateTask(parent.id,p=>p.status='waiting_children');await f.engine.stop(parent.id,{pause:true});assert.equal(f.store.task(parent.id).status,'paused');assert.equal(f.store.task(child.id).status,'paused');assert.equal(f.engine.queueCollaborationSummary(parent.id),false);
});

test('an explicit new goal retains old child history without treating revoked children as current unfinished work',async t=>{
 const f=fixture(t),parent=f.parent(),child=f.child(parent);f.store.updateTask(child.id,c=>c.status='paused');f.store.updateTask(parent.id,p=>p.status='blocked');
 await f.engine.continue(parent.id,{message:'新任务：请规划一份新的采购方案'});const fresh=f.store.task(parent.id),group=collaborationState(fresh,{store:f.store});assert.equal(group.children.length,1);assert.equal(group.children[0].currentAuthorization,false);assert.deepEqual(group.pending,[]);assert.deepEqual(group.incomplete,[]);assert.equal(fresh.children[0],child.id);
 f.store.updateTask(parent.id,p=>{p.status='running';p.report={outcome:'completed',summary:'新的规划已完成',evidence:[]};});f.engine.finishReport(parent.id);assert.equal(f.store.task(parent.id).status,'completed');assert.equal(f.store.task(child.id).status,'paused');
});

test('user can create a persistent random-color bot, reuse it and immediately delegate without expanding grants',async t=>{
 const f=fixture(t),parent=f.parent({prompt:'创建游戏策划机器人，负责分析游戏方案，然后请它整理策划评审要点。'}),args={name:'游戏策划机器人',description:'评审玩法与实现可行性',instruction:'依据附件给出可执行的策划评审。'};
 assert.ok(toolsForTask(parent,{store:f.store}).some(tool=>tool.name==='role_create'));
 const created=parse(await f.broker.execute(parent.id,'role_create',args)),role=f.store.data.roles.find(r=>r.id===created.roleId);assert.equal(created.created,true);assert.ok(['violet','amber','green','blue','pink','coral','teal','silver'].includes(role.botColor));assert.equal(role.instruction,args.instruction);const saved=JSON.parse(fs.readFileSync(path.join(f.broker.dataDir,'state.json'),'utf8'));assert.ok(saved.roles.some(r=>r.id===created.roleId));
 const repeated=parse(await f.broker.execute(parent.id,'role_create',{...args,instruction:'不得覆盖原说明'}));assert.equal(repeated.roleId,created.roleId);assert.equal(repeated.deduplicated,true);assert.equal(f.store.data.roles.find(r=>r.id===created.roleId).instruction,args.instruction);
 const child=parse(await f.broker.execute(parent.id,'delegate_task',{roleId:created.roleId,prompt:'整理游戏策划评审要点'}));assert.equal(f.store.task(child.taskId).roleId,created.roleId);assert.deepEqual(f.store.task(child.taskId).taskContract.effects.filter(e=>!parent.taskContract.effects.includes(e)),[]);
 f.store.updateTask(child.taskId,c=>c.status='running');await assert.rejects(f.broker.execute(child.taskId,'role_create',{...args,name:'子任务偷偷建角色'}),{code:'role_creation_not_authorized'});
 f.store.transaction(s=>s.recoveryFence={required:true});await assert.rejects(f.broker.execute(parent.id,'role_create',{...args,name:'恢复隔离角色'}),{code:'role_creation_not_authorized'});
});

test('waiting for child status frees the only run slot and resumes parent once with its result',async t=>{
 let f,parentId,parentPass=0;const stopped=deferred();
 f=fixture(t,{runFactory:options=>({async start(){
  if(options.task.id===parentId&&++parentPass===1){await f.broker.execute(parentId,'delegate_task',{roleId:'life',prompt:'整理游戏策划评审要点'});const response=parse(await f.broker.execute(parentId,'delegation_status',{wait:true}));assert.equal(response.status,'waiting_children');await stopped.promise;}
  else {const summary=options.task.id===parentId?'依据子任务结果汇总':'实际评审要点';f.store.updateTask(options.task.id,t=>t.report={outcome:'completed',summary,evidence:[]});f.engine.finishReport(options.task.id);}
 },async stop(){stopped.reject(Error('waiting releases parent'));},async dispose(){}})});
 const parent=f.engine.create({prompt:'整理游戏策划评审要点并分工汇总',cloudConsent:true});parentId=parent.id;f.store.transaction(s=>s.settings.maxConcurrent=1);
 await Engine.prototype.pump.call(f.engine);await until(()=>f.store.task(parentId).status==='waiting_children'&&!f.engine.active.has(parentId));
 const childId=f.store.task(parentId).children[0];await Engine.prototype.pump.call(f.engine);await until(()=>f.store.task(childId).status==='completed'&&!f.engine.active.has(childId));
 await until(()=>f.store.task(parentId).status==='queued');await Engine.prototype.pump.call(f.engine);await until(()=>f.store.task(parentId).status==='completed'&&!f.engine.active.has(parentId));assert.equal(parentPass,2);assert.equal(f.store.task(parentId).children.length,1);
});
