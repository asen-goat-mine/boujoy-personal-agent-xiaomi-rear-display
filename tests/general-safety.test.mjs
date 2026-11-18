import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/phone-integration-fixture.mjs';
import {sendMatchesUserWords} from '../src/tools/broker.mjs';
const screen=title=>({ocr:{height:2000,lines:[{text:title,bounds:[100,100,600,180]}]}});
test('sending preserves the exact body and rejects fuzzy recipients and cross-message concatenation',()=>{
 const task={messages:[{role:'user',content:'给张三发“明天 10:30，可以吗？”'}]};
 assert.equal(sendMatchesUserWords(task,screen('张三'),'明天 10:30，可以吗？'),true);
 for(const title of ['张三三','张明三','李三'])assert.equal(sendMatchesUserWords(task,screen(title),'明天 10:30，可以吗？'),false);
 for(const body of ['明天1030可以吗','明天 10:30，可以吗！'])assert.equal(sendMatchesUserWords(task,screen('张三'),body),false);
 assert.equal(sendMatchesUserWords({messages:[{role:'user',content:'张三 AB'},{role:'user',content:'CD'}]},screen('张三'),'AB CD'),false);
});
// Direct user tasks: the Harness decides what to do next. A phone action whose receipt
// never came is not replayed by code; the model gets the screen as it is now and judges.
// Only when the screen cannot be read either does the step stay unknown and block.
test('an unconfirmed step is attempted once and the model is handed the current screen',async()=>{
 for(const args of [{action:'tap',textTargetId:'search'},{action:'tap',x:500,y:500},{action:'type',text:'上海',inputMode:'replace'}]){
  const f=fixture();await f.broker.execute('t','phone_open_app',{packageName:'com.example.weather'});
  const observation=f.phone.observation;let attempts=0;
  f.phone.actGeneral=async()=>{attempts++;throw Object.assign(Error('lost receipt'),{code:'outcome_unknown',dispatchState:'unknown',requestId:'original'});};
  const result=await f.broker.generalAction('t',{...args,observationId:observation.id});
  const receipt=JSON.parse(result.content[0].text);assert.equal(receipt.accepted,'unconfirmed');assert.match(receipt.message,/不要重复/);
  assert.equal(attempts,1,'never replayed by code');
  const row=f.data.actions.at(-1);assert.equal(row.status,'unknown');assert.equal(row.nativeRequestId,'original');assert.equal(row.resolution.kind,'navigation_observed');
  assert.notEqual(f.task.status,'unknown_result');assert.deepEqual(receipt.finishEvidenceRefs,[f.phone.observation.id]);
 }
});
test('an unconfirmed step whose screen cannot be read afterwards stays unknown and blocks the next phone action',async()=>{
 const f=fixture();await f.broker.execute('t','phone_open_app',{packageName:'com.example.weather'});
 const observation=f.phone.observation;let attempts=0;
 f.phone.actGeneral=async()=>{attempts++;throw Object.assign(Error('lost receipt'),{code:'outcome_unknown',dispatchState:'unknown',requestId:'original'});};
 f.broker.readGeneral=async()=>{throw Error('phone unreachable');};
 const args={action:'tap',observationId:observation.id,textTargetId:'search'};
 await assert.rejects(f.broker.generalAction('t',args),{code:'outcome_unknown'});
 assert.equal(attempts,1);assert.equal(f.data.actions.at(-1).status,'unknown');assert.equal(f.data.actions.at(-1).resolution,undefined);
 await assert.rejects(f.broker.generalAction('t',args),{code:'outcome_unknown'});
 assert.equal(attempts,1,'never replayed');
});
test('a step refused because an earlier one is still unconfirmed is tried again after a short wait, not handed to the model',async()=>{
 const f=fixture();await f.broker.execute('t','phone_open_app',{packageName:'com.example.weather'});f.broker.phoneFenceWaitMs=1;
 const observation=f.phone.observation;let attempts=0;
 f.phone.actGeneral=async()=>{attempts++;if(attempts<3)throw Object.assign(Error('fenced'),{code:'outcome_unknown',dispatchState:'not_sent'});return {accepted:true};};
 const result=await f.broker.generalAction('t',{action:'tap',observationId:observation.id,textTargetId:'search'});
 assert.equal(JSON.parse(result.content[0].text).accepted,true);assert.equal(attempts,3);assert.equal(f.data.actions.at(-1).status,'completed');
});
test('a window mismatch is reported without replaying a text or coordinate tap',async()=>{
 const refuse=()=>Object.assign(Error('moved'),{code:'action_cancelled',dispatchState:'not_sent',phoneuseCode:'WINDOW_MISMATCH'});
 const f=fixture();await f.broker.execute('t','phone_open_app',{packageName:'com.example.weather'});
 const target=f.phone.observation.ocr.lines.find(l=>l.id==='search');let attempts=0;f.phone.actGeneral=async()=>{attempts++;throw refuse();};
 for(const args of [{action:'tap',observationId:f.phone.observation.id,textTargetId:'search'},{action:'tap',observationId:f.phone.observation.id,x:target.center.x,y:target.center.y}]){
  const before=attempts;const reply=JSON.parse((await f.broker.generalAction('t',args)).content[0].text);assert.equal(reply.recovered,false);assert.equal(reply.code,'screen_changed','the model gets the fresh screen in the same call');assert.equal(attempts,before+1,'one attempt per model call');
  assert.equal(f.data.actions.at(-1).status,'not_executed');
 }
 assert.notEqual(f.task.status,'blocked','moving screens do not end the task; the model looks again');
});
test('a definitive not-sent input is recorded as not executed and not retried',async()=>{
 const f=fixture();await f.broker.execute('t','phone_open_app',{packageName:'com.example.weather'});let attempts=0;
 f.phone.actGeneral=async()=>{attempts++;throw Object.assign(Error('input'),{code:'phone_input_unavailable',dispatchState:'not_sent',requestId:'attempt-'+attempts});};
 await assert.rejects(f.broker.generalAction('t',{action:'type',observationId:f.phone.observation.id,text:'上海',inputMode:'replace'}),{code:'phone_input_unavailable'});
 assert.equal(attempts,1);assert.equal(f.data.actions.at(-1).status,'not_executed');assert.equal(f.data.actions.at(-1).nativeRequestId,'attempt-1');
});

