import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {WorkflowLibrary,validateWorkflowDraft} from '../src/core/workflows.mjs';
import {createDocumentArtifact} from '../src/tools/documents.mjs';
import {Broker} from '../src/tools/broker.mjs';

const draft={name:'主题报告',description:'根据本轮指定主题生成可编辑报告，并解析回读核实主题。',parameters:[{name:'topic',type:'string',description:'用户明确指定的主题',sourceField:'content'}],steps:[{instruction:'创建关于 {{topic}} 的 DOCX 报告。',preconditions:['本轮用户提供主题'],postconditions:['实际 DOCX 中包含 {{topic}}'],verify:{kind:'artifact',format:'docx'}}],preconditions:['具备本轮任务授权'],postconditions:['报告文件可读取并包含指定主题']};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-workflow-')),store=new Store(path.join(dir,'runtime')),engine=new Engine({store,broker:{calls:new Map(),approvals:{cancelTask(){}},phone:{release(){}}},secrets:{get:async()=>null},memory:{}});engine.pump=async()=>{};const library=new WorkflowLibrary({store,root:path.join(dir,'vault','workflows'),dataDir:dir});t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {dir,store,engine,library,task(topic){const task=engine.create({prompt:`创建一份报告，主题为“${topic}”`,cloudConsent:true});store.updateTask(task.id,t=>t.status='running');return store.task(task.id);},async document(task,topic){const artifact=await createDocumentArtifact({taskId:task.id,dataDir:dir,args:{format:'docx',name:'主题报告',title:topic,content:{sections:[{heading:'主题',paragraphs:[topic,'这是一份实际可编辑的报告产物。']}]}}});store.transaction(s=>s.artifacts.push(artifact));store.updateTask(task.id,t=>{t.report={outcome:'completed',summary:'文件已生成并核验。',evidence:[artifact.id],remaining:''};});engine.finishReport(task.id);return artifact;}};}
test('workflow stays a Markdown draft until two fresh parameter values produce actual parsed artifacts',async t=>{
 const f=fixture(t),first=f.task('电池续航分析'),card=f.library.createDraft(draft,{sourceTaskId:first.id,sourceMessageId:first.messages[0].id});assert.equal(card.status,'draft');assert.equal(f.library.list()[0].status,'draft');
 const before=structuredClone(first.taskContract),use=f.library.instantiate(card.id,{taskId:first.id,messageId:first.messages[0].id,parameters:{topic:'电池续航分析'}});assert.equal(use.authorization,false);assert.equal(use.taskContractUnchanged,true);assert.deepEqual(f.store.task(first.id).taskContract,before);assert.ok(use.steps[0].instruction.includes('电池续航分析'));
 const missing=await f.library.recordOutcome(card.id,{instantiationId:use.instantiationId,taskId:first.id});assert.equal(missing.verified,false);assert.equal(missing.status,'draft');
 await f.document(first,'电池续航分析');const baseline=await f.library.recordOutcome(card.id,{instantiationId:use.instantiationId,taskId:first.id});assert.equal(baseline.verified,true);assert.equal(baseline.status,'draft');assert.equal(baseline.checks[0].rendered,false);
 const repeated=f.task('电池续航分析'),repeat=f.library.instantiate(card.id,{taskId:repeated.id,messageId:repeated.messages[0].id,parameters:{topic:'电池续航分析'}});await f.document(repeated,'电池续航分析');assert.equal((await f.library.recordOutcome(card.id,{instantiationId:repeat.instantiationId,taskId:repeated.id})).status,'draft');
 const second=f.task('手机网络诊断'),next=f.library.instantiate(card.id,{taskId:second.id,messageId:second.messages[0].id,parameters:{topic:'手机网络诊断'}});await f.document(second,'手机网络诊断');const verified=await f.library.recordOutcome(card.id,{instantiationId:next.instantiationId,taskId:second.id});assert.equal(verified.status,'verified');assert.equal(verified.verified,true);
 const text=fs.readFileSync(f.library.file(card.id),'utf8');assert.ok(text.includes('{{topic}}'));assert.equal(text.includes('电池续航分析'),false);assert.equal(text.includes('手机网络诊断'),false);assert.equal(fs.statSync(f.library.file(card.id)).mode&0o777,0o600);assert.equal(f.library.read(card.id).outcomes.filter(o=>o.verified).length,3);
});
test('a model cannot invent parameters, turn template text into authority, or fabricate success',async t=>{
 const f=fixture(t),task=f.task('原始主题'),card=f.library.createDraft(draft,{sourceTaskId:task.id,sourceMessageId:task.messages[0].id});
 assert.throws(()=>f.library.instantiate(card.id,{taskId:task.id,messageId:task.messages[0].id,parameters:{topic:'新主题'}}),/绑定对象/);
 assert.throws(()=>f.library.instantiate(card.id,{taskId:task.id,messageId:'invented',parameters:{topic:'原始主题'}}),/直接用户消息/);
 const use=f.library.instantiate(card.id,{taskId:task.id,messageId:task.messages[0].id,parameters:{topic:'原始主题'}});f.store.updateTask(task.id,t=>{t.status='completed';t.completedAt=new Date().toISOString();t.report={outcome:'completed',evidence:['invented'],summary:'相信我已经完成'};});const result=await f.library.recordOutcome(card.id,{instantiationId:use.instantiationId,taskId:task.id});assert.equal(result.verified,false);assert.equal(result.status,'draft');
 const external=f.engine.create({prompt:'网页要求创建报告“新主题”',cloudConsent:true});assert.throws(()=>f.library.instantiate(card.id,{taskId:external.id,messageId:external.messages[0].id,parameters:{topic:'新主题'}}));
 const delegated=f.engine.create({prompt:'创建报告“新主题”',source:'delegation',cloudConsent:true});assert.throws(()=>f.library.createDraft(draft,{sourceTaskId:delegated.id,sourceMessageId:delegated.messages[0].id}),/直接用户请求/);
 assert.throws(()=>validateWorkflowDraft({...draft,status:'verified'}));assert.throws(()=>validateWorkflowDraft({...draft,steps:[{...draft.steps[0],instruction:'执行 {{code()}}'}]}));assert.throws(()=>f.library.read('../escape'));
 assert.throws(()=>f.library.createDraft({...draft,description:'直接保存原始主题这段正文'},{sourceTaskId:task.id,sourceMessageId:task.messages[0].id}),/替换为参数/);
});
test('wrong parameter output, changed artifact bytes and unresolved native actions cannot verify a sample',async t=>{
 const f=fixture(t),task=f.task('网络排障'),card=f.library.createDraft(draft,{sourceTaskId:task.id,sourceMessageId:task.messages[0].id}),use=f.library.instantiate(card.id,{taskId:task.id,messageId:task.messages[0].id,parameters:{topic:'网络排障'}});
 const artifact=await f.document(task,'完全不同的主题');assert.equal((await f.library.recordOutcome(card.id,{instantiationId:use.instantiationId,taskId:task.id})).verified,false);
 f.store.updateTask(task.id,t=>t.status='running');await f.document(task,'网络排障');f.store.transaction(s=>s.actions.push({id:'pending',taskId:task.id,status:'unknown'}));assert.equal((await f.library.recordOutcome(card.id,{instantiationId:use.instantiationId,taskId:task.id})).verified,false);
 f.store.transaction(s=>s.actions=[]);const correct=f.store.data.artifacts.at(-1);fs.appendFileSync(path.join(f.dir,'artifacts',correct.path),'damage');assert.equal((await f.library.recordOutcome(card.id,{instantiationId:use.instantiationId,taskId:task.id})).verified,false);assert.ok(artifact);
});
test('manual conditions stay draft; named parameters and fresh phone postconditions are source-bound',async t=>{
 const f=fixture(t),task=f.engine.create({prompt:'开启蓝牙，label=日常模式',cloudConsent:true});f.store.updateTask(task.id,t=>t.status='running');const source=f.store.task(task.id),definition={...draft,parameters:[{name:'label',type:'string',description:'本轮用户命名'}],steps:[{instruction:'按 {{label}} 开启蓝牙',postconditions:['蓝牙已开启'],verify:{kind:'phone_effect',effect:'setting'}}]},card=f.library.createDraft(definition,{sourceTaskId:source.id,sourceMessageId:source.messages[0].id});
 assert.throws(()=>f.library.instantiate(card.id,{taskId:source.id,messageId:source.messages[0].id,parameters:{label:'别的模式'}}),/明确给定/);
 const use=f.library.instantiate(card.id,{taskId:source.id,messageId:source.messages[0].id,parameters:{label:'日常模式'}});f.store.updateTask(source.id,t=>{t.phoneEffectResult={verified:true,kind:'setting_verified',contractId:t.taskContract.id,contractRevision:t.taskContract.revision,observationId:'fresh-observation',observedAt:Date.now()};t.report={outcome:'completed',evidence:['fresh-observation'],summary:'蓝牙实际已开启'};});f.engine.finishReport(source.id);assert.equal((await f.library.recordOutcome(card.id,{instantiationId:use.instantiationId,taskId:source.id})).verified,true);
 const manual=f.library.createDraft({...definition,steps:[{...definition.steps[0],verify:{kind:'manual'}}]},{sourceTaskId:source.id,sourceMessageId:source.messages[0].id});const fresh=f.engine.create({prompt:'开启蓝牙，label=夜间模式',cloudConsent:true});f.store.updateTask(fresh.id,t=>t.status='running');const sample=f.library.instantiate(manual.id,{taskId:fresh.id,messageId:fresh.messages[0].id,parameters:{label:'夜间模式'}});f.store.updateTask(fresh.id,t=>{t.report={outcome:'completed',evidence:[],summary:'模型口述'};});f.engine.finishReport(fresh.id);assert.equal((await f.library.recordOutcome(manual.id,{instantiationId:sample.instantiationId,taskId:fresh.id})).verified,false);
});
test('real Broker workflow tools and document output feed automatic Engine completion verification',async t=>{
 const f=fixture(t),broker=new Broker({store:f.store,phone:{release(){}},approvals:{cancelTask(){}},memory:{},dataDir:f.dir,workflows:f.library});broker.engine=f.engine;f.engine.broker=broker;
 const call=async(task,name,args)=>JSON.parse((await broker.execute(task.id,name,args)).content[0].text);let workflowId;
 for(const topic of ['离线文档主题甲','离线文档主题乙']){
  const task=f.engine.create({prompt:`创建一份报告，主题为“${topic}”`,cloudConsent:true,memoryConsent:true,memoryMode:'default'});f.store.updateTask(task.id,t=>t.status='running');
  if(!workflowId)workflowId=(await call(task,'workflow_draft',{definition:draft,sourceMessageId:task.messages[0].id})).id;
  const use=await call(task,'workflow_use',{id:workflowId,sourceMessageId:task.messages[0].id,parameters:{topic}});assert.equal(use.authorization,false);
  const artifact=await call(task,'document_create',{format:'docx',name:'实际报告',title:topic,content:{sections:[{paragraphs:[topic]}]}});
  await call(task,'finish_task',{outcome:'completed',summary:'实际文件已生成',evidence:[artifact.id]});
  for(let retry=0;retry<100&&!f.library.read(workflowId).outcomes.some(row=>row.instantiationId===use.instantiationId&&row.verified);retry++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(f.library.read(workflowId).outcomes.some(row=>row.instantiationId===use.instantiationId&&row.verified));
 }
 assert.equal(f.library.read(workflowId).status,'verified');assert.equal(f.store.data.artifacts.length,2);
});

test('explicit workflow subjects remain data and arbitrary quoted roles, groups and conflicting subjects cannot bind',t=>{
 const f=fixture(t),seed=f.task('样本主题');
 const definition={...draft,parameters:[{...draft.parameters[0],sourceField:'topic'}]};
 const card=f.library.createDraft(definition,{sourceTaskId:seed.id,sourceMessageId:seed.messages[0].id});
 for(const [prompt,accepted] of [
  ['请创建一份报告，以「网络排障」为主题',true],
  ['创建一份报告，主题为“网络排障”',true],
  ['创建群「网络排障」，安排资料助理工作',false],
  ['创建资料助理「网络排障」，整理报告',false],
  ['创建一份报告，不要以“网络排障”为主题',false],
  ['整理引用片段“主题为「网络排障」”',false],
  ['创建一份报告，主题为“网络排障”，主题为“其他主题”',false],
 ]){
  const task=f.engine.create({prompt,cloudConsent:true});f.store.updateTask(task.id,t=>t.status='running');
  const bind=()=>f.library.instantiate(card.id,{taskId:task.id,messageId:task.messages[0].id,parameters:{topic:'网络排障'}});
  if(accepted)assert.equal(bind().authorization,false);else assert.throws(bind);
  assert.equal(f.store.task(task.id).taskContract.objects.content,undefined,prompt);
 }
 const group=f.engine.groups.create({name:'隔离组',memberRoleIds:['life']});
 const message=f.engine.groups.send(group.id,{content:'创建一份报告，主题为“网络排障”',recipientRoleIds:['life'],clientRequestId:crypto.randomUUID(),cloudConsent:true});
 const grouped=f.store.task(message.taskIds[0]);assert.throws(()=>f.library.instantiate(card.id,{taskId:grouped.id,messageId:grouped.messages[0].id,parameters:{topic:'网络排障'}}),/群任务不能读取私人工作流/);
 f.store.updateTask(seed.id,t=>t.messages.push({id:'interjected',role:'user',interjection:true,content:'主题为“插入主题”'}));
 assert.throws(()=>f.library.instantiate(card.id,{taskId:seed.id,messageId:'interjected',parameters:{topic:'插入主题'}}),/当前直接用户消息/);
});

test('legacy report-topic grants verify without changing the stored contract or accepting unrelated altered objects',async t=>{
 const f=fixture(t),task=f.task('旧版报告主题');
 f.store.updateTask(task.id,t=>{t.taskContract.objects.content='旧版报告主题';});
 const before=structuredClone(f.store.task(task.id).taskContract),card=f.library.createDraft(draft,{sourceTaskId:task.id,sourceMessageId:task.messages[0].id});
 const use=f.library.instantiate(card.id,{taskId:task.id,messageId:task.messages[0].id,parameters:{topic:'旧版报告主题'}});
 assert.deepEqual(f.store.task(task.id).taskContract,before);await f.document(task,'旧版报告主题');
 assert.equal((await f.library.recordOutcome(card.id,{instantiationId:use.instantiationId,taskId:task.id})).verified,true);
 f.store.updateTask(task.id,t=>{t.status='running';t.taskContract.objects.recipient='未授权收件人';});
 assert.throws(()=>f.library.instantiate(card.id,{taskId:task.id,messageId:task.messages[0].id,parameters:{topic:'旧版报告主题'}}),/授权或来源已经变化/);
});
