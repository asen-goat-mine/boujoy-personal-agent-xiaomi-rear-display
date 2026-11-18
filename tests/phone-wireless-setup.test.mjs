import {DISTRIBUTION,BACKGROUND_SUPPORTED} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {AppError,requireValue} from '../src/core/errors.mjs';
import {Store,initialState} from '../src/core/store.mjs';
import {effectiveTimezone} from '../src/core/timezone.mjs';
import {reasoningSettings,REASONING_OPTIONS} from '../src/core/reasoning-settings.mjs';

const server=fs.readFileSync(new URL('../src/server.mjs',import.meta.url),'utf8');
const web=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const device='phone-install-01',address='https://100.100.1.9:8443';
function serverFixture({pair}={}){
 const calls=[];
 const store={data:{settings:initialState().settings,tasks:[]}};
 const engine={active:new Map()};
 const phone={pair:async args=>{calls.push(['pair',plain(args)]);return pair?pair(args,store):{status:'pending',device_id:device,address,verification_code:'01234567',token:'hidden-token',tls_pin:'hidden-pin',pairing_secret:'hidden-secret'};},devices:async args=>{calls.push(['devices',plain(args)]);return {devices:[{device_id:device,address,paired:false,online:null,name:'Z Fold6',token:'hidden-token',client_id:'hidden-client',tls_pin:'hidden-pin',pending:{pairing_secret:'hidden-secret'}}]};},status:async()=>({enabled:false,connected:false})};
 const c={DISTRIBUTION,BACKGROUND_SUPPORTED,URL,AppError,requireValue,effectiveTimezone,reasoningSettings,REASONING_OPTIONS,phone,store,engine,auth(){},body:async req=>req.payload||{},json:(res,status,value)=>Object.assign(res,{status,value})};
 vm.createContext(c);
 vm.runInContext(server.slice(server.indexOf('// Phone setup boundary:'),server.indexOf('// End phone setup boundary.')).replaceAll('export ',''),c);
 vm.runInContext(server.slice(server.indexOf('async function api('),server.indexOf('\nconst server=')),c);
 const request=async(method,pathname,payload)=>{const res={};await c.api({method,payload},res,{pathname});return plain(res);};
 return {c,phone,store,engine,calls,request};
}
function uiFixture(){
 const calls=[],renders=[];
 const c={state:{settings:{...initialState().settings,distributionEdition:DISTRIBUTION.edition,backgroundSupported:BACKGROUND_SUPPORTED}},phoneSetup:{pending:null,paired:null,devices:[],status:null},panel:'phone',esc:s=>String(s??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])),icon:()=>'',openSheet:(title,html)=>renders.push({title,html}),refresh:async()=>{},api:async(endpoint,payload)=>{calls.push({endpoint,payload:payload&&plain(payload)});if(endpoint==='/phone/devices')return {devices:[]};if(endpoint==='/phone/status')return {enabled:false,connected:false};if(payload.confirmPairing){c.state.settings.phoneBackend='phoneuse';c.state.settings.phoneEnabled=true;c.state.settings.phoneUseDeviceId=device;return {status:'paired',device_id:device,address,token:'never-render'};}return {status:'pending',device_id:device,address,verification_code:'01234567',token:'never-render'};}};
 vm.createContext(c);vm.runInContext(web.slice(web.indexOf('function phoneSetupMarkup('),web.indexOf('function showWorkspace(')),c);
 return {c,calls,renders};
}

test('pair endpoint requires HTTPS origin, explicit boolean confirmation, and current device identity',async()=>{
 const f=serverFixture();
 assert.equal(f.c.phoneSetupAddress('https://PHONE.local'),'https://phone.local:8443');
 assert.equal(f.c.phoneSetupAddress('https://phone.local:443/'),'https://phone.local:443');
 for(const bad of ['http://phone:8443','ws://phone','https://user:secret@phone','https://phone/api','https://phone/../','https://phone?token=secret','https://phone#secret','https://phone:0','https://phone:65536','https://phone\\evil'])await assert.rejects(f.request('POST','/api/phone/pair',{backend:'phoneuse',address:bad}),{code:'invalid_input'});
 await assert.rejects(f.request('POST','/api/phone/pair',{backend:'phoneuse',address,confirmPairing:'true'}),{code:'invalid_input'});
 await assert.rejects(f.request('POST','/api/phone/pair',{backend:'phoneuse',address,confirmPairing:true}),{code:'invalid_input'});
 await assert.rejects(f.request('POST','/api/phone/pair',{backend:'phoneuse',address,token:'secret'}),{code:'invalid_input'});
 assert.equal(f.calls.length,0);
 await f.request('POST','/api/phone/pair',{backend:'phoneuse',address,confirmPairing:false});
 assert.deepEqual(f.calls[0],['pair',{backend:'phoneuse',address,confirmPairing:false}]);
});

