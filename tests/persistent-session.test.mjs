// Fusion phase 1: one Harness session per conversation, reused by its next task.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';

// A fake Harness run that behaves like the real SDK session: start() opens a
// session and runs the first prompt; send() runs another prompt in the same
// session; history accumulates; stop() kills it.
function fakeHarness({reply=prompt=>`收到：${prompt.match(/"content":"([^"]+)"/g)?.at(-1)||''}`}={}){
  const runs=[];
  const factory=options=>{
    const run={options,prompts:[],history:[],alive:()=>!run.dead,dead:false,disposed:false,onEvent:options.onEvent,
      async start(){runs.push(run);await run.send(options.prompt);},
      async send(prompt){if(run.dead)throw Object.assign(new Error('dead'),{code:'runtime_exited'});run.prompts.push(prompt);run.history.push(prompt);run.onEvent({type:'assistant/message',data:{content:[{type:'text',text:reply(prompt,run)}]}});},
      async stop(){run.dead=true;},async dispose(){run.dead=true;run.disposed=true;}};
    return run;
  };
  return {factory,runs};
}
function fixture(t,harness=fakeHarness()){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-persistent-')),store=new Store(dir);
  const broker={calls:new Map(),approvals:{cancelTask(){}},phone:{release(){},close(){}},browser:{close(){}},allToolNames:()=>['finish_task','phone_use','web_search']};
  const engine=new Engine({store,broker,secrets:{get:async()=>'synthetic'},memory:{observe:async()=>{}},runFactory:harness.factory});
  t.after(async()=>{await engine.shutdown();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {store,engine,harness};
}
async function runQueued(f){
  // Drive the real pump once and wait for every started run to finish.
  await f.engine.pump();await Promise.all([...f.engine.active.values()].map(a=>a.completion));
}
const uuid=()=>crypto.randomUUID();

test('the next task in a conversation reuses the same Harness session instead of starting a new process',async t=>{
 const f=fixture(t);
 const first=f.engine.create({prompt:'明天洛杉矶天气怎么样',cloudConsent:true});await runQueued(f);
 assert.equal(f.store.task(first.id).status,'completed');assert.equal(f.harness.runs.length,1);
 assert.equal(f.engine.warm.size,1);assert.equal(f.harness.runs[0].dead,false);
 const second=await f.engine.message(first.id,{message:'那后天呢',clientRequestId:uuid(),cloudConsent:true});await runQueued(f);
 assert.notEqual(second.id,first.id);assert.equal(f.store.task(second.id).status,'completed');
 assert.equal(f.harness.runs.length,1,'no second Harness process');assert.equal(f.harness.runs[0].prompts.length,2);
 assert.match(f.harness.runs[0].prompts[1],/那后天呢/);
 assert.doesNotMatch(f.harness.runs[0].prompts[1],/明天洛杉矶天气/,'earlier turns are already in the session, not re-sent');
 assert.ok(f.store.task(second.id).events.some(e=>e.type==='harness_session'&&e.reused));
 assert.equal(f.harness.runs[0].options.systemToolNames.length,3);
 assert.equal(f.harness.runs[0].task?.id,second.id,'the reused run waits on behalf of the new task, not the old one');
});
test('a stopped task kills its session, and the next message starts a fresh one with full history',async t=>{
 const harness=fakeHarness();const f=fixture(t,harness);
 const first=f.engine.create({prompt:'明天洛杉矶天气怎么样',cloudConsent:true});await runQueued(f);
 const warm=[...f.engine.warm.values()][0];warm.run.dead=true;
 const second=await f.engine.message(first.id,{message:'那后天呢',clientRequestId:uuid(),cloudConsent:true});await runQueued(f);
 assert.equal(harness.runs.length,2);assert.match(harness.runs[1].prompts[0],/明天洛杉矶天气/,'cold start carries the conversation history');
 assert.equal(f.store.task(second.id).status,'completed');
});
test('a different conversation or role never reuses another conversation\'s session',async t=>{
 const f=fixture(t);
 f.engine.create({prompt:'明天洛杉矶天气怎么样',cloudConsent:true});await runQueued(f);
 f.engine.create({prompt:'明天纽约天气怎么样',cloudConsent:true});await runQueued(f);
 assert.equal(f.harness.runs.length,2);assert.equal(f.engine.warm.size,2);
});
test('warm sessions are capped, disposed on shutdown, and can be turned off',async t=>{
 const f=fixture(t);
 for(const city of ['洛杉矶','纽约','东京','巴黎'])(f.engine.create({prompt:`明天${city}天气怎么样`,cloudConsent:true}),await runQueued(f));
 assert.equal(f.engine.warm.size,3);assert.equal(f.harness.runs[0].disposed,true);
 const g=fixture(t);g.store.transaction(s=>{s.settings.harnessPersistent=false;});
 const a=g.engine.create({prompt:'明天洛杉矶天气怎么样',cloudConsent:true});await runQueued(g);
 assert.equal(g.engine.warm.size,0);assert.equal(g.harness.runs[0].disposed,true);
 await g.engine.message(a.id,{message:'那后天呢',clientRequestId:uuid(),cloudConsent:true});await runQueued(g);assert.equal(g.harness.runs.length,2);
});
test('finish_task ends softly: the session is not killed and the parked token only answers with a synthetic end',async t=>{
 const harness=fakeHarness({reply:()=>''});const f=fixture(t,harness);
 harness.factory=(base=>options=>{const run=base(options);const send=run.send;run.send=async prompt=>{run.prompts.push(prompt);const id=[...f.engine.active.values()][0].taskId;f.store.updateTask(id,row=>{row.report={outcome:'completed',summary:'明天晴。',evidence:[],remaining:''};});f.engine.finishReport(id);const active=[...f.engine.active.values()][0];assert.equal(active.softFinished,true);assert.equal(run.dead,false);};return run;})(harness.factory);
 f.engine.runFactory=harness.factory;
 const first=f.engine.create({prompt:'明天洛杉矶天气怎么样',cloudConsent:true});await runQueued(f);
 assert.equal(f.store.task(first.id).status,'completed');assert.equal(f.engine.warm.size,1);
 const warm=[...f.engine.warm.values()][0];assert.equal(f.engine.tokens.get(warm.token).softFinished,true);assert.equal(f.engine.tokens.get(warm.token).parked,true);
});
test('a session whose turn ended in a model error is not kept for the next task',async t=>{
 const harness=fakeHarness();const f=fixture(t,harness);
 harness.factory=(base=>options=>{const run=base(options);const send=run.send;run.send=async prompt=>{await send(prompt);options.onEvent({type:'turn/end',data:{reason:{kind:'error',error:{code:'CONTEXT_WINDOW_EXCEEDED',status:400}}}});};return run;})(harness.factory);f.engine.runFactory=harness.factory;
 const task=f.engine.create({prompt:'明天洛杉矶天气怎么样',cloudConsent:true});await runQueued(f);
 assert.equal(f.engine.warm.size,0);assert.equal(harness.runs[0].disposed,true);
 assert.equal(f.store.task(task.id).status,'needs_review');
 assert.match(f.store.task(task.id).blockedReason,/超出/);
});
