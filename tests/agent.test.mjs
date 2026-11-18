import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {Approvals} from '../src/core/approvals.mjs';
import {normalizeQuote,compareQuotes} from '../src/core/compare.mjs';
import {createRoutine,updateRoutine,nextDaily,Scheduler} from '../src/core/scheduler.mjs';
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pa-agent-test-'));const store=new Store(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});const approvals=new Approvals(store);const broker={approvals,phone:{release(){},close(){}},browser:{close(){}},calls:new Map()};const engine=new Engine({store,broker,secrets:{get:async()=>''},memory:{observe:async()=>{}}});engine.pump=async()=>{};return {store,engine,dir,approvals};}
function quote(platform,overrides={}){return normalizeQuote({platform,item:'同款餐品',spec:'标准',merchant:'门店 A',quantity:1,itemsFen:2000,packagingFen:100,deliveryFen:200,serviceFen:0,discountFen:300,paidBenefitFen:0,observedAt:new Date().toISOString(),evidence:'test-only-evidence',final:true,addressLabel:'测试位置',...overrides});}
test('replying to a local reminder becomes a conversation and respects cloud consent',async t=>{const {store,engine}=setup(t);const task=engine.create({prompt:'Synthetic reminder',kind:'reminder'});store.updateTask(task.id,t=>{t.status='completed';});const next=await engine.message(task.id,{message:'Help me with this',clientRequestId:randomUUID(),cloudConsent:false});assert.notEqual(next.id,task.id);assert.equal(next.kind,'general');assert.equal(next.status,'waiting_consent');assert.equal(store.task(task.id).status,'completed');});
test('quote arithmetic includes fees and paid benefits; food requires same branch; shopping can compare merchants',()=>{const a=quote('meituan',{paidBenefitFen:500});assert.equal(a.totalFen,2500);const b=quote('taobao',{merchant:'门店 B'});assert.ok(compareQuotes([a,b],{kind:'food'}).every(g=>!g.comparable));assert.equal(compareQuotes([a,b],{kind:'shopping'})[0].comparable,true);assert.equal(compareQuotes([a,quote('taobao')],{kind:'food'})[0].comparable,true);assert.equal(compareQuotes([a,quote('taobao',{observedAt:new Date(Date.now()-700000).toISOString()})],{kind:'food'})[0].comparable,false);});
test('new and follow-up messages are idempotent, results retained in history and turn state cleared',async t=>{const {store,engine}=setup(t);const clientRequestId=randomUUID();const input={prompt:'Synthetic request',clientRequestId};const task=engine.create(input);assert.equal(engine.create(input).id,task.id);assert.equal(store.data.tasks.length,1);assert.throws(()=>engine.create({...input,prompt:'different'}));store.updateTask(task.id,t=>{t.status='completed';t.result='Old result';t.messages.push({id:randomUUID(),role:'assistant',content:'Old result'});t.quotes=[quote('taobao')];});const id=randomUUID();const next=await engine.message(task.id,{message:'Follow up',clientRequestId:id,cloudConsent:false});assert.equal((await engine.message(task.id,{message:'Follow up',clientRequestId:id,cloudConsent:false})).id,next.id);const row=store.task(next.id);assert.equal(row.messages.filter(m=>m.content==='Follow up').length,1);assert.equal(store.task(task.id).messages.filter(m=>m.content==='Old result').length,1);assert.equal(store.task(task.id).result,'Old result');assert.equal(row.result,null);assert.deepEqual(row.quotes,[]);assert.equal(row.status,'waiting_consent');});
test('restart preserves unknown effects and expires approval instead of replaying a transaction',t=>{const {store,engine,dir}=setup(t);const task=engine.create({prompt:'Synthetic transaction'});store.transaction(s=>{s.tasks[0].status='running';s.actions.push({id:'effect',taskId:task.id,status:'executing'});s.approvals.push({id:'approval',status:'pending'});});store.close();const reopened=new Store(dir);try{assert.equal(reopened.task(task.id).status,'unknown_result');assert.equal(reopened.data.actions[0].status,'unknown');assert.equal(reopened.data.approvals[0].status,'expired');}finally{reopened.close();}});
test('stop preserves unknown effects while a new conversation message cannot resolve them',async t=>{const {store,engine}=setup(t);const task=engine.create({prompt:'Synthetic task'});store.transaction(s=>s.actions.push({id:'effect',taskId:task.id,status:'executing'}));await engine.stop(task.id);assert.equal(store.task(task.id).status,'unknown_result');const next=await engine.message(task.id,{message:'retry',clientRequestId:randomUUID()});assert.notEqual(next.id,task.id);assert.equal(store.task(task.id).status,'unknown_result');await engine.reconcile(task.id,'Test fixture: operation did not occur');assert.equal(store.task(task.id).status,'unknown_result');assert.equal(store.data.actions[0].status,'unknown');assert.equal(store.data.actions[0].resolution,undefined);});
test('approval is bound to the exact operation, denial is final and cannot be reused',async t=>{const {store,engine,approvals}=setup(t);const task=engine.create({prompt:'Synthetic action'});const promise=approvals.request(task.id,{tool:'browser_action',args:{index:2,action:'click'},summary:'Test click',evidence:'synthetic'});const a=store.data.approvals.at(-1);assert.equal(a.args.index,2);assert.ok(a.fingerprint);approvals.resolve(a.id,false);await assert.rejects(promise,{code:'not_approved'});assert.throws(()=>approvals.resolve(a.id,true),{code:'approval_expired'});});
test('editing routine time changes next trigger; re-enabling skips missed daily slots; one slot creates one task',t=>{const {store,engine}=setup(t);const r=createRoutine({name:'Test reminder',prompt:'Synthetic reminder',kind:'daily',time:'09:00'});r.taskKind='reminder';const updated=updateRoutine(r,{time:'18:45'});assert.equal(updated.nextAt,nextDaily('18:45'));assert.notEqual(updated.nextAt,r.nextAt);const slot=new Date(Date.now()-1000).toISOString();updated.nextAt=slot;store.transaction(s=>s.routines.push(updated));const scheduler=new Scheduler(store,engine);scheduler.tick();scheduler.tick();assert.equal(store.data.tasks.length,1);assert.equal(store.data.tasks[0].kind,'reminder');const paused={...updated,enabled:false};assert.ok(Date.parse(updateRoutine(paused,{enabled:true}).nextAt)>Date.now());assert.throws(()=>updateRoutine({...r,kind:'once',nextAt:slot},{enabled:true}));});

