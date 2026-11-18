import {DISTRIBUTION,ANDROID_PACKAGE} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {taskProgress} from '../src/core/task-progress.mjs';
import {Store} from '../src/core/store.mjs';
import {RemoteState,spkiPin} from '../src/remote/state.mjs';
import {createGateway} from '../src/remote/gateway.mjs';
import {identities,request} from './helpers/remote-tls.mjs';

const START='2026-11-15T08:00:00.000Z',NOW=Date.parse('2026-11-15T08:10:00.000Z');
const at=seconds=>new Date(Date.parse(START)+seconds*1000).toISOString();
const task=(extra={})=>({id:'task-1',status:'running',attempt:1,createdAt:START,runStartedAt:START,updatedAt:at(120),events:[],...extra});
const action=(id,extra={})=>({id,taskId:'task-1',tool:'phone_open_app',status:'completed',startedAt:at(10),finishedAt:at(11),...extra});
const view=(t,actions=[])=>taskProgress(t,{actions,now:NOW});
const done=rows=>rows.filter(row=>row.state==='completed');
const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}return value;};

test('only a completed action receipt becomes a checked step beside real current work',()=>{
 const rows=view(task({events:[{type:'model_timing',at:at(20)}]}),[action('open')]);
 assert.deepEqual(rows,[{id:'action:open',label:'已打开应用',state:'completed'},{id:'current',label:'正在思考',state:'running'}]);
});

test('recent completed receipts are ordered, adjacent equal labels collapsed, and output stays at three rows',()=>{
 const actions=[action('old'),action('tap1',{tool:'phone_action',phoneOperation:'tap',startedAt:at(20),finishedAt:at(21)}),action('tap2',{tool:'phone_action',phoneOperation:'tap',startedAt:at(30),finishedAt:at(31)}),action('type',{tool:'phone_action',phoneOperation:'type',startedAt:at(40),finishedAt:at(41)})];
 const rows=view(task(),[...actions].reverse());
 assert.equal(rows.length,3);assert.deepEqual(rows.slice(0,2).map(r=>[r.id,r.label]),[['action:tap2','已点按'],['action:type','已输入文字']]);
 assert.equal(rows.at(-1).state,'running');
});

test('unknown, failed, executing, not-executed and malformed or foreign receipts cannot become checkmarks',()=>{
 const rejected=['unknown','failed','executing','not_executed'].map((status,i)=>action('bad'+i,{status,resolution:{outcome:'navigation_observed'}}));
 rejected.push(action('foreign',{taskId:'other'}),action('future',{finishedAt:at(1000)}),action('reverse',{finishedAt:at(1)}),action('missing',{finishedAt:undefined}),action('badtime',{startedAt:'invalid'}),action('not-executed',{executionStatus:'not_executed'}),action('invalid id'));
 assert.equal(done(view(task(),rejected)).length,0);
});

test('a receipt from an earlier attempt is excluded even if it returns during the new run',()=>{
 const t=task({attempt:2,runStartedAt:at(60),events:[{type:'tool',tool:'phone_use',action:'tap',at:at(30)}]});
 const rows=view(t,[action('prior',{startedAt:at(20),finishedAt:at(80)}),action('current',{startedAt:at(70),finishedAt:at(71)})]);
 assert.deepEqual(done(rows).map(r=>r.id),['action:current']);assert.equal(rows.at(-1).label,'正在处理');
});

test('a newer timeline segment narrows the receipt window without changing execution data',()=>{
 const t=task({timeline:{segmentStartedAt:at(50)}});
 assert.equal(done(view(t,[action('old')])).length,0);
 assert.equal(done(view(t,[action('new',{startedAt:at(60),finishedAt:at(61)})])).length,1);
});

test('queued retries and retries missing a trustworthy run start do not reuse old completions',()=>{
 for(const t of [task({status:'queued',attempt:1}),task({attempt:2,runStartedAt:null}),task({attempt:3,runStartedAt:'invalid'})])assert.equal(done(view(t,[action('old')])).length,0);
 assert.equal(done(view(task({runStartedAt:null,createdAt:null}),[action('old')])).length,0);
});

