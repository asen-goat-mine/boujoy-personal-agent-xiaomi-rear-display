import test from 'node:test';
import assert from 'node:assert/strict';
import {PhoneApps} from '../src/adapters/phone-apps.mjs';

const now=Date.parse('2026-10-14T10:00:00Z'),cachePath='/fixture/phone/apps.json';
function memoryFiles(initial={}){
 const contents=new Map(Object.entries(initial)),writes=[],renames=[];
 return {contents,writes,renames,async readFile(file){if(!contents.has(file))throw Object.assign(new Error('missing'),{code:'ENOENT'});return contents.get(file);},async mkdir(){},async writeFile(file,text,options){writes.push({file,text,options});contents.set(file,text);},async rename(from,to){renames.push({from,to});contents.set(to,contents.get(from));contents.delete(from);},async rm(file){contents.delete(file);}};
}
function setup(packages,{files=memoryFiles(),clock=()=>now,exec,env}={}){
 const calls=[];
 const run=exec||(async(command,args,options)=>{calls.push({command,args,options});return {stdout:packages.map(pkg=>'package:'+pkg).join('\n'),stderr:''};});
 const apps=new PhoneApps({adbPath:'/fixture/platform-tools/adb',cachePath,exec:run,clock,files,env});
 return {apps,calls,files};
}
const unavailable=async()=>{throw Object.assign(new Error('no devices/emulators found'),{code:1});};
const snapshot=packages=>JSON.stringify({version:1,observedAt:'2026-10-14T09:00:00.000Z',packages});

test('fresh app lookup uses only execFile argv and includes exact directory provenance',async()=>{
 const f=setup(['com.tencent.mm','com.taobao.taobao','com.sec.android.app.camera'],{env:{ANDROID_SERIAL:'test-only-device'}});
 const out=await f.apps.list('微信');
 assert.deepEqual(out.apps,[{packageName:'com.tencent.mm',label:'微信',aliases:['微信','WeChat']}]);assert.equal(out.source,'adb');assert.equal(out.cached,false);assert.equal(out.observedAt,'2026-10-14T10:00:00.000Z');assert.equal(out.ageMs,0);
 assert.deepEqual(f.calls[0].args,['shell','pm','list','packages']);assert.equal(f.calls[0].command,'/fixture/platform-tools/adb');assert.equal(f.calls[0].options.shell,undefined);assert.deepEqual(f.calls[0].options.env,{ANDROID_SERIAL:'test-only-device'});assert.equal(f.calls[0].options.timeout,5000);
 const saved=JSON.parse(f.files.contents.get(cachePath));assert.deepEqual(saved.packages,['com.sec.android.app.camera','com.taobao.taobao','com.tencent.mm']);assert.equal(f.files.writes[0].options.mode,0o600);assert.equal(f.files.renames.length,1);
});

test('known labels do not fabricate installation and unknown packages retain their original names',async()=>{
 const f=setup(['com.example.unknown','com.tencent.mm']);
 assert.deepEqual((await f.apps.list('unknown')).apps,[{packageName:'com.example.unknown',label:'com.example.unknown',aliases:['com.example.unknown']}]);
 assert.deepEqual((await f.apps.list('京东')).apps,[]);
 await assert.rejects(f.apps.resolve('com.jingdong.app.mall'),e=>e.code==='app_not_installed');
});

test('system and common Chinese/English aliases identify only actual installed packages',async()=>{
 const rows=[['com.android.settings','Settings','设置'],['com.sec.android.app.camera','相机','相机'],['com.sec.android.gallery3d','相册','相册'],['com.sec.android.app.popupcalculator','计算器','计算器'],['com.sankuai.meituan','美团','美团'],['com.jingdong.app.mall','JD','京东'],['com.xunmeng.pinduoduo','PDD','拼多多'],['com.ss.android.ugc.aweme','Douyin','抖音'],['tv.danmaku.bili','Bili','哔哩哔哩'],['com.autonavi.minimap','高德','高德地图'],['com.baidu.BaiduMap','Baidu Maps','百度地图'],['com.google.android.apps.maps','Google Maps','Google 地图'],['com.tencent.mobileqq','QQ','QQ'],['com.tencent.mtt','QQ Browser','QQ 浏览器']];
 const f=setup(rows.map(([pkg])=>pkg));
 for(const [packageName,query,label] of rows){const found=(await f.apps.list(query)).apps[0];assert.equal(found.packageName,packageName,query);assert.equal(found.label,label,query);assert.ok(found.aliases.includes(query),query);}
});

test('explicit package matching ranks an exact installed package before broader substring candidates',async()=>{
 const f=setup(['com.example.app.plus','com.example.app','com.example.other']);
 const out=await f.apps.list('com.example.app');assert.equal(out.apps[0].packageName,'com.example.app');assert.equal(out.totalMatched,2);
 const resolved=await f.apps.resolve('com.example.app');assert.equal(resolved.packageName,'com.example.app');assert.equal(resolved.cached,true);assert.equal(resolved.reason,'recent_verified_catalog');
});

