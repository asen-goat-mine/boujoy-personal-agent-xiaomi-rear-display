import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {GroupService} from '../src/core/groups.mjs';
import {requestGroupDecision} from '../src/core/group-coordinator.mjs';

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-group-decision-'));
 const store=new Store(dir),secrets={get:async()=>'isolated-test-key'};
 const engine=new Engine({store,secrets,broker:{calls:new Map(),phone:{release(){}},approvals:{cancelTask(){}}},memory:{}});
 engine.pump=async()=>{};
 const groups=engine.groups,group=groups.create({name:'公开项目组',memberRoleIds:['work','life'],coordinatorRoleId:'life'});
 const input=(content,extra={})=>({content,cloudConsent:true,clientRequestId:randomUUID(),...extra});
 const send=request=>groups.send(group.id,request);
 t.after(()=>{groups.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,store,secrets,engine,groups,group,input,send};
}

test('one isolated HTTP classification can keep an unmentioned group message truly silent, counted and private',async t=>{
 const f=fixture(t),calls=[];
 f.store.transaction(s=>{const role=s.roles.find(r=>r.id==='life');role.notes=[{text:'private-note-canary'}];role.instruction='private-instruction-canary';});
 f.engine.create({prompt:'private-chat-canary',cloudConsent:false});
 const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;calls.push(JSON.parse(body));assert.equal(req.headers['x-api-key'],'isolated-test-key');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({type:'message',role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:'{"decision":"ignore"}'}],usage:{input_tokens:12,output_tokens:4}}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 f.groups.coordinator.request=options=>requestGroupDecision({...options,fetchImpl:(url,request)=>{assert.equal(url,'https://api.deepseek.com/anthropic/v1/messages');return fetch(`http://127.0.0.1:${server.address().port}`,request);}});
 const request=f.input('本段作为群记录，原操作另外安排。'),before=f.store.data.tasks.length;
 const first=f.send(request);assert.equal(first.coordinatorStatus,'pending');assert.deepEqual(first.taskIds,[]);
 assert.equal(f.send(request).deduplicated,true);await f.groups.coordinator.tail;
 const detail=f.groups.detail(f.group.id);assert.equal(calls.length,1);assert.equal(detail.messages.length,1);assert.equal(detail.messages[0].content,request.content);assert.equal(detail.messages[0].coordinatorStatus,'ignored');assert.deepEqual(detail.tasks,[]);assert.deepEqual(detail.receipts,[]);assert.equal(f.store.data.tasks.length,before);
 const audit=f.store.data.groupDecisions[0];assert.equal(audit.status,'ignored');assert.equal(audit.coordinatorRoleId,'life');assert.equal(audit.candidate,undefined);assert.equal(audit.usage.status,'reported');assert.equal(f.store.data.modelBudgetReservations.filter(r=>r.source==='group_decision').length,1);assert.equal(f.store.data.usage.requests,1);
 const body=calls[0];assert.equal(body.tools,undefined);assert.equal(body.messages.length,1);assert.deepEqual(JSON.parse(body.messages[0].content),{group:'公开项目组',coordinator:'生活管家',recent:[],message:request.content});
 for(const marker of ['private-chat-canary','private-note-canary','private-instruction-canary'])assert.ok(!JSON.stringify(body).includes(marker));
 assert.equal(JSON.stringify(detail).includes('candidateHash'),false);assert.equal(f.groups.messageReceipt(f.group.id,request.clientRequestId).status,'ignored');f.send(request);await f.groups.coordinator.tail;assert.equal(calls.length,1);
});

