import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {PetState,summarizeTasks}=require('../desktop/pet-state.cjs');
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-pet-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {file:path.join(dir,'pet.json'),dir};}
test('one feed is accepted and repeated input cannot bypass a full minute',t=>{const {file}=setup(t),pet=new PetState(file),now=100000;assert.equal(pet.feed(now).accepted,true);assert.equal(pet.feed(now).accepted,false);assert.equal(pet.feed(now+59999).accepted,false);assert.equal(pet.feed(now+60000).accepted,true);assert.equal(pet.data.feeds,2);});
test('cooldown and position survive recreating the desktop pet',t=>{const {file}=setup(t),pet=new PetState(file);pet.feed(100000);pet.position(20.4,30.6);const restored=new PetState(file);assert.equal(restored.feed(130000).accepted,false);assert.equal(restored.status(130000).remainingMs,30000);assert.deepEqual(restored.data.position,{x:20,y:31});assert.equal(restored.feed(160000).accepted,true);});
test('failed persistence never acknowledges a feed or spends the cooldown',t=>{const {file}=setup(t),pet=new PetState(file);pet.save=()=>{throw Error('disk unavailable');};assert.throws(()=>pet.feed(100000),/disk unavailable/);assert.equal(pet.status(100000).remainingMs,0);assert.equal(pet.data.feeds,0);});
test('clock rollback cannot make a recently fed pet ready early',t=>{const {file}=setup(t),pet=new PetState(file);pet.feed(100000);assert.equal(pet.feed(90000).accepted,false);});
test('active work drives code face; finished work restores idle',()=>{const data={tasks:[{status:'running',messages:['private'],id:'private'},{status:'queued'},{status:'completed'}]};assert.deepEqual(summarizeTasks(data),{mode:'working',running:2,waiting:0});data.tasks.forEach(t=>t.status='completed');assert.deepEqual(summarizeTasks(data),{mode:'idle',running:0,waiting:0});});
test('approval waiting is distinct from running and exposes no task content',()=>{assert.deepEqual(summarizeTasks({tasks:[{status:'waiting_approval',prompt:'private',token:'private'}]}),{mode:'waiting',running:0,waiting:1});});
test('unreadable pet preferences fall back safely',t=>{const {file}=setup(t);fs.writeFileSync(file,'invalid');const pet=new PetState(file);assert.equal(pet.status().remainingMs,0);assert.equal(pet.data.position,null);});
