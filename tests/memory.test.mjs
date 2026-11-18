import test from 'node:test';
import {NEEDS_BOK} from './helpers/requirements.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalMemory, renderCard, parseCard } from '../src/adapters/memory.mjs';
import { Broker, TOOL_DEFINITIONS } from '../src/tools/broker.mjs';

function fixture(t){
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pa-memory-test-')));const root=path.join(base,'vault');fs.mkdirSync(root);
  for(const dir of ['00-System','01-Personal','02-Projects','03-Knowledge/workflows','03-Knowledge/platforms','04-Routines','07-Inbox','90-Archive','98-Templates','.bok'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  fs.writeFileSync(path.join(root,'00-System/Memory-Protocol.md'),renderCard({protocol_id:'boujoy-personal-memory',protocol_version:1,scope:'personal-agent'},'Local protocol'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));const memory=new PersonalMemory({root,runtime:path.join(base,'runtime')});return {root,base,memory};
}
function card(root,rel,meta={},body='外卖选择：比较配送费与餐品规格。'){
  const base={id:path.basename(rel),title:'外卖比价',type:'knowledge',memory_kind:'workflow',scope:'personal-agent',status:'active',updated:'2026-01-01',source_type:'test-fixture',verification:'design',concept_key:rel};
  const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,renderCard({...base,...meta},body));return file;
}
const proposal={conceptKey:'food.spice',kind:'preference',title:'用餐口味',summary:'仅在测试场景中偏好微辣。',appliesTo:'合成测试，不是真实用户偏好。'};
const provenance={taskId:'synthetic-task',evidenceRefs:['synthetic-message']};

test('reads live Markdown, excludes candidates/templates/archive/other scopes and expired data',async t=>{
  const {root,memory}=fixture(t);const file=card(root,'03-Knowledge/workflows/food.md');
  for(const rel of ['07-Inbox/candidate.md','90-Archive/old.md','98-Templates/template.md','.bok/private.md'])card(root,rel);
  card(root,'01-Personal/foreign.md',{scope:'original-brain'});card(root,'01-Personal/inactive.md',{status:'candidate'});card(root,'01-Personal/expired.md',{expires_at:'2020-01-01T00:00:00Z'});card(root,'01-Personal/future.md',{updated:'2099-01-01'});
  let found=await memory.context('外卖配送费');assert.equal(found.sources.length,1);assert.equal(found.sources[0].path,'03-Knowledge/workflows/food.md');
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('比较配送费','重新核实配送费'));
  const fresh=await memory.context('外卖配送费');assert.match(fresh.context,/重新核实/);assert.notEqual(fresh.sources[0].hash,found.sources[0].hash);
  fs.unlinkSync(file);assert.equal((await memory.context('外卖')).sources.length,0);
});
test('fails closed on incompatible roots and ignores links to another vault',async t=>{
  const {root,base,memory}=fixture(t);const external=path.join(base,'outside.md');fs.writeFileSync(external,'外卖 SECRET_OTHER_VAULT');
  fs.symlinkSync(external,path.join(root,'01-Personal/link.md'));assert.equal((await memory.context('外卖')).sources.length,0);
  assert.throws(()=>memory.read('../outside.md'));assert.throws(()=>memory.read('01-Personal/link.md'));
  fs.writeFileSync(path.join(root,'00-System/Memory-Protocol.md'),'# wrong root');assert.equal((await memory.health()).connected,false);await assert.rejects(memory.context('外卖'));
});
test('conflicting active concepts are excluded rather than silently selecting one',async t=>{
  const {root,memory}=fixture(t);card(root,'01-Personal/a.md',{concept_key:'food.spice'});card(root,'01-Personal/b.md',{concept_key:'food.spice'});
  const result=await memory.context('外卖');assert.deepEqual(result.conflicts,['food.spice']);assert.equal(result.sources.length,0);
});
test('bounded Chinese retrieval returns provenance and never makes network calls',async t=>{
  const {root,memory}=fixture(t);for(let i=0;i<5;i++)card(root,`03-Knowledge/workflows/${i}.md`,{},'外卖配送费。'.repeat(500));
  const result=await memory.context('外卖配送费',{limit:3,tokenBudget:1500});assert.equal(result.sources.length,3);assert.ok(Buffer.byteLength(result.context)<=1500);assert.ok(result.sources.every(s=>s.hash&&s.truncated));assert.equal(result.cloudRequestSent,false);
});
test('candidates deduplicate and never enter context until explicit review',async t=>{
  const {memory}=fixture(t);const result=await memory.propose(proposal,provenance);assert.equal(result.status,'candidate');assert.equal((await memory.propose(proposal,provenance)).id,result.id);assert.equal(memory.proposals().length,1);assert.equal((await memory.context('用餐口味微辣')).sources.length,0);
  const pending=memory.proposals()[0];await assert.rejects(memory.review(result.id,{decision:'accept',expectedHash:'wrong'}),{code:'memory_conflict'});
  const saved=await memory.review(result.id,{decision:'accept',expectedHash:pending.hash});assert.equal(saved.path,'01-Personal/food.spice.md');assert.equal(memory.proposals().length,0);assert.equal((await memory.context('用餐口味微辣')).sources.length,1);
});
test('updating a concept protects concurrent Bok edits and retains the old version',async t=>{
  const {root,base,memory}=fixture(t);const file=card(root,'01-Personal/food.spice.md',{concept_key:'food.spice'},'原有口味说明');
  const p=await memory.propose(proposal,provenance);const pending=memory.proposals()[0];const oldHash=pending.existing[0].hash;fs.appendFileSync(file,'\nBok 新编辑\n');
  await assert.rejects(memory.review(p.id,{decision:'accept',expectedHash:pending.hash,expectedTargetHash:oldHash}),{code:'memory_conflict'});assert.match(fs.readFileSync(file,'utf8'),/Bok 新编辑/);
  await memory.review(p.id,{decision:'accept',expectedHash:pending.hash,expectedTargetHash:memory.read('01-Personal/food.spice.md').hash});
  const versions=fs.readdirSync(path.join(base,'runtime/versions')).filter(f=>f.endsWith('.md')).map(f=>fs.readFileSync(path.join(base,'runtime/versions',f),'utf8'));assert.ok(versions.some(v=>v.includes('Bok 新编辑')));
  assert.equal((await memory.context('微辣')).sources.length,1);
});
test('rejected proposals remain out of context, receipts are idempotent and content-free',async t=>{
  const {memory,base}=fixture(t);const p=await memory.propose(proposal,provenance);await memory.review(p.id,{decision:'reject',expectedHash:memory.proposals()[0].hash});assert.equal(memory.proposals().length,0);assert.equal((await memory.context('口味')).sources.length,0);
  const item={conversationId:'synthetic',turnId:'1',content:'NEVER_COPY_THIS_RAW_TEXT'};await memory.observe(item);await memory.observe(item);await memory.observe({...item,turnId:'2',memoryMode:'do_not_remember'});
  const files=fs.readdirSync(path.join(base,'runtime/receipts'));assert.equal(files.length,1);assert.ok(!fs.readFileSync(path.join(base,'runtime/receipts',files[0]),'utf8').includes(item.content));
});
test('rejects sensitive material, missing provenance and indefinite episodes',async t=>{
  const {memory}=fixture(t);await assert.rejects(memory.propose({...proposal,summary:'验证码：123456'},provenance),{code:'sensitive_memory'});
  await assert.rejects(memory.propose(proposal,{}));await assert.rejects(memory.propose({...proposal,kind:'episode'},provenance));await assert.rejects(memory.propose({...proposal,kind:'boundary'},provenance));
  assert.deepEqual(parseCard(renderCard({title:'中文',tags:['外卖','购物'],protocol_version:1},'正文')).meta.tags,['外卖','购物']);
});
test('model tools cannot approve memory, bypass consent or fabricate source references',async t=>{
  const {memory}=fixture(t);const task={id:'task',status:'running',messages:[{id:'user1',role:'user',content:'Synthetic preference'}],cloudConsent:true,memoryConsent:false};
  const store={data:{settings:{memoryEnabled:true},actions:[]},task:()=>task,event(){}};
  const broker=new Broker({store,memory});assert.ok(!TOOL_DEFINITIONS.some(t=>/memory_(review|approve|commit)/.test(t.name)));
  await assert.rejects(broker.execute('task','memory_context',{query:'外卖'}));task.memoryConsent=true;
  await assert.rejects(broker.execute('task','memory_propose',{...proposal,evidenceRefs:['unknown']}));
  const result=await broker.execute('task','memory_propose',{...proposal,evidenceRefs:['user1']});assert.equal(JSON.parse(result.content[0].text).status,'candidate');
  task.memoryMode='do_not_remember';await assert.rejects(broker.execute('task','memory_propose',{...proposal,evidenceRefs:['user1']}));
});

