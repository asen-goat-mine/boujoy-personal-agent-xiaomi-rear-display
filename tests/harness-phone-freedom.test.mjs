// 2026-11-07: for a direct user task the Harness decides which app, which
// control and when the task is finished. Code no longer classifies business
// intent (send / delete / pay / checkout) or rejects a finish by a fixed
// evidence rule. What code still guarantees: nothing is replayed, an
// unconfirmed action blocks the next one, and pause, stop, the phone switch
// and an unknown receipt stop dispatch.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/phone-integration-fixture.mjs';
import {createTaskContract} from '../src/core/task-contract.mjs';

const line=(id,text,y)=>({id,text,bounds:[100,y,600,y+60],center:{x:350,y:y+30}});
const screen=(pkg,lines)=>({tree:{content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:pkg+'/Activity',windowPkg:pkg,window:'main',tree:'window pkg='+pkg+' bounds=0,0,1000,2000\n'+lines.map(l=>`Button "${l.text}" clickable bounds=${l.bounds.join(',')}`).join('\n')}})}]},ocr:{width:1000,height:2000,lines}});
const object=r=>r.content.filter(c=>c.type==='text').map(c=>{try{return JSON.parse(c.text);}catch{return null;}}).filter(Boolean);
const taps=f=>f.calls.filter(c=>c.name==='tap').length;

test('a direct user task can tap any visible control the model chooses, including send, delete and pay',async()=>{
 for(const label of ['发送','删除','立即支付','提交订单']){
  const f=fixture({prompt:'打开天气，查看天气',current:screen('com.example.weather',[line('guarded',label,900)])});
  await f.broker.execute('t','phone_use',{action:'open_app',app:'天气'});
  assert.equal(f.task.phoneUseScope.decisionOwner,'harness');
  const head=object(await f.broker.execute('t','phone_use',{action:'tap',target:label}))[0];
  assert.equal(head.accepted,true,label);assert.ok(head.actionId,label);assert.equal(taps(f),1,label);
  const row=f.data.actions.find(a=>a.id===head.actionId);assert.equal(row.status,'completed');assert.equal(row.authorization,'harness');
  assert.equal(f.counts().approvals,0,'no per-click approval');
 }
});

test('pause, the phone switch and an unknown receipt still stop dispatch',async()=>{
 const ready=async()=>{const f=fixture({prompt:'打开天气，查看天气',current:screen('com.example.weather',[line('x','详情',900)])});await f.broker.execute('t','phone_use',{action:'open_app',app:'天气'});return f;};
 {const f=await ready();f.task.status='paused';await assert.rejects(f.broker.execute('t','phone_use',{action:'tap',target:'详情'}));assert.equal(taps(f),0);}
 {const f=await ready();f.data.settings.phoneEnabled=false;await assert.rejects(f.broker.execute('t','phone_use',{action:'tap',target:'详情'}));assert.equal(taps(f),0);}
 {const f=await ready();f.data.actions.push({id:'earlier',taskId:'t',tool:'phone_action',status:'unknown'});
  await assert.rejects(f.broker.execute('t','phone_use',{action:'tap',target:'详情'}),{code:'outcome_unknown'});assert.equal(taps(f),0);
  assert.equal(f.data.actions.find(a=>a.id==='earlier').status,'unknown','the unknown receipt is kept, not rewritten');}
});

test('a stopped run cannot dispatch even when the model still calls the tool',async()=>{
 const f=fixture({prompt:'打开天气，查看天气',current:screen('com.example.weather',[line('x','详情',900)])});
 await f.broker.execute('t','phone_use',{action:'open_app',app:'天气'});
 const stop=new AbortController();stop.abort();
 await assert.rejects(f.broker.execute('t','phone_use',{action:'tap',target:'详情'},stop.signal));
 assert.equal(taps(f),0);
});

test('the model decides when the task is finished and reports it with the evidence it saw',async()=>{
 const f=fixture({prompt:'打开天气，看看上海',current:screen('com.example.weather',[line('temp','上海 18°C',500)])});
 const opened=object(await f.broker.execute('t','phone_use',{action:'open_app',app:'天气'}));
 const evidence=f.phone.observation.id;assert.ok(opened.length);
 await f.broker.execute('t','finish_task',{outcome:'completed',summary:'上海现在 18°C。',evidence:[evidence]});
 assert.equal(f.task.status,'completed');assert.equal(f.task.report.summary,'上海现在 18°C。');
});

test('a direct user task that asked to end on the home screen finishes on the model\'s word in full Harness mode',async()=>{
 const f=fixture({prompt:'打开天气看看上海，看完回到桌面',current:screen('com.example.weather',[line('temp','上海 18°C',500)])});
 f.task.taskContract=createTaskContract(f.task);assert.equal(f.task.taskContract.objects.systemNavigation,'home');
 await f.broker.execute('t','phone_use',{action:'open_app',app:'天气'});
 const evidence=f.phone.observation.id;
 f.data.settings.harnessFull=true;
 await f.broker.execute('t','finish_task',{outcome:'completed',summary:'上海 18°C，已回到桌面。',evidence:[evidence]});
 assert.equal(f.task.status,'completed');
});
