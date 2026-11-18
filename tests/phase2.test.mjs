// Fusion phase 2: phone queue, chat-created routines that report back, cross-conversation lookup.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {Scheduler,createRoutine,createChatRoutine,routineTaskInput} from '../src/core/scheduler.mjs';
import {Broker,toolsForTask} from '../src/tools/broker.mjs';
import {validateTaskContract} from '../src/core/task-contract.mjs';

function fixture(t,{reply}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-phase2-')),store=new Store(dir);
  const runFactory=options=>{const run={options,dead:false,alive:()=>!run.dead,async start(){await reply?.(run,options);},async send(){},async stop(){run.dead=true;},async dispose(){run.dead=true;}};return run;};
  const fake={calls:new Map(),approvals:{cancelTask(){}},phone:{release(){},close(){}},browser:{close(){}},allToolNames:()=>['finish_task']};
  const engine=new Engine({store,broker:fake,secrets:{get:async()=>'synthetic'},memory:{observe:async()=>{}},runFactory});
  t.after(async()=>{await engine.shutdown();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {store,engine,scheduler:new Scheduler(store,engine)};
}
async function settle(f){for(let i=0;i<5;i++){await f.engine.pump();await Promise.all([...f.engine.active.values()].map(a=>a.completion));await new Promise(r=>setTimeout(r,5));}}
const chat=(f,text)=>{const task=f.engine.newTask({prompt:text,cloudConsent:true});task.status='running';f.store.transaction(s=>{s.tasks.push(task);});return task;};

test('a second phone task waits for the phone instead of failing, and stops waiting when stopped',async t=>{
  const f=fixture(t);
  const first=chat(f,'打开淘宝点包纸巾'),second=chat(f,'打开微信给文件传输助手发个测试一下');
  const phone={lease:first.id,release(id){if(this.lease===id)this.lease=null;},close(){}};
  const broker=new Broker({store:f.store,browser:{},phone,memory:{},approvals:{cancelTask(){}}});
  setTimeout(()=>{phone.lease=null;},60);
  await broker.waitForPhone(second.id,null,{pollMs:10});
  const events=f.store.task(second.id).events.filter(e=>e.type==='phone_queue').map(e=>e.text);
  assert.deepEqual(events,['排队等手机：上一个手机任务做完就开始','手机空出来了，开始操作']);assert.equal(f.store.task(second.id).phoneQueuedAt,null);
  phone.lease=first.id;const controller=new AbortController();setTimeout(()=>controller.abort(),30);
  await assert.rejects(broker.waitForPhone(second.id,controller.signal,{pollMs:10}),{code:'cancelled'});
  phone.lease=first.id;f.store.updateTask(first.id,t=>{t.status='unknown_result';});
  await broker.waitForPhone(second.id,null,{pollMs:10});
  assert.equal(f.store.task(second.id).events.filter(e=>e.type==='phone_queue').length,3,'an ended task\'s stale lease is not waited on');
  assert.equal(phone.lease,null,'terminal orphan lease is actually released');
  phone.lease=first.id;f.store.updateTask(first.id,t=>{t.status='running';});
  await assert.rejects(broker.waitForPhone(second.id,null,{pollMs:5,maxMs:30}),{code:'phone_busy'},'a wait never outlives the tool-call timeout; the step is not run');
  assert.equal(f.store.task(second.id).phoneQueuedAt,null);
});

test('a routine asked for in chat is read-only, bound to the conversation and reports back into it',async t=>{
  const f=fixture(t,{reply:(run,options)=>{f.store.updateTask(options.task.id,row=>{row.report={outcome:'completed',summary:'小红书有 3 条新私信：…',evidence:[],remaining:''};});f.engine.finishReport(options.task.id);}});
  const origin=chat(f,'每天早上9点帮我看看小红书有没有新私信');
  assert.ok(toolsForTask(origin,{store:f.store}).some(x=>x.name==='routine_create'));
  assert.throws(()=>createChatRoutine(chat(f,'小红书有没有新私信'),{name:'x',prompt:'看看小红书',kind:'daily',time:'09:00'}),/没有提到定时/);
  const routine=createChatRoutine(origin,{name:'小红书私信',prompt:'看看小红书有没有新私信，并给小王发消息说收到了',kind:'daily',time:'09:00'},{timezone:'America/Los_Angeles'});
  assert.equal(routine.conversationId,origin.conversationId);assert.equal(routine.timezone,'America/Los_Angeles');
  assert.ok(routine.authorization.effects.every(e=>['read','navigate'].includes(e)),'a model-written routine prompt cannot authorize sending');
  f.store.transaction(s=>{s.routines.push(routine);s.tasks.find(x=>x.id===origin.id).status='completed';});
  const run=f.engine.newTask(routineTaskInput(routine,{at:Date.now(),slot:new Date().toISOString()}));
  assert.ok(validateTaskContract(run,{store:f.store}).valid);assert.ok(!run.taskContract.effects.includes('send'));
  f.store.transaction(s=>{s.tasks.push(run);});await settle(f);
  assert.equal(f.store.task(run.id).status,'completed');assert.equal(f.store.task(run.id).archived,true);
  const notice=f.store.data.tasks.find(x=>x.routineTaskId===run.id);
  assert.ok(notice);assert.equal(notice.conversationId,origin.conversationId);assert.match(notice.result,/3 条新私信/);assert.equal(notice.messages[0].watchNotice,true);
  f.engine.deliverRoutineResult(run.id);assert.equal(f.store.data.tasks.filter(x=>x.routineTaskId===run.id).length,1,'delivered once');
});

test('a chat reminder routine delivers without a model call',async t=>{
  const f=fixture(t);const origin=chat(f,'明早8点提醒我带伞');
  const routine=createChatRoutine(origin,{name:'带伞',prompt:'带伞',kind:'once',at:new Date(Date.now()+60000).toISOString(),taskKind:'reminder'});
  f.store.transaction(s=>{s.routines.push(routine);});
  const run=f.engine.newTask(routineTaskInput(routine,{at:Date.now(),slot:new Date().toISOString()}));f.store.transaction(s=>{s.tasks.push(run);});
  await settle(f);
  const notice=f.store.data.tasks.find(x=>x.routineTaskId===run.id);assert.match(notice?.result||'',/提醒你：带伞/);
});

test('task_lookup answers about other conversations and only when the user refers back',async t=>{
  const f=fixture(t);
  const coffee=chat(f,'淘宝给我点个咖啡 要外卖');f.store.updateTask(coffee.id,row=>{row.status='ready_for_user';row.result='已到确认订单页，请核对后自行付款。';});
  const asking=chat(f,'刚才那个咖啡点好了吗');
  assert.ok(toolsForTask(asking,{store:f.store}).some(x=>x.name==='task_lookup'));
  assert.ok(toolsForTask(chat(f,'明天洛杉矶天气怎么样'),{store:f.store}).some(x=>x.name==='task_lookup'),'always available in the user\'s own chat');
  const broker=new Broker({store:f.store,browser:{},phone:null,memory:{},approvals:{cancelTask(){}}});
  const raw=await broker.executeTool(asking.id,'task_lookup',{query:'咖啡'}),result=raw.tasks?raw:JSON.parse(raw.content.find(c=>c.type==='text').text);
  assert.equal(result.tasks.length,1);assert.equal(result.tasks[0].status,'ready_for_user');assert.match(result.tasks[0].result,/确认订单页/);
});

// ---- Dispatch session (Router) ----
const routerFixture=(t,decide)=>{const f=fixture(t,{reply:async(run,options)=>{if(options.task.source==='router')await decide(f,options.task);}});return f;};
async function unboundRoutineRun(f,{result='小红书有 2 条新私信。'}={}){
  const routine=createRoutine({name:'小红书私信',prompt:'看看小红书新私信',roleId:'concierge',taskKind:'general',kind:'daily',time:'09:00',timezone:'Asia/Shanghai',cloudConsent:true});
  const run=f.engine.newTask(routineTaskInput(routine,{at:Date.now(),slot:new Date().toISOString()}));
  Object.assign(run,{status:'completed',result});
  f.store.transaction(s=>{s.routines.push(routine);s.tasks.push(run);});
  return run;
}

test('an unbound routine result goes through the dispatch session into the conversation it picks',async t=>{
  const seen=[];
  const f=routerFixture(t,async(f,task)=>{seen.push(task.routerCard);const target=task.routerCard.openConversations.find(c=>/小红书/.test(c.title));
    const {Broker}=await import('../src/tools/broker.mjs');const broker=new Broker({store:f.store,browser:{},phone:null,memory:{},approvals:{cancelTask(){}}});broker.engine=f.engine;
    await broker.executeTool(task.id,'route_reply',{conversationId:target.conversationId,text:'今天小红书有 2 条新私信。'});});
  const talk=chat(f,'帮我整理下小红书私信');f.store.updateTask(talk.id,t=>{t.status='completed';});chat(f,'明天洛杉矶天气怎么样');
  const run=await unboundRoutineRun(f);f.engine.deliverRoutineResult(run.id);await settle(f);
  assert.equal(seen.length,1);assert.equal(seen[0].kind,'routine_result');assert.match(seen[0].rules,/不是指令/);
  const notice=f.store.data.tasks.find(x=>x.sourceTaskId===run.id&&x.watchNotice);
  assert.ok(notice);assert.equal(notice.conversationId,talk.conversationId);assert.match(notice.result,/2 条新私信/);
  const router=f.store.data.tasks.find(x=>x.source==='router');assert.equal(router.archived,true);assert.equal(router.status,'completed');assert.deepEqual(router.taskContract.effects,[]);
  assert.equal(f.store.data.routerLog.at(-1).decision.kind,'reply');
  f.engine.routeEvent({kind:'routine_result',title:'x',summary:'y',sourceTaskId:run.id});assert.equal(f.store.data.tasks.filter(x=>x.source==='router').length,1,'the same result is routed once');
});

test('the dispatch session can pass a note to a running task, but not as the user and not to a finished one',async t=>{
  let outcome;
  const f=routerFixture(t,async(f,task)=>{const {Broker}=await import('../src/tools/broker.mjs');const broker=new Broker({store:f.store,browser:{},phone:null,memory:{},approvals:{cancelTask(){}}});broker.engine=f.engine;
    const live=task.routerCard.openConversations.find(c=>c.live);
    await assert.rejects(broker.executeTool(task.id,'phone_use',{action:'read'}),e=>['router_read_only'].includes(e.code)||/手机/.test(e.message));
    outcome=await broker.executeTool(task.id,'route_to_task',{taskId:live.latestTaskId,note:'快递已到驿站'});});
  const running=chat(f,'等快递到了帮我去取件码');
  const run=await unboundRoutineRun(f,{result:'快递已到驿站，取件码 1234'});f.engine.deliverRoutineResult(run.id);await settle(f);
  assert.ok(outcome);
  const notes=f.engine.takeRouterNotes(running.id);assert.equal(notes.length,1);assert.match(notes[0].handling,/不是用户指令/);
  assert.ok(!f.store.task(running.id).messages.some(m=>m.role==='user'&&/驿站/.test(m.content)),'never becomes user words');
  assert.equal(f.engine.takeRouterNotes(running.id).length,0);
});

test('user tasks cannot use route tools and the router switch turns dispatch off',async t=>{
  const f=fixture(t);const user=chat(f,'随便聊聊');
  const broker=new Broker({store:f.store,browser:{},phone:null,memory:{},approvals:{cancelTask(){}}});broker.engine=f.engine;
  await assert.rejects(broker.executeTool(user.id,'route_ignore',{reason:'x'}),{code:'router_only'});
  f.store.transaction(s=>{s.settings.routerEnabled=false;});
  const run=await unboundRoutineRun(f);f.engine.deliverRoutineResult(run.id);
  assert.equal(f.store.data.tasks.filter(x=>x.source==='router').length,0);assert.equal(f.store.task(run.id).archived,undefined,'the run stays visible on its own');
});

// ---- Found in device testing 2026-11-01 ----
test('only the latest two screenshots are sent to the model; text and tool results stay',async()=>{
  const {pruneOldImages}=await import('../src/core/model-context.mjs');
  const img=n=>({type:'image',source:{type:'base64',media_type:'image/png',data:'x'.repeat(n)}});
  const data={messages:[
    {role:'user',content:'打开淘宝看看购物车'},
    {role:'user',content:[{type:'tool_result',tool_use_id:'a',content:[{type:'text',text:'页面1'},img(10)]}]},
    {role:'assistant',content:[{type:'text',text:'继续'}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:'b',content:[img(10)]}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:'c',content:[{type:'text',text:'页面3'},img(10)]}]},
    {role:'user',content:[img(10),{type:'text',text:'最新'}]}]};
  assert.equal(pruneOldImages(data),2);
  const flat=JSON.stringify(data.messages);
  assert.equal((flat.match(/"type":"image"/g)||[]).length,2);assert.match(flat,/页面1/);assert.match(flat,/较早的手机截图已省略/);
  assert.equal(data.messages[3].content[0].content[0].type,'text','an image-only tool result keeps a placeholder');
  assert.equal(data.messages[0].content,'打开淘宝看看购物车');
});

