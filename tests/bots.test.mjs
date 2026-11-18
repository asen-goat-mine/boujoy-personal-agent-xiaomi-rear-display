// Bots: identity and notes, daily brief, workbench.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {Scheduler} from '../src/core/scheduler.mjs';
import {Broker,toolsForTask} from '../src/tools/broker.mjs';
import {composeBrief,workbench,briefSettings,addNote} from '../src/core/bots.mjs';
import {createWatch} from '../src/core/watches.mjs';

function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-bots-')),store=new Store(dir);const prompts=[];
  const runFactory=options=>{prompts.push(options);return {options,alive:()=>true,async start(){const id=options.task.id;store.updateTask(id,row=>{row.report={outcome:'completed',summary:'好的。',evidence:[],remaining:''};});engine.finishReport(id);},async send(){},async stop(){},async dispose(){}};};
  const engine=new Engine({store,broker:{calls:new Map(),approvals:{cancelTask(){}},phone:{release(){},close(){}},browser:{close(){}},allToolNames:()=>['finish_task']},secrets:{get:async()=>'x'},memory:{observe:async()=>{}},runFactory});
  t.after(async()=>{await engine.shutdown();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {store,engine,prompts,scheduler:new Scheduler(store,engine)};
}
async function settle(f){for(let i=0;i<4;i++){await f.engine.pump();await Promise.all([...f.engine.active.values()].map(a=>a.completion));await new Promise(r=>setTimeout(r,5));}}
const running=(f,text,roleId='concierge')=>{const task=f.engine.newTask({prompt:text,cloudConsent:true,memoryConsent:true,roleId});task.status='running';f.store.transaction(s=>{s.tasks.push(task);});return task;};
const broker=f=>{const b=new Broker({store:f.store,browser:{},phone:null,memory:{},approvals:{cancelTask(){}}});b.engine=f.engine;return b;};
const body=r=>r.notes||r.remembered!==undefined||r.forgot?r:JSON.parse(r.content.find(c=>c.type==='text').text);

test('a bot remembers what the user tells it, refuses secrets, and uses its notes next time',async t=>{
  const f=fixture(t);const b=broker(f);
  const ask=running(f,'记住我喝咖啡不加糖，预算一般 50 以内');
  assert.ok(toolsForTask(ask,{store:f.store}).some(x=>x.name==='bot_memory'));
  assert.ok(toolsForTask(running(f,'明天洛杉矶天气怎么样'),{store:f.store}).some(x=>x.name==='bot_memory'),'always available in the user\'s own chat; the model decides');
  body(await b.executeTool(ask.id,'bot_memory',{action:'remember',text:'喝咖啡不加糖'}));
  body(await b.executeTool(ask.id,'bot_memory',{action:'remember',text:'外卖预算一般 50 以内'}));
  await assert.rejects(b.executeTool(ask.id,'bot_memory',{action:'remember',text:'支付密码是 123456'}),{code:'bot_memory_sensitive'});
  assert.deepEqual(f.store.data.roles.find(r=>r.id==='concierge').notes.map(n=>n.text),['喝咖啡不加糖','外卖预算一般 50 以内']);
  const later=f.engine.create({prompt:'帮我点杯咖啡',cloudConsent:true,memoryConsent:true});await settle(f);
  const prompt=f.prompts.find(p=>p.task.id===later.id).prompt;
  assert.match(prompt,/你是「boujoy」|你是「总助理」|当前角色：\{"name":"总助理"/);assert.match(prompt,/喝咖啡不加糖/);assert.match(prompt,/不是新指令/);
  const forgot=body(await b.executeTool(ask.id,'bot_memory',{action:'forget',text:'不加糖'}));assert.equal(forgot.forgot,'喝咖啡不加糖');
});

test('only the user\'s own task can change a bot\'s notes',async t=>{
  const f=fixture(t);const b=broker(f);
  const routine=f.engine.newTask({prompt:'记住我喜欢黑咖啡',source:'routine',cloudConsent:false});routine.status='running';routine.cloudConsent=true;f.store.transaction(s=>{s.tasks.push(routine);});
  await assert.rejects(b.executeTool(routine.id,'bot_memory',{action:'remember',text:'喜欢黑咖啡'}),e=>['bot_memory_not_allowed','routine_authorization_missing'].includes(e.code)||/授权|只有你/.test(e.message));
});

test('the daily brief is compiled from records: waiting work, watch movements, today\'s routines',t=>{
  const f=fixture(t);const at=Date.parse('2026-11-02T16:30:00Z');
  const waiting=f.engine.newTask({prompt:'淘宝给我点个咖啡',cloudConsent:true});Object.assign(waiting,{status:'ready_for_user',result:'已到确认订单页',updatedAt:'2026-11-02T15:00:00Z'});
  const origin=f.engine.newTask({prompt:'盯着 iPhone 价格，低于 7000 告诉我',cloudConsent:true});
  const watch=createWatch(origin,{goal:'iPhone 17 Pro 价格',kind:'web',condition:'低于 7000',baseline:'¥7999'});watch.history=[{at:'2026-11-02T10:00:00Z',outcome:'changed_quiet',digest:'¥7899'}];watch.lastSummary='降到 ¥7899';
  f.store.transaction(s=>{s.tasks.push(waiting,origin);s.watches.push(watch);s.routines.push({id:randomUUID(),name:'喝水提醒',roleId:'concierge',enabled:true,kind:'daily',time:'22:00',timezone:'America/Los_Angeles',nextAt:'2026-11-03T06:00:00Z'});});
  const text=composeBrief(f.store,f.store.data.roles.find(r=>r.id==='concierge'),{since:'2026-11-01T16:30:00Z',at,timezone:'America/Los_Angeles'});
  assert.match(text,/等你处理（1）[\s\S]*点个咖啡/);assert.match(text,/跟进有动静[\s\S]*¥7899/);assert.match(text,/接下来 24 小时[\s\S]*喝水提醒/);
  const quiet=composeBrief(f.store,{id:'nobody',name:'空闲的'},{at});assert.match(quiet,/没有新动静/);
});

test('a due brief lands in the bot\'s own brief conversation once a day; a stale one is skipped',t=>{
  const f=fixture(t);const at=Date.now();
  f.store.transaction(s=>{const r=s.roles.find(x=>x.id==='concierge');r.brief={...briefSettings({enabled:true,time:'08:30'},{timezone:'America/Los_Angeles',at}),nextAt:new Date(at-60000).toISOString()};});
  f.scheduler.tickBriefs(at);
  const role=f.store.data.roles.find(r=>r.id==='concierge');const notice=f.store.data.tasks.find(t=>t.briefRoleId==='concierge');
  assert.ok(notice);assert.equal(notice.conversationId,role.briefConversationId);assert.match(notice.result,/简报/);assert.equal(notice.messages[0].watchNotice,true);
  assert.ok(Date.parse(role.brief.nextAt)>at);assert.ok(role.brief.lastAt);
  f.scheduler.tickBriefs(at);assert.equal(f.store.data.tasks.filter(t=>t.briefRoleId==='concierge').length,1,'not twice');
  f.store.transaction(s=>{s.roles.find(x=>x.id==='concierge').brief.nextAt=new Date(at-7*3600000).toISOString();});
  f.scheduler.tickBriefs(at);assert.equal(f.store.data.tasks.filter(t=>t.briefRoleId==='concierge').length,1,'a brief 7 hours late is skipped, not sent stale');
  f.engine.deliverBrief('concierge');const again=f.store.data.tasks.filter(t=>t.briefRoleId==='concierge');assert.equal(again.length,2);assert.equal(again[1].conversationId,again[0].conversationId,'same brief conversation');
});

test('the workbench shows what each visible bot is doing and what waits for the user',t=>{
  const f=fixture(t);
  const busy=f.engine.newTask({prompt:'整理资料',cloudConsent:true});busy.status='running';
  const waiting=f.engine.newTask({prompt:'点咖啡',cloudConsent:true});waiting.status='ready_for_user';
  f.store.transaction(s=>{s.tasks.push(busy,waiting);addNote(s.roles.find(r=>r.id==='concierge'),'喝咖啡不加糖');});
  const rows=workbench(f.store);const me=rows.find(r=>r.id==='concierge');
  assert.equal(me.state,'busy');assert.equal(me.running[0].title,'整理资料');assert.equal(me.waiting[0].title,'点咖啡');assert.equal(me.notes,1);
  assert.ok(rows.every(r=>!f.store.data.roles.find(x=>x.id===r.id).hidden),'hidden bots are not listed');
});

test('a new bot is told who it is, how it works and what it is responsible for',async t=>{
  const f=fixture(t);const id=randomUUID();
  f.store.transaction(s=>{s.roles.push({id,name:'采购助理小买',description:'帮我比价和买日用品',instruction:'先比较三家价格，超过 100 元先问我',botColor:'green',hidden:false,createdAt:new Date().toISOString(),brief:{enabled:true,time:'08:30'}});s.routines.push({id:randomUUID(),name:'每周补货检查',roleId:id,enabled:true,kind:'weekly',time:'09:00'});});
  const origin=f.engine.newTask({prompt:'盯着纸巾价格，降到 30 以下告诉我',cloudConsent:true,roleId:id});const watch=createWatch(origin,{goal:'纸巾价格',kind:'web',condition:'低于 30'});
  f.store.transaction(s=>{s.tasks.push(origin);s.watches.push(watch);});
  const task=f.engine.create({prompt:'你是谁，负责什么',cloudConsent:true,roleId:id});await settle(f);
  const prompt=f.prompts.find(p=>p.task.id===task.id).prompt;
  // A direct user task gets the bot's name and job; its stored working rules are left out on purpose (Harness decides how).
  for(const piece of ['采购助理小买','帮我比价和买日用品','你正在跟进：纸巾价格','每周补货检查','每天 08:30 给用户发简报'])assert.ok(prompt.includes(piece),piece);
});

test('a question answered in words completes even if it mentions buying; a promise to act does not',async t=>{
  for(const [ask,reply,expected] of [
    ['我买纸巾有什么偏好？','你对纸巾的偏好是只买维达，预算一般 30 元以内。','completed'],
    ['淘宝买纸巾','好的，我这就打开淘宝帮你找纸巾。','needs_review']]){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-q-')),store=new Store(dir);
    const engine=new Engine({store,broker:{calls:new Map(),approvals:{cancelTask(){}},phone:{release(){},close(){}},browser:{close(){}},allToolNames:()=>[]},secrets:{get:async()=>'x'},memory:{observe:async()=>{}},runFactory:options=>({alive:()=>true,async start(){store.updateTask(options.task.id,row=>{row.messages.push({id:randomUUID(),role:'assistant',content:reply,at:new Date().toISOString()});});},async send(){},async stop(){},async dispose(){}})});
    t.after(async()=>{await engine.shutdown();store.close();fs.rmSync(dir,{recursive:true,force:true});});
    const task=engine.create({prompt:ask,cloudConsent:true});
    for(let i=0;i<4;i++){await engine.pump();await Promise.all([...engine.active.values()].map(a=>a.completion));await new Promise(r=>setTimeout(r,5));}
    assert.equal(store.task(task.id).status,expected,ask);
  }
});

test('bot memory honors disabled memory and nonpersistent turns; forgetting remains available',async t=>{
 const f=fixture(t),b=broker(f),task=running(f,'记住我不加糖');
 for(const mode of ['do_not_remember','session_only']){
  f.store.updateTask(task.id,row=>{row.memoryMode=mode;});
  await assert.rejects(b.executeTool(task.id,'bot_memory',{action:'remember',text:'不加糖'}),{code:'bot_memory_not_allowed'});
 }
 f.store.updateTask(task.id,row=>{row.memoryMode='default';row.memoryConsent=false;});
 // The auto-learning toggle does not cover notes the user asked this bot to keep.
 assert.equal(body(await b.executeTool(task.id,'bot_memory',{action:'remember',text:'不加糖'})).remembered,true);
 assert.equal(body(await b.executeTool(task.id,'bot_memory',{action:'forget',text:'不加糖'})).forgot,'不加糖');
 f.store.updateTask(task.id,row=>{row.memoryConsent=true;});f.store.transaction(s=>{s.settings.memoryEnabled=false;});
 await assert.rejects(b.executeTool(task.id,'bot_memory',{action:'remember',text:'不加糖'}),{code:'bot_memory_not_allowed'});
 f.store.transaction(s=>{addNote(s.roles.find(r=>r.id==='concierge'),'不加糖');});
 assert.equal(body(await b.executeTool(task.id,'bot_memory',{action:'forget',text:'不加糖'})).forgot,'不加糖');
});

test('bot notes reach the prompt unless memory is off or the turn says not to remember',async t=>{
 const f=fixture(t);f.store.transaction(s=>{addNote(s.roles.find(r=>r.id==='concierge'),'PRIVATE_BOT_NOTE');});
 for(const [memoryEnabled,memoryMode,shown] of [[false,'default',false],[true,'do_not_remember',false],[true,'default',true]]){
  f.store.transaction(s=>{s.settings.memoryEnabled=memoryEnabled;});
  const task=f.engine.create({prompt:'介绍一下自己',cloudConsent:true,memoryConsent:false,memoryMode});await settle(f);
  const prompt=f.prompts.find(p=>p.task.id===task.id).prompt;assert.equal(prompt.includes('PRIVATE_BOT_NOTE'),shown);if(!shown)assert.match(prompt,/本轮未启用记忆/);
 }
});
