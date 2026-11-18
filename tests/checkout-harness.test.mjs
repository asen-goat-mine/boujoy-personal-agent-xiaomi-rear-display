import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {harnessVersion} from '../src/adapters/harness.mjs';

const exec=promisify(execFile);
test('real Harness verifies checkout through the broker and freezes a ready_for_user handoff',{skip:harnessVersion()!=='0.2.1-alpha.2',timeout:65000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pa-checkout-harness-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const {stdout}=await exec(process.execPath,['tests/helpers/checkout-harness-wire.mjs'],{
    cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,BOUJOY_DATA:dir},timeout:60000,maxBuffer:200000
  });
  const result=JSON.parse(stdout.trim());
  assert.equal(result.passed,true);
  assert.equal(result.status,'ready_for_user');
  assert.equal(result.requests,2);
  assert.equal(result.stableReads,1);
  assert.equal(result.phoneActions,0);
  assert.equal(result.pendingApprovals,0);
  assert.equal(result.latestObservationReused,true);
  assert.equal(result.lateActionRefused,true);
});