test('live HTTP service exposes the dedicated vault and enforces local session plus CSRF',async t=>{
  const {root,base}=fixture(t);card(root,'03-Knowledge/workflows/food.md');
  const {spawn}=await import('node:child_process');const net=await import('node:net');
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,BOUJOY_PORT:String(port),BOUJOY_DATA:path.join(base,'app-state'),BOUJOY_MEMORY_VAULT:root},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  t.after(async()=>{child.kill('SIGTERM');await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(()=>{child.kill('SIGKILL');r();},1500).unref();});});
  const origin=`http://127.0.0.1:${port}`;let ready=false;for(let n=0;n<60;n++){try{if((await fetch(origin)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready,output);
  assert.equal((await fetch(origin+'/api/memory/status')).status,401);
  const session=await fetch(origin+'/api/session');const cookie=session.headers.get('set-cookie').split(';')[0];const {csrf}=await session.json();
  const headers={Cookie:cookie,'Content-Type':'application/json','x-boujoy-csrf':csrf};
  const status=await (await fetch(origin+'/api/memory/status',{headers})).json();assert.equal(status.root,root);assert.equal(status.protocol,'boujoy-personal-memory');
  assert.equal((await fetch(origin+'/api/memory/context',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({query:'外卖'})})).status,403);
  assert.equal((await fetch(origin+'/api/memory/context',{method:'POST',headers:{...headers,Origin:'https://unrelated.example'},body:JSON.stringify({query:'外卖'})})).status,403);
  const context=await (await fetch(origin+'/api/memory/context',{method:'POST',headers,body:JSON.stringify({query:'外卖'})})).json();assert.equal(context.sources.length,1);assert.equal(context.cloudRequestSent,false);
  // Without the optional Bok core the memory panel still opens: an empty list, not an error.
  if(NEEDS_BOK){const personal=await fetch(origin+'/api/memory/personal',{headers});assert.equal(personal.status,200);assert.deepEqual((await personal.json()).items,[]);}
  const state=await (await fetch(origin+'/api/state',{headers})).json();assert.equal(state.usage.requests,0);
  const pending=await (await fetch(origin+'/api/memory/proposals',{headers})).json();assert.deepEqual(pending.proposals,[]);
  const task=await (await fetch(origin+'/api/tasks',{method:'POST',headers,body:JSON.stringify({prompt:'Synthetic consent fixture',cloudConsent:false,memoryMode:'do_not_remember'})})).json();
  assert.equal((await fetch(origin+'/api/settings',{method:'POST',headers,body:JSON.stringify({chatCloudConsent:true,chatMemoryConsent:true,chatMemoryMode:'do_not_remember'})})).status,200);
  const after=await (await fetch(origin+'/api/state',{headers})).json();assert.equal(after.settings.chatCloudConsent,true);assert.equal(after.settings.chatMemoryMode,'do_not_remember');assert.equal(after.tasks.find(t=>t.id===task.id).status,'waiting_consent');assert.equal(after.usage.requests,0);
  child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));assert.equal(child.exitCode,0);
});