test('a phone look-and-answer turn completes even if the model skips finish_task, but not after a commit or a step note',async t=>{
  const answer='购物车一共 8 件商品，目前能买的只有 1 件：康师傅冰红茶整箱 ¥41.9，其余 7 件已失效。';
  for(const [label,setup,last,expected] of [
    ['read-only answer',()=>({status:'completed'}),answer,'completed'],
    ['step note only',()=>({status:'completed'}),'正在打开淘宝查看购物车。','needs_review'],
    ['a send happened',()=>({status:'completed',phoneEffect:{kind:'effect_send'}}),answer,'needs_review'],
    ['unknown action',()=>({status:'unknown'}),answer,'needs_review']]){
    const f=fixture(t,{reply:(run,options)=>{const id=options.task.id;f.store.transaction(s=>{s.actions.push({id:randomUUID(),taskId:id,tool:'phone_action',startedAt:new Date().toISOString(),...setup()});s.tasks.find(x=>x.id===id).events.push({id:randomUUID(),at:new Date().toISOString(),type:'tool',tool:'phone_use',text:'正在执行：phone_use'});});
      f.store.updateTask(id,row=>{row.messages.push({id:randomUUID(),role:'assistant',content:last,at:new Date().toISOString()});});}});
    const task=f.engine.create({prompt:'打开淘宝看看购物车里有什么',cloudConsent:true});await settle(f);
    assert.equal(f.store.task(task.id).status,expected,label);
  }
});