test('catalog output is bounded to ten matches without exposing other phone data',async()=>{
 const packages=Array.from({length:25},(_,i)=>'com.example.app'+i);const f=setup(packages);
 const out=await f.apps.list('example');assert.equal(out.apps.length,10);assert.equal(out.totalInstalled,25);assert.equal(out.totalMatched,25);assert.equal(out.truncated,true);
 assert.ok(out.apps.every(row=>Object.keys(row).sort().join(',')==='aliases,label,packageName'));
});

test('fresh catalog ignores malformed lines and removes duplicate package entries',async()=>{
 const f=setup([],{exec:async()=>({stdout:'package:com.tencent.mm\npackage:com.tencent.mm\nwarning: ignored\npackage:bad;payload\npackage:/private/secret.apk\npackage:com.example.valid\n',stderr:''})});
 const out=await f.apps.list();assert.equal(out.totalInstalled,2);assert.equal(out.totalMatched,2);assert.equal(out.apps.some(row=>row.packageName.includes('secret')),false);
});

test('a disconnected device uses only valid derived cache and marks its original observation time',async()=>{
 const files=memoryFiles({[cachePath]:snapshot(['com.tencent.mm','com.example.old'])});const f=setup([],{files,exec:unavailable});
 const out=await f.apps.list('微信');assert.equal(out.source,'cache');assert.equal(out.cached,true);assert.equal(out.stale,true);assert.equal(out.observedAt,'2026-10-14T09:00:00.000Z');assert.equal(out.ageMs,3600000);assert.ok(out.unavailableReason);assert.equal(files.writes.length,0);
 const resolved=await f.apps.resolve('com.tencent.mm');assert.equal(resolved.cached,true);assert.equal(resolved.observedAt,out.observedAt);
});

test('no device and no cache produce a clear unavailable error rather than a synthetic app list',async()=>{
 const f=setup([],{exec:unavailable});await assert.rejects(f.apps.list('淘宝'),e=>e.code==='app_catalog_unavailable'&&e.status===503);
});

test('invalid cached package lists and timestamps cannot become an installed directory',async()=>{
 for(const value of ['not-json',JSON.stringify({version:1,observedAt:'bad',packages:['com.tencent.mm']}),snapshot(['com.tencent.mm','bad;payload']),snapshot([])]){
  const f=setup([],{exec:unavailable,files:memoryFiles({[cachePath]:value})});await assert.rejects(f.apps.list(),e=>e.code==='app_catalog_unavailable');
 }
});

test('fresh empty output falls back to cache and cannot replace it with an empty directory',async()=>{
 const files=memoryFiles({[cachePath]:snapshot(['com.tencent.mm'])});const f=setup([],{files});
 const out=await f.apps.list();assert.equal(out.cached,true);assert.equal(out.apps[0].packageName,'com.tencent.mm');assert.equal(files.writes.length,0);
});

test('cache write failure does not hide a real fresh catalog and memory fallback retains provenance',async()=>{
 const files=memoryFiles();files.writeFile=async()=>{throw new Error('disk unavailable');};let connected=true,time=now;
 const f=setup([],{files,clock:()=>time,exec:async()=>{if(!connected)return unavailable();return {stdout:'package:com.tencent.mm\n'};}});
 const fresh=await f.apps.list('微信');assert.equal(fresh.cached,false);assert.equal(fresh.cachePersisted,false);
 connected=false;time+=15001;const fallback=await f.apps.list('微信');assert.equal(fallback.cached,true);assert.equal(fallback.observedAt,fresh.observedAt);assert.equal(fallback.apps[0].packageName,'com.tencent.mm');
});

test('invalid queries/packages are rejected before running adb, including shell-like inputs',async()=>{
 const f=setup(['com.tencent.mm']);
 for(const pkg of ['com.tencent.mm;rm -rf /','$(command)','com.tencent.mm\ncom.other','',null])await assert.rejects(f.apps.resolve(pkg),e=>e.code==='invalid_input');
 for(const query of [false,'x'.repeat(121),null])await assert.rejects(f.apps.list(query),e=>e.code==='invalid_input');
 assert.equal(f.calls.length,0);
});

test('simultaneous lookups share one real directory read without broadening either result',async()=>{
 let calls=0,release;const gate=new Promise(resolve=>{release=resolve;});
 const f=setup([],{exec:async()=>{calls++;await gate;return {stdout:'package:com.tencent.mm\npackage:com.taobao.taobao\n'};}});
 const first=f.apps.list('微信'),second=f.apps.resolve('com.taobao.taobao');release();
 const [list,resolved]=await Promise.all([first,second]);assert.equal(calls,1);assert.equal(list.apps.length,1);assert.equal(list.apps[0].packageName,'com.tencent.mm');assert.equal(resolved.packageName,'com.taobao.taobao');
});