test('wireless input never retries delivery timeouts or possible post-commit failures',async()=>{
 for(const result of [{status:'submitted'},{status:'failed',diagnostic:'commit_timeout'},{status:'failed',diagnostic:'commit_exception'},{status:'failed',diagnostic:'editor_changed_after_commit'},{status:'failed'}]){
  const f=fixture();let requests=0;f.phone.ime={request:async()=>{requests++;return {id:'ime-original',...result};}};
  await assert.rejects(f.phone.typeWithIme({text:'原文',inputMode:'replace'},{packageName:'com.tencent.mm'}),{code:'outcome_unknown',dispatchState:'unknown',requestId:'ime-original'});
  assert.equal(requests,1);assert.equal(f.calls.length,0,'no speculative focus tap');
 }
});
test('wireless input retries only a definitive pre-commit replace failure and requires a typed receipt',async()=>{
 const f=fixture(),requests=[];f.phone.ime={request:async args=>{requests.push(args);return requests.length===1?{status:'failed',diagnostic:'prepare_exception'}:{status:'typed'};}};
 const result=await f.phone.typeWithIme({text:'原文',inputMode:'replace'},{packageName:'com.tencent.mm'});
 assert.deepEqual(requests.map(row=>row.mode),['replace','insert']);assert.equal(JSON.parse(result.content[0].text).result.verified,true);assert.equal(f.calls.length,0);
});