test('pending never enables or switches the backend; paired relies on Phone and filters every credential',async()=>{
 const f=serverFixture({pair:(args,store)=>{if(args.confirmPairing){store.data.settings.phoneBackend='phoneuse';store.data.settings.phoneUseDeviceId=device;store.data.settings.phoneEnabled=true;return {status:'paired',device_id:device,address,token:'hidden-token',tls_pin:'hidden-pin'};}return {status:'pending',device_id:device,address,verification_code:'01234567',confirmation_required:true,pairing_secret:'hidden-secret',token:'hidden-token',client_id:'hidden-client',private:{token:'hidden-nested'}};}});
 const before=plain(f.store.data.settings),pending=await f.request('POST','/api/phone/pair',{backend:'phoneuse',address,confirmPairing:false});
 assert.deepEqual(f.store.data.settings,before);
 assert.deepEqual(pending.value,{device_id:device,address,status:'pending',verification_code:'01234567',confirmation_required:true});
 const paired=await f.request('POST','/api/phone/pair',{backend:'phoneuse',address,deviceId:device,confirmPairing:true});
 assert.deepEqual(f.calls[1][1],{backend:'phoneuse',address,deviceId:device,confirmPairing:true});
 assert.deepEqual(paired.value,{device_id:device,address,status:'paired'});
 assert.equal(f.store.data.settings.phoneEnabled,true);assert.equal(f.store.data.settings.phoneBackend,'phoneuse');
 assert.doesNotMatch(JSON.stringify([pending,paired]),/hidden|token|tls_pin|pairing_secret|client_id|private/);
});

test('active, queued, awaiting approval, child work and concurrent setup block pairing before any call',async()=>{
 for(const status of ['running','queued','waiting_approval','waiting_children']){const f=serverFixture();f.store.data.tasks.push({status});await assert.rejects(f.request('POST','/api/phone/pair',{backend:'phoneuse',address}),{code:'phone_busy'});assert.equal(f.calls.length,0);}
 const active=serverFixture();active.engine.active.set('task',{});await assert.rejects(active.request('POST','/api/phone/pair',{backend:'phoneuse',address}),{code:'phone_busy'});assert.equal(active.calls.length,0);
 let resolve;const f=serverFixture({pair:()=>new Promise(r=>resolve=r)});
 const first=f.request('POST','/api/phone/pair',{backend:'phoneuse',address});
 await assert.rejects(f.request('POST','/api/phone/pair',{backend:'phoneuse',address}),{code:'phone_busy'});
 resolve({status:'pending',device_id:device,verification_code:'01234567'});await first;
 f.phone.pair=async()=>{throw new AppError('pair_failed','未完成配对');};
 await assert.rejects(f.request('POST','/api/phone/pair',{backend:'phoneuse',address}),{code:'pair_failed'});
 f.phone.pair=async()=>({status:'paired',device_id:device});await f.request('POST','/api/phone/pair',{backend:'phoneuse',address,deviceId:device,confirmPairing:true});
 assert.equal(f.store.data.settings.phoneEnabled,false,'server itself does not fabricate paired settings');
});

test('cached device route does not refresh the network and settings/device output excludes credentials',async()=>{
 const f=serverFixture();const out=await f.request('GET','/api/phone/devices');
 assert.deepEqual(f.calls,[['devices',{refresh:false}]]);
 assert.equal(out.value.cached,true);assert.equal(out.value.devices[0].online,null);
 assert.equal(out.value.devices[0].name,'Z Fold6');assert.doesNotMatch(JSON.stringify(out),/hidden|token|tls_pin|pairing_secret|client_id/);
 const settings=f.c.publicSettings({...f.store.data.settings,phoneUseToken:'hidden-token',tls_pin:'hidden-pin',pairing_secret:'hidden-secret',client_id:'hidden-client'});
 assert.equal(settings.phoneBackend,'phoneuse');assert.equal(settings.phoneEnabled,false);assert.doesNotMatch(JSON.stringify(settings),/hidden|Token|tls_pin|pairing_secret|client_id/);
 assert.match(server,/settings:publicSettings\(store\.data\.settings\)/);
});

