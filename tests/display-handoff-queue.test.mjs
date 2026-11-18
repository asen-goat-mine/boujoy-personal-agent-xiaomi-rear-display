import test from 'node:test';
import assert from 'node:assert/strict';
import {DisplayCommands,DISPLAY_OPS,DISPLAY_EFFECT_OPS} from '../src/remote/display-commands.mjs';
import {DisplayDriver} from '../src/adapters/display-driver.mjs';

const DEVICE='11111111-2222-4333-8444-555555555555';
const TASK='56c25fdf-7e43-4e22-a276-357456d5cf2d';
const SESSION={sessionId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',generation:19,displayId:19,width:1080,height:2348,densityDpi:420};
const ARGS={task_id:TASK,title:'请接手',summary:'页面已准备好'};
function fixture(t,{supported=true}={}){
 const queue=new DisplayCommands({pollMs:15}),sent=[];
 const backend={telemetry:()=>({ready:true,features:supported?['session_handoff']:[]}),request(op,args,options){
  sent.push({op,args,options});return queue.request({deviceId:DEVICE,controlEpoch:3,op,args,...options,timeoutMs:500});
 }};
 // The phone lease has already been released; only the explicit handoff task ID survives.
 const driver=new DisplayDriver({backend:()=>backend,taskId:()=>null});
 t.after(()=>queue.close());
 return {queue,driver,sent,async open(){const waiting=driver.ensureSession();const command=await queue.wait(DEVICE);assert.equal(command.op,'session_open');queue.complete(DEVICE,command.id,{session:SESSION});await waiting;}};
}
async function answerHandoff(x,result){
 const waiting=x.driver.handoffSession({taskId:TASK,title:'  准备\n接手 ',summary:'页面'});
 const command=await x.queue.wait(DEVICE);assert.equal(command.op,'session_handoff');x.queue.complete(DEVICE,command.id,result);return {result:await waiting,command};
}

test('real queue admits handoff and binds the explicit task after the lease is cleared',async t=>{
 assert.ok(DISPLAY_OPS.has('session_handoff'));assert.ok(DISPLAY_EFFECT_OPS.has('session_handoff'));assert.ok(DISPLAY_EFFECT_OPS.has('session_close'));
 const x=fixture(t);await x.open();
 const waiting=x.driver.handoffSession({taskId:TASK,title:'  准备\n接手 ',summary:'🙂'.repeat(170)});
 assert.equal(x.driver.session,null,'the Mac retires the session before a receipt');
 const command=await x.queue.wait(DEVICE);assert.equal(command.op,'session_handoff');assert.equal(command.taskId,TASK);assert.equal(command.args.task_id,TASK);
 assert.deepEqual(command.session,{sessionId:SESSION.sessionId,generation:19,displayId:19});assert.equal(command.args.title,'准备 接手');assert.equal([...command.args.summary].length,160);
 x.queue.complete(DEVICE,command.id,{handoff:{state:'pending',expiresAtMs:Date.now()+1800000}});
 assert.deepEqual(await waiting,{handed:true,closed:false,state:'pending',reason:'pending',dispatchState:'confirmed'});
 assert.equal(await x.queue.wait(DEVICE),null);assert.deepEqual(x.sent.map(s=>s.op),['session_open','session_handoff']);
});

test('delivered handoff timeout is unknown and never replays or closes the old session',async t=>{
 const x=fixture(t);await x.open();const waiting=x.driver.handoffSession({taskId:TASK});const command=await x.queue.wait(DEVICE);
 assert.equal(await x.queue.wait(DEVICE),null,'only one delivery');
 const result=await waiting;assert.deepEqual(result,{handed:false,closed:false,state:'unknown',reason:'outcome_unknown',dispatchState:'unknown'});
 assert.throws(()=>x.queue.complete(DEVICE,command.id,{handoff:{state:'pending'}}),error=>error.code==='display_expired');
 assert.equal((await x.driver.handoffSession({taskId:TASK})).state,'no_session');assert.equal((await x.driver.closeSession()).closed,false);
 assert.equal(x.driver.session,null);assert.deepEqual(x.sent.map(s=>s.op),['session_open','session_handoff']);
});

test('undelivered handoff timeout is not-sent and does not claim the page was closed',async t=>{
 const x=fixture(t);await x.open();const result=await x.driver.handoffSession({taskId:TASK});
 assert.equal(result.state,'failed');assert.equal(result.dispatchState,'not_sent');assert.equal(result.reason,'display_backend_unavailable');assert.equal(result.closed,false);
 assert.equal(await x.queue.wait(DEVICE),null);assert.equal(x.driver.session,null);
});

test('closing the transport after delivery leaves handoff unknown',async t=>{
 const x=fixture(t);await x.open();const waiting=x.driver.handoffSession({taskId:TASK});await x.queue.wait(DEVICE);x.queue.close();
 const result=await waiting;assert.equal(result.reason,'outcome_unknown');assert.equal(result.state,'unknown');assert.equal(result.dispatchState,'unknown');assert.equal(result.closed,false);
 assert.deepEqual(x.sent.map(s=>s.op),['session_open','session_handoff']);
});

test('aborting an already delivered real queue handoff never becomes not-sent',async t=>{
 const queue=new DisplayCommands({pollMs:15});t.after(()=>queue.close());const controller=new AbortController();
 const pending=queue.request({deviceId:DEVICE,op:'session_handoff',args:ARGS,session:SESSION,taskId:TASK,controlEpoch:3,timeoutMs:500,signal:controller.signal});
 const result=assert.rejects(pending,error=>error.code==='outcome_unknown'&&error.dispatchState==='unknown');
 await queue.wait(DEVICE);controller.abort();await result;assert.equal(await queue.wait(DEVICE),null);
});

test('canceling a queued handoff is known not-sent without an automatic close',async t=>{
 const x=fixture(t);await x.open();const waiting=x.driver.handoffSession({taskId:TASK});x.queue.cancelUndelivered(DEVICE);
 const result=await waiting;assert.equal(result.reason,'action_cancelled');assert.equal(result.dispatchState,'not_sent');assert.equal(result.closed,false);
 assert.deepEqual(x.sent.map(s=>s.op),['session_open','session_handoff']);
});

for(const [state,closed] of [['failed',false],['taken',false],['dismissed',true],['expired',true]]){
 test(`real ${state} handoff receipt stays distinct from pending`,async t=>{
  const x=fixture(t);await x.open();const {result}=await answerHandoff(x,{handoff:{state}});
  assert.equal(result.handed,false);assert.equal(result.closed,closed);assert.equal(result.state,state);assert.equal(result.dispatchState,'confirmed');
  assert.deepEqual(x.sent.map(s=>s.op),['session_open','session_handoff']);
 });
}

test('Android preflight rejection is not-sent and preserves its safe error code',async t=>{
 const x=fixture(t);await x.open();const {result}=await answerHandoff(x,{request:{state:'failed',action_executed:false,error:{code:'LOCALLY_PAUSED'}}});
 assert.deepEqual(result,{handed:false,closed:false,state:'failed',reason:'LOCALLY_PAUSED',dispatchState:'not_sent'});
});

test('unknown action receipt stays unknown even beside a conflicting pending state',async t=>{
 const x=fixture(t);await x.open();const {result}=await answerHandoff(x,{request:{state:'unknown',action_executed:true,error:{code:'ACTION_UNCONFIRMED'}},handoff:{state:'pending'}});
 assert.equal(result.handed,false);assert.equal(result.closed,false);assert.equal(result.state,'unknown');assert.equal(result.reason,'ACTION_UNCONFIRMED');
});

test('malformed lifecycle receipt and non-string error code cannot claim handoff or close',async t=>{
 const x=fixture(t);await x.open();const {result}=await answerHandoff(x,{request:{state:'failed',action_executed:false,error:{code:{unexpected:'text'}}}});
 assert.equal(result.reason,'handoff_unconfirmed');assert.equal(result.handed,false);assert.equal(result.closed,false);
 await x.open();const empty=await answerHandoff(x,{});assert.equal(empty.result.state,'unknown');assert.equal(empty.result.handed,false);assert.equal(empty.result.closed,false);
});

test('unsupported phones close only once and report closure only on its real receipt',async t=>{
 const x=fixture(t,{supported:false});await x.open();const waiting=x.driver.handoffSession({taskId:TASK});const command=await x.queue.wait(DEVICE);
 assert.equal(command.op,'session_close');assert.equal(command.taskId,TASK);x.queue.complete(DEVICE,command.id,{closed:true});
 assert.deepEqual(await waiting,{closed:true,state:'closed',reason:'unsupported',dispatchState:'confirmed',handed:false,handoffSupported:false});
 assert.deepEqual(x.sent.map(s=>s.op),['session_open','session_close']);
});

test('unsupported fallback close with a lost delivered reply stays unknown',async t=>{
 const x=fixture(t,{supported:false});await x.open();const waiting=x.driver.handoffSession({taskId:TASK});await x.queue.wait(DEVICE);
 const result=await waiting;assert.equal(result.closed,false);assert.equal(result.state,'unknown');assert.equal(result.reason,'outcome_unknown');assert.equal(result.dispatchState,'unknown');
 assert.equal((await x.driver.closeSession()).closed,false);assert.deepEqual(x.sent.map(s=>s.op),['session_open','session_close']);
});

test('a rejected close receipt cannot be reported as closure',async t=>{
 const x=fixture(t,{supported:false});await x.open();const waiting=x.driver.handoffSession({taskId:TASK});const command=await x.queue.wait(DEVICE);
 x.queue.complete(DEVICE,command.id,{request:{state:'failed',action_executed:false,error:{code:'SESSION_STALE'}}});
 const result=await waiting;assert.equal(result.closed,false);assert.equal(result.reason,'SESSION_STALE');assert.equal(result.dispatchState,'not_sent');
});

test('queue handoff metadata and envelope task identities must agree before any delivery',async t=>{
 const queue=new DisplayCommands({pollMs:15});t.after(()=>queue.close());
 for(const fields of [{taskId:null},{taskId:'different'}, {args:{...ARGS,title:'x'.repeat(41)}},{args:{...ARGS,summary:'x'.repeat(161)}}]){
  assert.throws(()=>queue.request({deviceId:DEVICE,op:'session_handoff',args:ARGS,session:SESSION,taskId:TASK,controlEpoch:3,timeoutMs:500,...fields}),error=>error.code==='invalid_input'&&error.dispatchState==='not_sent');
 }
 assert.equal(queue.queue.length,0);assert.equal(queue.pending.size,0);assert.equal(await queue.wait(DEVICE),null);
});
