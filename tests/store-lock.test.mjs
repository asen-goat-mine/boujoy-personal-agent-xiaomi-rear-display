import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/core/store.mjs';

function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-store-lock-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function deadLock(dir,pid='2147483646'){const lock=path.join(dir,'service.lock');fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'pid'),pid);return lock;}
const absent=()=>Object.assign(Error('fixture owner exited'),{code:'ESRCH'});

test('an incomplete or malformed owner is never mistaken for a dead service',t=>{
 for(const pid of [null,'','0','-1','not-a-pid','12junk']){
  const dir=directory(t),lock=path.join(dir,'service.lock');fs.mkdirSync(lock);if(pid!==null)fs.writeFileSync(path.join(lock,'pid'),pid);
  assert.throws(()=>new Store(dir),error=>error.code==='already_running');
  assert.equal(fs.existsSync(lock),true);assert.equal(fs.existsSync(path.join(dir,'state.json')),false);
  if(pid!==null)assert.equal(fs.readFileSync(path.join(lock,'pid'),'utf8'),pid);
  assert.equal(fs.existsSync(lock+'.reclaim'),false);
 }
});

test('a live owner remains exclusive and keeps the legacy pid file',t=>{
 const dir=directory(t),first=new Store(dir);t.after(()=>first.close());
 const owner=fs.readFileSync(path.join(dir,'service.lock/owner'),'utf8');
 assert.equal(fs.readFileSync(path.join(dir,'service.lock/pid'),'utf8'),String(process.pid));
 assert.throws(()=>new Store(dir),error=>error.code==='already_running');
 assert.equal(fs.readFileSync(path.join(dir,'service.lock/owner'),'utf8'),owner);
});

test('an identified dead legacy owner can be recovered once',t=>{
 const dir=directory(t);deadLock(dir);t.mock.method(process,'kill',()=>{throw absent();});
 const store=new Store(dir);t.after(()=>store.close());
 assert.equal(store.ownsLock,true);assert.equal(fs.readFileSync(path.join(dir,'service.lock/pid'),'utf8'),String(process.pid));
 assert.match(fs.readFileSync(path.join(dir,'service.lock/owner'),'utf8'),/^[a-f0-9-]{36}$/);
 assert.equal(fs.existsSync(path.join(dir,'service.lock.reclaim')),false);
});

test('two stale-owner observers cannot remove the winner new lock',t=>{
 const dir=directory(t);deadLock(dir);let interleaved=false,competitor,competitorError;
 // Run a competing starter after the first read of the dead PID but before
 // the first starter can remove it: the old implementation admitted both.
 t.mock.method(process,'kill',()=>{
  if(!interleaved){interleaved=true;try{competitor=new Store(dir);}catch(error){competitorError=error;}}
  throw absent();
 });
 const winner=new Store(dir);t.after(()=>{winner.close();competitor?.close();});
 assert.equal(competitor,undefined);assert.equal(competitorError?.code,'already_running');
 assert.equal(fs.readFileSync(path.join(dir,'service.lock/owner'),'utf8'),winner.lockIdentity.token);
});

test('an abandoned reclaim guard fails closed instead of guessing another starter died',t=>{
 const dir=directory(t),lock=deadLock(dir);fs.mkdirSync(lock+'.reclaim');
 assert.throws(()=>new Store(dir),error=>error.code==='already_running');
 assert.equal(fs.readFileSync(path.join(lock,'pid'),'utf8'),'2147483646');assert.equal(fs.existsSync(lock+'.reclaim'),true);
});

test('an old Store cannot write through or remove a replacement owner lock',t=>{
 const dir=directory(t),old=new Store(dir),lock=path.join(dir,'service.lock');
 fs.renameSync(lock,path.join(dir,'retired-lock'));const replacement=new Store(dir);t.after(()=>replacement.close());
 const owner=fs.readFileSync(path.join(lock,'owner'),'utf8'),before=fs.readFileSync(path.join(dir,'state.json'),'utf8');
 assert.throws(()=>old.transaction(state=>{state.settings.quiet=false;}),error=>error.code==='store_lock_lost');
 assert.equal(fs.readFileSync(path.join(dir,'state.json'),'utf8'),before);old.close();
 assert.equal(fs.readFileSync(path.join(lock,'owner'),'utf8'),owner);
 replacement.transaction(state=>{state.settings.quiet=false;});assert.equal(replacement.data.settings.quiet,false);
});

test('a closed Store cannot overwrite the next service state',t=>{
 const dir=directory(t),old=new Store(dir);old.close();const next=new Store(dir);t.after(()=>next.close());
 const before=fs.readFileSync(path.join(dir,'state.json'),'utf8');
 assert.throws(()=>old.transaction(state=>{state.settings.quiet=false;}),error=>error.code==='store_closed');
 old.close();assert.equal(fs.readFileSync(path.join(dir,'state.json'),'utf8'),before);assert.equal(fs.existsSync(path.join(dir,'service.lock')),true);
});
