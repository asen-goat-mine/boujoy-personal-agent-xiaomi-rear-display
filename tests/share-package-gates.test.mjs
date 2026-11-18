import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('formal share packaging rejects unverified and APK-omission switches before writing output',t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-package-gates-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 for(const flag of ['BOUJOY_ALLOW_UNVERIFIED_APK','BOUJOY_SHARE_WITHOUT_ANDROID']){
  const output=path.join(base,flag),env={...process.env,BOUJOY_SHARE_OUTPUT:output,[flag]:'1'};
  const result=spawnSync(process.execPath,['scripts/package-share.mjs'],{cwd:root,env,encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/bypass options are forbidden/);assert.equal(fs.existsSync(output),false);
 }
});
test('formal share packaging requires the matching build metadata even for a provided APK',t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-package-metadata-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const apk=path.join(base,'app-release.apk'),output=path.join(base,'release');fs.writeFileSync(apk,'synthetic fixture');
 const env={...process.env,BOUJOY_SHARE_OUTPUT:output,BOUJOY_FRESH_ANDROID_APK:apk};delete env.BOUJOY_ALLOW_UNVERIFIED_APK;delete env.BOUJOY_SHARE_WITHOUT_ANDROID;
 const result=spawnSync(process.execPath,['scripts/package-share.mjs'],{cwd:root,env,encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/requires its adjacent output-metadata.json/);assert.equal(fs.existsSync(output),false);
});
