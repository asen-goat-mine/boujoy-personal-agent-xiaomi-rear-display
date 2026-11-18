import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {Broker,TOOL_DEFINITIONS} from '../src/tools/broker.mjs';
import {explicitCollaboration,withCollaborationMutation} from '../src/core/collaboration-roster.mjs';
import {validateTaskContract} from '../src/core/task-contract.mjs';
const parse=result=>JSON.parse(result.content[0].text);
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'f1-integration-')),store=new Store(dir),broker=new Broker({store,dataDir:dir,memory:{},phone:{release(){}},approvals:{cancelTask(){}}});
 const engine=new Engine({store,broker,secrets:{get:async()=>null},memory:{}});engine.pump=async()=>{};
 t.after(()=>{engine.groups.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const groups=engine.groups,group=groups.create({name:'验证群',memberRoleIds:['life','shopping','work']}),send=(content,extra={})=>groups.send(group.id,{content,cloudConsent:true,clientRequestId:randomUUID(),...extra});
 return {dir,store,broker,engine,groups,group,send};
}
test('model sees every group tool before creating any group and can create roles, group, add members, hand off',async t=>{
 const f=fixture(t),root=f.engine.create({prompt:'建两个专职助手，拉进群，让他们分工整理一份计划并交接结果。',cloudConsent:true});f.store.updateTask(root.id,t=>t.status='running');
 assert.equal(new Set(TOOL_DEFINITIONS.map(t=>t.name)).size,TOOL_DEFINITIONS.length,'model tool names must be unique');
 const tools=f.broker.catalog(f.store.task(root.id)).map(t=>t.name);
 for(const name of ['role_create','group_create','group_members','group_context','group_handoff','group_task'])assert.ok(tools.includes(name),name);
 const one=parse(await f.broker.execute(root.id,'role_create',{name:'资料专职',description:'核对资料',instruction:'给出来源和不确定性'})),two=parse(await f.broker.execute(root.id,'role_create',{name:'计划专职',description:'整理计划',instruction:'按目标安排步骤'}));
 const group=parse(await f.broker.execute(root.id,'group_create',{name:'本轮计划',memberRoleIds:[one.roleId]}));
 const updated=parse(await f.broker.execute(root.id,'group_members',{groupId:group.id,addRoleIds:[two.roleId]}));assert.equal(updated.members.length,2);
 const handoff=parse(await f.broker.execute(root.id,'group_handoff',{groupId:group.id,roleId:one.roleId,prompt:'先梳理已有资料',context:'本轮尚未查询外部资料'}));assert.equal(f.store.task(handoff.taskId).roleId,one.roleId);
 assert.equal(parse(await f.broker.execute(root.id,'group_context',{groupId:group.id})).receipts.at(-1).state,'queued');
});
test('single abbreviated @ routes once, exact wins, and ambiguous abbreviation dispatches nothing',t=>{
 const f=fixture(t),sent=f.send('@采购 请整理采购建议');assert.equal(sent.taskIds.length,1);const task=f.store.task(sent.taskIds[0]);assert.equal(task.roleId,'shopping');assert.equal(explicitCollaboration(task,{store:f.store}).reason,'group_already_routed');
 f.store.transaction(s=>s.roles.push({id:'other',name:'采购顾问'}));f.groups.members(f.group.id,{addRoleIds:['other']});const count=f.store.data.tasks.length;
 assert.throws(()=>f.send('@采购 请整理采购建议'),{code:'group_recipient_ambiguous'});assert.equal(f.store.data.tasks.length,count);
 assert.equal(f.store.task(f.send('@采购助理 请整理采购建议').taskIds[0]).roleId,'shopping');
});
test('real pause/resume retains child grant, deadline and task identity; paused siblings stay quiet',async t=>{
 const f=fixture(t),sourceId=f.send('@生活管家 打开设置查看电池').taskIds[0];f.store.updateTask(sourceId,t=>t.status='running');
 const first=f.groups.handoff(sourceId,{roleId:'work',prompt:'打开设置查看电池'}),second=f.groups.handoff(sourceId,{roleId:'shopping',prompt:'打开设置查看电池'});
 const deadline=f.store.task(first.taskId).deadlineAt,grant=structuredClone(f.store.task(first.taskId).delegationGrant),revision=f.store.task(sourceId).taskContract.revision;
 f.store.updateTask(first.taskId,t=>t.status='running');f.groups.reconcile();
 await f.groups.control(f.group.id,sourceId,'pause');assert.equal(f.store.task(first.taskId).status,'paused');assert.equal(f.store.task(second.taskId).status,'paused');
 const count=f.store.data.tasks.length,requestId=randomUUID();await f.groups.control(f.group.id,first.taskId,'resume',{clientRequestId:requestId});
 assert.equal(f.store.task(sourceId).status,'waiting_children');assert.equal(f.store.task(first.taskId).status,'queued');assert.equal(f.store.task(second.taskId).status,'paused');assert.equal(f.store.task(first.taskId).deadlineAt,deadline);assert.equal(f.store.task(sourceId).taskContract.revision,revision);assert.deepEqual(f.store.task(first.taskId).delegationGrant,grant);assert.equal(validateTaskContract(f.store.task(first.taskId),{store:f.store}).valid,true);
 assert.equal((await f.groups.control(f.group.id,first.taskId,'resume',{clientRequestId:requestId})).deduplicated,true);assert.equal(f.store.data.tasks.length,count);
 f.store.updateTask(first.taskId,t=>t.status='running');f.groups.reconcile();assert.deepEqual(f.groups.detail(f.group.id).receipts.filter(r=>r.taskId===first.taskId).map(r=>r.state),['queued','accepted','paused','resuming','resumed']);
});
test('expired and unknown handoffs never become queued; rejection keeps original status',async t=>{
 const f=fixture(t),id=f.send('@生活管家 打开设置查看电池').taskIds[0];f.store.updateTask(id,t=>{t.status='paused';t.deadlineAt=t.timeline.deadlineAt=new Date(0).toISOString();});
 await assert.rejects(f.groups.control(f.group.id,id,'resume'));assert.equal(f.store.task(id).status,'paused');
 f.store.updateTask(id,t=>t.status='unknown_result');await assert.rejects(f.groups.control(f.group.id,id,'resume'));assert.equal(f.store.task(id).status,'unknown_result');
});
test('same-message peers share the mutation lock, and a fresh group intent is independent',async t=>{
 const f=fixture(t),message=f.send('@生活管家 @工作伙伴 打开设置查看电池'),[a,b]=message.taskIds,next=f.send('@生活管家 打开计算器').taskIds[0];
 await withCollaborationMutation(f.store,a,async()=>{await assert.rejects(withCollaborationMutation(f.store,b,async()=>{}),{code:'collaboration_action_busy'});await withCollaborationMutation(f.store,next,async()=>{});});
});
test('public blocked results and stable running receipts are truthful',t=>{
 const f=fixture(t),id=f.send('@生活管家 整理计划').taskIds[0];f.store.updateTask(id,t=>t.status='running');f.groups.reconcile();f.store.updateTask(id,t=>t.blockedReason='正在核对');f.groups.reconcile();assert.equal(f.groups.detail(f.group.id).receipts.at(-1).state,'accepted');
 f.store.updateTask(id,t=>{t.status='blocked';t.result='缺少日期，尚未创建日历提醒';});f.groups.reconcile();const detail=f.groups.detail(f.group.id);assert.equal(detail.receipts.at(-1).state,'blocked');assert.equal(detail.messages.at(-1).content,'缺少日期，尚未创建日历提醒');
});

test('Engine runs a group handoff through its scheduler and the worker uses the user\'s memory like a private chat',async t=>{
 const f=fixture(t),runs=[],prompts=[];let rootId,childId,rootPass=0,personalReads=0;
 f.store.transaction(s=>{s.settings.maxConcurrent=1;s.settings.memoryEnabled=true;s.roles.find(r=>r.id==='work').notes=[{text:'PRIVATE_WORK_NOTE_SENTINEL'}];});
 f.engine.memory.personal={context:async()=>{personalReads++;return {context:'PRIVATE_PERSONAL_CORE_SENTINEL'};}};
 f.engine.secrets.get=async()=> 'synthetic-no-cloud';
 f.engine.runFactory=options=>({async start(){
  runs.push(options.task.id);prompts.push(options.prompt);
  if(options.task.id===rootId&&++rootPass===1){
   childId=parse(await f.broker.execute(rootId,'group_handoff',{roleId:'work',prompt:'整理交班收到的资料',context:'已查到的公开结果：甲方案需要两步'})).taskId;
   await f.broker.execute(rootId,'delegation_status',{wait:true});return;
  }
  f.store.updateTask(options.task.id,row=>{row.report={outcome:'completed',summary:options.task.id===rootId?'已核对专职返回的结果（合成测试）':'收到资料并整理完成（合成测试）',evidence:[]};});f.engine.finishReport(options.task.id);
 },async stop(){},async dispose(){}});
 rootId=f.send('@生活管家 整理资料并交班给工作伙伴',{memoryConsent:true,memoryMode:'default'}).taskIds[0];
 assert.equal(f.store.task(rootId).memoryConsent,true);assert.equal(f.store.task(rootId).memoryMode,'default');
 for(let i=0;i<100&&f.store.task(rootId).status!=='completed';i++){await Engine.prototype.pump.call(f.engine);await new Promise(resolve=>setImmediate(resolve));}
 assert.equal(f.store.task(rootId).status,'completed');assert.equal(f.store.task(childId).status,'completed');assert.deepEqual(runs,[rootId,childId,rootId]);
 assert.match(prompts[1],/已查到的公开结果：甲方案需要两步/);
 assert.ok(personalReads>0);assert.ok(prompts.some(prompt=>prompt.includes('PRIVATE_PERSONAL_CORE_SENTINEL')));assert.equal(f.store.task(childId).memoryConsent,true);assert.equal(f.store.task(childId).memoryMode,'default');
 const detail=f.groups.detail(f.group.id);assert.ok(detail.receipts.some(r=>r.taskId===childId&&r.state==='accepted'));assert.ok(detail.receipts.some(r=>r.taskId===childId&&r.state==='completed'));assert.equal(detail.messages.filter(m=>m.kind==='assistant'&&m.taskId===childId).length,1);
});

test('explicit private conversation memory consent still supplies Personal Core context',async t=>{
 const f=fixture(t),prompts=[];let personalReads=0;
 f.engine.secrets.get=async()=> 'synthetic-no-cloud';f.engine.memory.personal={context:async()=>{personalReads++;return {context:'PRIVATE_OPT_IN_CONTEXT'};}};
 f.engine.runFactory=options=>({async start(){prompts.push(options.prompt);f.store.updateTask(options.task.id,row=>{row.report={outcome:'completed',summary:'合成私聊完成',evidence:[]};});f.engine.finishReport(options.task.id);},async stop(){},async dispose(){}});
 const task=f.engine.create({prompt:'整理我的私人计划',cloudConsent:true,memoryConsent:true});
 for(let i=0;i<100&&f.store.task(task.id).status!=='completed';i++){await Engine.prototype.pump.call(f.engine);await new Promise(resolve=>setImmediate(resolve));}
 assert.equal(f.store.task(task.id).status,'completed');assert.equal(personalReads,1);assert.ok(prompts[0].includes('PRIVATE_OPT_IN_CONTEXT'));
});

test('one model task can hand off the same goal in two groups without mixing tasks, context or receipts',async t=>{
 const f=fixture(t),root=f.engine.create({prompt:'建立两个资料群，分别让资料专职整理公开材料并交接结果。',cloudConsent:true});
 f.store.updateTask(root.id,t=>t.status='running');
 const call=async(name,args)=>parse(await f.broker.execute(root.id,name,args));
 const a=await call('group_create',{name:'资料甲组',memberRoleIds:['life','work']}),b=await call('group_create',{name:'资料乙组',memberRoleIds:['life','work']});
 const request={roleId:'work',prompt:'整理公开材料',context:'只整理本轮提供的公开信息'};
 const first=await call('group_handoff',{groupId:a.id,...request}),second=await call('group_handoff',{groupId:b.id,...request});
 assert.equal(second.groupId,b.id);assert.notEqual(second.taskId,first.taskId);
 assert.equal((await call('group_handoff',{groupId:a.id,...request})).taskId,first.taskId);
 assert.equal((await call('group_handoff',{groupId:b.id,...request})).taskId,second.taskId);
 const followup=await call('group_handoff',{groupId:b.id,...request,prompt:'核对公开材料来源'});
 assert.equal(followup.rootMessageId,second.rootMessageId);
 assert.notEqual(second.rootMessageId,first.rootMessageId);
 const context=await call('group_context',{groupId:b.id});assert.equal(context.groupId,b.id);
 assert.ok(context.receipts.every(r=>r.groupId===b.id));assert.ok(!context.messages.some(m=>m.id===first.messageId));
 const paused=await call('group_task',{taskId:second.taskId,action:'pause'});assert.equal(paused.status,'paused');
 assert.equal(f.store.task(first.taskId).status,'queued');
 const resumed=await call('group_task',{taskId:second.taskId,action:'resume'});assert.equal(resumed.status,'queued');
 assert.equal(f.store.data.groupHandoffs.length,3);
 f.store.updateTask(first.taskId,t=>t.status='running');
 await assert.rejects(f.broker.execute(first.taskId,'group_context',{groupId:b.id}),{code:'group_access_denied'});
 await assert.rejects(f.broker.execute(first.taskId,'group_handoff',{groupId:b.id,roleId:'life',prompt:'核对来源'}),{code:'group_handoff_not_authorized'});
 await assert.rejects(f.broker.execute(first.taskId,'group_task',{taskId:second.taskId,action:'pause'}),/当前任务不在这个群中/);
 assert.equal(f.store.task(second.taskId).status,'queued');
});

test('pause before first acceptance emits resuming, while normal handoff waiting never claims a resume',async t=>{
 const f=fixture(t),id=f.send('@生活管家 整理公开资料').taskIds[0];
 await f.groups.control(f.group.id,id,'pause');await f.groups.control(f.group.id,id,'resume');
 assert.equal(f.groups.detail(f.group.id).receipts.at(-1).state,'resuming');
 f.store.updateTask(id,t=>t.status='running');assert.equal(f.groups.detail(f.group.id).receipts.at(-1).state,'resumed');
 f.store.updateTask(id,t=>t.status='waiting_children');f.store.updateTask(id,t=>t.status='queued');
 assert.equal(f.groups.detail(f.group.id).receipts.at(-1).state,'queued');
 f.store.updateTask(id,t=>t.status='running');assert.equal(f.groups.detail(f.group.id).receipts.at(-1).state,'accepted');
});

test('running model can resume its own handoff without resetting the active parent or reviving a stopping worker',async t=>{
 const f=fixture(t),rootId=f.send('@生活管家 整理公开资料并交班给工作伙伴').taskIds[0];
 f.store.updateTask(rootId,t=>{t.status='running';t.blockedReason='正在统筹资料';});
 const handoff=parse(await f.broker.execute(rootId,'group_handoff',{roleId:'work',prompt:'整理公开资料'}));
 await f.broker.execute(rootId,'group_task',{taskId:handoff.taskId,action:'pause'});
 // Model tools execute while the source runtime still occupies an active slot.
 f.engine.active.set(rootId,{});f.engine.active.set(handoff.taskId,{});
 await assert.rejects(f.groups.control(f.group.id,handoff.taskId,'resume',{callerId:rootId}),{code:'still_stopping'});
 assert.equal(f.store.task(handoff.taskId).status,'paused');f.engine.active.delete(handoff.taskId);
 const before=structuredClone(f.store.task(rootId));
 const resumed=parse(await f.broker.execute(rootId,'group_task',{taskId:handoff.taskId,action:'resume'}));
 assert.equal(resumed.status,'queued');assert.equal(validateTaskContract(f.store.task(handoff.taskId),{store:f.store}).valid,true);
 assert.equal(f.store.task(rootId).status,before.status);assert.equal(f.store.task(rootId).blockedReason,before.blockedReason);
 assert.deepEqual(f.store.task(rootId).taskContract,before.taskContract);
 f.engine.active.delete(rootId);
});

test('follow-up in the creating conversation can manage and hand off to its group without exposing unrelated groups',async t=>{
 const f=fixture(t),root=f.engine.create({prompt:'建立一个资料协作群',cloudConsent:true});f.store.updateTask(root.id,t=>t.status='running');
 const group=parse(await f.broker.execute(root.id,'group_create',{name:'资料群',memberRoleIds:['life','work']}));f.store.updateTask(root.id,t=>t.status='completed');
 const follow=f.engine.create({prompt:'把采购助理也拉进刚才的群，让它整理资料',conversationId:root.conversationId,roleId:root.roleId,cloudConsent:true});f.store.updateTask(follow.id,t=>t.status='running');
 const context=parse(await f.broker.execute(follow.id,'group_context',{groupId:group.id}));assert.equal(context.groupId,group.id);
 const updated=parse(await f.broker.execute(follow.id,'group_members',{groupId:group.id,addRoleIds:['shopping']}));assert.equal(updated.members.length,3);
 const handed=parse(await f.broker.execute(follow.id,'group_handoff',{groupId:group.id,roleId:'shopping',prompt:'整理资料并给出结论'}));assert.equal(f.store.task(handed.taskId).parentId,follow.id);
 const outsider=f.engine.create({prompt:'查看另一个群',cloudConsent:true});f.store.updateTask(outsider.id,t=>t.status='running');
 await assert.rejects(f.broker.execute(outsider.id,'group_context',{groupId:group.id}),{code:'group_access_denied'});
});

test('member mutation receipt survives lost gateway response without undoing a later membership change',t=>{
 const f=fixture(t),group=f.groups.create({name:'成员回执',memberRoleIds:['life']}),request={messageId:randomUUID(),addRoleIds:['work']};
 f.groups.members(group.id,request);f.groups.members(group.id,{messageId:randomUUID(),removeRoleIds:['work']});
 const replay=f.groups.members(group.id,request);assert.equal(replay.deduplicated,true);assert.deepEqual(f.groups.detail(group.id).memberRoleIds,['life']);
 assert.throws(()=>f.groups.members(group.id,{...request,addRoleIds:['shopping']}),{code:'group_idempotency_conflict'});
});

test('resuming and its durable control receipt commit together or both remain unchanged',async t=>{
 const f=fixture(t),id=f.send('@生活管家 整理资料').taskIds[0];await f.groups.control(f.group.id,id,'pause');
 const original=f.store.persist.bind(f.store),request=randomUUID();let fail=true;
 f.store.persist=()=>{if(fail&&f.store.data.groupControls?.some(r=>r.requestKey==='local:'+request)){fail=false;throw Error('synthetic write failure');}return original();};
 await assert.rejects(f.groups.control(f.group.id,id,'resume',{clientRequestId:request}),/synthetic write failure/);
 assert.equal(f.store.task(id).status,'paused');assert.equal(f.store.data.groupControls.some(r=>r.requestKey==='local:'+request),false);
 const resumed=await f.groups.control(f.group.id,id,'resume',{clientRequestId:request});assert.equal(resumed.status,'queued');
});

test('new and follow-up conversations infer their only group; multiple groups require explicit selection',async t=>{
 const f=fixture(t),root=f.engine.create({prompt:'建立资料群并让工作伙伴整理资料',cloudConsent:true});f.store.updateTask(root.id,t=>t.status='running');
 const call=async(name,args={})=>parse(await f.broker.execute(root.id,name,args));
 const a=await call('group_create',{name:'资料甲组',memberRoleIds:['life','work']});
 assert.equal((await call('group_context')).groupId,a.id);
 const handed=await call('group_handoff',{roleId:'work',prompt:'整理公开资料'});assert.equal(handed.groupId,a.id);
 const follow=f.engine.create({prompt:'查看刚才群里的进度',conversationId:root.conversationId,roleId:root.roleId,cloudConsent:true});f.store.updateTask(follow.id,t=>t.status='running');
 assert.equal(parse(await f.broker.execute(follow.id,'group_context',{})).groupId,a.id);
 const b=await call('group_create',{name:'资料乙组',memberRoleIds:['life','work']});
 const count=f.store.data.tasks.length;
 await assert.rejects(call('group_context'),{code:'group_selection_required'});
 await assert.rejects(call('group_handoff',{roleId:'work',prompt:'继续整理公开资料'}),{code:'group_selection_required'});
 assert.equal(f.store.data.tasks.length,count);
 assert.equal((await call('group_context',{groupId:b.id})).groupId,b.id);
 f.store.updateTask(handed.taskId,t=>t.status='running');
 assert.equal(parse(await f.broker.execute(handed.taskId,'group_context',{})).groupId,a.id);
});

test('resuming a paused parent preserves the resume receipt while its handoff finishes',async t=>{
 const f=fixture(t),id=f.send('@生活管家 整理公开资料并交班').taskIds[0];f.store.updateTask(id,t=>t.status='running');
 const child=f.groups.handoff(id,{roleId:'work',prompt:'整理公开资料'});
 await f.groups.control(f.group.id,id,'pause');await f.groups.control(f.group.id,child.taskId,'resume');
 assert.equal(f.store.task(id).status,'waiting_children');
 assert.equal(f.groups.detail(f.group.id).receipts.filter(r=>r.taskId===id).at(-1).state,'waiting_handoff');
 f.store.updateTask(child.taskId,t=>{t.status='completed';t.result='公开资料已整理（合成）';});
 f.store.updateTask(id,t=>t.status='queued');
 assert.equal(f.groups.detail(f.group.id).receipts.filter(r=>r.taskId===id).at(-1).state,'resuming');
 f.store.updateTask(id,t=>t.status='running');
 assert.equal(f.groups.detail(f.group.id).receipts.filter(r=>r.taskId===id).at(-1).state,'resumed');
 f.store.updateTask(id,t=>t.status='waiting_children');f.store.updateTask(id,t=>t.status='queued');f.store.updateTask(id,t=>t.status='running');
 assert.equal(f.groups.detail(f.group.id).receipts.filter(r=>r.taskId===id).at(-1).state,'accepted');
});

test('a resumed read-only group review publishes its real final answer without requiring a redundant finish call',async t=>{
 const f=fixture(t);let rootId,childId,rootPass=0;
 f.engine.secrets.get=async()=> 'synthetic-no-cloud';
 f.engine.runFactory=options=>({async start(){
  if(options.task.id===rootId){
   if(++rootPass===1){childId=parse(await f.broker.execute(rootId,'group_handoff',{roleId:'work',prompt:'独立检查方案中的时间分配',context:'总共 30 分钟，其中至少留 3 分钟缓冲'})).taskId;await f.broker.execute(rootId,'delegation_status',{wait:true});return;}
   f.store.updateTask(rootId,row=>row.messages.push({id:randomUUID(),role:'assistant',content:'核对独立评审后，建议内容 27 分钟、缓冲 3 分钟，总计 30 分钟。主持人负责讲解，操作员负责演示。',at:new Date().toISOString()}));return;
  }
  f.store.updateTask(childId,row=>{row.report={outcome:'completed',summary:'独立评审完成：内容最多 27 分钟。',evidence:[]};});f.engine.finishReport(childId);
 },async stop(){},async dispose(){}});
 rootId=f.send('@生活管家 请独立评审时间分配后给出综合建议，不修改日程').taskIds[0];
 for(let i=0;i<120&&f.store.task(rootId).status!=='completed';i++){await Engine.prototype.pump.call(f.engine);await new Promise(resolve=>setImmediate(resolve));}
 assert.equal(f.store.task(rootId).status,'completed');assert.equal(f.store.task(childId).status,'completed');
 f.groups.reconcile();const answers=f.groups.detail(f.group.id).messages.filter(m=>m.kind==='assistant'&&m.taskId===rootId);assert.equal(answers.length,1);assert.match(answers[0].content,/27 分钟/);
});