test('wireless setup UI reads state only until an explicit connect and then a separate safety-code confirmation',async()=>{
 const f=uiFixture();await f.c.showPhoneSetup();
 assert.deepEqual(f.calls.map(c=>c.endpoint),['/phone/devices'],'opening wireless setup must not start the old Pony transport');
 assert.match(f.renders.at(-1).html,/Phone Use 无线连接/);assert.match(f.renders.at(-1).html,/type="url"/);assert.doesNotMatch(f.renders.at(-1).html,/开启调试|尚未验证真机|按你的安排/);
 await f.c.connectPhoneSetup(address);
 assert.deepEqual(f.calls.at(-1).payload,{backend:'phoneuse',address,confirmPairing:false});
 assert.equal(f.c.phoneSetup.pending.device_id,device);assert.equal(f.c.state.settings.phoneEnabled,false);
 assert.match(f.renders.at(-1).html,/01234567/);assert.match(f.renders.at(-1).html,/安全码一致，且已在手机允许/);assert.doesNotMatch(f.renders.at(-1).html,/never-render/);
 await f.c.showPhoneSetup();assert.equal(f.calls.filter(c=>c.endpoint==='/phone/pair').length,1,'opening/reopening the sheet does not confirm');
 await f.c.confirmPhoneSetup();
 assert.deepEqual(f.calls.at(-1).payload,{backend:'phoneuse',address,deviceId:device,confirmPairing:true});
 assert.equal(f.c.phoneSetup.pending,null);assert.match(f.renders.at(-1).html,/已完成配对/);assert.match(f.renders.at(-1).html,/停用当前手机接入/);assert.doesNotMatch(f.renders.at(-1).html,/真机控制已验证|never-render/);
 await assert.rejects(f.c.confirmPhoneSetup(),/请先连接手机/);
 // Late setup responses never open a sheet over a different settings/chat surface.
 f.c.panel='settings';const rendered=f.renders.length;await f.c.connectPhoneSetup(address);assert.equal(f.renders.length,rendered);
 assert.match(web,/if\(a==='confirm-phone-pair'\)return confirmPhoneSetup\(\)/);
 assert.match(web,/phone_use:'操作手机'/);
});

test('new and missing-backend settings default to Phone Use without enabling a phone; explicit Pony remains compatible',()=>{
 assert.equal(initialState().settings.phoneBackend,'phoneuse');assert.equal(initialState().settings.phoneEnabled,false);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-wireless-settings-'));
 try{const old=initialState();delete old.settings.phoneBackend;delete old.settings.phoneUseDeviceId;fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(old));const s=new Store(dir,{lock:false});try{assert.equal(s.data.settings.phoneBackend,'phoneuse');assert.equal(s.data.settings.phoneUseDeviceId,null);assert.equal(s.data.settings.phoneEnabled,false);}finally{s.close();}
 const legacy=initialState();legacy.settings.phoneBackend='pony';fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(legacy));const l=new Store(dir,{lock:false});try{assert.equal(l.data.settings.phoneBackend,'pony');assert.equal(l.data.settings.phoneEnabled,false);}finally{l.close();}
 const paired=initialState();paired.settings.phoneBackend='phoneuse';paired.settings.phoneUseDeviceId=device;paired.settings.phoneEnabled=true;fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(paired));const p=new Store(dir,{lock:false});try{assert.equal(p.data.settings.phoneBackend,'phoneuse');assert.equal(p.data.settings.phoneUseDeviceId,device);assert.equal(p.data.settings.phoneEnabled,true);}finally{p.close();}
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('the phone row shows the paired device name, or a neutral label before pairing, never a fixed model',async()=>{
 const f=uiFixture();assert.equal(f.c.phoneName(),'Android 手机');
 f.c.state.settings.phoneDeviceName='Pixel 9';assert.equal(f.c.phoneName(),'Pixel 9');
 await f.c.showPhoneSetup();assert.match(f.renders.at(-1).html,/Pixel 9/);
 assert.doesNotMatch(web,/Samsung Z Fold6/);
 const s=serverFixture();assert.equal(s.c.phoneDeviceLabel(s.store.data.settings),'Android 手机');
 s.store.transaction=fn=>fn(s.store.data);s.store.data.settings.phoneUseDeviceId=device;
 await s.request('GET','/api/phone/devices');assert.equal(s.store.data.settings.phoneDeviceName,'Z Fold6');assert.equal(s.c.phoneDeviceLabel(s.store.data.settings),'Z Fold6');
 assert.equal(s.c.publicSettings(s.store.data.settings).phoneDeviceName,'Z Fold6');assert.doesNotMatch(server,/Samsung Z Fold6/);
});

