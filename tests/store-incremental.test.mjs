import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/core/store.mjs';

function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-store-'));const store=new Store(dir);
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  store.transaction(s=>{for(const id of ['a','b','c'])s.tasks.push({id,status:'running',prompt:'任务 '+id,messages:[],events:[]});});
  return {dir,store,disk:()=>fs.readFileSync(path.join(dir,'state.json'),'utf8')};
}

test('the saved file is always exactly the JSON of the current state, whichever kind of change wrote it',t=>{
  const {store,disk}=fixture(t);
  assert.equal(disk(),JSON.stringify(store.data));
  store.event('b','tool','第一步');assert.equal(disk(),JSON.stringify(store.data));
  store.transaction(s=>{s.usage.requests=(s.usage.requests||0)+1;});assert.equal(disk(),JSON.stringify(store.data));
  store.updateTask('c',t=>{t.status='completed';t.note='含 "引号"、换行\n和 emoji 🙂';});assert.equal(disk(),JSON.stringify(store.data));
  store.updateTask('a',(t,s)=>{t.status='paused';s.schedulerPaused=true;});assert.equal(disk(),JSON.stringify(store.data));
  store.transaction(s=>{s.tasks.splice(1,1);delete s.schedulerPaused;s.extra=undefined;});assert.equal(disk(),JSON.stringify(store.data));
  store.event('a','tool','删除之后');assert.equal(disk(),JSON.stringify(store.data));
  assert.deepEqual(store.data.tasks.map(t=>t.id),['a','c']);
});

test('a restart reads back every change, including ones written by single-task updates',t=>{
  const {dir,store}=fixture(t);
  store.event('a','tool','一');store.transaction(s=>{s.settings.quiet=false;});store.event('a','tool','二');store.updateTask('b',t=>{t.result='done';});
  const expected=JSON.parse(JSON.stringify(store.data));store.close();
  const again=new Store(dir);t.after(()=>again.close());
  assert.equal(again.data.settings.quiet,false);assert.equal(again.data.tasks.find(t=>t.id==='b').result,'done');assert.deepEqual(again.data.tasks.map(t=>t.id),expected.tasks.map(t=>t.id));
  assert.deepEqual(again.data.tasks[0].events.map(e=>e.text),['一','二']);
});

test('a change copies only what it touches and leaves earlier snapshots untouched',t=>{
  const {store}=fixture(t);const before=store.data,[a,b,c]=before.tasks,actions=before.actions;
  store.event('b','tool','x');
  assert.equal(store.data.tasks[0],a);assert.equal(store.data.tasks[2],c);assert.notEqual(store.data.tasks[1],b);assert.equal(b.events.length,0,'the earlier snapshot of the task is not edited');
  assert.equal(store.data.revision,before.revision+1);
  const mid=store.data;store.transaction(s=>{s.usage.requests=7;});
  assert.equal(store.data.tasks,mid.tasks,'a usage change does not copy the tasks');assert.equal(store.data.actions,actions);assert.notEqual(store.data.usage,mid.usage);assert.notEqual(mid.usage.requests,7);
  store.transaction(s=>{s.tasks.find(t=>t.id==='a').status='completed';});
  assert.equal(mid.tasks[0].status,'running');assert.equal(store.data.tasks[0].status,'completed');
});

test('a failing change, or a failing save, leaves state and file exactly as they were',t=>{
  const {store,disk}=fixture(t);const before=store.data,file=disk();let changes=0;store.on('change',()=>changes++);
  assert.throws(()=>store.transaction(s=>{s.tasks[0].status='broken';s.settings.quiet=false;throw Error('stop');}),/stop/);
  assert.throws(()=>store.updateTask('a',t=>{t.status='broken';throw Error('stop');}),/stop/);
  assert.throws(()=>store.updateTask('missing',t=>{t.status='x';}),/任务不存在/);
  assert.throws(()=>store.updateTask('missing',(t,s)=>{t.status='x';}),/任务不存在/);
  const persist=store.persist;store.persist=()=>{throw Error('disk full');};
  assert.throws(()=>store.event('a','tool','x'),/disk full/);assert.throws(()=>store.transaction(s=>{s.usage.requests=9;}),/disk full/);store.persist=persist;
  assert.equal(store.data,before);assert.equal(disk(),file);assert.equal(changes,0);
  store.event('a','tool','恢复后');assert.equal(disk(),JSON.stringify(store.data));
});

test('single-task changes announce which task changed; other changes do not name one',t=>{
  const {store}=fixture(t);const seen=[];store.on('change',e=>seen.push(e));
  const returned=store.updateTask('a',t=>{t.status='completed';});store.transaction(s=>{s.usage.requests=1;});
  assert.equal(seen[0].taskId,'a');assert.equal(seen[1].taskId,undefined);assert.equal(seen[1].revision,seen[0].revision+1);
  returned.status='edited by caller';assert.equal(store.data.tasks[0].status,'completed','the returned copy is the caller\'s own');
  assert.ok(store.data.tasks[0].updatedAt);
});
