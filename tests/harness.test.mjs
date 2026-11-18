import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {harnessVersion} from '../src/adapters/harness.mjs';
const exec=promisify(execFile);
test('real Harness completes memory → artifact → finish against synthetic local model through the brokered tools',{skip:harnessVersion()!=='0.2.1-alpha.2',timeout:65000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pa-harness-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const {stdout}=await exec(process.execPath,['tests/helpers/harness-wire.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,BOUJOY_DATA:dir},timeout:60000,maxBuffer:200000});
  const result=JSON.parse(stdout.trim());assert.equal(result.passed,true);assert.equal(result.requests,3);assert.equal(result.postFinishFrozen,true);assert.equal(result.systemPromptVerified,true);assert.equal(result.systemPromptChecks,result.requests);assert.deepEqual(result.brokerCalls,['memory_context','artifact_write','finish_task']);assert.equal(result.artifacts,1);
});

test('real Harness carries screenshot bytes through the MCP bridge into an inline model request',{skip:harnessVersion()!=='0.2.1-alpha.2',timeout:65000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pa-image-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const {stdout}=await exec(process.execPath,['tests/helpers/harness-image-wire.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,BOUJOY_DATA:dir},timeout:60000,maxBuffer:200000});
 const result=JSON.parse(stdout.trim());assert.equal(result.passed,true);assert.equal(result.modelSawImage,true);assert.equal(result.requests,3);assert.equal(result.postFinishFrozen,true);assert.equal(result.systemPromptVerified,true);assert.equal(result.systemPromptChecks,result.requests);assert.deepEqual(result.brokerCalls,['memory_context','artifact_write','finish_task']);
});

test('real Harness phone screenshot events bind cache ownership and clean it after 24h without deleting task artifacts',{skip:harnessVersion()!=='0.2.1-alpha.2',timeout:65000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pa-image-retention-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const {stdout}=await exec(process.execPath,['tests/helpers/harness-image-wire.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,BOUJOY_DATA:dir,BOUJOY_TEST_IMAGE_RETENTION:'1'},timeout:60000,maxBuffer:200000});const result=JSON.parse(stdout.trim());assert.equal(result.passed,true);assert.equal(result.retentionVerified,true);assert.equal(result.modelSawImage,true);assert.deepEqual(result.brokerCalls,['phone_observe','artifact_write','finish_task']);
});


test('real Harness retrieves omitted original history through the current-task-only MCP tool and keeps focused instructions',{skip:harnessVersion()!=='0.2.1-alpha.2',timeout:65000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pa-history-context-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const {stdout}=await exec(process.execPath,['tests/helpers/history-harness-wire.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,BOUJOY_DATA:dir},timeout:60000,maxBuffer:200000});
 const result=JSON.parse(stdout.trim());assert.equal(result.passed,true);assert.equal(result.requests,4);assert.equal(result.historyRecovered,true);assert.equal(result.focusedPolicyVerified,true);assert.deepEqual(result.calls,['task_history','task_history','artifact_write','finish_task']);
});
