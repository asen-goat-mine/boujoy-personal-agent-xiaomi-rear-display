import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../src/core/store.mjs';import {Engine} from '../src/core/engine.mjs';import {Broker} from '../src/tools/broker.mjs';import {deriveDelegation} from '../src/core/delegation.mjs';import {phoneUseGrant} from '../src/adapters/phone-use.mjs';import {withCollaborationMutation} from '../src/core/collaboration-roster.mjs';
const app={packageName:'com.tencent.mm',appName:'微信'},prompt='在微信给张三发送“到了”';
const parse=r=>JSON.parse(r.content[0].text);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-lineage-')),store=new Store(dir);store.transaction(s=>s.settings.phoneEnabled=true);let reads=0;
 const phone={release(){},status:async()=>({ready:true}),observeUse:async()=>{reads++;return {content:[{type:'text',text:JSON.stringify({observationId:'read',stability:'fresh'})}]};}},approvals={cancelTask(){},request:async()=>{throw Error('unexpected approval');}},broker=new Broker({store,phone,approvals,dataDir:dir,memory:{}}),engine=new Engine({store,broker,secrets:{get:async()=>null},memory:{}});engine.pump=async()=>{};
 const parent=engine.create({prompt:'@生活管家 @采购助理 '+prompt,cloudConsent:true});store.updateTask(parent.id,x=>x.status='running');
 const child=roleId=>{const c=engine.create(deriveDelegation(store.task(parent.id),{prompt,roleId},store));store.updateTask(c.id,x=>x.status='running');return store.task(c.id);};
 const observe=task=>{const scope=phoneUseGrant(store.task(task.id),app,{store});assert.equal(scope?.mode,'task_effects');store.updateTask(task.id,x=>x.phoneUseScope=scope);const id='obs-'+task.id;phone.observation={taskId:task.id,id,at:Date.now(),stability:'fresh',stabilityScope:'phone_use',tree:{content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:app.packageName+'/Activity',windowPkg:app.packageName,tree:`window pkg=${app.packageName} bounds=0,0,1000,2000\nTextView "张三" bounds=100,50,600,120\nEditText "消息" "到了" editable focused clickable bounds=100,1600,700,1700\nButton "发送" clickable bounds=750,1600,950,1700`}})}]},ocr:{width:1000,height:2000,lines:[]}};broker.evidence.set(id,{taskId:task.id,at:new Date().toISOString()});return {action:'tap',observationId:id,x:850,y:1650,reason:'按原请求发送'};};
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {store,engine,broker,parent,child,observe,phone,approvals,reads:()=>reads};}

test('unresolved child effect fences parent and other roles but permits exact receipt reuse, status and observation',async t=>{
 const f=fixture(t),first=parse(await f.broker.execute(f.parent.id,'delegate_task',{roleId:'life',prompt}));f.store.updateTask(first.taskId,c=>c.status='unknown_result');f.store.transaction(s=>s.actions.push({id:'unknown-send',taskId:first.taskId,tool:'phone_action',status:'unknown',phoneEffect:{kind:'effect_send'}}));
 await assert.rejects(f.broker.execute(f.parent.id,'delegate_task',{roleId:'shopping',prompt}),{code:'collaboration_result_unresolved'});assert.equal(f.store.task(f.parent.id).children.length,1);
 const duplicate=parse(await f.broker.execute(f.parent.id,'delegate_task',{roleId:'life',prompt}));assert.equal(duplicate.taskId,first.taskId);assert.equal(duplicate.deduplicated,true);
 await assert.rejects(f.broker.execute(f.parent.id,'phone_use',{action:'tap',target:'发送'}),{code:'collaboration_result_unresolved'});
 f.observe(f.parent);await f.broker.execute(f.parent.id,'phone_use',{action:'read'});assert.equal(f.reads(),1);assert.equal(parse(await f.broker.execute(f.parent.id,'phone_status',{})).ready,true);assert.equal(f.store.data.actions[0].status,'unknown');
});

test('same authorized side effect is reused across roles after completion, not sent to a new child',async t=>{
 const f=fixture(t),first=parse(await f.broker.execute(f.parent.id,'delegate_task',{roleId:'life',prompt}));f.store.updateTask(first.taskId,c=>c.status='completed');const second=parse(await f.broker.execute(f.parent.id,'delegate_task',{roleId:'shopping',prompt:'请'+prompt}));assert.equal(second.taskId,first.taskId);assert.equal(second.deduplicated,true);assert.equal(f.store.task(f.parent.id).children.length,1);
});

test('atomic lineage reservation prevents parallel sends and completed semantic key fences another role or parent',async t=>{
 const f=fixture(t),a=f.child('life'),b=f.child('shopping'),gate=deferred();let dispatches=0;
 const action=f.observe(a),first=withCollaborationMutation(f.store,a.id,()=>f.broker.action(a.id,'phone_action',action,null,async()=>{dispatches++;await gate.promise;return {accepted:true};}));await new Promise(resolve=>setImmediate(resolve));
 const other=f.observe(b);await assert.rejects(withCollaborationMutation(f.store,b.id,()=>f.broker.action(b.id,'phone_action',other,null,async()=>dispatches++)),{code:'collaboration_action_busy'});assert.equal(dispatches,1);gate.resolve();await first;
 assert.ok(f.store.data.actions[0].collaborationEffect.key);await assert.rejects(f.broker.action(b.id,'phone_action',other,null,async()=>dispatches++),{code:'collaboration_effect_already_attempted'});
 const parentAction=f.observe(f.parent);await assert.rejects(f.broker.action(f.parent.id,'phone_action',parentAction,null,async()=>dispatches++),{code:'collaboration_effect_already_attempted'});assert.equal(dispatches,1);assert.equal(f.store.data.actions.length,1);
 // Upgrade compatibility: old successful rows have owner contract + classified native effect, not the new key.
 f.store.transaction(s=>delete s.actions[0].collaborationEffect);f.observe(b);await assert.rejects(f.broker.action(b.id,'phone_action',other,null,async()=>dispatches++),{code:'collaboration_effect_already_attempted'});assert.equal(dispatches,1);
});

test('approval wait rechecks live lineage before browser action reservation and does not count rejection as dispatch',async t=>{
 const f=fixture(t),a=f.child('life'),b=f.child('shopping'),gate=deferred(),waiting=deferred();let clicks=0;f.approvals.request=async()=>{waiting.resolve();await gate.promise;};f.broker.evidence.set('browser',{taskId:a.id});
 const pending=f.broker.action(a.id,'browser_action',{observationId:'browser',reason:'explicit operation'},null,async()=>clicks++);await waiting.promise;f.store.transaction(s=>s.actions.push({id:'late-unknown',taskId:b.id,status:'unknown',tool:'phone_action'}));gate.resolve();await assert.rejects(pending,{code:'collaboration_result_unresolved'});assert.equal(clicks,0);assert.equal(f.store.data.actions.length,1);
});