test('blocking repeated tool validation failures stops the run without overwriting unknown effects',t=>{
  const {store,engine}=setup(t);const task=engine.create({prompt:'Synthetic tool failure',cloudConsent:true});
  store.updateTask(task.id,t=>{t.status='running';});let stopped=false;const controller=new AbortController();
  engine.active.set(task.id,{controller,run:{stop:async()=>{stopped=true;}}});
  engine.blockToolFailure(task.id,'Synthetic validation error');
  assert.equal(store.task(task.id).status,'blocked');assert.equal(controller.signal.aborted,true);assert.equal(stopped,true);
  store.updateTask(task.id,t=>{t.status='unknown_result';});engine.blockToolFailure(task.id,'Do not overwrite');assert.equal(store.task(task.id).status,'unknown_result');
});

test('query authority is user-scoped and cleared on unrelated continuation or delegation',async t=>{
 const {store,engine}=setup(t);const grant={platform:'taobao',query:'冰美式'};
 const task=engine.create({prompt:'查淘宝冰美式',phoneQuery:grant});assert.deepEqual(store.task(task.id).phoneQuery,grant);
 const child=engine.create({prompt:'Synthetic delegated task',source:'delegation',phoneQuery:grant});assert.equal(child.phoneQuery,null);
 await engine.continue(task.id,{message:'Another request'});assert.equal(store.task(task.id).phoneQuery,null);
 await engine.continue(task.id,{message:'查询冰美式',phoneQuery:grant});assert.deepEqual(store.task(task.id).phoneQuery,grant);
});

test('ready for user is a terminal handoff preserved by stop and cleared by a new request',async t=>{
 const {store,engine}=setup(t);const task=engine.create({prompt:'Synthetic handoff'});store.updateTask(task.id,row=>{row.status='running';row.report={outcome:'ready_for_user',summary:'Prepared only',evidence:[]};row.checkout={totalFen:100};});
 engine.readyForUser(task.id);assert.equal(store.task(task.id).status,'ready_for_user');assert.equal(store.task(task.id).result,'Prepared only');await engine.stop(task.id);assert.equal(store.task(task.id).status,'ready_for_user');
 await engine.continue(task.id,{message:'Different task'});assert.equal(store.task(task.id).checkout,null);assert.equal(store.task(task.id).phoneQuery,null);
});

test('meal routing and handoff intent are derived from the latest human request only',async t=>{
 const {store,engine}=setup(t);const prompt='在淘宝闪购帮我点一份牛肉面，到结算页我自己付款';const task=engine.create({prompt});assert.deepEqual(task.phoneQuery,{platform:'taobao',query:'牛肉面'});
 const child=engine.create({prompt,source:'delegation'});assert.equal(child.phoneQuery,null);
 await engine.continue(task.id,{message:'在淘宝闪购帮我点两份黄焖鸡米饭，到结算页'});assert.equal(store.task(task.id).phoneQuery.query,'黄焖鸡米饭');
 await engine.continue(task.id,{message:'另一个话题'});assert.equal(store.task(task.id).phoneQuery,null);
});

