import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import http from 'node:http';
import {startUiAuditServer,FIXTURE_IDS} from './ui-audit-server.mjs';

async function fixture(t) {
  const host=await startUiAuditServer({port:0,fallbackPort:false});t.after(()=>host.close());
  const session=await (await fetch(host.url+'/api/session')).json();
  const get=path=>fetch(host.url+path);
  const post=(path,body,headers={})=>fetch(host.url+path,{method:'POST',headers:{'Content-Type':'application/json','X-Boujoy-CSRF':session.csrf,...headers},body:JSON.stringify(body)});
  const control=body=>post('/__audit/control',body,{'X-UI-Audit-Control':'local-fixture'});
  return {host,get,post,control};
}

test('serves unchanged real UI assets and history/details with every audit state',async t=>{
  const {get}=await fixture(t);
  for(const file of ['index.html','app.js','app.css','robot-motion.js'])assert.equal(await (await get('/'+file)).text(),await readFile(new URL('../../web/'+file,import.meta.url),'utf8'));
  for(const file of ['robot-head-base.png','robot-eyes-atlas.png'])assert.deepEqual(Buffer.from(await (await get('/'+file)).arrayBuffer()),await readFile(new URL('../../web/assets/'+file,import.meta.url)));
  const state=await (await get('/api/state')).json();
  assert.equal(state.tasks.some(row=>row.roleId===FIXTURE_IDS.emptyRole),false);
  assert.equal(state.tasks.some(row=>row.id===FIXTURE_IDS.markdown),true);
  for(const id of Object.values(FIXTURE_IDS).filter(id=>id!==FIXTURE_IDS.emptyRole)) {
    const response=await get('/api/tasks/'+id);assert.equal(response.status,200,id);
    const task=await response.json();assert.ok(Array.isArray(task.messages)&&Array.isArray(task.events));
  }
  const payment=await (await get('/api/tasks/'+FIXTURE_IDS.payment)).json();
  assert.equal(payment.status,'ready_for_user');assert.equal(payment.checkout.totalFen,2650);assert.equal(payment.handoff.paymentSubmitted,false);
  const markdown=await (await get('/api/tasks/'+FIXTURE_IDS.markdown)).json();
  assert.match(markdown.result,/<script>/);assert.match(markdown.result,/\| 平台 \|/);assert.match(markdown.result,/```javascript/);
  const files=await (await get('/api/tasks/'+FIXTURE_IDS.attachments)).json();
  for(const artifact of files.artifacts){const response=await get('/api/artifacts/'+artifact.id);assert.equal((await response.arrayBuffer()).byteLength,artifact.size);assert.match(response.headers.get('content-disposition'),/^attachment/);}
});

test('slow acknowledgement is one accepted send and repeated request is deduplicated',async t=>{
  const {post,control,get}=await fixture(t);
  await control({action:'next-send',ackDelayMs:120,autoReply:false});
  const body={prompt:'慢回执合成测试',roleId:'concierge',clientRequestId:'same-send-id'};
  const first=post('/api/tasks',body);
  await new Promise(resolve=>setTimeout(resolve,35));
  const state=await (await get('/api/state')).json();
  assert.equal(state.tasks.filter(task=>task.prompt===body.prompt).length,1);
  const receipt=await (await first).json(),again=await (await post('/api/tasks',body)).json();
  assert.equal(receipt.id,again.id);
  const logs=await (await get('/__audit/logs')).json();
  assert.equal(logs.messageRequests,2);assert.equal(logs.acceptedMessages,1);assert.equal(logs.duplicateRequests,1);
  assert.equal((await post('/api/tasks',{...body,prompt:'不同请求内容'})).status,409);
});

test('failed send does not commit and lost receipt can be retried without new task',async t=>{
  const {post,control,get}=await fixture(t);
  await control({action:'next-send',failBeforeCommit:true});
  assert.equal((await post('/api/tasks',{prompt:'失败发送',clientRequestId:'failed'})).status,503);
  assert.equal((await (await get('/__audit/manifest')).json()).acceptedMessages,0);
  await control({action:'next-send',dropReceipt:true,autoReply:false});
  const body={prompt:'回执丢失',clientRequestId:'lost'};
  await assert.rejects(post('/api/tasks',body));
  assert.equal((await post('/api/tasks',body)).status,200);
  const logs=await (await get('/__audit/logs')).json();assert.equal(logs.acceptedMessages,1);assert.equal(logs.duplicateRequests,1);
});

test('progress, stop, unknown reconciliation, archive and temporary offline use HTTP contracts',async t=>{
  const {post,control,get}=await fixture(t);
  await control({action:'task',id:FIXTURE_IDS.running,progress:'新合成进展'});
  let task=await (await get('/api/tasks/'+FIXTURE_IDS.running)).json();assert.equal(task.messages.at(-1).content,'新合成进展');
  task=await (await post('/api/tasks/'+FIXTURE_IDS.running+'/stop',{})).json();assert.equal(task.status,'cancelled');
  assert.equal((await post('/api/tasks/'+FIXTURE_IDS.unknown+'/message',{prompt:'不要重复'})).status,409);
  task=await (await post('/api/tasks/'+FIXTURE_IDS.unknown+'/reconcile',{note:'确认没有发送'})).json();assert.equal(task.status,'needs_review');
  task=await (await post('/api/tasks/'+FIXTURE_IDS.archived+'/archive',{archived:false})).json();assert.equal(task.archived,false);
  await control({action:'offline',durationMs:120});assert.equal((await get('/api/state')).status,503);
  await new Promise(resolve=>setTimeout(resolve,160));assert.equal((await get('/api/state')).status,200);
  assert.equal((await (await get('/__audit/manifest')).json()).acceptedMessages,0);
});

test('host/origin/CSRF boundaries and unsupported APIs never forward to production',async t=>{
  const {host,get,post}=await fixture(t);
  assert.equal((await fetch(host.url+'/api/state',{headers:{Origin:'https://example.com'}})).status,403);
  const wrongHostStatus=await new Promise((resolve,reject)=>{http.get(host.url+'/api/state',{headers:{Host:'example.com'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject);});
  assert.equal(wrongHostStatus,403);
  assert.equal((await fetch(host.url+'/api/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await post('/api/secrets',{name:'deepseek',value:'synthetic-not-a-key'})).status,501);
  assert.equal((await get('/src/server.mjs')).status,404);
  assert.equal((await post('/api/phone/pair',{address:'https://example.com'})).status,404);
  assert.equal((await get('/__audit/logs')).status,200);
});
