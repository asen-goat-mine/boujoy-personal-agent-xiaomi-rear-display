import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {canonicalAndroidInputs,androidInputsDigest,collectAndroidSourceInputs,verifyAndroidSourceReceipt} from '../scripts/android-source-gate.mjs';
const D={edition:'phoneuse',androidApplicationId:'dev.boujoy.phoneuse',androidVersion:'1.0.52',androidVersionCode:54};
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-apk-receipt-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const [name,body] of Object.entries({'android/app/src/main/java/Example.java':'class Example {}','android/app/src/test/java/ExampleTest.java':'class ExampleTest {}','android/app/src/main/res/values/strings.xml':'<resources/>','android/app/build.gradle':'app','android/build.gradle':'root','android/settings.gradle':'settings','android/gradle.properties':'properties','distribution.json':JSON.stringify(D)})){const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);}
 const apkPath=path.join(root,'output/app-release.apk');fs.mkdirSync(path.dirname(apkPath));fs.writeFileSync(apkPath,'synthetic APK bytes');
 const androidSourceInputs=collectAndroidSourceInputs(root),report={edition:D.edition,applicationId:D.androidApplicationId,version:D.androidVersion,versionCode:D.androidVersionCode,sha256:createHash('sha256').update(fs.readFileSync(apkPath)).digest('hex'),androidSourceInputs,androidSourceDigest:androidInputsDigest(androidSourceInputs)};
 const reportPath=path.join(path.dirname(apkPath),'boujoy-build-report.json'),save=()=>fs.writeFileSync(reportPath,JSON.stringify(report));save();return {root,apkPath,report,reportPath,save,verify:()=>verifyAndroidSourceReceipt({root,apkPath,distribution:D})};
}
test('source receipt accepts matching APK, full source set and build inputs independent of mtimes',t=>{
 const f=fixture(t);fs.utimesSync(f.apkPath,0,0);const result=f.verify();assert.equal(result.sourceInputsVerified,true);assert.equal(result.androidSourceInputCount,8);assert.equal(result.androidSourceDigest,f.report.androidSourceDigest);
});
test('source receipt rejects changed, added and deleted source/resource/test files even with preserved timestamp',t=>{
 for(const action of ['changed','added','deleted']){const f=fixture(t),file=path.join(f.root,'android/app/src/main/java/Example.java'),before=fs.statSync(file);
  if(action==='changed'){fs.writeFileSync(file,'class Changed {}');fs.utimesSync(file,before.atime,before.mtime);}if(action==='added')fs.writeFileSync(path.join(f.root,'android/app/src/test/java/NewTest.java'),'new test');if(action==='deleted')fs.unlinkSync(path.join(f.root,'android/app/src/main/res/values/strings.xml'));
  assert.throws(f.verify,/source inputs changed/);
 }
});
test('source receipt rejects missing receipt, wrong edition/package/version/code and replaced APK bytes',t=>{
 for(const field of ['edition','applicationId','version','versionCode']){const f=fixture(t);f.report[field]='wrong';f.save();assert.throws(f.verify,/identity mismatch/);}
 const replaced=fixture(t);fs.appendFileSync(replaced.apkPath,'changed');assert.throws(replaced.verify,/APK bytes/);
 const absent=fixture(t);fs.unlinkSync(absent.reportPath);assert.throws(absent.verify,/requires its adjacent/);
});
test('source receipt rejects forged digest, extra paths and symlinked inputs',t=>{
 const digest=fixture(t);digest.report.androidSourceDigest='0'.repeat(64);digest.save();assert.throws(digest.verify,/digest is invalid/);
 const extra=fixture(t);extra.report.androidSourceInputs['../external']='a'.repeat(64);extra.report.androidSourceDigest=androidInputsDigest(extra.report.androidSourceInputs);extra.save();assert.throws(extra.verify,/source inputs changed/);
 const link=fixture(t),file=path.join(link.root,'android/app/src/main/java/Example.java');fs.unlinkSync(file);fs.symlinkSync(path.join(link.root,'android/settings.gradle'),file);assert.throws(link.verify,/symlink/);
});
test('compact ASCII source digest encoding agrees with Python for ASCII and non-ASCII paths',()=>{
 const inputs={'android/app/src/main/资源.txt':'a'.repeat(64),'distribution.json':'b'.repeat(64),'android/app/src/main/Z.java':'c'.repeat(64)};
 const result=spawnSync('python3',['-c',"import json,sys; x=json.load(sys.stdin); print(json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=True),end='')"],{input:JSON.stringify(inputs),encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.equal(canonicalAndroidInputs(inputs),result.stdout);
});