test('narration, successful-looking harness returns, errors and timing events never fabricate completions',()=>{
 for(const event of [{type:'harness_tool',phase:'tool/result',tool:'phone_use',isError:false,text:'{"accepted":"unconfirmed"}'},{type:'phone_tool_result',outcome:'returned',tool:'phone_use'},{type:'tool_timing',tool:'phone_use',durationMs:1},{type:'tool_error',tool:'phone_use',code:'outcome_unknown'}]){
  const rows=view(task({events:[{...event,at:at(20)}],phase:'已经下单',liveDraft:'已完成'}));
  assert.equal(done(rows).length,0);assert.equal(rows.length,1);
 }
});

test('phase changes alone leave the previous phase unchecked',()=>{
 const first=view(task({events:[{type:'tool',tool:'phone_use',action:'tap',at:at(20)}]}));
 const next=view(task({events:[{type:'tool',tool:'phone_use',action:'type',at:at(21)}]}));
 assert.equal(done(first).length,0);assert.equal(done(next).length,0);assert.equal(next.at(-1).label,'操作手机：输入文字');
});

test('only live running or child work spins; pauses, waits and failures use waiting',()=>{
 for(const status of ['running','waiting_children'])assert.equal(view(task({status})).at(-1).state,'running');
 for(const status of ['queued','paused','stopped','cancelled','interrupted','expired','failed','unknown_result','needs_review','waiting_approval','waiting_consent','waiting_setup','waiting_user','needs_input','ready_for_user','blocked','unrecognized'])assert.equal(view(task({status,attempt:0})).at(-1).state,'waiting',status);
 for(const status of ['completed','succeeded'])assert.deepEqual(view(task({status})).at(-1),{id:'current',label:'任务已完成',state:'completed'});
});

test('a failed overall task retains only its real prior action completion, never a final spinner or success',()=>{
 const rows=view(task({status:'failed'}),[action('open')]);
 assert.equal(rows[0].state,'completed');assert.deepEqual(rows.at(-1),{id:'current',label:'任务未完成',state:'waiting'});
});

test('system navigation and range outcomes require explicit verification; payment receipts are not business success',()=>{
 const invalid=[action('nav',{tool:'phone_system_navigation',resultVerified:false}),action('range',{tool:'phone_range_value'}),action('payment',{tool:'phone_prepare_payment',verification:'pending',executionStatus:'executed'}),action('unknown',{tool:'custom',label:'私密内容'})];
 assert.equal(done(view(task(),invalid)).length,0);
 const valid=[action('nav',{tool:'phone_system_navigation',resultVerified:true}),action('range',{tool:'phone_range_value',resultVerified:true,startedAt:at(20),finishedAt:at(21)})];
 assert.deepEqual(done(view(task(),valid)).map(r=>r.label),['已切换页面','已调整数值']);
});

test('labels contain no action arguments, task prompt, live narration or tool detail',()=>{
 const secret='PRIVATE_MARKER';
 const rows=view(task({title:secret,prompt:secret,liveDraft:secret,events:[{type:'harness_tool',phase:'tool/call',tool:'unknown',detail:secret,at:at(30)}]}),[action('typed',{tool:'phone_action',phoneOperation:'type',text:secret,label:secret,args:{text:secret}})]);
 assert.ok(!JSON.stringify(rows).includes(secret));assert.equal(rows.at(-1).label,'使用工具');
 assert.ok(rows.every(r=>Object.keys(r).sort().join(',')==='id,label,state'&&[...r.label].length<=36));
});

test('returned tools move the active label to the next step without inventing a checked receipt',()=>{
 const rows=view(task({events:[{type:'phone_tool_result',tool:'phone_use',action:'tap',outcome:'returned',at:at(30)}]}));
 assert.deepEqual(rows,[{id:'current',label:'正在处理下一步',state:'running'}]);
});

