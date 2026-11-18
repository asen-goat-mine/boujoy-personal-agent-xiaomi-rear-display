// Edge cases found in the 2026-11-12 review. Each test checks the real file,
// request or state, not only the returned error.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {macFiles,taskArtifactBytes} from '../src/tools/mac-files.mjs';
import {withExecutionPermission} from '../src/core/execution-permissions.mjs';
import {phoneTaskWindow} from '../src/remote/gateway.mjs';
import {OfficialSuperagent} from '../src/core/official-superagent.mjs';

const temp=(t,name)=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),name));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};

test('a save whose file permission is switched off while the attachment is read writes nothing',async t=>{
  const home=temp(t,'boujoy-save-');fs.mkdirSync(path.join(home,'Desktop'));
  const state={settings:{filesEnabled:true,executionEpochs:{files:0}},tasks:[],actions:[]},store={data:state};
  const run=()=>withExecutionPermission(store,['files'],null,()=>macFiles({action:'save',artifactId:'a',path:'桌面/out.txt'},{home,artifactBytes:async()=>{state.settings.filesEnabled=false;return {name:'out.txt',bytes:Buffer.from('secret')};}}));
  await assert.rejects(run(),{code:'execution_disabled'});
  assert.equal(fs.existsSync(path.join(home,'Desktop/out.txt')),false);
  assert.deepEqual(fs.readdirSync(path.join(home,'Desktop')),[]);
  // Switched back on with a new generation: the old operation still may not write.
  state.settings.filesEnabled=true;
  const stale=()=>withExecutionPermission(store,['files'],null,()=>macFiles({action:'save',artifactId:'a',path:'桌面/out.txt'},{home,artifactBytes:async()=>{state.settings.executionEpochs.files=1;return {name:'out.txt',bytes:Buffer.from('secret')};}}));
  await assert.rejects(stale(),{code:'execution_revoked'});
  assert.equal(fs.existsSync(path.join(home,'Desktop/out.txt')),false);
});

test('saving an attachment refuses a file that was swapped on disk, as reading it does',async t=>{
  const dataDir=temp(t,'boujoy-artifact-');fs.mkdirSync(path.join(dataDir,'artifacts/t'),{recursive:true});
  const file=path.join(dataDir,'artifacts/t/a.txt');fs.writeFileSync(file,'original');
  const artifact={id:'a',taskId:'t',name:'a.txt',mime:'text/plain',path:'t/a.txt',size:8,sha256:createHash('sha256').update('original').digest('hex')};
  const store={data:{artifacts:[artifact]}};
  assert.equal((await taskArtifactBytes({store,dataDir,taskId:'t',id:'a'})).bytes.toString(),'original');
  fs.writeFileSync(file,'tampered');
  await assert.rejects(taskArtifactBytes({store,dataDir,taskId:'t',id:'a'}),{code:'artifact_changed'});
  fs.writeFileSync(file,'longer than before');
  await assert.rejects(taskArtifactBytes({store,dataDir,taskId:'t',id:'a'}),{code:'artifact_changed'});
});

test('the phone still receives an old task that waits for approval or is running, beyond the latest 150',()=>{
  const tasks=[{id:'old-approval',status:'waiting_approval'},{id:'old-done',status:'completed'},{id:'old-pending',status:'completed'},{id:'old-running',status:'running'}];
  for(let i=0;i<150;i++)tasks.push({id:'t'+i,status:'completed'});
  const store={data:{approvals:[{taskId:'old-pending',status:'pending'},{taskId:'old-done',status:'approved'}]}};
  const ids=phoneTaskWindow(tasks,store).map(t=>t.id);
  assert.deepEqual(ids.slice(0,3),['old-approval','old-pending','old-running']);
  assert.equal(ids.includes('old-done'),false);assert.equal(ids.length,153);assert.equal(ids.at(-1),'t149');
  assert.equal(phoneTaskWindow(tasks.slice(4),store).length,150);
});