test('execution choices expose only the edition capability and never infer readiness from mode',()=>{
 const f=uiFixture();f.c.state.settings.phoneEnabled=true;f.c.state.settings.phoneBackend='phoneuse';
 f.c.state.settings.backgroundSupported=false;f.c.state.settings.phoneExecutionMode='background';
 const generic=f.c.executionModeMarkup(null);assert.match(generic,/Phone Use · 主屏执行/);assert.doesNotMatch(generic,/phone-mode-background|后台显示执行|Shizuku/);
 f.c.state.settings.backgroundSupported=true;const xiaomi=f.c.executionModeMarkup(null);assert.match(xiaomi,/phone-mode-background/);assert.match(xiaomi,/正在读取手机状态/);assert.doesNotMatch(xiaomi,/后台执行已就绪/);
});


test('enabled but unpaired phone never claims pairing from permission, another device or a stale result',()=>{
 for(const backgroundSupported of [false,true]){
  const f=uiFixture();Object.assign(f.c.state.settings,{phoneEnabled:true,phoneBackend:'phoneuse',phoneUseDeviceId:null,backgroundSupported});
  f.c.phoneSetup.status={connected:false,reason:'尚未完成 Phone Use 配对'};
  assert.match(f.c.phoneSetupMarkup(),/尚未完成 Phone Use 配对/);
  assert.doesNotMatch(f.c.phoneSetupMarkup(),/已配对|已完成配对|无线手机已连接/);
  f.c.phoneSetup.devices=[{device_id:device,paired:true}];f.c.phoneSetup.paired={device_id:device};
  f.c.phoneSetup.status={connected:true};
  assert.doesNotMatch(f.c.phoneSetupMarkup(),/已配对|已完成配对|无线手机已连接/,'a cached result cannot replace selection');
  f.c.state.settings.phoneUseDeviceId='different-selected-phone';f.c.phoneSetup.status={connected:false};
  assert.match(f.c.phoneSetupMarkup(),/尚未完成 Phone Use 配对/);
  assert.doesNotMatch(f.c.phoneSetupMarkup(),/已配对|已完成配对/,'another paired phone does not confirm the selected phone');
 }
});

test('offline pairing summary requires confirmation for the selected device and preserves a new confirmed result',()=>{
 for(const backgroundSupported of [false,true]){
  const f=uiFixture();Object.assign(f.c.state.settings,{phoneEnabled:true,phoneBackend:'phoneuse',phoneUseDeviceId:device,backgroundSupported});
  f.c.phoneSetup.status={connected:false};f.c.phoneSetup.devices=[{device_id:device,paired:false}];
  assert.match(f.c.phoneSetupMarkup(),/尚未完成 Phone Use 配对/);assert.doesNotMatch(f.c.phoneSetupMarkup(),/已配对/);
  f.c.phoneSetup.devices[0].paired=true;
  assert.match(f.c.phoneSetupMarkup(),/已配对 · 手机暂未连接/);assert.doesNotMatch(f.c.phoneSetupMarkup(),/无线手机已连接/);
  f.c.phoneSetup.devices=[];f.c.phoneSetup.paired={device_id:device};
  assert.match(f.c.phoneSetupMarkup(),/已配对 · 手机暂未连接/);assert.match(f.c.phoneSetupMarkup(),/已完成配对/);
 }
});

test('connected selected phone is shown as connected in both editions without claiming successful task execution',()=>{
 for(const backgroundSupported of [false,true]){
  const f=uiFixture();Object.assign(f.c.state.settings,{phoneEnabled:true,phoneBackend:'phoneuse',phoneUseDeviceId:device,backgroundSupported});
  f.c.phoneSetup.devices=[{device_id:device,paired:true}];f.c.phoneSetup.status={connected:true};
  const html=f.c.phoneSetupMarkup();assert.match(html,/无线手机已连接/);assert.doesNotMatch(html,/手机暂未连接|尚未完成 Phone Use 配对|真机控制已验证/);
 }
});
