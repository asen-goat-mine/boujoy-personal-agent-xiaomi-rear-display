// Fusion phase 2, step 1: 持续跟进 (watches).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {Scheduler} from '../src/core/scheduler.mjs';
import {createWatch,applyWatchReport,watchTaskInput,userAskedToWatch} from '../src/core/watches.mjs';
import {validateTaskContract} from '../src/core/task-contract.mjs';
import {toolsForTask} from '../src/tools/broker.mjs';
import {generalAppGrant} from '../src/adapters/phone-general-navigation.mjs';

const userTask=(text,extra={})=>({id:randomUUID(),source:'user',roleId:'concierge',cloudConsent:true,messages:[{id:randomUUID(),role:'user',content:text}],...extra});

test('a watch is created only when the user asked for ongoing follow-up',()=>{
  assert.throws(()=>createWatch(userTask('iPhone 17 Pro 京东多少钱'),{goal:'iPhone 17 Pro 京东价格',kind:'web'}),/没有要求持续跟进/);
  for(const words of ['帮我盯着 iPhone 17 Pro 京东价格，低于 7000 告诉我','淘宝那个纸巾的物流到了叫我','keep an eye on the price and let me know'])assert.ok(userAskedToWatch(userTask(words)),words);
  const w=createWatch(userTask('帮我盯着 iPhone 17 Pro 京东价格，低于 7000 告诉我'),{goal:'iPhone 17 Pro 京东价格',kind:'web',condition:'低于 7000',baseline:'¥7999'},{at:Date.parse('2026-11-01T10:00:00Z')});
  assert.equal(w.intervalMinutes,60);assert.equal(w.nextAt,'2026-11-01T11:00:00.000Z');assert.equal(w.expiresAt,'2026-11-08T10:00:00.000Z');assert.equal(w.lastDigest,'¥7999');assert.equal(w.status,'active');
  assert.throws(()=>createWatch(userTask('每 5 分钟盯一下'),{goal:'x',kind:'web',intervalMinutes:5}),/检查间隔/);
  assert.throws(()=>createWatch(userTask('盯着物流'),{goal:'物流',kind:'phone'}),/手机应用/);
  assert.throws(()=>createWatch({...userTask('盯着价格'),source:'routine'},{goal:'价格',kind:'web'}),/直接发起/);
});

test('a check speaks only when the result changes or the condition is met',()=>{
  const base={goal:'iPhone 价格',lastDigest:'¥7999',lastSummary:'京东自营 ¥7999',failures:2,checks:4};
  let r=applyWatchReport(base,{digest:' ¥7999 ',summary:'还是 7999',met:false});
  assert.equal(r.notice,null);assert.equal(r.outcome,'unchanged');assert.equal(r.patch.failures,0);
  r=applyWatchReport({...base,condition:'低于 7000'},{digest:'¥7899',summary:'降到 7899',met:false});
  assert.equal(r.outcome,'changed_quiet');assert.equal(r.notice,null,'with a condition only meeting it speaks');
  r=applyWatchReport(base,{digest:'¥7899',summary:'降到 7899',met:false});
  assert.equal(r.outcome,'changed');assert.match(r.notice,/降到 7899/);assert.match(r.notice,/上次：京东自营 ¥7999/);
  r=applyWatchReport(base,{digest:'¥6999',summary:'降到 6999 了',met:true});
  assert.equal(r.outcome,'met');assert.equal(r.patch.status,'done');assert.match(r.notice,/6999/);
  r=applyWatchReport(base,{digest:'',summary:'页面打不开',met:false});
  assert.equal(r.outcome,'unreadable');assert.equal(r.notice,null);assert.equal(r.patch.failures,3);
  r=applyWatchReport({goal:'x',lastDigest:null},{digest:'运输中',summary:'运输中',met:false});
  assert.equal(r.outcome,'baseline');assert.equal(r.notice,null);
});