test('memory retention restrictions pass to delegated tasks and consent can be revoked',async t=>{
  const {memory,base}=fixture(t);const {Store}=await import('../src/core/store.mjs');const {Engine}=await import('../src/core/engine.mjs');
  const store=new Store(path.join(base,'state'));t.after(()=>store.close());const broker=new Broker({store,memory});const engine=new Engine({store,memory,broker,secrets:{get:async()=>''}});engine.pump=async()=>{};
  const task=engine.create({prompt:'Synthetic task',cloudConsent:true,memoryConsent:true,memoryMode:'do_not_remember'});
  store.updateTask(task.id,t=>{t.status='running';});await broker.execute(task.id,'delegate_task',{roleId:'shopping',prompt:'Synthetic delegated task'});
  const child=store.task(store.task(task.id).children[0]);assert.equal(child.memoryMode,'do_not_remember');assert.equal(store.data.outbox.length,0);
  await engine.continue(task.id,{cloudConsent:false,memoryConsent:false,message:'Synthetic continuation'});const current=store.task(task.id);assert.equal(current.cloudConsent,false);assert.equal(current.memoryConsent,false);assert.equal(current.status,'waiting_consent');assert.equal(store.data.outbox.length,0);
});

test('an unchanged memory card is parsed once; an edited one is read again and callers cannot alter the cached copy',t=>{
  const {root,memory}=fixture(t),rel='01-Personal/pref.md',file=path.join(root,rel);
  fs.writeFileSync(file,renderCard({id:'p1',title:'咖啡'},'喜欢冰美式'));
  const first=memory.read(rel);first.meta.title='changed by caller';
  const second=memory.read(rel);assert.equal(second.meta.title,'咖啡');assert.equal(second.hash,first.hash);assert.equal(memory.cardCache.size>=1,true);
  fs.writeFileSync(file,renderCard({id:'p1',title:'咖啡'},'现在喜欢热拿铁了'));
  const third=memory.read(rel);assert.match(third.text,/热拿铁/);assert.notEqual(third.hash,first.hash);
});