test('per-run execution deadline is bounded user input and does not silently carry to unrelated work',async t=>{
 const {store,engine}=setup(t);const task=engine.create({prompt:'Synthetic deadline',maxRunSeconds:60});assert.equal(task.maxRunSeconds,60);
 for(const maxRunSeconds of [0,9,1201,'60',60.5])assert.throws(()=>engine.create({prompt:'Invalid deadline',maxRunSeconds}));
 await engine.continue(task.id,{message:'Same test',maxRunSeconds:60});assert.equal(store.task(task.id).maxRunSeconds,60);
 await assert.rejects(engine.continue(task.id,{message:'Bad deadline',maxRunSeconds:1}));
 await engine.continue(task.id,{message:'Unrelated task'});assert.equal(store.task(task.id).maxRunSeconds,null);
});

test('new input is not special-cased by length and follow-up context exposes the current human goal',async t=>{
 const {store,engine}=setup(t);const task=engine.create({prompt:'1',cloudConsent:true});assert.equal(task.status,'queued');assert.equal(task.messages.filter(m=>m.role==='assistant').length,0);
 await engine.continue(task.id,{message:'帮我点一份牛肉面'});assert.equal(store.task(task.id).messages[0].content,'1');assert.equal(store.task(task.id).phoneQuery.query,'牛肉面');assert.ok(store.task(task.id).title.includes('牛肉面'));
});

test('current ordinary meal correction creates a fresh query and unrelated continuation clears it',async t=>{
 const {store,engine}=setup(t);const task=engine.create({prompt:'帮我点牛肉面',cloudConsent:true});
 await engine.continue(task.id,{message:'这次是猪脚饭'});assert.equal(store.task(task.id).phoneQuery.query,'猪脚饭');
 await engine.continue(task.id,{message:'聊点别的'});assert.equal(store.task(task.id).phoneQuery,null);
 await engine.continue(task.id,{message:'换成牛肉面'});assert.equal(store.task(task.id).phoneQuery,null);
});

test('ordinary finish freezes the current run and suppresses a redundant final model roundtrip',t=>{
 const {store,engine}=setup(t);for(const outcome of ['completed','blocked']){
  const task=engine.create({prompt:'Synthetic ordinary result',cloudConsent:true});store.updateTask(task.id,row=>{row.status='running';row.report={outcome,summary:'Current answer',remaining:'One actual missing item'};});
  const controller=new AbortController();let stopped=0;engine.active.set(task.id,{controller,run:{stop:async()=>{stopped++;}}});engine.finishReport(task.id);
  assert.equal(store.task(task.id).status,outcome);assert.equal(controller.signal.aborted,true);assert.equal(stopped,1);
  const before=store.task(task.id).messages.length;engine.onEvent(task.id,{type:'assistant/message',data:{content:[{type:'text',text:'Redundant follow-up'}]}});assert.equal(store.task(task.id).messages.length,before);
 }
});

test('ordinary meal requests and meal corrections default to a 60 second run without a UI control',async t=>{
 const {store,engine}=setup(t);const task=engine.create({prompt:'帮我点牛肉面',cloudConsent:true});assert.equal(task.maxRunSeconds,300);
 await engine.continue(task.id,{message:'这次是猪脚饭'});assert.equal(store.task(task.id).maxRunSeconds,300);
 await engine.continue(task.id,{message:'帮我写一句话'});assert.equal(store.task(task.id).maxRunSeconds,null);
});


test('known phone takeover stops the model once and retains cloud consent and unknown action evidence',t=>{
 const {store,engine}=setup(t);for(const unknown of [false,true]){
  const task=engine.create({prompt:'打开设置查看电池',cloudConsent:true,memoryConsent:false});store.updateTask(task.id,t=>t.status='running');
  if(unknown)store.transaction(s=>s.actions.push({id:'pending-native',taskId:task.id,status:'unknown'}));
  let stopped=0;const controller=new AbortController();engine.active.set(task.id,{controller,run:{stop:async()=>{stopped++;}}});
  engine.pauseForPhoneControl(task.id,'手机已接管');engine.pauseForPhoneControl(task.id,'重复信号');
  assert.equal(stopped,1);assert.equal(controller.signal.aborted,true);assert.equal(store.task(task.id).status,unknown?'unknown_result':'paused');assert.equal(store.task(task.id).cloudConsent,true);assert.equal(store.task(task.id).memoryConsent,false);
  if(unknown){assert.equal(store.data.actions.find(a=>a.id==='pending-native').status,'unknown');assert.equal(store.data.actions.find(a=>a.id==='pending-native').resolution,undefined);}
 }
});