test('a failed folder sync after the state file was replaced keeps memory and disk the same',t=>{
  const dir=temp(t,'boujoy-store-');const store=new Store(dir);t.after(()=>store.close());
  const realOpen=fs.openSync,realFsync=fs.fsyncSync;let dirFd=null,fail=true;
  fs.openSync=(file,...rest)=>{const fd=realOpen(file,...rest);if(file===store.dir)dirFd=fd;return fd;};
  fs.fsyncSync=fd=>{if(fail&&fd===dirFd)throw Object.assign(Error('sync'),{code:'EIO'});return realFsync(fd);};
  try{store.transaction(s=>{s.tasks.push({id:'a',status:'running',messages:[],events:[]});});}finally{fs.openSync=realOpen;fs.fsyncSync=realFsync;}
  const disk=JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));
  assert.equal(disk.revision,store.data.revision);assert.equal(store.data.tasks.length,1);assert.equal(disk.tasks.length,1);
  assert.equal(store.writeSummary().durability.uncertain,true);
  store.transaction(s=>{s.tasks[0].status='completed';});
  assert.equal(store.writeSummary().durability,undefined);
});

test('a write that fails before the state file is replaced rolls back and leaves no temporary file',t=>{
  const dir=temp(t,'boujoy-store-');const store=new Store(dir);t.after(()=>store.close());
  const before=fs.readFileSync(path.join(dir,'state.json'),'utf8'),revision=store.data.revision,realRename=fs.renameSync;
  fs.renameSync=()=>{throw Object.assign(Error('rename'),{code:'EIO'});};
  try{assert.throws(()=>store.transaction(s=>{s.tasks.push({id:'a',status:'running',messages:[],events:[]});}),{code:'EIO'});}finally{fs.renameSync=realRename;}
  assert.equal(store.data.revision,revision);assert.equal(store.data.tasks.length,0);
  assert.equal(fs.readFileSync(path.join(dir,'state.json'),'utf8'),before);
  assert.deepEqual(fs.readdirSync(dir).filter(name=>name.endsWith('.tmp')),[]);
});

test('a cancelled, expired or review-needed task no longer leaves its Super-agent ticket working',async t=>{
  for(const [status,expected] of [['cancelled','failed'],['expired','failed'],['stopped','failed'],['needs_review','blocked']]){
    const dir=temp(t,'boujoy-official-');const store=new Store(dir);t.after(()=>store.close());const at=new Date().toISOString();
    store.transaction(s=>s.tasks.push({id:'task-1',roleId:'concierge',source:'user',status:'running',prompt:'x',title:'x',createdAt:at,messages:[{id:'m',role:'user',content:'x',at}],events:[],children:[]}));
    const s=new OfficialSuperagent({store,host:{stop:async()=>{}}});s.bind('task-1');await s.drain();
    assert.equal(s.snapshot('task-1').ticket.assignments[0].report,undefined);
    store.updateTask('task-1',x=>{x.status=status;});s.sync('task-1');
    const ticket=s.snapshot('task-1').ticket,last=ticket.assignments.at(-1);
    assert.equal(last.report?.state,expected,status);assert.equal(last.report.summary,status);
  }
});

test('the group composer keeps one request id per group until it is confirmed',async()=>{
  const source=fs.readFileSync(new URL('../web/groups.js',import.meta.url),'utf8');
  const start=source.indexOf("const SEND_KEY="),end=source.indexOf('async function handleSubmit');
  const memory=new Map(),localStorage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)};
  const make=()=>new Function('localStorage','crypto',source.slice(start,end)+';return {pendingSend,clearPendingSend};')(localStorage,globalThis.crypto);
  let page=make();
  const a=page.pendingSend('A','["A","hi"]').id,b=page.pendingSend('B','["B","hi"]').id;
  assert.notEqual(a,b);assert.equal(page.pendingSend('A','["A","hi"]').id,a);
  page=make(); // page reload
  assert.equal(page.pendingSend('A','["A","hi"]').id,a);
  assert.notEqual(page.pendingSend('A','["A","other"]').id,a);
  page.clearPendingSend('B');assert.notEqual(page.pendingSend('B','["B","hi"]').id,b);
});
