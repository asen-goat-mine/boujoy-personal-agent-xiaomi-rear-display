import test from 'node:test';
import {NEEDS_SANDBOX} from './helpers/requirements.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {snapshot,verify,restore,rehearse,acknowledge} from '../scripts/recovery.mjs';
import {Store} from '../src/core/store.mjs';import {Engine} from '../src/core/engine.mjs';
const signingPaths=['build-tools/android/signing/boujoy-android.jks','build-tools/android/signing/store-password'];
function signingIdentity(runtime){for(const [index,relative] of signingPaths.entries()){const file=path.join(runtime,relative);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,'synthetic-signing-identity-'+index,{mode:0o600});}return path.join(runtime,'build-tools/android/signing');}
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-recovery-')),source=path.join(root,'project'),runtime=path.join(root,'runtime'),out=path.join(root,'snapshot');
 fs.mkdirSync(source,{recursive:true});for(const name of ['src','web','config','distribution.json','package.json','package-lock.json'])fs.cpSync(fileURLToPath(new URL('../'+name,import.meta.url)),path.join(source,name),{recursive:true});fs.writeFileSync(path.join(source,'.dockerignore'),'**\n!src/\n');
 const store=new Store(runtime),engine=new Engine({store,broker:{},memory:{},secrets:{}});engine.pump=async()=>{};
 const task=engine.create({prompt:'打开淘宝',cloudConsent:true});store.transaction(s=>{s.tasks[0].status='running';s.actions.push({id:'pending-action',taskId:task.id,status:'unknown',nativeRequestId:'native-original',input:{action:'launch_app'}});s.approvals.push({id:'approval',status:'pending'});});store.close();
 fs.mkdirSync(path.join(runtime,'phone'),{recursive:true});fs.writeFileSync(path.join(runtime,'phone/phoneuse-pending.json'),'{"requestId":"native-original","status":"unknown"}');fs.writeFileSync(path.join(runtime,'phone/phoneuse.json'),'{"credential":"synthetic-secret"}');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,source,runtime,out,task};
}
test('offline snapshot hashes source and runtime, restores only to a fresh isolated destination, and preserves unknown receipts',t=>{
 const f=fixture(t),captured=snapshot(f);assert.equal(captured.keychainExported,false);assert.equal(verify({snapshot:f.out}).valid,true);
 assert.equal(fs.statSync(path.join(f.out,'runtime/phone/phoneuse.json')).mode&0o777,0o600);
 const productionBefore=fs.readFileSync(path.join(f.runtime,'state.json'),'utf8');const result=restore({snapshot:f.out,to:path.join(f.root,'restore')});
 assert.equal(fs.readFileSync(path.join(f.runtime,'state.json'),'utf8'),productionBefore);assert.throws(()=>restore({snapshot:f.out,to:f.runtime}));
 const state=JSON.parse(fs.readFileSync(path.join(result.runtime,'state.json')));assert.equal(state.recoveryFence.required,true);assert.equal(state.schedulerPaused,true);assert.equal(state.settings.phoneEnabled,false);assert.equal(state.tasks[0].status,'unknown_result');assert.equal(state.actions[0].nativeRequestId,'native-original');assert.equal(state.approvals[0].status,'expired');
 assert.deepEqual(fs.readFileSync(path.join(result.runtime,'phone/phoneuse-pending.json')),fs.readFileSync(path.join(f.runtime,'phone/phoneuse-pending.json')));
 assert.equal(fs.readFileSync(path.join(result.source,'.dockerignore'),'utf8'),fs.readFileSync(path.join(f.source,'.dockerignore'),'utf8'));
});
test('rehearsal starts no model, blocks dispatch, rejects corruption before restore, and requires offline exact fence acknowledgement',{skip:NEEDS_SANDBOX},async t=>{
 const f=fixture(t);fs.appendFileSync(path.join(f.source,'src/core/engine.mjs'),'\nimport {writeFileSync as sourceProbeWrite} from "node:fs";sourceProbeWrite(process.env.BOUJOY_DATA+"/restored-engine-loaded","restored-source-only");\n');
 snapshot(f);const result=await rehearse({snapshot:f.out,to:path.join(f.root,'rehearsal')});assert.equal(result.modelStarts,0);assert.equal(result.networkRequests,0);assert.equal(result.credentialReads,0);assert.equal(result.phoneCalls,0);assert.equal(result.memoryCalls,0);assert.equal(result.dispatchBlocked,true);assert.equal(result.monitorStartupBlocked,true);assert.equal(result.corruptionRejected,true);assert.equal(result.unknownActionsPreserved,1);assert.equal(result.sourceRuntimeVerified,true);
 assert.equal(result.sourceRuntime.source,result.source);assert.equal(result.sourceRuntime.isolation,'macos-seatbelt-files-network-process-mach');assert.deepEqual(result.sourceRuntime.entrypoints.map(e=>e.path),['src/core/store.mjs','src/core/engine.mjs','src/core/scheduler.mjs','src/core/event-monitor.mjs']);assert(result.sourceRuntime.entrypoints.every(e=>/^[a-f0-9]{64}$/.test(e.sha256)));assert.deepEqual(result.rejectedOperations,['create','newTask','continue']);
 assert.equal(fs.readFileSync(path.join(result.destination,'source-runtime-probe/runtime/restored-engine-loaded'),'utf8'),'restored-source-only');assert.equal(fs.existsSync(path.join(result.runtime,'restored-engine-loaded')),false);assert.equal(fs.existsSync(path.join(result.destination,'source-runtime-probe/runtime/phone')),false);assert.equal(fs.existsSync(path.join(result.source,'node_modules')),false);
 assert.throws(()=>acknowledge({runtime:result.runtime,fenceId:'wrong'}));const live=new Store(result.runtime);assert.throws(()=>acknowledge({runtime:result.runtime,fenceId:result.fenceId}),/running/);live.close();
 acknowledge({runtime:result.runtime,fenceId:result.fenceId});const reopened=new Store(result.runtime);try{assert.equal(reopened.data.recoveryFence.required,false);assert.equal(reopened.data.schedulerPaused,true);assert.equal(reopened.data.tasks[0].status,'unknown_result');}finally{reopened.close();}
});
test('rehearsal refuses stub exports and missing restored modules instead of falling back to current production modules',{skip:NEEDS_SANDBOX},async t=>{
 for(const invalid of ['stub','missing']){
  const f=fixture(t);if(invalid==='stub')fs.writeFileSync(path.join(f.source,'src/core/engine.mjs'),'export const snapshot = true;\n');else fs.unlinkSync(path.join(f.source,'src/core/scheduler.mjs'));
  snapshot(f);const to=path.join(f.root,'refused');await assert.rejects(rehearse({snapshot:f.out,to}),error=>error.code==='source_runtime_unverified'&&/missing Store, Engine, Scheduler or SignedEventMonitor exports|ERR_MODULE_NOT_FOUND/.test(error.message));
  const report=JSON.parse(fs.readFileSync(path.join(to,'rehearsal-report.json')));assert.equal(report.sourceRuntimeVerified,false);assert.equal(report.dispatchBlocked,false);assert.equal(report.activated,false);assert.equal(report.error.code,'source_runtime_unverified');assert.equal(fs.existsSync(path.join(to,'corruption-probe')),false);
 }
});
test('rehearsal exercises the restored Store, Engine and Scheduler fences, not only already-fenced copied state',{skip:NEEDS_SANDBOX},async t=>{
 const changes=[['store.mjs','fenceRecoveredState(s,fence);','s.recoveryFence={required:false};','did not reapply'],['engine.mjs','if(this.pumping||this.shuttingDown||this.store.data.recoveryFence?.required)return;','if(this.pumping||this.shuttingDown)return;','credentialReads'],['scheduler.mjs','if(this.store.data.schedulerPaused||this.store.data.recoveryFence?.required)return;','if(this.store.data.schedulerPaused)return;','恢复隔离'],['store.mjs','rule.conditionState=null;','','historical baselines'],['event-monitor.mjs','!this.closed&&!this.store.data.recoveryFence?.required&&!this.store.data.schedulerPaused','!this.closed&&!this.store.data.schedulerPaused','Restored monitor attempted']];
 for(const [name,before,after,errorText] of changes){
  const f=fixture(t),file=path.join(f.source,'src/core',name),original=fs.readFileSync(file,'utf8');assert(original.includes(before));fs.writeFileSync(file,original.replace(before,after));snapshot(f);
  await assert.rejects(rehearse({snapshot:f.out,to:path.join(f.root,'broken-fence')}),error=>error.code==='source_runtime_unverified'&&error.message.includes(errorText));
 }
});
test('restored source probe cannot access runtime credentials, subprocesses or network and does not inherit parent environment',{skip:NEEDS_SANDBOX},async t=>{
 const attempts=[
  ['credentials','import {readFileSync} from "node:fs";readFileSync(process.env.BOUJOY_DATA+"/../../runtime/phone/phoneuse.json");','EPERM'],
  ['subprocess','import {execFileSync} from "node:child_process";execFileSync("/usr/bin/true");','EPERM'],
  ['network','await fetch("http://127.0.0.1:9/");','networkRequests'],
  ['dependency','import "missing-restored-dependency";','ERR_MODULE_NOT_FOUND']
 ];
 for(const [name,code,expected] of attempts){
  const f=fixture(t);fs.appendFileSync(path.join(f.source,'src/core/engine.mjs'),'\n'+code+'\n');snapshot(f);
  await assert.rejects(rehearse({snapshot:f.out,to:path.join(f.root,name)}),error=>error.code==='source_runtime_unverified'&&error.message.includes(expected));
 }
 const f=fixture(t),previous=process.env.BOUJOY_REHEARSAL_PARENT_SECRET;process.env.BOUJOY_REHEARSAL_PARENT_SECRET='fixture-only-secret';
 try{fs.appendFileSync(path.join(f.source,'src/core/engine.mjs'),'\nif(process.env.BOUJOY_REHEARSAL_PARENT_SECRET||process.env.NODE_OPTIONS||process.env.NODE_PATH)throw Error("parent environment leaked");\n');snapshot(f);assert.equal((await rehearse({snapshot:f.out,to:path.join(f.root,'clean-environment')})).sourceRuntimeVerified,true);}
 finally{if(previous===undefined)delete process.env.BOUJOY_REHEARSAL_PARENT_SECRET;else process.env.BOUJOY_REHEARSAL_PARENT_SECRET=previous;}
});
test('live runtime, symlinks, unlisted files, incomplete legacy manifests and checksum changes are rejected',t=>{
 const f=fixture(t),store=new Store(f.runtime);assert.throws(()=>snapshot(f),/running/);store.close();
 fs.symlinkSync('/etc/hosts',path.join(f.source,'src/escape'));assert.throws(()=>snapshot(f),/symlink/i);fs.unlinkSync(path.join(f.source,'src/escape'));
 snapshot(f);fs.writeFileSync(path.join(f.out,'runtime/extra'),'unlisted');assert.throws(()=>verify({snapshot:f.out}),/Unlisted/);fs.unlinkSync(path.join(f.out,'runtime/extra'));
 fs.appendFileSync(path.join(f.out,'source/src/core/engine.mjs'),'changed');assert.throws(()=>restore({snapshot:f.out,to:path.join(f.root,'refused')}),/checksum/);assert.equal(fs.existsSync(path.join(f.root,'refused')),false);
 const legacy=path.join(f.root,'legacy');fs.mkdirSync(legacy);fs.writeFileSync(path.join(legacy,'manifest.json'),JSON.stringify({kind:'source-and-runtime-snapshot',files:[]}));assert.throws(()=>verify({snapshot:legacy}),/complete source\/runtime manifest/);
});
test('restored state remains fenced even if a queued task is inserted before restart',async t=>{
 const f=fixture(t);snapshot(f);const result=restore({snapshot:f.out,to:path.join(f.root,'fenced')}),file=path.join(result.runtime,'state.json'),state=JSON.parse(fs.readFileSync(file));state.tasks[0].status='queued';state.recoveryFence.required=false;fs.writeFileSync(file,JSON.stringify(state));
 const store=new Store(result.runtime),engine=new Engine({store,broker:{},memory:{},secrets:{get:async()=>{throw Error('not permitted');}}});try{assert.equal(store.data.recoveryFence.required,true);await engine.pump();assert.throws(()=>engine.create({prompt:'你好',cloudConsent:true}));await assert.rejects(engine.continue(f.task.id,{message:'继续'}));assert.equal(store.task(f.task.id).status,'unknown_result');}finally{store.close();}
});
test('snapshot excludes rebuildable Android tools and preserves the exact APK signing identity with private permissions',t=>{
 const f=fixture(t);signingIdentity(f.runtime);const tools=path.join(f.runtime,'build-tools/android');fs.mkdirSync(path.join(tools,'jdk/legal'),{recursive:true});fs.writeFileSync(path.join(tools,'jdk/rebuildable'),'do not back up');fs.symlinkSync('../rebuildable',path.join(tools,'jdk/legal/LICENSE'));fs.writeFileSync(path.join(tools,'signing/not-a-signing-credential'),'exclude unrelated signing directory contents');
 snapshot(f);const checked=verify({snapshot:f.out});assert.deepEqual(checked.manifest.preservedRuntimeExceptions,signingPaths);assert(checked.manifest.exclusions.runtime.includes('build-tools'));
 assert.deepEqual(checked.manifest.files.filter(e=>e.kind==='runtime'&&e.path.startsWith('build-tools/')).map(e=>e.path),signingPaths);
 const restored=restore({snapshot:f.out,to:path.join(f.root,'signed-restore')});for(const relative of signingPaths){assert.deepEqual(fs.readFileSync(path.join(restored.runtime,relative)),fs.readFileSync(path.join(f.runtime,relative)));assert.equal(fs.statSync(path.join(restored.runtime,relative)).mode&0o777,0o600);assert.equal(fs.statSync(path.dirname(path.join(restored.runtime,relative))).mode&0o777,0o700);}
 assert.equal(fs.existsSync(path.join(restored.runtime,'build-tools/android/jdk')),false);fs.appendFileSync(path.join(f.out,'runtime',signingPaths[0]),'tampered');assert.throws(()=>restore({snapshot:f.out,to:path.join(f.root,'tampered')}),/checksum/);assert.equal(fs.existsSync(path.join(f.root,'tampered')),false);
});
test('signing backup rejects partial identities, loose permissions and linked signing paths without traversing toolchains',t=>{
 const f=fixture(t),signing=signingIdentity(f.runtime),key=path.join(f.runtime,signingPaths[0]),password=path.join(f.runtime,signingPaths[1]);
 fs.unlinkSync(password);assert.throws(()=>snapshot(f),/signing identity is incomplete/);fs.writeFileSync(password,'synthetic-password',{mode:0o600});
 fs.chmodSync(key,0o644);assert.throws(()=>snapshot(f),/credentials must be 0600/);fs.chmodSync(key,0o600);fs.chmodSync(signing,0o755);assert.throws(()=>snapshot(f),/directory must be 0700/);fs.chmodSync(signing,0o700);
 fs.unlinkSync(key);fs.symlinkSync(path.join(f.root,'missing-key'),key);assert.throws(()=>snapshot(f),/symlink/i);fs.unlinkSync(key);fs.writeFileSync(key,'synthetic-key',{mode:0o600});
 const moved=signing+'-moved';fs.renameSync(signing,moved);fs.symlinkSync(moved,signing);assert.throws(()=>snapshot(f),/symlink/i);fs.unlinkSync(signing);fs.renameSync(moved,signing);
 snapshot(f);fs.chmodSync(path.join(f.out,'runtime/build-tools/android/signing'),0o755);assert.throws(()=>verify({snapshot:f.out}),/directory permissions must be 0700/);
});
test('restoring a remote backup disables historical device bindings and pairing even after recovery acknowledgement',t=>{
 const f=fixture(t),remoteFile=path.join(f.runtime,'remote/state.json');fs.mkdirSync(path.dirname(remoteFile),{recursive:true});const remote={version:1,devices:{old:{id:'phone',active:true},revoked:{id:'other',active:false,revokedAt:'2026-01-01T00:00:00Z'}},pairing:{tokenHash:'synthetic',expiresAt:Date.now()+600000},messages:{'original-id':{taskId:f.task.id}},control:{controlEpoch:7,paused:false}};fs.writeFileSync(remoteFile,JSON.stringify(remote));
 snapshot(f);const restored=restore({snapshot:f.out,to:path.join(f.root,'remote-restore')});acknowledge({runtime:restored.runtime,fenceId:restored.fenceId});const actual=JSON.parse(fs.readFileSync(path.join(restored.runtime,'remote/state.json')));
 assert.equal(actual.control.paused,true);assert.equal(actual.control.controlEpoch,8);assert.equal(actual.pairing,null);assert.equal(actual.devices.old.active,false);assert(actual.devices.old.recoveryDisabledAt);assert.equal(actual.devices.revoked.active,false);assert.equal(actual.devices.revoked.revokedAt,remote.devices.revoked.revokedAt);assert.deepEqual(actual.messages,remote.messages);assert.deepEqual(JSON.parse(fs.readFileSync(remoteFile)),remote);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.out,'runtime/remote/state.json'))),remote);
});
test('Chromium process markers are excluded but browser profile state and all other symlink protections remain',t=>{
 const f=fixture(t),browser=path.join(f.runtime,'browser');fs.mkdirSync(browser);fs.symlinkSync('155.0.8059.40:1',path.join(browser,'RunningChromeVersion'));fs.symlinkSync('/tmp/nonexistent-browser-socket',path.join(browser,'SingletonSocket'));fs.writeFileSync(path.join(browser,'Preferences'),'profile-data');snapshot(f);const manifest=JSON.parse(fs.readFileSync(path.join(f.out,'manifest.json')));assert.equal(manifest.files.some(e=>e.path==='browser/RunningChromeVersion'),false);assert.equal(manifest.files.some(e=>e.path==='browser/Preferences'),true);assert.equal(verify({snapshot:f.out}).valid,true);
 fs.symlinkSync('/etc/hosts',path.join(browser,'UserData'));assert.throws(()=>snapshot({...f,out:path.join(f.root,'second')}),/symlink/i);
});
test('native desktop process markers are excluded without following targets while actual profile and pet state restore',t=>{
 const f=fixture(t),profile=path.join(f.runtime,'desktop-native'),outside=path.join(f.root,'outside-profile');fs.mkdirSync(profile);fs.writeFileSync(outside,'must-not-be-followed');
 const markers=['RunningChromeVersion','SingletonCookie','SingletonLock','SingletonSocket'];
 for(const name of markers)fs.symlinkSync(name==='SingletonCookie'?outside:path.join(f.root,'missing-'+name),path.join(profile,name));
 fs.writeFileSync(path.join(profile,'Preferences'),'native-profile-data');fs.writeFileSync(path.join(profile,'pet-state.json'),'{"visible":true}');
 snapshot(f);const checked=verify({snapshot:f.out});
 for(const name of markers){assert(checked.manifest.exclusions.runtime.includes('desktop-native/'+name));assert.equal(checked.manifest.files.some(e=>e.kind==='runtime'&&e.path==='desktop-native/'+name),false);assert.equal(fs.existsSync(path.join(f.out,'runtime/desktop-native',name)),false);assert(fs.lstatSync(path.join(profile,name)).isSymbolicLink());}
 const restored=restore({snapshot:f.out,to:path.join(f.root,'native-restore')});
 for(const name of ['Preferences','pet-state.json']){assert.deepEqual(fs.readFileSync(path.join(restored.runtime,'desktop-native',name)),fs.readFileSync(path.join(profile,name)));assert.equal(fs.statSync(path.join(restored.runtime,'desktop-native',name)).mode&0o777,0o600);}
 for(const name of markers)assert.equal(fs.existsSync(path.join(restored.runtime,'desktop-native',name)),false);
 assert.equal(fs.readFileSync(outside,'utf8'),'must-not-be-followed');
});
test('native desktop marker exclusions do not permit unknown, nested or similarly named profile symlinks',t=>{
 const f=fixture(t),outside=path.join(f.root,'external-state');fs.writeFileSync(outside,'outside-state');
 for(const relative of ['desktop-native/Preferences','desktop-native/Default/SingletonCookie','desktop-native-copy/SingletonCookie']){
  const file=path.join(f.runtime,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.symlinkSync(outside,file);
  assert.throws(()=>snapshot(f),/Snapshot refuses symlinks:/);assert.equal(fs.existsSync(f.out),false);fs.unlinkSync(file);
 }
 fs.rmSync(path.join(f.runtime,'desktop-native'),{recursive:true});fs.symlinkSync(path.dirname(outside),path.join(f.runtime,'desktop-native'));
 assert.throws(()=>snapshot(f),/Snapshot refuses symlinks: desktop-native/);assert.equal(fs.existsSync(f.out),false);
});

test('restore disables monitored delivery, removes historical baselines and retains only non-executable uncertain receipts',t=>{
 const f=fixture(t),file=path.join(f.runtime,'state.json'),state=JSON.parse(fs.readFileSync(file)),signedAt=String(Date.now()-1000),bodySha256='a'.repeat(64);
 state.eventRules=[{id:'rule',enabled:true,conditionState:{lastValue:10,initialized:true},authorization:{id:'old-auth'}}];
 state.eventMonitors=[{id:'monitor',ruleId:'rule',enabled:true,pending:{eventId:'pending-event',timestamp:signedAt,bodySha256,nonce:'never-replay',rawBody:'private-history'}}];
 const receipts=[{id:'older-receipt',ruleId:'rule',eventId:'older-event',bodySha256:'b'.repeat(64)}];state.eventReceipts=receipts;fs.writeFileSync(file,JSON.stringify(state));
 snapshot(f);const result=restore({snapshot:f.out,to:path.join(f.root,'monitor-restore')}),actual=JSON.parse(fs.readFileSync(path.join(result.runtime,'state.json')));
 assert.equal(actual.eventRules[0].enabled,false);assert.equal(actual.eventRules[0].conditionState,null);assert(actual.eventRules[0].authorization.revokedAt);assert.equal(actual.eventMonitors[0].enabled,false);assert.equal(actual.eventMonitors[0].pending,null);
 const receipt=actual.eventMonitors[0].recoveryReceipt;assert.deepEqual(receipt,{fenceId:result.fenceId,restoredAt:actual.recoveryFence.restoredAt,eventId:'pending-event',bodySha256,signedAt:new Date(Number(signedAt)).toISOString(),deliveryState:'unknown',receiptId:null,replayAllowed:false});assert.equal(JSON.stringify(receipt).includes('private-history'),false);assert.equal(JSON.stringify(receipt).includes('never-replay'),false);assert.deepEqual(actual.eventReceipts,receipts);
 const reopened=new Store(result.runtime);try{assert.deepEqual(reopened.data.eventMonitors[0].recoveryReceipt,receipt);}finally{reopened.close();}
 acknowledge({runtime:result.runtime,fenceId:result.fenceId});const acknowledged=JSON.parse(fs.readFileSync(path.join(result.runtime,'state.json')));assert.equal(acknowledged.eventMonitors[0].enabled,false);assert.equal(acknowledged.eventRules[0].enabled,false);assert.equal(acknowledged.eventRules[0].conditionState,null);assert.deepEqual(JSON.parse(fs.readFileSync(file)),state);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.out,'runtime/state.json'))),state);
});
