// An unverified phone receipt left by a task that has ended must not block new tasks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {unresolvedPhoneAction} from '../src/tools/broker.mjs';
const row=(over)=>({id:'a',taskId:'old',tool:'phone_action',status:'unknown',startedAt:'2026-11-01T10:11:56Z',...over});
test('the task\'s own unknown phone action still blocks it, however old',()=>{
  assert.ok(unresolvedPhoneAction([row({taskId:'me',startedAt:'2026-10-16T06:17:33Z'})],'me',[{id:'me',status:'running'}]));
});
test('another live task\'s unknown phone action blocks (two tasks must not interleave)',()=>{
  for(const status of ['running','waiting_approval','queued'])assert.ok(unresolvedPhoneAction([row()],'me',[{id:'old',status},{id:'me',status:'running'}]),status);
});
test('an ended task\'s unknown phone action no longer blocks a new task, even seconds later',()=>{
  for(const status of ['unknown_result','blocked','paused','completed','cancelled'])assert.equal(unresolvedPhoneAction([row()],'me',[{id:'old',status},{id:'me',status:'running'}]),undefined,status);
});
test('resolved navigation receipts never block',()=>{
  assert.equal(unresolvedPhoneAction([row({taskId:'me',resolution:{kind:'navigation_observed'}})],'me',[]),undefined);
});
