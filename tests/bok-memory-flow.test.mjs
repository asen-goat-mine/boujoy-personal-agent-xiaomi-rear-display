import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../src/core/store.mjs';import {Engine} from '../src/core/engine.mjs';import {HarnessRun} from '../src/adapters/harness.mjs';
function setup(t,memory){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bok-flow-')),store=new Store(dir),broker={calls:new Map(),approvals:{cancelTask(){}},phone:{release(){}}};const engine=new Engine({store,broker,memory,secrets:{get:async()=>''}});t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {store,engine};}
test('queue keeps failed learning and backs off; receipt retry is not lost',async t=>{const {store,engine}=setup(t,{observe:async()=>{throw Error('offline');}});store.transaction(s=>s.outbox.push({id:'q',conversationId:'c',turnId:'m',createdAt:new Date().toISOString(),memoryMode:'default',attempts:0}));await engine.flushMemory();assert.equal(store.data.outbox.length,1);assert.equal(store.data.outbox[0].attempts,1);assert.ok(Date.parse(store.data.outbox[0].nextAttemptAt)>Date.now());});
test('authorization is captured per message and rechecked against fresh state during learning',async t=>{let payload;const {store,engine}=setup(t,{observe:async p=>{payload=p;assert.equal(p.isAuthorized(),true);store.updateTask('c',x=>x.memoryConsent=false);assert.equal(p.isAuthorized(),false);}});store.transaction(s=>{s.tasks.push({id:'c',memoryConsent:true,cloudConsent:true,memoryMode:'default',messages:[{id:'m',role:'user',content:'native turn'}]});s.outbox.push({id:'q',conversationId:'c',turnId:'m',createdAt:new Date().toISOString(),memoryMode:'default',learningConsent:true});});await engine.flushMemory();assert.equal(payload.content,'native turn');assert.equal(payload.authorized,true);assert.equal(store.data.outbox.length,0);});
test('legacy receipts and non-user content do not gain new learning permission',async t=>{let payload;const {store,engine}=setup(t,{observe:async p=>payload=p});store.transaction(s=>{s.tasks.push({id:'c',memoryConsent:true,cloudConsent:true,memoryMode:'default',messages:[{id:'m',role:'assistant',content:'not user input'}]});s.outbox.push({id:'q',conversationId:'c',turnId:'m',createdAt:new Date().toISOString(),memoryMode:'default'});});await engine.flushMemory();assert.equal(payload.content,'');assert.equal(payload.authorized,false);});
test('actual engine injects minimal Bok context only when task memory is authorized',async t=>{
 const old=HarnessRun.prototype.start;let prompt='',reads=0;HarnessRun.prototype.start=async function(){prompt=this.prompt;};t.after(()=>HarnessRun.prototype.start=old);
 const {store,engine}=setup(t,{observe:async()=>{},personal:{context:async()=>{reads++;return {context:'[P1] synthetic learned preference'};}}});
 for(const consent of [true,false]){const task=engine.newTask({prompt:'请按我的习惯解释',cloudConsent:true,memoryConsent:consent});store.transaction(s=>s.tasks.push(task));await engine.run(task.id,{controller:new AbortController(),token:'local-test-token'});assert.equal(prompt.includes('synthetic learned preference'),consent);}
 assert.equal(reads,1);
});

test('without the optional Bok core the Markdown cards still reach the model and no memory error is logged',async t=>{
 const old=HarnessRun.prototype.start;let prompt='';HarnessRun.prototype.start=async function(){prompt=this.prompt;};t.after(()=>HarnessRun.prototype.start=old);
 const {store,engine}=setup(t,{observe:async()=>{},context:async()=>({context:'[K1] synthetic markdown card'})});
 const task=engine.newTask({prompt:'请按我的习惯解释',cloudConsent:true,memoryConsent:true});store.transaction(s=>s.tasks.push(task));await engine.run(task.id,{controller:new AbortController(),token:'local-test-token'});
 assert.match(prompt,/synthetic markdown card/);assert.equal(store.task(task.id).events.some(e=>e.type==='memory_unavailable'),false);
});

test('files disabled skips personal context and leaves learning outbox untouched while prompt reports switches',async t=>{
 let reads=0,writes=0,prompt='';const {store,engine}=setup(t,{observe:async()=>writes++,personal:{context:async()=>{reads++;return {context:'private'};}}});engine.pump=async()=>{};
 engine.runFactory=options=>({async start(){prompt=options.prompt;},async stop(){},async dispose(){}});store.transaction(s=>{s.settings.filesEnabled=false;s.settings.browserEnabled=false;});
 const task=engine.create({prompt:'请按我的习惯解释',cloudConsent:true,memoryConsent:true});const before=structuredClone(store.data.outbox);await engine.run(task.id,{controller:new AbortController(),token:'local-test-token'});await engine.flushMemory();
 assert.equal(reads,0);assert.equal(writes,0);assert.deepEqual(store.data.outbox,before);assert.match(prompt,/(?:executionPermissions.*|已启用能力：)\{?"browserEnabled":false,"filesEnabled":false,"phoneEnabled":false/);assert.ok(!prompt.includes('private'));
});

test('revoked then re-enabled files permission discards in-flight personal context before any model start',async t=>{
 let release,started,starts=0;const ready=new Promise(resolve=>started=resolve),pending=new Promise(resolve=>release=resolve);
 const {store,engine}=setup(t,{observe:async()=>{},personal:{context:async()=>{started();await pending;return {context:'must not leave Mac'};}}});engine.pump=async()=>{};engine.runFactory=()=>({async start(){starts++;},async stop(){},async dispose(){}});
 const task=engine.create({prompt:'请按我的习惯解释',cloudConsent:true,memoryConsent:true}),run=engine.run(task.id,{controller:new AbortController(),token:'local-test-token'});await ready;
 store.transaction(s=>{s.settings.filesEnabled=false;s.settings.executionEpochs.files++;});store.transaction(s=>{s.settings.filesEnabled=true;s.settings.executionEpochs.files++;});release();await run;
 assert.equal(starts,0);assert.equal(store.task(task.id).status,'failed');assert.match(store.task(task.id).blockedReason,/授权已变化/);assert.ok(store.task(task.id).executionDomains.includes('files'));
});

test('in-flight learning keeps stable receipt after file revocation and never treats re-enable as old authorization',async t=>{
 let release,started,payload,calls=0;const ready=new Promise(resolve=>started=resolve),pending=new Promise(resolve=>release=resolve);
 const {store,engine}=setup(t,{observe:async p=>{calls++;payload=p;started();await pending;assert.equal(p.isAuthorized(),false);}});engine.pump=async()=>{};
 store.transaction(s=>{s.tasks.push({id:'c',status:'completed',memoryConsent:true,cloudConsent:true,memoryMode:'default',messages:[{id:'m',role:'user',content:'native turn'}]});s.outbox.push({id:'q',conversationId:'c',turnId:'m',createdAt:new Date().toISOString(),memoryMode:'default',learningConsent:true});});
 const run=engine.flushMemory();await ready;assert.equal(payload.authorized,true);store.transaction(s=>{s.settings.filesEnabled=false;s.settings.executionEpochs.files++;});store.transaction(s=>{s.settings.filesEnabled=true;s.settings.executionEpochs.files++;});release();await run;
 assert.equal(calls,1);assert.equal(store.data.outbox.length,1);assert.equal(store.data.outbox[0].id,'q');assert.equal(store.data.outbox[0].attempts,undefined,'permission revocation is not a retryable provider failure');
});

test('the matching knowledge cards ride along with personal context when memory is allowed',async t=>{
 const old=HarnessRun.prototype.start;let prompt='';HarnessRun.prototype.start=async function(){prompt=this.prompt;};t.after(()=>HarnessRun.prototype.start=old);
 let cardReads=0;const {store,engine}=setup(t,{observe:async()=>{},context:async query=>{cardReads++;assert.match(query,/淘宝/);return {context:'[03-Knowledge/platforms/platform-status.md; device-test; 2026-11-07]\n淘宝搜索结果顶部有广告位'};},personal:{context:async()=>({context:'[P1] synthetic learned preference'})}});
 store.transaction(s=>{s.settings.memoryEnabled=true;});
 for(const consent of [true,false]){const task=engine.newTask({prompt:'帮我在淘宝比一下充电宝',cloudConsent:true,memoryConsent:consent});store.transaction(s=>s.tasks.push(task));await engine.run(task.id,{controller:new AbortController(),token:'local-test-token'});assert.equal(prompt.includes('淘宝搜索结果顶部有广告位'),consent);assert.equal(prompt.includes('知识库相关卡片'),consent);}
 assert.equal(cardReads,1);
});
