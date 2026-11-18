import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {HARNESS} from '../src/config.mjs';
import {harnessVersion} from '../src/adapters/harness.mjs';

test('F2 real Harness spawned file child can read through mac_files and MCP',{skip:harnessVersion()!=='0.2.1-alpha.2',timeout:65000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-f2-wire-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const {stdout}=await promisify(execFile)(process.execPath,['tests/helpers/f2-mac-files-wire.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,HOME:dir,BOUJOY_F2_FIXTURE:dir,BOUJOY_DATA:path.join(dir,'data'),BOUJOY_HARNESS:HARNESS},timeout:60000,maxBuffer:200000});
 const result=JSON.parse(stdout.trim());assert.equal(result.passed,true);assert.equal(result.childHasMacFiles,true);assert.equal(result.childHasArtifactRead,true);assert.equal(result.sourceUnchanged,true);assert.deepEqual(result.calls,['mac_files']);
});
