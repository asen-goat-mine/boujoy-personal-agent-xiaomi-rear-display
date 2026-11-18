import {DISTRIBUTION} from '../src/distribution.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fenceRecoveredState} from '../src/core/store.mjs';

const sourceRoots=['src','web','scripts','tests','docs','android','config','desktop','macos','deploy','vendor','README.md','distribution.json','runtime-manifest.json','package.json','package-lock.json','.gitignore','.dockerignore'];
const ignored=new Set(['node_modules','.git','.gradle','build','dist','.DS_Store','__pycache__','.venv','.pytest_cache']);
const runtimeIgnored=new Set(['backups','logs','service.lock','harness','build-tools','code-runs','voice-work']);
// These exact Chromium profile roots are owned by Browser and desktop/main.cjs.
// Process markers are not recoverable profile data; do not follow their links
// or generalize this exclusion to matching names elsewhere in the runtime.
const runtimeEphemeralPaths=new Set(['browser','desktop-native'].flatMap(profile=>['RunningChromeVersion','SingletonCookie','SingletonLock','SingletonSocket'].map(name=>profile+'/'+name)));
// Toolchains are large and contain platform symlinks. Only the established APK
// signing identity is irreproducible; never traverse the rest of build-tools.
const signingFiles=['build-tools/android/signing/boujoy-android.jks','build-tools/android/signing/store-password'];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const runFile=promisify(execFile);
const ensure=(value,message)=>{if(!value)throw new Error(message);};
const isInside=(root,target)=>target===root||target.startsWith(root+path.sep);
function safeRelative(value){ensure(typeof value==='string'&&value.length>0&&!value.includes('\\')&&!path.isAbsolute(value)&&!value.split('/').some(x=>!x||x==='.'||x==='..'),'Unsafe manifest path');return value;}
function assertNoSymlinks(target){
  let current=path.resolve(target);while(true){let stat;try{stat=fs.lstatSync(current);}catch(e){if(e.code!=='ENOENT')throw e;}if(stat)ensure(!stat.isSymbolicLink()||process.platform==='darwin'&&['/var','/tmp','/etc'].includes(current)&&fs.realpathSync(current)==='/private'+current,'Symlink path is not permitted');const parent=path.dirname(current);if(parent===current)break;current=parent;}
}
function canonical(target){
  const absolute=path.resolve(target);assertNoSymlinks(absolute);let current=absolute;const suffix=[];
  while(!fs.existsSync(current)){suffix.unshift(path.basename(current));const parent=path.dirname(current);ensure(parent!==current,'Cannot resolve destination');current=parent;}
  return path.join(fs.realpathSync(current),...suffix);
}
function offline(runtime){
  assertNoSymlinks(runtime);const lock=path.join(runtime,'service.lock');
  if(fs.existsSync(lock)){
    let pid;try{pid=Number(fs.readFileSync(path.join(lock,'pid'),'utf8'));}catch{}
    ensure(Number.isInteger(pid)&&pid>0,'Runtime has an unreadable service lock; stop and inspect it first');
    let alive=true;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}
    ensure(!alive,'Runtime service is running; offline recovery refuses to continue');
  }
}
function fresh(destination,protectedRoots=[]){
  const dest=canonical(destination);ensure(!fs.existsSync(dest),'Destination already exists; recovery never overwrites a directory');
  for(const root of protectedRoots.filter(Boolean).map(canonical))ensure(!isInside(root,dest)&&!isInside(dest,root),'Destination overlaps a protected source/runtime directory');
  fs.mkdirSync(dest,{recursive:true,mode:0o700});fs.chmodSync(dest,0o700);return dest;
}
function walk(root,{runtime=false}={}){
  assertNoSymlinks(root);const found=[];
  function visit(relative){const absolute=path.join(root,relative),stat=fs.lstatSync(absolute);ensure(!stat.isSymbolicLink(),'Snapshot refuses symlinks: '+relative);
    if(stat.isDirectory()){for(const name of fs.readdirSync(absolute).sort()){const child=relative?relative+'/'+name:name;if(ignored.has(name)||runtime&&(!relative&&runtimeIgnored.has(name)||runtimeEphemeralPaths.has(child)))continue;visit(child);}return;}
    ensure(stat.isFile(),'Snapshot refuses special files: '+relative);found.push(relative);
  }
  if(runtime){
    visit('');const signing=signingFiles.filter(relative=>{const file=path.join(root,relative);assertNoSymlinks(file);return fs.existsSync(file);});
    ensure(signing.length===0||signing.length===signingFiles.length,'APK signing identity is incomplete; preserve both keystore and password');
    for(const relative of signing){const file=path.join(root,relative);ensure(fs.lstatSync(file).isFile(),'APK signing identity must contain regular files');ensure((fs.statSync(file).mode&0o777)===0o600,'APK signing credentials must be 0600');ensure((fs.statSync(path.dirname(file)).mode&0o777)===0o700,'APK signing directory must be 0700');visit(relative);}
  }else for(const name of sourceRoots)if(fs.existsSync(path.join(root,name)))visit(name);
  return found;
}
function writeFile(file,bytes,mode=0o600){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const fd=fs.openSync(file,'wx',mode);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.chmodSync(file,mode);}
function writeJSON(file,data){writeFile(file,JSON.stringify(data,null,2)+'\n');}
function atomicJSON(file,data){const temp=file+'.'+randomUUID()+'.tmp';writeJSON(temp,data);fs.renameSync(temp,file);const fd=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function readState(runtime){const state=JSON.parse(fs.readFileSync(path.join(runtime,'state.json'),'utf8'));ensure(state.schemaVersion===1&&Array.isArray(state.tasks)&&Array.isArray(state.actions)&&state.settings,'Unsupported or invalid runtime state');return state;}

export function snapshot({source,runtime,out}){
  source=canonical(source);runtime=canonical(runtime);offline(runtime);readState(runtime);
  ensure(fs.existsSync(path.join(source,'src/core/engine.mjs')),'Source project is incomplete');
  const entries=[];for(const [kind,root] of [['source',source],['runtime',runtime]])for(const relative of walk(root,{runtime:kind==='runtime'})){
    const file=path.join(root,relative),before=fs.statSync(file),bytes=fs.readFileSync(file),after=fs.statSync(file);
    ensure(before.size===after.size&&before.mtimeMs===after.mtimeMs&&bytes.length===after.size,'Snapshot source changed during capture');
    entries.push({kind,path:relative,bytes:bytes.length,sha256:digest(bytes),mode:kind==='runtime'?0o600:(before.mode&0o111?0o700:0o600)});
  }
  // A snapshot may live inside runtime/backups, which is explicitly excluded from capture.
  const outPath=canonical(out);ensure(!isInside(source,outPath)&&!isInside(outPath,source)&&!isInside(outPath,runtime),'Snapshot output overlaps captured data');
  if(isInside(runtime,outPath))ensure(isInside(path.join(runtime,'backups'),outPath),'Runtime snapshot destination must be under backups');
  const dest=fresh(outPath);try{
    for(const item of entries){const bytes=fs.readFileSync(path.join(item.kind==='source'?source:runtime,item.path));ensure(bytes.length===item.bytes&&digest(bytes)===item.sha256,'Snapshot source changed during capture');writeFile(path.join(dest,item.kind,item.path),bytes,item.mode);}
    const manifest={schemaVersion:2,id:randomUUID(),capturedAt:new Date().toISOString(),kind:'offline-source-runtime',sourceRoot:source,runtimeRoot:runtime,exclusions:{source:[...ignored],runtime:[...runtimeIgnored,...runtimeEphemeralPaths]},preservedRuntimeExceptions:signingFiles.filter(relative=>entries.some(e=>e.kind==='runtime'&&e.path===relative)),credentials:'File-backed credentials, including an existing APK signing identity, are included with mode 0600. macOS Keychain entries are not exported.',files:entries};
    writeJSON(path.join(dest,'manifest.json'),manifest);verify({snapshot:dest});return {snapshot:dest,snapshotId:manifest.id,files:entries.length,sourceFiles:entries.filter(e=>e.kind==='source').length,runtimeFiles:entries.filter(e=>e.kind==='runtime').length,keychainExported:false};
  }catch(e){e.message='Snapshot left incomplete for inspection: '+e.message;throw e;}
}
export function verify({snapshot:directory}){
  const root=path.resolve(directory);assertNoSymlinks(root);const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  ensure(manifest.schemaVersion===2&&manifest.kind==='offline-source-runtime'&&typeof manifest.id==='string'&&Array.isArray(manifest.files),'Snapshot lacks complete source/runtime manifest; capture a new baseline before restoring');
  const seen=new Set();for(const item of manifest.files){
    ensure(['source','runtime'].includes(item.kind),'Invalid snapshot namespace');safeRelative(item.path);const key=item.kind+'/'+item.path;ensure(!seen.has(key),'Duplicate manifest path');seen.add(key);
    const file=path.join(root,key);assertNoSymlinks(file);const stat=fs.lstatSync(file);ensure(stat.isFile(),'Snapshot item is not a file');const bytes=fs.readFileSync(file);
    ensure(Number.isSafeInteger(item.bytes)&&bytes.length===item.bytes&&/^[a-f0-9]{64}$/.test(item.sha256)&&digest(bytes)===item.sha256,'Snapshot checksum mismatch: '+key);
    if(item.kind==='runtime')ensure((stat.mode&0o777)===0o600,'Runtime snapshot file permissions must be 0600');
  }
  for(const kind of ['source','runtime']){
    const inspect=(relative='')=>{const dir=path.join(root,kind,relative);if(kind==='runtime')ensure((fs.statSync(dir).mode&0o777)===0o700,'Runtime snapshot directory permissions must be 0700');for(const name of fs.readdirSync(dir)){const next=relative?relative+'/'+name:name,file=path.join(root,kind,next),stat=fs.lstatSync(file);ensure(!stat.isSymbolicLink(),'Unlisted symlink in snapshot');if(stat.isDirectory())inspect(next);else ensure(stat.isFile()&&seen.has(kind+'/'+next),'Unlisted file in snapshot');}};
    inspect();
  }
  ensure(seen.has('runtime/state.json')&&seen.has('source/src/core/engine.mjs'),'Snapshot is missing core source/runtime');
  const signingCount=signingFiles.filter(relative=>seen.has('runtime/'+relative)).length;ensure(signingCount===0||signingCount===signingFiles.length,'Snapshot APK signing identity is incomplete');
  readState(path.join(root,'runtime'));return {valid:true,snapshotId:manifest.id,files:manifest.files.length,manifest};
}
export function restore({snapshot:directory,to}){
  const checked=verify({snapshot:directory}),manifest=checked.manifest;
  const production=path.join(os.homedir(),'Library/Application Support',DISTRIBUTION.dataDirectoryName);
  const dest=fresh(to,[directory,manifest.sourceRoot,manifest.runtimeRoot,production,fileURLToPath(new URL('..',import.meta.url))]);
  const runtime=path.join(dest,'runtime'),fence={id:randomUUID(),required:true,snapshotId:manifest.id,restoredAt:new Date().toISOString(),reason:'offline_restore'};
  // Install the fence before any state is written. Even an interrupted restore is inert.
  writeJSON(path.join(runtime,'.recovery-fence.json'),fence);
  for(const item of manifest.files){let bytes=fs.readFileSync(path.join(directory,item.kind,item.path));ensure(bytes.length===item.bytes&&digest(bytes)===item.sha256,'Snapshot changed during restore');
    if(item.kind==='runtime'&&item.path==='.recovery-fence.json')continue;
    if(item.kind==='runtime'&&item.path==='state.json')bytes=Buffer.from(JSON.stringify(fenceRecoveredState(JSON.parse(bytes),fence)));
    if(item.kind==='runtime'&&item.path==='remote/state.json'){
      const value=JSON.parse(bytes);ensure(value.control&&typeof value.control==='object'&&Number.isSafeInteger(value.control.controlEpoch)&&value.control.controlEpoch>=0&&value.control.controlEpoch<Number.MAX_SAFE_INTEGER&&value.devices&&typeof value.devices==='object'&&!Array.isArray(value.devices),'Invalid remote control state');
      value.control.paused=true;value.control.controlEpoch++;value.pairing=null;
      // A backup predates later certificate revocations. Never revive historical
      // authorization when the local recovery fence is acknowledged.
      for(const device of Object.values(value.devices)){ensure(device&&typeof device==='object','Invalid restored remote device');device.active=false;device.recoveryDisabledAt=fence.restoredAt;}
      bytes=Buffer.from(JSON.stringify(value));
    }
    writeFile(path.join(dest,item.kind,item.path),bytes,item.kind==='runtime'?0o600:item.mode&0o111?0o700:0o600);
  }
  const state=readState(runtime);
  writeJSON(path.join(dest,'restore-report.json'),{snapshotId:manifest.id,restoredAt:fence.restoredAt,fenceId:fence.id,isolated:true,activated:false,unknownActions:state.actions.filter(a=>a.status==='unknown'&&!a.resolution).length,keychainExported:false});
  return {destination:dest,runtime,source:path.join(dest,'source'),fenceId:fence.id,snapshotId:manifest.id,activated:false};
}
// This script is management code, not part of the restored application. Its only
// application imports are dynamic URLs under the restored source root. A missing
// module/export or dependency is a failed rehearsal, never a production fallback.
const sourceRuntimeProbe=String.raw`
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dgram from 'node:dgram';
import dns from 'node:dns';
const [source,runtime,fenceId,nonce]=process.argv.slice(2);
const counters={modelStarts:0,networkRequests:0,credentialReads:0,phoneCalls:0,memoryCalls:0};
const check=(value,message)=>{if(!value)throw Error(message);};
const deny=key=>()=>{counters[key]++;throw Error('Recovery attempted '+key);};
// Instrument the normal JS entrypoints; Seatbelt additionally denies network
// syscalls, including implementations that do not use these exported functions.
const noNetwork=deny('networkRequests');
for(const [target,names] of [[net,['connect','createConnection']],[net.Socket.prototype,['connect']],[net.Server.prototype,['listen']],[tls,['connect']],[http,['request','get']],[https,['request','get']],[http2,['connect']],[dgram,['createSocket']]])for(const name of names)target[name]=noNetwork;
for(const target of [dns,dns.promises])for(const name of Object.keys(target))if(/^(lookup|resolve)/.test(name)&&typeof target[name]==='function')target[name]=noNetwork;
globalThis.fetch=noNetwork;globalThis.WebSocket=noNetwork;syncBuiltinESMExports();
check(process.execArgv.includes('--no-addons'),'Native addons are not disabled');
let store,monitor;
try{
  const load=relative=>import(pathToFileURL(path.join(source,relative)).href);
  const [{Store},{Engine},{Scheduler},{SignedEventMonitor}]=await Promise.all([load('src/core/store.mjs'),load('src/core/engine.mjs'),load('src/core/scheduler.mjs'),load('src/core/event-monitor.mjs')]);
  check([Store,Engine,Scheduler,SignedEventMonitor].every(value=>typeof value==='function'),'Restored source is missing Store, Engine, Scheduler or SignedEventMonitor exports');
  store=new Store(runtime);
  check(store.data.recoveryFence?.required===true&&store.data.recoveryFence.id===fenceId,'Restored Store did not reapply the on-disk recovery fence');
  check(store.data.schedulerPaused===true&&store.data.settings.phoneEnabled===false&&store.data.settings.browserEnabled===false&&store.data.settings.filesEnabled===false&&store.data.settings.chatCloudConsent===false&&store.data.settings.chatMemoryConsent===false,'Restored Store did not disable recovered execution permissions');
  check((store.data.eventMonitors||[]).every(row=>row.enabled===false&&row.pending===null)&&(store.data.eventRules||[]).every(row=>row.enabled===false&&row.conditionState===null&&(!row.authorization||row.authorization.revokedAt)),'Restored Store did not fence monitor state and historical baselines');
  const forbidPhone=new Proxy({},{get:()=>deny('phoneCalls')});
  const broker={calls:new Map(),approvals:{cancelTask:deny('phoneCalls')},phone:forbidPhone};
  const engine=new Engine({store,broker,secrets:{get:deny('credentialReads')},memory:new Proxy({},{get:()=>deny('memoryCalls')}),runFactory:deny('modelStarts')});
  // A queued task and a due schedule prevent empty backups from passing vacuously.
  // schedulerPaused is cleared only in this throwaway in-memory fixture so the
  // test specifically exercises the recovery fence rather than another guard.
  const at=Date.now(),taskId='recovery-probe-task';
  store.data.tasks.push({id:taskId,title:'recovery probe',prompt:'recovery probe',status:'queued',kind:'general',roleId:'concierge',cloudConsent:true,memoryConsent:false,createdAt:new Date(at).toISOString(),deadlineAt:new Date(at+60000).toISOString(),messages:[],events:[],children:[]});
  store.data.routines.push({id:'recovery-probe-routine',enabled:true,kind:'once',name:'recovery probe',prompt:'recovery probe',nextAt:new Date(at-1).toISOString(),executionWindowSeconds:300,history:[]});
  // These intentionally live monitor rows exercise the restored monitor's own
  // fence even if a historical row is re-enabled accidentally during startup.
  const ruleId='12345678-1234-4234-8234-123456789abc',monitorId='12345678-1234-4234-8234-123456789def';
  store.data.eventRules.push({id:ruleId,enabled:true,revision:1,roleId:'concierge',eventType:'probe',authorization:{id:'probe-authorization',expiresAt:new Date(at+60000).toISOString()}});
  (store.data.eventMonitors||=[]).push({id:monitorId,ruleId,enabled:true,revision:1,nextAt:new Date(at-1).toISOString(),intervalSeconds:30,credentialName:'probe-never-read',authorizationId:'probe-authorization'});
  store.data.schedulerPaused=false;
  monitor=new SignedEventMonitor({store,secrets:{get:deny('credentialReads')},eventTriggers:{},origin:'http://127.0.0.1:9'});
  const before=JSON.stringify(store.data);
  await engine.pump();new Scheduler(store,engine).tick(at);
  monitor.start();await new Promise(resolve=>setTimeout(resolve,1100));monitor.close();
  check(Object.values(counters).every(value=>value===0),'Restored monitor attempted a forbidden execution path');
  // Closing sets another guard; reopen only the flag for a direct poll check.
  monitor.closed=false;let monitorError;try{await monitor.poll(monitorId);}catch(error){monitorError=error;}finally{monitor.close();}
  check(monitorError?.code==='monitor_not_authorized','Restored monitor did not reject while fenced');
  check(JSON.stringify(store.data)===before,'Restored source dispatched or changed a task/schedule/monitor while fenced');
  const rejected=[];
  for(const [name,operation] of [['create',()=>engine.create({prompt:'恢复测试',cloudConsent:true})],['newTask',()=>engine.newTask({prompt:'恢复测试',cloudConsent:true})],['continue',()=>engine.continue(taskId,{message:'继续',cloudConsent:true})]]){
    let error;try{await operation();}catch(value){error=value;}
    check(error&&/恢复隔离/.test(error.message),'Restored '+name+' did not reject specifically because of the recovery fence');rejected.push(name);
  }
  await new Promise(resolve=>setImmediate(resolve));
  check(JSON.stringify(store.data)===before,'Rejected operations changed recovered state');
  check(Object.values(counters).every(value=>value===0),'Restored source attempted a forbidden execution path');
  store.close();store=null;
  process.stdout.write(JSON.stringify({nonce,sourceRuntimeVerified:true,dispatchBlocked:true,monitorStartupBlocked:true,monitorStateFenced:true,rejectedOperations:rejected,...counters}));
}catch(error){
  try{monitor?.close();store?.close();}catch{}
  process.stderr.write(String(error.stack||error.message||error).slice(0,4096));process.exitCode=1;
}
`;
async function verifySourceRuntime(restored){
  const probe=path.join(restored.destination,'source-runtime-probe'),runtime=path.join(probe,'runtime'),script=path.join(probe,'probe.mjs'),nonce=randomUUID();
  try{
    // Node 24's permission model disables fsync even for permitted files, so it
    // cannot run the real Store. Seatbelt restricts actual filesystem/network
    // access while preserving its unmodified durability operations.
    ensure(process.platform==='darwin'&&fs.existsSync('/usr/bin/sandbox-exec'),'Restored-source network isolation is unavailable on this platform');
    ensure(Number(process.versions.node.split('.')[0])>=24,'Restored-source verification requires Node 24 or later');
    writeFile(script,sourceRuntimeProbe);
    const state=readState(restored.runtime);
    // Deliberately stale state ensures the restored Store actually reads the
    // marker, instead of inheriting the current management tool's transformation.
    state.recoveryFence={required:false};state.schedulerPaused=false;state.settings.phoneEnabled=true;state.settings.browserEnabled=true;state.settings.filesEnabled=true;state.settings.chatCloudConsent=true;state.settings.chatMemoryConsent=true;
    (state.eventRules||=[]).push({id:'recovery-input-rule',enabled:true,conditionState:{initialized:true,lastValue:10},authorization:{id:'recovery-input-auth'}});
    (state.eventMonitors||=[]).push({id:'recovery-input-monitor',ruleId:'recovery-input-rule',enabled:true,pending:{eventId:'recovery-input-pending',timestamp:String(Date.now()),bodySha256:'a'.repeat(64),nonce:'never-replay',rawBody:'synthetic-only'}});
    writeJSON(path.join(runtime,'state.json'),state);
    writeFile(path.join(runtime,'.recovery-fence.json'),fs.readFileSync(path.join(restored.runtime,'.recovery-fence.json')));
    const probeCache=path.join(probe,'cache');fs.mkdirSync(probeCache,{mode:0o700});
    const binary=fs.realpathSync(process.execPath),quote=JSON.stringify;
    const readers=[restored.source,probe,path.dirname(path.dirname(binary)),'/System/Library','/usr/lib'].map(root=>`(subpath ${quote(root)})`).join(' ');
    // dyld reads the root directory while starting Node; this literal grants no
    // access to its children. Metadata remains readable for module resolution.
    const profile=`(version 1)(allow default)(deny network*)(deny mach-lookup)(deny process-fork)(deny process-exec (require-not (literal ${quote(binary)})))(deny file-read-data (require-not (require-any ${readers} (literal "/") (literal "/dev/urandom") (literal "/dev/null"))))(deny file-write* (require-not (subpath ${quote(runtime)})))`;
    const args=['-p',profile,binary,'--no-addons',script,restored.source,runtime,restored.fenceId,nonce];
    const {stdout}=await runFile('/usr/bin/sandbox-exec',args,{cwd:probe,env:{TMPDIR:probeCache,PATH:'',LANG:'en_US.UTF-8',TZ:'UTC',BOUJOY_DATA:runtime,BOUJOY_HARNESS:path.join(probe,'unavailable-harness'),BOUJOY_MEMORY_VAULT:path.join(probe,'unavailable-memory')},timeout:10000,killSignal:'SIGKILL',maxBuffer:64*1024});
    const result=JSON.parse(stdout);ensure(result.nonce===nonce&&result.sourceRuntimeVerified===true&&result.dispatchBlocked===true&&result.monitorStartupBlocked===true&&result.monitorStateFenced===true&&['modelStarts','networkRequests','credentialReads','phoneCalls','memoryCalls'].every(key=>result[key]===0)&&result.rejectedOperations?.join(',')==='create,newTask,continue','Invalid restored-source runtime verification result');
    delete result.nonce;
    return {...result,sourceRuntime:{source:restored.source,nodeVersion:process.version,isolation:'macos-seatbelt-files-network-process-mach',entrypoints:['src/core/store.mjs','src/core/engine.mjs','src/core/scheduler.mjs','src/core/event-monitor.mjs'].map(relative=>({path:relative,sha256:digest(fs.readFileSync(path.join(restored.source,relative)))}))}};
  }catch(cause){
    const error=new Error('Restored source runtime was not verified: '+String(cause.stderr||cause.message).slice(0,4096),{cause});error.code='source_runtime_unverified';
    writeJSON(path.join(restored.destination,'rehearsal-report.json'),{...restored,sourceRuntimeVerified:false,dispatchBlocked:false,error:{code:error.code,message:error.message}});throw error;
  }
}
export async function rehearse({snapshot:directory,to}){
  const restored=restore({snapshot:directory,to}),sourceVerification=await verifySourceRuntime(restored);
  const checked=verify({snapshot:directory}),copy=fresh(path.join(restored.destination,'corruption-probe'));
  for(const entry of checked.manifest.files)writeFile(path.join(copy,entry.kind,entry.path),fs.readFileSync(path.join(directory,entry.kind,entry.path)),entry.kind==='runtime'?0o600:entry.mode&0o111?0o700:0o600);
  writeJSON(path.join(copy,'manifest.json'),checked.manifest);const corrupt=checked.manifest.files.find(e=>e.kind==='source');fs.appendFileSync(path.join(copy,corrupt.kind,corrupt.path),'\ncorruption-probe\n');
  let corruptionRejected=false;try{restore({snapshot:copy,to:path.join(restored.destination,'must-not-restore')});}catch{corruptionRejected=true;}
  ensure(corruptionRejected&&!fs.existsSync(path.join(restored.destination,'must-not-restore')),'Corrupt snapshot was not rejected before writing');
  const pendingFiles=checked.manifest.files.filter(e=>e.kind==='runtime'&&/pending/i.test(e.path));
  for(const entry of pendingFiles)ensure(digest(fs.readFileSync(path.join(restored.runtime,entry.path)))===entry.sha256,'Pending native receipt was changed');
  const report={...restored,...sourceVerification,corruptionRejected,unknownActionsPreserved:readState(restored.runtime).actions.filter(a=>a.status==='unknown'&&!a.resolution).length,pendingReceiptFilesPreserved:pendingFiles.length};
  writeJSON(path.join(restored.destination,'rehearsal-report.json'),report);return report;
}
export function acknowledge({runtime,fenceId}){
  runtime=path.resolve(runtime);offline(runtime);const marker=path.join(runtime,'.recovery-fence.json'),fence=JSON.parse(fs.readFileSync(marker,'utf8')),state=readState(runtime);
  ensure(fenceId&&fence.id===fenceId&&state.recoveryFence?.id===fenceId&&state.recoveryFence.required,'Recovery fence ID mismatch');
  state.recoveryFence={...state.recoveryFence,required:false,acknowledgedAt:new Date().toISOString()};state.schedulerPaused=true;
  atomicJSON(path.join(runtime,'state.json'),state);fs.unlinkSync(marker);return {acknowledged:true,fenceId,schedulerPaused:true,previousTasksRemainPaused:true};
}
async function main(args){const command=args.shift(),options={};while(args.length){const key=args.shift();ensure(key?.startsWith('--')&&args.length,'Expected --option value');options[key.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=args.shift();}
  let result;if(command==='snapshot')result=snapshot(options);else if(command==='verify'){const {manifest,...status}=verify(options);result=status;}else if(command==='restore')result=restore(options);else if(command==='rehearse')result=await rehearse(options);else if(command==='acknowledge')result=acknowledge(options);else throw Error('Use snapshot, verify, restore, rehearse, or acknowledge');
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{process.stderr.write('Recovery refused: '+error.message+'\n');process.exitCode=1;});