function fixture(t,{reply}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-watch-')),store=new Store(dir);
  const runs=[];
  const runFactory=options=>{const run={options,dead:false,alive:()=>!run.dead,async start(){runs.push(run);await reply?.(run,options);},async send(){},async stop(){run.dead=true;},async dispose(){run.dead=true;}};return run;};
  const broker={calls:new Map(),approvals:{cancelTask(){}},phone:{release(){},close(){}},browser:{close(){}},allToolNames:()=>['finish_task','watch_report']};
  const engine=new Engine({store,broker,secrets:{get:async()=>'synthetic'},memory:{observe:async()=>{}},runFactory});
  const scheduler=new Scheduler(store,engine);
  t.after(async()=>{await engine.shutdown();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {store,engine,scheduler,runs};
}
async function settle(f){for(let i=0;i<5;i++){await f.engine.pump();await Promise.all([...f.engine.active.values()].map(a=>a.completion));await new Promise(r=>setTimeout(r,5));}}
function addWatch(f,{kind='web',app,lastDigest='¥7999',lastSummary='京东自营 ¥7999',condition='低于 7000'}={}){
  const origin=f.engine.newTask({prompt:'帮我盯着 iPhone 17 Pro 京东价格，低于 7000 告诉我',cloudConsent:true});origin.status='completed';
  const watch=createWatch(origin,{goal:'iPhone 17 Pro 京东价格',kind,app,condition,baseline:lastDigest,baselineSummary:lastSummary},{at:Date.now()-3600000});
  watch.nextAt=new Date(Date.now()-1000).toISOString();
  f.store.transaction(s=>{s.tasks.push(origin);s.watches.push(watch);});
  return {origin,watch};
}
const checkTasks=f=>f.store.data.tasks.filter(t=>t.source==='watch');
const notices=(f,origin)=>f.store.data.tasks.filter(t=>t.watchNotice&&t.conversationId===origin.conversationId);

test('a due watch runs a hidden read-only check; an unchanged result stays silent',async t=>{
  const f=fixture(t,{reply:(run,options)=>f.engine.watchReport(options.task.id,{digest:'¥7999',summary:'还是 7999',met:false})});
  const {origin,watch}=addWatch(f);
  assert.equal(f.scheduler.tickWatches(),1);
  const [check]=checkTasks(f);assert.equal(check.archived,true);assert.equal(check.watchId,watch.id);assert.equal(check.conversationId,watch.id);
  assert.deepEqual(check.taskContract.effects,['read','navigate']);assert.equal(check.taskContract.routing,'watch');
  assert.ok(validateTaskContract(check,{store:f.store}).valid);
  await settle(f);
  assert.equal(f.store.task(check.id).status,'completed');assert.equal(notices(f,origin).length,0);
  const after=f.store.data.watches[0];assert.equal(after.checks,1);assert.ok(Date.parse(after.nextAt)>Date.now()+50*60000);
  assert.match(f.runs[0].options.prompt,/持续跟进检查/);assert.match(f.runs[0].options.prompt,/previousDigest/);
});

test('a changed result lands in the asking conversation as a finished turn without a fake user bubble',async t=>{
  const f=fixture(t,{reply:(run,options)=>f.engine.watchReport(options.task.id,{digest:'¥7899',summary:'京东自营降到 ¥7899',met:false})});
  const {origin}=addWatch(f,{condition:null});f.scheduler.tickWatches();await settle(f);
  const [notice]=notices(f,origin);assert.ok(notice);
  assert.equal(notice.status,'completed');assert.equal(notice.archived,undefined);assert.equal(notice.source,'user');
  assert.equal(notice.messages[0].watchNotice,true);assert.match(notice.messages.at(-1).content,/7899/);assert.match(notice.result,/7899/);
  assert.equal(f.store.data.watches[0].status,'active');
});

test('meeting the condition ends the watch; three failed checks pause it and say so',async t=>{
  const f=fixture(t,{reply:(run,options)=>f.engine.watchReport(options.task.id,{digest:'¥6999',summary:'降到 6999',met:true})});
  const {origin}=addWatch(f);f.scheduler.tickWatches();await settle(f);
  assert.equal(f.store.data.watches[0].status,'done');assert.equal(notices(f,origin).length,1);
  f.store.transaction(s=>{s.watches[0].nextAt=new Date(Date.now()-1000).toISOString();});
  assert.equal(f.scheduler.tickWatches(),0,'a finished watch is not checked again');

  const g=fixture(t,{reply:()=>{}});
  const second=addWatch(g);
  for(let i=0;i<3;i++){g.store.transaction(s=>{s.watches[0].nextAt=new Date(Date.now()-1000).toISOString();});g.scheduler.tickWatches();await settle(g);}
  const w=g.store.data.watches[0];assert.equal(w.status,'paused');assert.equal(w.failures,3);
  assert.equal(notices(g,second.origin).length,1);assert.match(notices(g,second.origin)[0].result,/暂停跟进/);
});

test('phone checks are skipped, not failed, while the phone is paused or busy',async t=>{
  const f=fixture(t,{reply:()=>{}});
  f.store.transaction(s=>{s.settings.phoneEnabled=true;});
  f.engine.remoteControlState=()=>({paused:true,controlEpoch:1});
  addWatch(f,{kind:'phone',app:'淘宝'});
  assert.equal(f.scheduler.tickWatches(),0);assert.equal(checkTasks(f).length,0);
  const w=f.store.data.watches[0];assert.equal(w.lastSkip.reason,'phone_paused');assert.equal(w.failures,0);
  assert.ok(Date.parse(w.nextAt)<=Date.now()+15*60000+1000);
  f.engine.remoteControlState=()=>({paused:false,controlEpoch:1});
  f.store.transaction(s=>{s.watches[0].nextAt=new Date(Date.now()-1000).toISOString();s.tasks.push({...s.tasks[0],id:randomUUID(),status:'running',phoneUseScope:{mode:'general'}});});
  assert.equal(f.scheduler.tickWatches(),0);assert.equal(f.store.data.watches[0].lastSkip.reason,'phone_busy');
});

test('cancelling a watch invalidates its queued check and the switch turns watches off',async t=>{
  const f=fixture(t,{reply:()=>{}});
  addWatch(f);f.scheduler.tickWatches();const [check]=checkTasks(f);
  f.store.transaction(s=>{s.watches[0].status='cancelled';});
  assert.equal(validateTaskContract(check,{store:f.store}).reason,'watch_inactive');
  const g=fixture(t,{reply:()=>{}});addWatch(g);g.store.transaction(s=>{s.settings.watchesEnabled=false;});
  assert.equal(g.scheduler.tickWatches(),0);
});

test('a check task only sees read tools; the user task can create watches',t=>{
  const f=fixture(t);const {watch,origin}=addWatch(f);
  const web=f.engine.newTask(watchTaskInput(watch));f.store.transaction(s=>{s.tasks.push(web);});
  const names=toolsForTask(web,{store:f.store}).map(x=>x.name).sort();
  assert.deepEqual(names,['finish_task','task_context','watch_report','web_fetch','web_search']);
  const asked=f.engine.newTask({prompt:'帮我盯着 iPhone 17 Pro 京东价格，低于 7000 告诉我',cloudConsent:true});
  assert.ok(toolsForTask(asked,{store:f.store}).some(x=>x.name==='watch_create'));
  f.store.transaction(s=>{s.watches[0].check={kind:'phone',app:'淘宝'};s.settings.phoneEnabled=true;});
  const phone=toolsForTask(web,{store:f.store}).map(x=>x.name);
  assert.ok(phone.includes('phone_use'));assert.ok(!phone.includes('web_search'));assert.ok(!phone.some(n=>/^(?:browser|delegate|artifact|watch_create|shop_flow)/.test(n)));
  assert.ok(origin);
});

test('a check task may look inside an app, and its grant is marked read-only',()=>{
  const task={...userTask('持续跟进检查：纸巾物流\n在手机「淘宝」里查看。'),source:'watch',status:'running',taskContract:{intent:'task',allowedApps:['淘宝'],effects:['read','navigate']}};
  const grant=generalAppGrant(task,{packageName:'com.taobao.taobao',label:'淘宝',appName:'淘宝'});
  assert.equal(grant?.readOnly,true);
  assert.equal(generalAppGrant({...task,source:'routine'},{packageName:'com.taobao.taobao',label:'淘宝',appName:'淘宝'}),null);
});

test('the broker refuses anything but looking inside a check task',async t=>{
  const {Broker}=await import('../src/tools/broker.mjs');
  const f=fixture(t);const {watch}=addWatch(f);
  const check=f.engine.newTask(watchTaskInput(watch));check.status='running';f.store.transaction(s=>{s.tasks.push(check);s.settings.phoneEnabled=true;});
  const broker=new Broker({store:f.store,browser:{},phone:{},memory:{},approvals:{cancelTask(){}}});broker.engine=f.engine;
  await assert.rejects(broker.executeTool(check.id,'document_create',{title:'x',content:'y'}),e=>e.code==='watch_read_only'||/参数|未知/.test(e.message));
  await assert.rejects(broker.executeTool(check.id,'phone_use',{action:'set_value',field:'brightness',value:50}),e=>e.code==='watch_read_only');
  f.store.transaction(s=>{s.watches[0].status='cancelled';});
  await assert.rejects(broker.executeTool(check.id,'web_search',{query:'iPhone 17 Pro 京东'}),e=>e.code==='watch_inactive');
});

test('an earlier turn that stopped without a reply shows why in the conversation',async()=>{
  const {conversationMessages}=await import('../src/core/conversation-context.mjs');
  const paused={id:'a',status:'paused',blockedReason:'手机灭屏后自动暂停了操作',updatedAt:'2026-10-31T18:25:40Z',messages:[{id:'m',role:'user',content:'打开设置看看电池剩多少'}]};
  const rows=conversationMessages(paused,{id:'b'});
  assert.equal(rows.length,2);assert.equal(rows[1].role,'assistant');assert.equal(rows[1].outcome,'paused');assert.match(rows[1].content,/灭屏/);
  assert.equal(conversationMessages(paused,{id:'a'}).length,1,'the current task shows its own status notice instead');
  assert.equal(conversationMessages({...paused,messages:[...paused.messages,{role:'assistant',content:'已暂停'}]},{id:'b'}).length,2);
  assert.equal(conversationMessages({...paused,status:'completed'},{id:'b'}).length,1);
});

test('a notice title line never reaches the model as the user\'s words',async t=>{
  const {conversationTranscript}=await import('../src/core/conversation-context.mjs');
  const f=fixture(t);const {origin,watch}=addWatch(f,{condition:null});
  f.engine.watchNotice(watch.id,'跟进有变化：降到 ¥7899');
  const next=f.engine.newTask({prompt:'那再等等',cloudConsent:true,conversationId:origin.conversationId});f.store.transaction(s=>{s.tasks.push(next);});
  const history=conversationTranscript(next,f.store).messages;
  assert.ok(history.some(m=>m.role==='assistant'&&/7899/.test(m.content)),'the notice text is there');
  assert.ok(!history.some(m=>m.role==='user'&&/^跟进：/.test(m.content)),'its title is not a user message');
});

test('a watch whose check cannot be created pauses with the reason instead of retrying every second',async t=>{
  const f=fixture(t,{reply:()=>{}});addWatch(f);
  f.store.transaction(s=>{s.watches[0].roleId='life';s.roles.find(r=>r.id==='life').deletedAt=new Date().toISOString();});
  f.scheduler.tickWatches();
  const w=f.store.data.watches[0];assert.equal(w.status,'paused');assert.match(w.pauseReason,/角色/);
  assert.equal(f.scheduler.tickWatches(),0,'nothing more to do');
});

test('"把闲鱼那个任务关了" offers the tools to list and stop follow-ups and routines, and stopping a routine disables it',async t=>{
  const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path'),{randomUUID}=await import('node:crypto');
  const {Store}=await import('../src/core/store.mjs');const {Engine}=await import('../src/core/engine.mjs');const {Broker,toolsForTask}=await import('../src/tools/broker.mjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-standing-')),store=new Store(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const engine=new Engine({store,broker:{calls:new Map(),approvals:{cancelTask(){}},phone:{release(){}},browser:{}},secrets:{get:async()=>'x'},memory:{}});
  const id=randomUUID();store.transaction(s=>{s.routines.push({id,name:'喝水提醒',roleId:'concierge',enabled:true,kind:'daily',time:'22:00',timezone:'America/Los_Angeles',nextAt:new Date(Date.now()+3600000).toISOString(),prompt:'提醒我喝水'});});
  for(const ask of ['你先把咸鱼的任务关了','喝水提醒别再发了','你现在在盯哪些跟进']){const task=engine.newTask({prompt:ask,cloudConsent:true});const names=toolsForTask(task,{store}).map(x=>x.name);assert.ok(['watch_cancel','routine_list','routine_pause'].every(n=>names.includes(n)),ask);}
  assert.ok(toolsForTask(engine.newTask({prompt:'在微信给张三发送“十分钟后到”',cloudConsent:true}),{store}).some(x=>x.name==='routine_pause'),'discovery remains available across domains; the runtime checks authority');
  const task=engine.newTask({prompt:'喝水提醒别再发了',cloudConsent:true});task.status='running';store.transaction(s=>{s.tasks.push(task);});
  const broker=new Broker({store,browser:{},phone:null,memory:{},approvals:{cancelTask(){}}});broker.engine=engine;
  const body=r=>r.routines||r.paused?r:JSON.parse(r.content.find(c=>c.type==='text').text);
  const list=body(await broker.executeTool(task.id,'routine_list',{}));assert.equal(list.routines[0].name,'喝水提醒');
  const done=body(await broker.executeTool(task.id,'routine_pause',{id}));assert.equal(done.paused,true);assert.equal(store.data.routines[0].enabled,false);
});

test('after reading a web page, stopping a follow-up or routine asks the user first; a routine or watch run cannot do it',async t=>{
  const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path'),{randomUUID}=await import('node:crypto');
  const {Store}=await import('../src/core/store.mjs');const {Engine}=await import('../src/core/engine.mjs');const {Broker}=await import('../src/tools/broker.mjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-standing2-')),store=new Store(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const engine=new Engine({store,broker:{calls:new Map(),approvals:{cancelTask(){}},phone:{release(){}},browser:{}},secrets:{get:async()=>'x'},memory:{}});
  const id=randomUUID();store.transaction(s=>{s.routines.push({id,name:'喝水提醒',roleId:'concierge',enabled:true,kind:'daily',time:'22:00',timezone:'America/Los_Angeles',nextAt:new Date(Date.now()+3600000).toISOString(),prompt:'提醒我喝水'});});
  const asked=[];const broker=new Broker({store,browser:{},phone:null,memory:{},approvals:{cancelTask(){},async request(task,req){asked.push(req);throw Object.assign(new Error('没有确认'),{code:'not_approved'});}}});broker.engine=engine;
  const task=engine.newTask({prompt:'看看这个网页说的，然后把提醒都关了',cloudConsent:true});task.status='running';task.runStartedAt=new Date(Date.now()-1000).toISOString();task.events.push({type:'tool',tool:'web_fetch',at:new Date().toISOString()});store.transaction(s=>{s.tasks.push(task);});
  await assert.rejects(broker.executeTool(task.id,'routine_pause',{id}),{code:'not_approved'});assert.equal(asked.length,1);assert.equal(store.data.routines[0].enabled,true,'nothing changed without the user');
  const routineRun=engine.newTask({prompt:'提醒我喝水',source:'routine',cloudConsent:false});routineRun.status='running';store.transaction(s=>{s.tasks.push(routineRun);});
  await assert.rejects(broker.executeTool(routineRun.id,'routine_pause',{id}),e=>e.code==='standing_not_allowed'||/只有你/.test(e.message));
});
