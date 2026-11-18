import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store,PROGRESS_WRITE_DELAY_MS} from '../src/core/store.mjs';
import {summarizeTasks,watchPetStatus} from '../src/core/pet-status.mjs';
import {boundTaskSummaries} from '../src/remote/gateway.mjs';

const fixture=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-perf-'));const store=new Store(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  store.transaction(s=>{s.tasks.push({id:'a',status:'running',messages:[],events:[]});});return {dir,store,disk:()=>JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'))};};

test('display-only progress is visible at once and written together shortly after; anything else is written before returning',async t=>{
  const f=fixture(t);const writes=()=>f.store.writeStats.writes,before=writes();
  for(let i=0;i<20;i++)f.store.event('a','tool_timing','工具耗时',{ms:i});
  assert.equal(f.store.task('a').events.length,20);assert.equal(writes(),before,'no write per progress line');assert.equal(f.disk().tasks[0].events.length,0);
  f.store.event('a','tool','正在执行：phone_use',{tool:'phone_use'});
  assert.equal(writes(),before+1);assert.equal(f.disk().tasks[0].events.length,21,'a durable write takes the pending progress along');
  f.store.event('a','phone_transport','手机云通道耗时');assert.equal(f.disk().tasks[0].events.length,21);
  await new Promise(resolve=>setTimeout(resolve,PROGRESS_WRITE_DELAY_MS+80));
  assert.equal(f.disk().tasks[0].events.length,22);assert.equal(f.disk().revision,f.store.data.revision);
});

test('closing the store writes progress that was still waiting',t=>{
  const f=fixture(t);f.store.event('a','harness_tool','原生工具：bash',{phase:'tool/call',tool:'bash'});
  f.store.close();assert.equal(f.disk().tasks[0].events.length,1);
});

test('the desk pet summary file is rewritten only when the summary changes',t=>{
  const f=fixture(t);const stop=watchPetStatus(f.store,f.dir,{pid:4242});const file=path.join(f.dir,'pet-status.json');
  const read=()=>JSON.parse(fs.readFileSync(file,'utf8'));
  assert.deepEqual([read().mode,read().running,read().waiting,read().pid],['working',1,0,4242]);
  const first=read().at;f.store.event('a','tool','x',{tool:'x'});f.store.updateTask('a',task=>{task.title='same summary';});
  assert.equal(read().at,first,'unchanged summary is not rewritten');
  f.store.updateTask('a',task=>{task.status='waiting_approval';});assert.equal(read().mode,'waiting');
  f.store.updateTask('a',task=>{task.status='completed';});assert.equal(read().mode,'idle');
  stop();assert.equal(fs.existsSync(file),false);
  assert.deepEqual(summarizeTasks([{status:'queued'},{status:'waiting_children'},{status:'waiting_approval'},{status:'failed'}]),{mode:'working',running:2,waiting:1});
});

test('a phone state past the byte budget trims the oldest finished results and never a live task',()=>{
  const long='结'.repeat(20000),rows=[];
  for(let i=0;i<150;i++)rows.push({id:'t'+i,status:i===3?'running':'completed',result:long,preview:long.slice(0,500)});
  const full=Buffer.byteLength(JSON.stringify(rows));assert.ok(full>8*1024*1024);
  const out=boundTaskSummaries(rows);const bytes=Buffer.byteLength(JSON.stringify(out));
  assert.ok(bytes<5*1024*1024,String(bytes));
  assert.equal(out[0].resultTrimmed,true);assert.equal(out[0].result.length,500);
  assert.equal(out[3].result,long,'a running task keeps its text');assert.equal(out.at(-1).result,long,'the newest stay whole');
  assert.equal(rows[0].result,long,'input rows are not changed');
  const small=[{id:'a',status:'completed',result:'短'}];assert.equal(boundTaskSummaries(small),small);
});
