// Compaction and subagents on top of the minimal Harness kernel, with a safe fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {HarnessRun,harnessExtrasStatus} from '../src/adapters/harness.mjs';

test('subagents inherit the full authorized task catalog and use the official provider depth policy',async()=>{
 const text=fs.readFileSync(new URL('../config/harness-extras.yml',import.meta.url),'utf8');assert.match(text,/maxDepth: provider-managed/);assert.match(text,/tool-subagent-control/);
 const {childToolFilter}=await import('../src/adapters/harness.mjs');
 const [layer]=childToolFilter([{insert:[{id:'tool-subagent',config:{toolFilter:{allow:['boujoy:inherit-task-tools']}}}]}],['phone_use','agent_run','finish_task']);
 assert.deepEqual(layer.insert[0].config.toolFilter.allow,['mcp__personal__phone_use','mcp__personal__agent_run','mcp__personal__finish_task','subagent','send_message','interrupt_agent']);
});

test('if the extra components fail to load, the same start retries on the plain kernel and they stay off',async()=>{
  class Fake extends HarnessRun{async send(){} async startOnce({extras}){this.calls=[...(this.calls||[]),extras];if(extras)throw Object.assign(new Error('entries did not activate: subagent'),{code:'harness_config'});return {ok:true};}}
  const logs=[];const run=new Fake({task:{id:'t'},onLog:t=>logs.push(t)});
  assert.deepEqual(await run.start(),{ok:true});assert.deepEqual(run.calls,[true,false]);assert.match(harnessExtrasStatus().broken.reason,/did not activate/);assert.match(logs[0],/extras disabled/);
  const next=new Fake({task:{id:'u'}});await next.start();assert.deepEqual(next.calls,[false],'not retried with extras until restart');
  const off=new Fake({task:{id:'v'},extras:false});await off.start();assert.deepEqual(off.calls,[false]);
});

test('a run stopped while starting is not taken as the extras failing',async()=>{
  const {HarnessRun:Fresh}=await import('../src/adapters/harness.mjs?fresh='+Date.now());
  class Stopped extends Fresh{async startOnce({extras}){this.calls=[...(this.calls||[]),extras];await this.stop();throw Object.assign(new Error('执行引擎连接已关闭'),{code:'runtime_exited'});}}
  const run=new Stopped({task:{id:'s'}});await assert.rejects(run.start(),/连接已关闭/);assert.deepEqual(run.calls,[true],'no fallback restart after a stop');
});

test('the child tool filter only names tools this task has; with none, no subagent tool is mounted',async()=>{
  const {childToolFilter}=await import('../src/adapters/harness.mjs');
  const extras=[{insert:[{id:'compaction-basic'},{id:'subagent'},{id:'subagent-spawn-in-process'},{id:'tool-subagent',config:{toolFilter:{allow:['mcp__personal__web_search','mcp__personal__task_history','mcp__personal__memory_context']}}}]}];
  const [layer]=childToolFilter(extras,['web_search','finish_task']);
  assert.deepEqual(layer.insert.find(e=>e.id==='tool-subagent').config.toolFilter.allow,['mcp__personal__web_search']);
  const [none]=childToolFilter(extras,['finish_task','phone_use']);
  assert.deepEqual(none.insert.map(e=>e.id),['compaction-basic'],'compaction stays; no unfiltered children');
});