test('take dispatches once to the stored coordinator on the original message, deadline and permissions',async t=>{
 const f=fixture(t);let calls=0;f.groups.coordinator.request=async()=>{calls++;return 'take';};
 const request=f.input('请核对这项公开工作。'),sent=f.send(request),candidate=structuredClone(f.store.data.groupDecisions[0].candidate);
 assert.deepEqual(sent.taskIds,[]);await f.groups.coordinator.tail;
 const receipt=f.groups.messageReceipt(f.group.id,request.clientRequestId),task=f.store.task(receipt.taskId);
 assert.equal(task.id,candidate.id);assert.equal(task.roleId,'life');assert.equal(task.prompt,request.content);assert.equal(task.groupContext.messageId,sent.id);assert.equal(task.memoryConsent,candidate.memoryConsent);assert.equal(task.memoryMode,candidate.memoryMode);assert.deepEqual(task.taskContract,candidate.taskContract);assert.equal(task.deadlineAt,candidate.deadlineAt);
 f.send(request);await f.groups.coordinator.tail;assert.equal(calls,1);assert.equal(f.groups.detail(f.group.id).tasks.length,1);assert.equal(f.store.data.groupDecisions[0].status,'taken');
 const named=f.send(f.input('@工作伙伴 请核对另一项'));assert.equal(f.store.task(named.taskIds[0]).roleId,'work');assert.equal(f.store.data.groupDecisions.length,1);
 const chosen=f.send(f.input('请核实',{recipientRoleIds:['work']}));assert.equal(f.store.task(chosen.taskIds[0]).roleId,'work');assert.equal(calls,1);
});

test('missing consent, key or daily budget keeps the original visible with a distinct state and makes zero cloud requests',async t=>{
 for(const kind of ['consent','key','budget']){
  const f=fixture(t);let calls=0;f.groups.coordinator.request=async()=>{calls++;return 'take';};
  if(kind==='key')f.secrets.get=async()=>null;if(kind==='budget')f.store.transaction(s=>s.settings.dailyModelRequests=0);
  const request=f.input('一条待判断的群消息',{cloudConsent:kind!=='consent'});f.send(request);await f.groups.coordinator.tail;
  const expected={consent:'needs_consent',key:'needs_setup',budget:'budget_limited'}[kind];assert.equal(calls,0);assert.equal(f.store.data.groupDecisions[0].status,expected);assert.equal(f.groups.messageReceipt(f.group.id,request.clientRequestId).status,expected);assert.deepEqual(f.groups.detail(f.group.id).receipts,[]);
 }
});

test('wrong output, provider errors, and an interrupted paid request cannot become ignore, take or an automatic retry',async t=>{
 for(const kind of ['format','failure','restart']){
  const f=fixture(t);let calls=0,entered,release;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  f.groups.coordinator.request=async()=>{calls++;entered();await gate;if(kind==='failure')throw Error('fixture failure');return kind==='format'?'take-and-send':'take';};
  const request=f.input('临时记录');f.send(request);await started;
  let reopened;if(kind==='restart'){f.groups.close();reopened=new GroupService({store:f.store,engine:f.engine,requestDecision:()=>assert.fail('paid decision must never be replayed')});}
  release();await f.groups.coordinator.tail;if(reopened)await reopened.coordinator.tail;
  const service=reopened||f.groups;assert.equal(service.messageReceipt(f.group.id,request.clientRequestId).status,kind==='restart'?'interrupted':'unavailable');service.send(f.group.id,request);await service.coordinator.tail;assert.equal(calls,1);assert.equal(f.store.data.tasks.length,0);assert.equal(f.store.data.groupReceipts.length,0);reopened?.close();
 }
});

test('membership, group identity, original message, recovery fence and phone control are rechecked before dispatch',async t=>{
 for(const kind of ['role','coordinator','archive','content','fence','epoch','cloud']){
  const f=fixture(t);let entered,release;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);let epoch=7;
  f.engine.remoteControlState=()=>({paused:false,controlEpoch:epoch});f.store.transaction(s=>s.settings.chatCloudConsent=true);
  f.groups.coordinator.request=async()=>{entered();await gate;return 'take';};
  const request=f.input('只回应这个群的这一条消息'),deviceId=randomUUID();f.groups.send(f.group.id,request,{deviceId,remoteControlEpoch:7});await started;
  if(kind==='epoch')epoch++;
  f.store.transaction(s=>{if(kind==='role')s.roles.find(r=>r.id==='life').hidden=true;if(kind==='coordinator')s.groups[0].coordinatorRoleId='work';if(kind==='archive')s.groups[0].archivedAt=new Date().toISOString();if(kind==='content')s.groupMessages[0].content='替换来源';if(kind==='fence')s.recoveryFence={required:true};if(kind==='cloud')s.settings.chatCloudConsent=false;});
  release();await f.groups.coordinator.tail;assert.equal(f.store.data.tasks.length,0,kind);assert.equal(f.store.data.groupDecisions[0].status,'revoked',kind);assert.equal(f.store.data.groupReceipts.length,0);
 }
});