test('list and resolve reuse one recently verified directory and reread when fifteen seconds expire',async()=>{
 let time=now;const f=setup(['com.tencent.mm','com.taobao.taobao'],{clock:()=>time});
 const fresh=await f.apps.list('微信');assert.equal(f.calls.length,1);assert.equal(fresh.source,'adb');
 time+=250;const resolved=await f.apps.resolve('com.tencent.mm');assert.equal(f.calls.length,1);assert.equal(resolved.source,'cache');assert.equal(resolved.cached,true);assert.equal(resolved.reason,'recent_verified_catalog');assert.equal(resolved.stale,false);assert.equal(resolved.ageMs,250);assert.equal(resolved.observedAt,fresh.observedAt);
 await f.apps.list('淘宝');assert.equal(f.calls.length,1);
 time=now+15000;const newer=await f.apps.list('淘宝');assert.equal(f.calls.length,2);assert.equal(newer.cached,false);assert.equal(newer.reason,'fresh_adb');assert.notEqual(newer.observedAt,fresh.observedAt);
});

test('a recent timestamp in a disk cache cannot qualify for verified-memory TTL',async()=>{
 const files=memoryFiles({[cachePath]:JSON.stringify({version:1,observedAt:new Date(now).toISOString(),packages:['com.example.old']})});
 const f=setup(['com.tencent.mm'],{files});const out=await f.apps.list('微信');
 assert.equal(f.calls.length,1);assert.equal(out.source,'adb');assert.equal(out.cached,false);assert.equal(out.apps[0].packageName,'com.tencent.mm');
});

test('failed adb reads use a five-second cooldown then retry rather than permanent fallback',async()=>{
 let time=now,connected=true,calls=0;
 const f=setup([],{clock:()=>time,exec:async()=>{calls++;if(!connected)return unavailable();return {stdout:'package:com.tencent.mm\n'};}});
 const initial=await f.apps.list('微信');assert.equal(calls,1);
 connected=false;time+=16000;const firstFailure=await f.apps.list('微信');assert.equal(calls,2);assert.equal(firstFailure.reason,'adb_unavailable');assert.equal(firstFailure.cached,true);assert.equal(firstFailure.stale,true);
 time+=4999;const reused=await f.apps.resolve('com.tencent.mm');assert.equal(calls,2);assert.equal(reused.reason,'adb_failure_cooldown');assert.equal(reused.observedAt,initial.observedAt);assert.equal(reused.ageMs,20999);
 time+=1;await f.apps.list('微信');assert.equal(calls,3);
 connected=true;time+=5000;const recovered=await f.apps.list('微信');assert.equal(calls,4);assert.equal(recovered.source,'adb');assert.equal(recovered.cached,false);assert.equal(recovered.reason,'fresh_adb');
});

test('a disconnected disk cache is explicitly stale during failure cooldown and retries after expiry',async()=>{
 let time=now,calls=0;const files=memoryFiles({[cachePath]:snapshot(['com.tencent.mm'])});
 const f=setup([],{files,clock:()=>time,exec:async()=>{calls++;return unavailable();}});
 const first=await f.apps.list('微信');assert.equal(calls,1);assert.equal(first.reason,'adb_unavailable');
 time+=1000;const second=await f.apps.resolve('com.tencent.mm');assert.equal(calls,1);assert.equal(second.reason,'adb_failure_cooldown');assert.equal(second.source,'cache');assert.equal(second.stale,true);assert.equal(second.ageMs,3601000);
 time+=4000;await f.apps.list('微信');assert.equal(calls,2);
});

test('list and resolve return the same trusted canonical aliases for non-primary user app names',async()=>{
 const f=setup(['com.android.settings','com.autonavi.minimap']);
 for(const [query,packageName,label] of [['Settings','com.android.settings','设置'],['高德','com.autonavi.minimap','高德地图']]){
  const listed=(await f.apps.list(query)).apps[0],resolved=await f.apps.resolve(packageName);
  assert.equal(listed.label,label);assert.equal(resolved.label,label);assert.ok(listed.aliases.includes(query));assert.deepEqual(resolved.aliases,listed.aliases);
 }
});

test('returned alias arrays cannot mutate the trusted local mapping or assign aliases to unknown packages',async()=>{
 const f=setup(['com.android.settings','com.example.unknown']);
 const listed=(await f.apps.list('Settings')).apps[0];listed.aliases.push('arbitrary model name');
 const resolved=await f.apps.resolve('com.android.settings');assert.equal(resolved.aliases.includes('arbitrary model name'),false);
 const unknown=await f.apps.resolve('com.example.unknown');assert.deepEqual(unknown.aliases,['com.example.unknown']);
});

test('cached directory resolves derive aliases from the same fixed mapping rather than cache contents',async()=>{
 const files=memoryFiles({[cachePath]:JSON.stringify({version:1,observedAt:'2026-10-14T09:00:00.000Z',packages:['com.android.settings'],aliases:['untrusted cached alias']})});
 const f=setup([],{files,exec:unavailable});const resolved=await f.apps.resolve('com.android.settings');
 assert.equal(resolved.cached,true);assert.ok(resolved.aliases.includes('Settings'));assert.equal(resolved.aliases.includes('untrusted cached alias'),false);
});