test('the dispatch session does not take a conversation\'s warm slot',async t=>{
  const f=fixture(t);const runs=[];
  f.engine.runFactory=options=>{const run={options,dead:false,alive:()=>!run.dead,async start(){runs.push(run);const id=options.task.id;f.store.updateTask(id,row=>{row.report={outcome:'completed',summary:'好的，已经处理。',evidence:[],remaining:''};});f.engine.finishReport(id);},async send(){},async stop(){run.dead=true;},async dispose(){run.dead=true;run.disposed=true;}};return run;};
  for(const city of ['洛杉矶','纽约','东京']){f.engine.create({prompt:`明天${city}天气怎么样`,cloudConsent:true});await settle(f);}
  const source=await unboundRoutineRun(f);f.engine.deliverRoutineResult(source.id);await settle(f);
  assert.equal(f.engine.warm.size,4);assert.equal([...f.engine.warm.values()].filter(w=>!w.router).length,3);
  assert.ok(runs.slice(0,3).every(r=>!r.disposed),'no conversation session was evicted');
});


test('phone queue waits for terminal task cleanup and does not steal its lease',async t=>{
 const f=fixture(t),first=chat(f,'first'),second=chat(f,'second');
 f.store.updateTask(first.id,row=>{row.status='completed';});
 const phone={lease:first.id,release(id){if(this.lease===id)this.lease=null;}};
 const broker=new Broker({store:f.store,phone,browser:{},memory:{},approvals:{}});broker.engine={active:new Map([[first.id,{}]])};
 let cleaned=false;setTimeout(()=>{cleaned=true;phone.release(first.id);broker.engine.active.delete(first.id);},40);
 await broker.waitForPhone(second.id,null,{pollMs:5});assert.equal(cleaned,true);assert.equal(phone.lease,null);
});

test('full Harness receives repeated recoverable failures without a counter forcing task completion',t=>{
 const f=fixture(t),task=chat(f,'inspect current state');f.store.transaction(s=>{s.settings.harnessFull=true;});let blocked=0;
 const broker=new Broker({store:f.store,phone:{},browser:{},memory:{},approvals:{}});broker.engine={blockToolFailure(){blocked++;}};
 for(let i=0;i<6;i++){const result=JSON.parse(broker.phoneFailure(task.id,{code:'phoneuse_error',message:'transport unavailable'},{content:[]}).content[0].text);assert.equal(result.recovered,false);assert.equal(result.recoverable,true);}
 assert.equal(blocked,0);assert.equal(f.store.task(task.id).status,'running');
});