test('large and truncated histories stay bounded and event IDs cannot substitute for receipts',()=>{
 const events=Array.from({length:1000},(_,i)=>({id:'e'+i,type:'tool_timing',tool:'phone_use',at:at(20)}));
 events.push({type:'model_timing',at:at(100)});
 const actions=Array.from({length:2000},(_,i)=>action('receipt'+i,{tool:'phone_action',phoneOperation:i%2?'tap':'type',startedAt:at(10+i/10),finishedAt:at(10.01+i/10)}));
 const rows=view(task({events}),actions);assert.equal(rows.length,3);assert.equal(rows.at(-1).label,'正在思考');
 assert.equal(done(view(task({events}),[])).length,0);
});

test('progress presentation is deterministic and side-effect free on frozen inputs',()=>{
 const t=freeze(task({events:[{type:'model_timing',at:at(30)}]})),actions=freeze([action('open')]);
 const before=JSON.stringify({t,actions});assert.deepEqual(view(t,actions),view(t,actions));assert.equal(JSON.stringify({t,actions}),before);
});

test('missing tasks, malformed identifiers and absent action collections are safe',()=>{
 for(const t of [null,undefined,{},task({id:'bad id'}),task({id:'x'.repeat(200)})])assert.deepEqual(view(t),[]);
 assert.equal(taskProgress(task(),{actions:null,now:NOW}).length,1);
});

test('authenticated mobile state carries the bounded receipt progress without raw ledger fields',async t=>{
 const id=identities();t.after(id.cleanup);const store=new Store(id.dir,{lock:false});t.after(()=>store.close());
 const state=new RemoteState(id.dir),deviceId=randomUUID();const engine={active:new Map(),broker:null,async stop(){}};
 const gateway=createGateway({identity:id.server,state,store,engine,phone:{lease:null},dataDir:id.dir});const port=await gateway.listen();t.after(()=>gateway.close());
 const call=(pathname,body)=>request({port,identity:id.client,pin:spkiPin(id.server.cert),pathname,method:body?'POST':'GET',body});
 const pairing=state.issuePairing({deviceId});assert.equal((await call('/v1/pair',{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,pairToken:pairing.pairToken})).status,200);
 const currentId=randomUUID(),started=new Date(Date.now()-2000).toISOString(),finished=new Date(Date.now()-1000).toISOString();
 store.transaction(s=>{s.tasks.push(task({id:currentId,title:'fixture',createdAt:started,runStartedAt:started,updatedAt:finished,messages:[]}));s.actions.push(action('receipt',{taskId:currentId,startedAt:started,finishedAt:finished,args:{text:'PRIVATE_MARKER'},nativeRequestId:'PRIVATE_NATIVE_ID'}));});
 const response=await call('/v1/state');assert.equal(response.status,200);
 const rows=response.body.tasks.find(row=>row.id===currentId).progress;assert.equal(rows.length,2);assert.deepEqual(rows[0],{id:'action:receipt',label:'已打开应用',state:'completed'});
 assert.ok(!JSON.stringify(rows).includes('PRIVATE_'));assert.equal(rows.at(-1).state,'running');
});


test('only the current row reuses the existing bounded phase narration; receipt labels remain generic',()=>{
 const note={text:'好的。\n**正在打开淘宝搜纸巾**',at:at(590)};
 const t=task({events:[{type:'phone_tool_result',tool:'phone_use',at:at(590)}]});
 const rows=taskProgress(t,{actions:[action('open')],note,now:NOW});
 assert.equal(rows[0].label,'已打开应用');assert.equal(rows[0].state,'completed');
 assert.deepEqual(rows.at(-1),{id:'current',label:'正在打开淘宝搜纸巾',state:'running'});
 const long=taskProgress(t,{note:{text:'字'.repeat(80),at:at(590)},now:NOW});assert.equal([...long.at(-1).label].length,36);
});

test('stale narration and narration from an older attempt cannot revive an earlier current step',()=>{
 const t=task({attempt:2,runStartedAt:at(550),events:[{type:'model_timing',at:at(560)}]});
 for(const note of [{text:'先前那一步',at:at(540)},{text:'过期',at:at(100)},{text:'未来',at:at(700)}]){
  assert.equal(taskProgress(t,{note,now:NOW}).at(-1).label,'正在思考');
 }
});