test('revocation during credential lookup prevents any model request, and provider output cannot supply a tool, target or extra field',async t=>{
 const f=fixture(t);let entered,release;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 f.secrets.get=async()=>{entered();await gate;return 'isolated-test-key';};f.groups.coordinator.request=()=>assert.fail('revocation must happen before egress');
 f.send(f.input('群消息'));await started;f.store.transaction(s=>s.groups[0].coordinatorRoleId='work');release();await f.groups.coordinator.tail;assert.equal(f.store.data.groupDecisions[0].status,'revoked');assert.equal(f.store.data.usage.requests,0);
 for(const content of [[{type:'tool_use',name:'group_handoff'}],[{type:'text',text:'{"decision":"take","roleId":"another"}'}],[{type:'text',text:'{"decision":"take"}'},{type:'text',text:'extra'}]]){
  await assert.rejects(requestGroupDecision({key:'test',context:{message:'synthetic'},onUsage(){},fetchImpl:async()=>Response.json({type:'message',role:'assistant',stop_reason:'end_turn',content})}));
 }
});

test('one deadline bounds both an unresponsive credential lookup and provider; a late take cannot dispatch',async t=>{
 for(const stage of ['credential','provider']){
  const f=fixture(t);let release,calls=0;const pending=new Promise(resolve=>release=resolve);
  if(stage==='credential')f.secrets.get=()=>pending;
  f.groups.coordinator.request=async()=>{calls++;return pending;};
  f.store.transaction(s=>{s.settings.maxTaskMinutes=20;});// a bounded deadline; unlimited is the default
  const request=f.input('需要判断的群消息');f.send(request);const end=Date.parse(f.store.data.groupDecisions[0].candidate.deadlineAt);
  f.engine.clock=()=>end-20;const keepAlive=setTimeout(()=>{},500);
  try{await f.groups.coordinator.tail;}finally{clearTimeout(keepAlive);}
  assert.equal(f.store.data.groupDecisions[0].status,'interrupted');release('take');await Promise.resolve();
  assert.equal(f.store.data.tasks.length,0);assert.equal(calls,stage==='credential'?0:1);
 }
});

test('a short follow-up is classified with the messages before it, by name and without ids',async t=>{
 const f=fixture(t);const calls=[];
 f.groups.coordinator.request=async({context})=>{calls.push(context);return 'take';};
 const first=f.input('帮我写一份优化方案');f.send(first);await f.groups.coordinator.tail;
 const second=f.input('放桌面');f.send(second);await f.groups.coordinator.tail;
 const last=calls.at(-1);assert.equal(last.message,'放桌面');
 assert.ok(last.recent.some(row=>row.from==='用户'&&row.text==='帮我写一份优化方案'),'the earlier request is visible');
 assert.ok(last.recent.every(row=>!('id' in row)&&!('roleId' in row)));
});

test('a decision that hangs in one group does not hold up another group; order inside a group is kept',async t=>{
 const f=fixture(t),other=f.groups.create({name:'另一个群',memberRoleIds:['work','life'],coordinatorRoleId:'life'});
 const started=[];let release;const gate=new Promise(resolve=>{release=resolve;});
 f.groups.coordinator.request=async({context})=>{const text=JSON.stringify(context);const tag=['A2','B1','A1'].find(name=>text.includes(name));started.push(tag);if(tag==='A1')await gate;return 'ignore';};
 f.send(f.input('A1 一条待判断的群消息'));f.send(f.input('A2 另一条待判断的群消息'));
 f.groups.send(other.id,f.input('B1 另一个群的消息'));
 for(let n=0;n<100&&started.length<2;n++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.deepEqual(started,['A1','B1'],'the other group was classified while the first was still waiting');
 release();await f.groups.coordinator.tail;assert.deepEqual(started,['A1','B1','A2']);
});
