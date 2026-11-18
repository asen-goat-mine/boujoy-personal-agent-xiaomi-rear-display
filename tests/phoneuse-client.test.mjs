import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {PhoneUseClient,unwrapPhoneUseMcp,PHONEUSE_CLIENT_SHA256,PHONEUSE_CONTROL_BOOTSTRAP} from '../src/adapters/phoneuse-client.mjs';

const execute=promisify(execFile);
const officialPath=path.join(os.homedir(),'Library/Application Support/Boujoy Personal Agent/tools/phoneuse/1.3.0/phoneuse_client.py');
const device='fixture-device',instance='fixture-service';
const native=(value,isError=false)=>({content:[{type:'text',text:JSON.stringify(value)}],isError});
const bound=value=>({device_id:device,service_instance_id:instance,...value});
const executed=id=>native(bound({state:'executed',request_id:id,action_executed:true,execution:{accepted:true}}));
const unknown=id=>native(bound({state:'unknown',request_id:id,action_executed:null,error:{code:'RESULT_UNKNOWN',message:'fixture unknown'}}),true);
const cancelled=id=>native(bound({state:'cancelled',request_id:id,action_executed:false,error:{code:'CANCELLED',message:'fixture cancelled'}}),true);
const status=value=>native(bound({paused:false,stopped:false,request:value}));
const never=()=>new Promise(()=>{});

async function setup(t,handler=()=>undefined,options={}){
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'boujoy-phoneuse-client-test-'));
 const calls=[],processes=[];
 const rpcFactory=(command,args,settings)=>{
  const rpc={role:settings.role,command,args,settings,dead:false,notifications:[],closeCount:0,
   notify(method,params){this.notifications.push({method,params});},
   close(){this.dead=true;this.closeCount++;},
   async request(method,params,timeout){
    const item={role:this.role,method,params,timeout};calls.push(item);
    if(method==='initialize')return {serverInfo:{name:'phone-use',version:'1.3.0'},protocolVersion:'2025-11-25'};
    const result=await handler(item,{calls,processes,dataDir});
    if(result!==undefined)return result;
    if(params.name==='phoneuse_list_devices')return native({devices:[]});
    if(params.name==='get_status')return native(bound({paused:false,stopped:false}));
    return executed(params.arguments.request_id);
   }};
  processes.push(rpc);return rpc;
 };
 const client=new PhoneUseClient({dataDir,clientPath:officialPath,rpcFactory,controlTimeout:250,...options});
 t.after(async()=>{await client.close();await fs.rm(dataDir,{recursive:true,force:true});});
 return {client,dataDir,calls,processes,tools:()=>calls.filter(call=>call.method==='tools/call')};
}
const isCode=code=>error=>error.code===code;
const actionArgs={observation_id:'snapshot',element_id:'0.1'};

test('unwrap returns the single native state object and preserves image blocks outside parsing',()=>{
 const result={content:[{type:'image',mimeType:'image/png',data:'fixture-image'},{type:'text',text:JSON.stringify(bound({tree:{available:true}}))}]};
 assert.deepEqual(unwrapPhoneUseMcp(result),bound({tree:{available:true}}));assert.equal(result.content[0].data,'fixture-image');
 assert.throws(()=>unwrapPhoneUseMcp(native([])),isCode('phoneuse_invalid_result'));
 assert.throws(()=>unwrapPhoneUseMcp({content:[...native({a:1}).content,...native({b:2}).content]}),isCode('phoneuse_invalid_result'));
});

test('startup verifies runtime and initializes separate main/control processes without discovering devices',async t=>{
 const {client,calls,processes,dataDir}=await setup(t);
 const result=await client.start();assert.equal(result.serverInfo.version,'1.3.0');
 assert.equal(processes.length,2);assert.deepEqual(calls.map(call=>[call.role,call.method]),[['main','initialize'],['control','initialize']]);
 assert.equal(processes[0].args[3],path.join(dataDir,'phone/phoneuse.json'));
 assert.equal(processes[1].args[2],PHONEUSE_CONTROL_BOOTSTRAP);
 assert.equal(processes[1].args[4],path.join(dataDir,'phone/phoneuse.json'));
 for(const rpc of processes)assert.equal(rpc.notifications[0].method,'notifications/initialized');
 await client.start();assert.equal(processes.length,2);
});

test('hash mismatch fails before any runtime process is created',async t=>{
 const {client,processes}=await setup(t,()=>undefined,{clientSha256:'0'.repeat(64)});
 await assert.rejects(client.start(),isCode('phoneuse_client_integrity'));assert.equal(processes.length,0);
});

test('device listing is cached by default and never exposes credential fields',async t=>{
 const {client,tools}=await setup(t,()=>native({devices:[{device_id:device,address:'https://fixture:8443',online:null,paired:true,token:'fixture-secret',tls_pin:'fixture-pin'}]}));
 const listed=await client.listDevices();assert.equal(listed.devices[0].device_id,device);assert.equal(listed.devices[0].token,undefined);assert.equal(listed.devices[0].tls_pin,undefined);
 assert.deepEqual(tools()[0].params,{name:'phoneuse_list_devices',arguments:{refresh:false}});
 await client.listDevices({refresh:true});assert.equal(tools()[1].params.arguments.refresh,true);
});

test('connect exposes official pending fields and only explicit confirmation reaches the bridge',async t=>{
 const pending={device_id:device,address:'https://fixture:8443',status:'pending',verification_code:'12345678',confirmation_required:true,poll_interval:2};
 const {client,tools}=await setup(t,()=>native({...pending,token:'fixture-secret',pairing_secret:'fixture-private'}));
 assert.deepEqual(await client.connect({address:'https://fixture:8443'}),pending);
 assert.deepEqual(tools()[0].params.arguments,{address:'https://fixture:8443',confirm_pairing:false});
 await client.connect({deviceId:device,confirmPairing:true});
 assert.deepEqual(tools()[1].params.arguments,{device_id:device,confirm_pairing:true});assert.equal(tools().length,2);
});

test('expired unconfirmed pairing retries once with the same identity and returns a fresh unconfirmed code',async t=>{
 const pending={device_id:device,address:'https://fixture:8443',status:'pending',verification_code:'87654321',confirmation_required:true};
 let attempts=0;
 const {client,tools}=await setup(t,()=>++attempts===1?native(bound({error:{code:'PAIRING_EXPIRED',message:'Pairing expired'}}),true):native(pending));
 const registry='{"devices":{"fixture-device":{"tls_pin":"fixture-pin","pending":{"verification_code":"12345678"}}}}';
 await fs.mkdir(path.dirname(client.configPath),{recursive:true});await fs.writeFile(client.configPath,registry);
 assert.deepEqual(await client.connect({address:'https://fixture:8443',deviceId:device}),pending);
 assert.equal(tools().length,2);
 for(const call of tools())assert.deepEqual(call.params,{name:'phoneuse_connect',arguments:{address:'https://fixture:8443',device_id:device,confirm_pairing:false}});
 assert.equal(await fs.readFile(client.configPath,'utf8'),registry,'wrapper must not clear or rewrite official pairing state');
});

test('a second pairing expiry stops instead of looping',async t=>{
 const {client,tools}=await setup(t,()=>native(bound({error:{code:'PAIRING_EXPIRED',message:'Pairing expired'}}),true));
 await assert.rejects(client.connect({deviceId:device}),error=>error.code==='phoneuse_error'&&error.phoneuseCode==='PAIRING_EXPIRED');
 assert.equal(tools().length,2);assert.ok(tools().every(call=>call.params.arguments.confirm_pairing===false));
});

test('expired human confirmation never retries or preapproves a replacement pairing',async t=>{
 const {client,tools}=await setup(t,()=>native(bound({error:{code:'PAIRING_EXPIRED',message:'Pairing expired'}}),true));
 await assert.rejects(client.connect({deviceId:device,confirmPairing:true}),error=>error.code==='phoneuse_error'&&error.phoneuseCode==='PAIRING_EXPIRED');
 assert.equal(tools().length,1);assert.equal(tools()[0].params.arguments.confirm_pairing,true);
});

test('pairing denial, revocation, identity errors and transport failures never create replacement requests',async t=>{
 for(const code of ['PAIRING_DENIED','PAIRING_REVOKED','TLS_IDENTITY_MISMATCH','DEVICE_IDENTITY_MISMATCH','PAIRING_BUSY']){
  const {client,tools}=await setup(t,()=>native(bound({error:{code,message:'Pairing expired'}}),true));
  await assert.rejects(client.connect({deviceId:device}),error=>error.code==='phoneuse_error'&&error.phoneuseCode===code);
  assert.equal(tools().length,1,code);
 }
 const timeout=Object.assign(Error('Pairing expired'),{code:'rpc_timeout'});
 const {client,tools}=await setup(t,()=>{throw timeout;});
 await assert.rejects(client.connect({deviceId:device}),error=>error===timeout);assert.equal(tools().length,1);
});

test('invalid preapproval/address and unknown native tools fail without dispatch',async t=>{
 const {client,processes}=await setup(t);
 await assert.rejects(client.connect({confirmPairing:'yes'}),isCode('invalid_input'));
 await assert.rejects(client.connect({address:'http://fixture:8443'}),isCode('invalid_input'));
 await assert.rejects(client.connect({address:'https://user:password@fixture:8443'}),isCode('invalid_input'));
 await assert.rejects(client.call(device,'shell',{}),isCode('phoneuse_tool_denied'));
 await assert.rejects(client.call(device,'tap',{...actionArgs,device_id:'another-device'}),isCode('phoneuse_device_mismatch'));
 assert.equal(processes.length,0);
});

test('list/connect/status and native reads reject isError/error rather than report successful connectivity',async t=>{
 const output=native(bound({state:'failed',action_executed:false,error:{code:'NOT_PAIRED',message:'fixture unpaired'}}),true);
 const {client}=await setup(t,()=>output);
 for(const request of [()=>client.listDevices(),()=>client.connect({deviceId:device}),()=>client.status(device),()=>client.call(device,'observe',{})]){
  await assert.rejects(request(),error=>error.code==='phoneuse_error'&&error.phoneuseCode==='NOT_PAIRED');
 }
 const incomplete=native(bound({observation_status:'failed'}),true);
 const second=await setup(t,()=>incomplete);await assert.rejects(second.client.call(device,'observe',{}),isCode('phoneuse_error'));
});

test('incomplete observation keeps all direct channel reasons without accepting the frame',async t=>{
 const output=native(bound({observation_status:'complete',tree:{available:false,reason:'NO_ACTIVE_WINDOW'},screenshot:{available:false,reason:'SCREENSHOT_RATE_LIMITED'}}),true);
 const {client,tools}=await setup(t,()=>output);
 await assert.rejects(client.call(device,'observe',{}),error=>{
  assert.equal(error.code,'phoneuse_error');assert.equal(error.phoneuseCode,'NO_ACTIVE_WINDOW');
  assert.deepEqual(error.phoneuseReasons,['NO_ACTIVE_WINDOW','SCREENSHOT_RATE_LIMITED']);assert.equal(error.phoneuseReasonsComplete,true);assert.equal(error.phoneuseObservationStatus,'complete');
  assert.match(error.message,/NO_ACTIVE_WINDOW/);assert.match(error.message,/SCREENSHOT_RATE_LIMITED/);return true;
 });assert.equal(tools().length,1);
});

test('root observation error retains priority and blocked channel reasons remain visible together',async t=>{
 const output=native(bound({observation_status:'failed',error:{code:'OBSERVATION_INCONSISTENT',message:'UI changed'},tree:{available:false,reason:'NO_ACTIVE_WINDOW'},screenshot:{available:false,reason:'SECURE_WINDOW'}}),true);
 const {client}=await setup(t,()=>output);
 await assert.rejects(client.call(device,'observe',{}),error=>{
  assert.equal(error.phoneuseCode,'OBSERVATION_INCONSISTENT');assert.equal(error.message,'UI changed');
  assert.deepEqual(error.phoneuseReasons,['OBSERVATION_INCONSISTENT','NO_ACTIVE_WINDOW','SECURE_WINDOW']);assert.equal(error.phoneuseReasonsComplete,true);return true;
 });
});

test('missing channel reasons, unknown failure envelopes and unmet conditions never become classified transient reads',async t=>{
 for(const value of [
  {observation_status:'complete',tree:{available:false,reason:'NO_ACTIVE_WINDOW'},screenshot:{available:false}},
  {observation_status:'failed',last_observation:{error:{code:'NO_ACTIVE_WINDOW'}}},
  {observation_status:'complete',tree:{available:false,reason:'NO_ACTIVE_WINDOW'},condition:{status:'unknown',timed_out:false}},
  {observation_status:'failed',error:{message:'OBSERVATION_INCONSISTENT'}}
 ]){
  const {client}=await setup(t,()=>native(bound(value),true));
  await assert.rejects(client.call(device,'observe',{}),error=>error.code==='phoneuse_error'&&error.phoneuseReasonsComplete===false);
 }
});

test('successful action returns original MCP, preserves caller ID/old service guard and journals before dispatch',async t=>{
 let original;
 const {client,dataDir,tools}=await setup(t,async item=>{
  if(item.params.name!=='tap')return;
  const file=path.join(dataDir,'phone/phoneuse-pending.json'),journal=JSON.parse(await fs.readFile(file,'utf8'));
  assert.deepEqual(journal.pending,[{deviceId:device,requestId:'supplied-action',tool:'tap',createdAt:1234,state:'sending',serviceInstanceId:'old-service'}]);
  assert.equal((await fs.stat(file)).mode&0o777,0o600);assert.equal(JSON.stringify(journal).includes('secret-input'),false);
  original=native({...unwrapPhoneUseMcp(executed('supplied-action')),service_instance_id:'old-service'});return original;
 },{clock:()=>1234});
 const result=await client.call(device,'tap',{...actionArgs,request_id:'supplied-action',service_instance_id:'old-service',expected_window_id:7,reason:'secret-input'},{effect:false});
 assert.equal(result,original);
 const sent=tools()[0].params.arguments;assert.equal(sent.request_id,'supplied-action');assert.equal(sent.service_instance_id,'old-service');assert.equal(sent.expected_window_id,7);
 assert.equal((await client.pendingSummary()).count,0);assert.deepEqual(JSON.parse(await fs.readFile(client.pendingPath,'utf8')).pending,[]);
 await assert.rejects(client.call(device,'tap',{...actionArgs,request_id:'supplied-action'}),isCode('request_id_reused'));assert.equal(tools().length,1);
});

test('all native input actions infer effects internally and generate IDs even when caller says effect=false',async t=>{
 const {client,tools}=await setup(t,()=>undefined,{uuid:()=>`fixture-${Math.random()}`});
 for(const tool of ['tap','long_press','swipe','scroll','input_text','back','home','recents','launch_app']){
  await client.call(device,tool,{}, {effect:false});const args=tools().at(-1).params.arguments;assert.ok(args.request_id.startsWith('fixture-'));
 }
});

test('confirmed terminal rejection clears journal without replay; cancelled false is action_cancelled',async t=>{
 const rejected=native(bound({state:'failed',request_id:'rejected',action_executed:false,error:{code:'STALE_ELEMENT',message:'fixture target changed'}}),true);
 const {client,tools}=await setup(t,item=>item.params.name==='tap'?rejected:undefined);
 assert.equal(await client.call(device,'tap',{...actionArgs,request_id:'rejected'}),rejected);assert.equal((await client.pendingSummary()).count,0);assert.equal(tools().length,1);
 const second=await setup(t,item=>cancelled(item.params.arguments.request_id));
 await assert.rejects(second.client.call(device,'tap',actionArgs),isCode('action_cancelled'));assert.equal((await second.client.pendingSummary()).count,0);
});

test('pending and uncertain states prevent replacement actions and keep request identity',async t=>{
 for(const value of [bound({state:'accepted',request_id:'unfinished',action_executed:false}),bound({state:'executing',request_id:'unfinished',action_executed:null}),bound({state:'unknown',request_id:'unfinished',action_executed:false}),bound({state:'executed',request_id:'unfinished',action_executed:null})]){
  const {client,tools}=await setup(t,()=>native(value));const expected=['accepted','executing'].includes(value.state)?'outcome_pending':'outcome_unknown';
  await assert.rejects(client.call(device,'tap',{...actionArgs,request_id:'unfinished'}),error=>error.code===expected&&error.requestId==='unfinished'&&error.deviceId===device);
  await assert.rejects(client.call(device,'back',{}),error=>error.code===expected&&error.requestId==='unfinished');
  assert.equal(tools().filter(call=>call.params.name!=='get_status').length,1);assert.ok(tools().filter(call=>call.params.name==='get_status').every(call=>call.role==='control'));assert.deepEqual(await client.pendingSummary(),{count:1,requests:[{requestId:'unfinished',deviceId:device,tool:'tap',status:expected==='outcome_pending'?'pending':'unknown'}]});
 }
});

test('missing or changed device/service identity cannot establish an executed effect',async t=>{
 for(const value of [{state:'executed',request_id:'untrusted',action_executed:true},bound({state:'executed',request_id:'untrusted',action_executed:true,device_id:'different-device'}),bound({state:'executed',request_id:'untrusted',action_executed:true,service_instance_id:'new-service'})]){
  const {client}=await setup(t,()=>native(value));
  await assert.rejects(client.call(device,'tap',{...actionArgs,request_id:'untrusted',service_instance_id:instance}),isCode('outcome_unknown'));assert.equal((await client.pendingSummary()).count,1);
 }
});

test('timeout uses independent control while ordinary action remains blocked and only proved nonexecution cancels',async t=>{
 const sequence=[];
 const {client,tools}=await setup(t,item=>{
  sequence.push([item.role,item.params.name]);const id=item.params.arguments.request_id;
  if(item.params.name==='tap')return never();
  if(item.params.name==='cancel')return native(bound({state:'cancel_requested',in_flight_may_complete:false}));
  if(item.params.name==='get_status')return status(unwrapPhoneUseMcp(cancelled(id)));
 });
 await assert.rejects(client.call(device,'tap',actionArgs,{timeout:15}),error=>error.code==='action_cancelled'&&typeof error.requestId==='string');
 assert.deepEqual(sequence,[['main','tap'],['control','cancel'],['control','get_status']]);
 assert.equal(tools()[0].params.arguments.request_id,tools()[1].params.arguments.request_id);assert.equal((await client.pendingSummary()).count,0);
});

test('cancel acknowledgement, missing status, null/true execution and mismatched IDs never prove action_cancelled',async t=>{
 for(const terminal of [native(bound({error:{code:'REQUEST_NOT_FOUND',message:'fixture missing'},state:'failed',action_executed:false}),true),status(bound({state:'cancelled',request_id:'request',action_executed:null})),status(bound({state:'cancelled',request_id:'request',action_executed:true})),status(bound({state:'cancelled',request_id:'wrong-request',action_executed:false}))]){
  const {client,tools}=await setup(t,item=>item.params.name==='tap'?never():item.params.name==='cancel'?native(bound({state:'cancel_requested',in_flight_may_complete:false})):terminal);
  await assert.rejects(client.call(device,'tap',{...actionArgs,request_id:'request'},{timeout:10}),isCode('outcome_unknown'));assert.equal((await client.pendingSummary()).count,1);
  await assert.rejects(client.call(device,'tap',actionArgs),isCode('outcome_unknown'));assert.equal(tools().filter(call=>call.params.name==='tap').length,1);
 }
});

test('abort before dispatch is cancelled locally; abort after dispatch cancels and checks status separately',async t=>{
 const before=new AbortController();before.abort();const first=await setup(t);
 await assert.rejects(first.client.call(device,'tap',actionArgs,{signal:before.signal}),isCode('action_cancelled'));assert.equal(first.processes.length,0);
 const after=new AbortController();let sent;
 const atDispatch=new Promise(resolve=>sent=resolve);
 const second=await setup(t,item=>{
  if(item.params.name==='tap'){sent();return never();}
  if(item.params.name==='cancel')return native(bound({state:'cancel_requested',in_flight_may_complete:true}));
  return status(unwrapPhoneUseMcp(unknown(item.params.arguments.request_id)));
 });
 const request=second.client.call(device,'tap',actionArgs,{signal:after.signal,timeout:1000});const rejected=assert.rejects(request,isCode('outcome_unknown'));
 await atDispatch;after.abort();await rejected;assert.deepEqual(second.tools().map(call=>call.role),['main','control','control']);
});

test('execution confirmed after timeout returns raw status MCP and does not pretend it was cancelled',async t=>{
 let terminal;
 const {client}=await setup(t,item=>{
  if(item.params.name==='tap')return never();
  if(item.params.name==='cancel')return native(bound({state:'cancel_requested',in_flight_may_complete:true}));
  terminal=status(unwrapPhoneUseMcp(executed(item.params.arguments.request_id)));return terminal;
 });
 const result=await client.call(device,'tap',actionArgs,{timeout:10});assert.equal(result,terminal);assert.equal(unwrapPhoneUseMcp(result).request.action_executed,true);assert.equal((await client.pendingSummary()).count,0);
});

test('uncertain journal survives restart and the next action reconciles it from status before sending',async t=>{
 const first=await setup(t,item=>unknown(item.params.arguments.request_id));
 await assert.rejects(first.client.call(device,'tap',{...actionArgs,request_id:'survives'}),isCode('outcome_unknown'));await first.client.close();
 const calls=[];
 const second=new PhoneUseClient({dataDir:first.dataDir,clientPath:officialPath,rpcFactory:(command,args,options)=>({dead:false,notify(){},close(){this.dead=true;},async request(method,params){calls.push({role:options.role,method,params});return method==='initialize'?{serverInfo:{name:'phone-use',version:'1.3.0'}}:status(unwrapPhoneUseMcp(executed('survives')));}})});
 t.after(()=>second.close());
 assert.deepEqual((await second.pendingSummary()).requests.map(row=>row.requestId),['survives']);
 await second.call(device,'back',{}).catch(()=>{});
 assert.deepEqual(calls.filter(call=>call.method==='tools/call').slice(0,2).map(call=>[call.role,call.params.name]),[['control','get_status'],['main','back']]);
 assert.equal((await second.pendingSummary()).requests.some(row=>row.requestId==='survives'),false);
 assert.equal((await second.reconcile('survives')).outcome,'not_pending');
});

test('lost retained status/service change leaves the journal unresolved; rejection proof can resolve it',async t=>{
 let returned=native(bound({state:'failed',action_executed:false,error:{code:'REQUEST_NOT_FOUND',message:'fixture restarted'}}),true);
 const {client,tools}=await setup(t,item=>item.params.name==='tap'?unknown('lost'):returned);
 await assert.rejects(client.call(device,'tap',{...actionArgs,request_id:'lost'}),isCode('outcome_unknown'));
 const lost=await client.reconcile('lost');assert.equal(lost.resolved,false);assert.equal(lost.outcome,'unknown');assert.equal((await client.pendingSummary()).count,1);
 returned=status(bound({state:'failed',request_id:'lost',action_executed:false,error:{code:'STALE_ELEMENT',message:'fixture changed'}}));
 assert.equal((await client.reconcile('lost')).resolved,true);assert.equal((await client.pendingSummary()).count,0);assert.equal(tools().filter(call=>call.params.name==='tap').length,1);
});

test('other devices can read/use their own independent queue while one device outcome remains unknown',async t=>{
 const {client}=await setup(t,item=>item.params.arguments.device_id===device?unknown('blocked'):native({device_id:'other-device',service_instance_id:'other-service',request_id:item.params.arguments.request_id,state:'executed',action_executed:true}));
 await assert.rejects(client.call(device,'tap',{...actionArgs,request_id:'blocked'}),isCode('outcome_unknown'));
 assert.equal(unwrapPhoneUseMcp(await client.call('other-device','home',{})).action_executed,true);assert.equal((await client.pendingSummary()).count,1);
});

test('same-device concurrent effects are blocked before a second dispatch',async t=>{
 let resolveAction,started;const start=new Promise(resolve=>started=resolve);
 const {client,tools}=await setup(t,item=>{if(item.params.name==='tap'){started(item.params.arguments.request_id);return new Promise(resolve=>resolveAction=()=>resolve(executed(item.params.arguments.request_id)));}});
 const first=client.call(device,'tap',actionArgs);await start;
 await assert.rejects(client.call(device,'back',{}),isCode('outcome_pending'));assert.equal(tools().length,1);resolveAction();await first;
});

test('failed durable pre-dispatch write prevents input and malformed journals fail closed',async t=>{
 const failing=await setup(t,()=>undefined,{files:{...fs,open:async()=>{throw new Error('fixture disk full');}}});
 await assert.rejects(failing.client.call(device,'tap',actionArgs),isCode('pending_store_unavailable'));assert.equal(failing.tools().length,0);
 const malformed=await setup(t);await fs.mkdir(path.dirname(malformed.client.pendingPath),{recursive:true});await fs.writeFile(malformed.client.pendingPath,'not-json');
 await assert.rejects(malformed.client.start(),isCode('pending_store_invalid'));assert.equal(malformed.processes.length,0);
});

test('crash-era sending journal becomes unknown and cannot be cleared by missing request proof',async t=>{
 const {client,processes}=await setup(t,()=>native(bound({error:{code:'REQUEST_NOT_FOUND',message:'fixture missing'}}),true));
 await fs.mkdir(path.dirname(client.pendingPath),{recursive:true});await fs.writeFile(client.pendingPath,JSON.stringify({version:1,pending:[{deviceId:device,requestId:'crash-id',tool:'input_text',createdAt:1,state:'sending'}]}));
 assert.deepEqual(await client.pendingSummary(),{count:1,requests:[{requestId:'crash-id',deviceId:device,tool:'input_text',status:'unknown'}]});assert.equal(processes.length,0);
 await assert.rejects(client.call(device,'home',{}),isCode('outcome_unknown'));assert.equal((await client.reconcile('crash-id')).resolved,false);
});

test('dead runtime processes are rebuilt for reads without replaying unresolved input',async t=>{
 const {client,processes,tools}=await setup(t,item=>item.params.name==='tap'?unknown('uncertain'):undefined);
 await assert.rejects(client.call(device,'tap',{...actionArgs,request_id:'uncertain'}),isCode('outcome_unknown'));
 processes[0].dead=true;await client.listDevices();assert.equal(processes.length,4);assert.equal(processes[1].dead,true);
 processes[3].dead=true;await client.status(device);assert.equal(processes.length,6);assert.equal(tools().filter(call=>call.params.name==='tap').length,1);
 await assert.rejects(client.call(device,'back',{}),isCode('outcome_unknown'));
});

test('close cancels active effect through control before closing both transports and is idempotent',async t=>{
 let started;const atDispatch=new Promise(resolve=>started=resolve);
 const {client,processes}=await setup(t,item=>{
  if(item.params.name==='tap'){started();return never();}
  if(item.params.name==='cancel'){assert.equal(processes[1].dead,false);return native(bound({state:'cancel_requested'}));}
  return status(unwrapPhoneUseMcp(cancelled(item.params.arguments.request_id)));
 });
 const action=client.call(device,'tap',actionArgs,{timeout:1000}),rejected=assert.rejects(action,isCode('action_cancelled'));await atDispatch;await client.close();await rejected;
 assert.deepEqual(processes.map(rpc=>rpc.closeCount),[1,1]);await client.close();assert.deepEqual(processes.map(rpc=>rpc.closeCount),[1,1]);
 await assert.rejects(client.start(),isCode('phoneuse_closed'));assert.equal((await client.pendingSummary()).count,0);
});

test('official control subclass bypasses only the long device lock and retains inherited TLS/identity checks',{timeout:8000},async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'boujoy-phoneuse-control-proof-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
 const bootstrap=PHONEUSE_CONTROL_BOOTSTRAP.slice(0,PHONEUSE_CONTROL_BOOTSTRAP.lastIndexOf("source['bridge']"));
 const checks=`
import json
client = ControlConnection(sys.argv[2], name='local fixture')
client._update('fixture-device', url='https://fixture:8443', token='fixture-token', tls_pin='fixture-pin')
events = []
def identify_fixture(address, pin):
    assert address == 'https://fixture:8443' and pin == 'fixture-pin'
    events.append('verify_pin_and_identity')
    return {'device_id':'fixture-device','service_instance_id':'fixture-service','tls_pin':'fixture-pin'}
def post_fixture(saved, endpoint, payload):
    assert events[-1] == 'verify_pin_and_identity'
    assert saved['token'] == 'fixture-token' and saved['tls_pin'] == 'fixture-pin'
    assert payload['params']['arguments']['device_id'] == 'fixture-device'
    assert payload['params']['arguments']['service_instance_id'] == 'old-service'
    events.append('post_after_verified_identity')
    return {'jsonrpc':'2.0','id':payload['id'],'result':{'content':[{'type':'text','text':json.dumps({'device_id':'fixture-device','service_instance_id':'fixture-service','state':'cancel_requested'})}]}}
globals = ControlConnection._send_locked.__globals__
globals['identify'] = identify_fixture
globals['post'] = post_fixture
def forbidden_lock(*args):
    raise AssertionError('control must not wait on action device_lock')
client.device_lock = forbidden_lock
payload = {'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'cancel','arguments':{'request_id':'fixture-action','service_instance_id':'old-service'}}}
client.send('fixture-device','/mcp',payload)
assert events == ['verify_pin_and_identity','post_after_verified_identity']
payload['params']['name'] = 'tap'
try:
    client.send('fixture-device','/mcp',payload)
    raise AssertionError('input must be denied')
except source['BridgeError'] as error:
    assert error.value['error']['code'] == 'CONTROL_TOOL_DENIED'
assert len(events) == 2
payload['params']['name'] = 'get_status'
def wrong_device(address, pin):
    return {'device_id':'other-installation','service_instance_id':'fixture-service','tls_pin':'fixture-pin'}
globals['identify'] = wrong_device
try:
    client.send('fixture-device','/mcp',payload)
    raise AssertionError('identity mismatch must fail before post')
except source['BridgeError'] as error:
    assert error.value['error']['code'] == 'DEVICE_IDENTITY_MISMATCH'
assert len(events) == 2
def changed_pin(address, pin):
    raise source['BridgeError']('TLS_IDENTITY_MISMATCH','fixture changed pin',action_executed=False)
globals['identify'] = changed_pin
try:
    client.send('fixture-device','/mcp',payload)
    raise AssertionError('pin mismatch must fail before post')
except source['BridgeError'] as error:
    assert error.value['error']['code'] == 'TLS_IDENTITY_MISMATCH'
assert len(events) == 2
print('local control contract passed')
`;
 const result=await execute('python3',['-c',bootstrap+checks,officialPath,path.join(dataDir,'phoneuse.json')],{timeout:5000});
 assert.equal(result.stdout.trim(),'local control contract passed');assert.equal(result.stderr,'');
});

test('actual verified official Python bridge initializes locally with an empty registry and no discovery/network calls',{timeout:10000},async t=>{
 assert.equal(createHash('sha256').update(await fs.readFile(officialPath)).digest('hex'),PHONEUSE_CLIENT_SHA256);
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'boujoy-phoneuse-offline-initialize-'));
 const client=new PhoneUseClient({dataDir,clientPath:officialPath});t.after(async()=>{await client.close();await fs.rm(dataDir,{recursive:true,force:true});});
 const result=await client.start();assert.equal(result.serverInfo.name,'phone-use');assert.equal(result.serverInfo.version,'1.3.0');
 assert.equal(client.rpc.dead,false);assert.equal(client.controlRpc.dead,false);assert.equal((await client.pendingSummary()).count,0);
 await assert.rejects(fs.stat(path.join(dataDir,'phone/phoneuse.json')),error=>error.code==='ENOENT');
 await client.close();assert.equal(client.rpc.dead,true);assert.equal(client.controlRpc.dead,true);
});

test('unknown launch is released only by fresh bound foreground proof, retains native unknown and survives restart',async t=>{
 const {client,dataDir}=await setup(t,item=>item.params.name==='launch_app'?unknown('launch-unknown'):item.params.name==='get_status'?native(bound({executing_request_id:null,request:bound({state:'unknown',request_id:'launch-unknown',action_executed:null})})):undefined);
 await assert.rejects(client.call(device,'launch_app',{package_name:'com.android.settings',request_id:'launch-unknown'}),isCode('outcome_unknown'));
 const frame=()=>({native:{deviceId:device,serviceInstanceId:instance,observationId:'fresh-native',at:Date.now()},tree:native({ok:true,result:{display:'main',windowPkg:'com.android.settings',foreground:'com.android.settings/Activity',tree:'window pkg=com.android.settings bounds=0,0,1000,2000'}})});
 const answer=await client.reconcileNavigation('launch-unknown',{deviceId:device,capture:async()=>frame()});assert.equal(answer.resolved,true);assert.equal(answer.nativeOutcome,'unknown');assert.equal((await client.pendingSummary()).count,0);
 const persisted=JSON.parse(await fs.readFile(client.pendingPath,'utf8'));assert.equal(persisted.pending[0].state,'unknown');assert.equal(persisted.pending[0].resolution.kind,'navigation_observed');
 await assert.rejects(client.call(device,'launch_app',{package_name:'com.android.settings',request_id:'launch-unknown'}),isCode('request_id_reused'));
 const restarted=new PhoneUseClient({dataDir,clientPath:officialPath});t.after(()=>restarted.close());assert.equal((await restarted.pendingSummary()).count,0);assert.equal((await restarted.status()).pending[0].state,'unknown');
});
test('navigation recovery never releases sends, legacy unbound launches, active requests, foreign or stale foreground',async t=>{
 for(const tool of ['input_text','launch_app']){
  const {client}=await setup(t,()=>unknown('legacy'));
  await assert.rejects(client.call(device,tool,{request_id:'legacy'}),isCode('outcome_unknown'));
  assert.equal((await client.reconcileNavigation('legacy',{deviceId:device,capture:async()=>assert.fail('must not capture an unbound effect')})).resolved,false);
 }
 for(const fault of ['active','foreign','stale','different-package','changed-service']){
  let reads=0;const {client}=await setup(t,item=>item.params.name==='launch_app'?unknown('nav'):item.params.name==='get_status'?native(bound({executing_request_id:fault==='active'?'nav':null,service_instance_id:fault==='changed-service'&&++reads>1?'new-service':instance,request:bound({state:'unknown',request_id:'nav',action_executed:null})})):undefined);
  await assert.rejects(client.call(device,'launch_app',{package_name:'com.android.settings',request_id:'nav'}),isCode('outcome_unknown'));
  const frame={native:{deviceId:fault==='foreign'?'other':device,serviceInstanceId:instance,observationId:'fresh',at:Date.now()-(fault==='stale'?60000:0)},tree:native({ok:true,result:{display:'main',windowPkg:fault==='different-package'?'com.tencent.mm':'com.android.settings',foreground:'com.android.settings/Activity'}})};
  assert.equal((await client.reconcileNavigation('nav',{deviceId:device,capture:async()=>frame})).resolved,false,fault);assert.equal((await client.pendingSummary()).count,1);
 }
});
test('remote transport rebuilds both wrappers with distinct loopback dial ports without clearing credentials or pending',async t=>{
 const {client,processes}=await setup(t,()=>unknown('preserved'));
 await assert.rejects(client.call(device,'tap',{request_id:'preserved'}),isCode('outcome_unknown'));
 const config='{"version":2,"devices":{"fixture-device":{"token":"preserved-secret","tls_pin":"pin"}}}';await fs.writeFile(client.configPath,config);
 await client.setRemoteTransport({dataPort:31001,controlPort:31002});assert.equal(processes[0].dead,true);assert.equal(processes[1].dead,true);
 await client.start();assert.equal(processes[2].args.at(-2),'31001');assert.equal(processes[3].args.at(-2),'31002');assert.equal(processes[2].args.at(-1),'main');assert.equal(processes[3].args.at(-1),'control');assert.match(processes[2].args[2],/127\.0\.0\.1/);
 assert.equal(await fs.readFile(client.configPath,'utf8'),config);assert.equal((await client.pendingSummary()).count,1);
 await client.setRemoteTransport(null);await client.start();assert.equal(processes.at(-2).args[1],officialPath);assert.equal((await client.pendingSummary()).count,1);
 for(const value of [{dataPort:0,controlPort:1},{dataPort:31001,controlPort:31001},{dataPort:1,controlPort:2,host:'remote.example'}])await assert.rejects(client.setRemoteTransport(value),isCode('invalid_input'));
});
test('remote transport cannot switch while a phone effect is in flight',async t=>{
 let release,started;const seen=new Promise(resolve=>started=resolve),wait=new Promise(resolve=>release=resolve);
 const {client}=await setup(t,async item=>{if(item.params.name==='tap'){started();await wait;return executed('running');}});
 const pending=client.call(device,'tap',{request_id:'running'});await seen;
 await assert.rejects(client.setRemoteTransport({dataPort:31001,controlPort:31002}),isCode('phone_transport_busy'));release();await pending;
});

test('bounded demo read requires an exact live lease before and after dispatch and never uses main input transport',async t=>{
 const lease={},seen=bound({observation_status:'complete',tree:{available:true,elements:[]},screenshot:null});let authorized=false;
 const {client,tools}=await setup(t,item=>item.params.name==='observe'?native(seen):undefined);client.demoLeaseGuard=(candidate,id)=>authorized&&candidate===lease&&id===device;
 await assert.rejects(client.observeForDemo(device,{lease}),isCode('demo_lease_expired'));assert.equal(tools().length,0);authorized=true;
 assert.deepEqual(await client.observeForDemo(device,{lease}),seen);assert.equal(tools()[0].role,'control');assert.deepEqual(tools()[0].params.arguments,{device_id:device,mode:'tree',output:'legacy',compact:true,include_details:false,diagnostics:false,stable_wait_ms:0,max_attempts:1,timeout_ms:1500});
 await assert.rejects(client.observeForDemo(device,{lease:{}}),isCode('demo_lease_expired'));assert.equal(tools().length,1);
 const late=await setup(t,item=>{if(item.params.name==='observe'){authorized=false;return native(seen);}});late.client.demoLeaseGuard=(candidate,id)=>authorized&&candidate===lease&&id===device;authorized=true;await assert.rejects(late.client.observeForDemo(device,{lease}),isCode('demo_lease_expired'));
});


async function legacyPending(client,overrides={}){
 const record={deviceId:device,requestId:'old-navigation',tool:'launch_app',createdAt:1,state:'unknown',...overrides};
 await fs.mkdir(path.dirname(client.pendingPath),{recursive:true});await fs.writeFile(client.pendingPath,JSON.stringify({version:1,pending:[record]}));return record;
}
test('lost legacy navigation remains unresolved across restart and cannot authorize a replacement',async t=>{
 const {client,tools}=await setup(t,()=>native(bound({error:{code:'REQUEST_NOT_FOUND',message:'not retained'}}),true));
 await legacyPending(client);const original=await fs.readFile(client.pendingPath,'utf8');
 await assert.rejects(client.call(device,'launch_app',{package_name:'com.android.settings',request_id:'replacement'}),isCode('outcome_unknown'));
 assert.equal(await fs.readFile(client.pendingPath,'utf8'),original);assert.equal(tools().some(call=>call.params.name==='launch_app'),false);
 client.loaded=false;client.pending.clear();await client.loadPending();assert.equal((await client.pendingSummary()).count,1);
});
for(const variation of ['executing','retained','transport-error'])test(`legacy navigation supersession rejects ${variation}`,async t=>{
 let reads=0;const {client,tools}=await setup(t,item=>{
  if(item.params.name==='get_status'){
   if(item.params.arguments.request_id){if(variation==='transport-error')throw Error('offline');if(variation==='retained')return native(bound({request:{request_id:'old-navigation',state:'pending'}}));return native(bound({error:{code:'REQUEST_NOT_FOUND',message:'not retained'}}),true);}
   reads++;return native(bound({paused:false,stopped:false,executing_request_id:variation==='executing'?'other':null,...(variation==='service-changed'&&reads===2?{service_instance_id:'changed'}:{})}));
  }
 });
 await legacyPending(client,variation==='known-target'?{navigationTarget:'com.example.original'}:{});
 const original=await fs.readFile(client.pendingPath,'utf8');await assert.rejects(client.call(device,variation==='tap'?'tap':'launch_app',variation==='tap'?{...actionArgs,request_id:'new-navigation'}:{package_name:'com.android.settings',request_id:'new-navigation'}),isCode('outcome_unknown'));
 assert.equal(await fs.readFile(client.pendingPath,'utf8'),original);assert.equal(tools().some(call=>['tap','launch_app'].includes(call.params.name)),false);
});

// An old open-app the restarted phone no longer remembers is superseded once the
// phone reports itself idle (see the restart test below); a tap or typed text never is.
for(const oldTool of ['tap','input_text'])for(const tool of ['launch_app','tap'])test(`idle status and fresh screen cannot release a recent unknown ${oldTool} for ${tool}`,async t=>{
 const {client,tools}=await setup(t,item=>item.params.arguments.request_id?native(bound({error:{code:'REQUEST_NOT_FOUND',message:'not retained'}}),true):native(bound({stopped:false,executing_request_id:null})));
 await legacyPending(client,{tool:oldTool,createdAt:Date.now()-5000,navigationTarget:oldTool==='launch_app'?'com.android.settings':undefined});
 const original=await fs.readFile(client.pendingPath,'utf8');
 await assert.rejects(client.call(device,tool,{...actionArgs,package_name:'com.android.settings',request_id:'new-action'},{freshObservation:true}),isCode('outcome_unknown'));
 assert.equal(await fs.readFile(client.pendingPath,'utf8'),original);assert.equal(tools().some(call=>call.params.name===tool),false);
});
test('an explicitly paused phone still blocks recovery even when other fields look idle',async t=>{
 const {client,tools}=await setup(t,item=>{
  if(item.params.name==='get_status')return item.params.arguments.request_id?native(bound({error:{code:'REQUEST_NOT_FOUND',message:'not retained'}}),true):native(bound({paused:true,stopped:false,executing_request_id:null}));
 });
 await legacyPending(client);
 await assert.rejects(client.call(device,'launch_app',{package_name:'com.android.settings',request_id:'paused-phone'}),isCode('outcome_unknown'));
 assert.equal(tools().some(call=>call.params.name==='launch_app'),false);
});
for(const oldTool of ['tap','input_text','long_press'])test(`an unknown ${oldTool} older than half a minute gives way once the phone reports itself idle, and is never replayed`,async t=>{
 const {client,tools}=await setup(t,item=>item.params.name==='get_status'?(item.params.arguments.request_id?native(bound({error:{code:'REQUEST_NOT_FOUND',message:'not retained'}}),true):native(bound({paused:false,stopped:false,executing_request_id:null}))):undefined);
 await legacyPending(client,{tool:oldTool,requestId:'old-effect',createdAt:Date.now()-31000});
 await client.call(device,'tap',{...actionArgs,request_id:'next-step'});
 const saved=JSON.parse(await fs.readFile(client.pendingPath,'utf8')).pending.find(row=>row.requestId==='old-effect');
 assert.equal(saved.resolution.kind,'expired_after_idle');assert.equal(saved.resolution.nativeOutcome,'unknown');assert.equal(saved.resolution.newRequestId,'next-step');
 assert.equal(tools().filter(call=>call.params.arguments.request_id==='old-effect'&&call.params.name!=='get_status').length,0);
 assert.equal(tools().filter(call=>call.params.name==='tap').length,1);
});
test('a recent unknown tap is not moved past by an action without a fresh bound screen',async t=>{
 const {client,tools}=await setup(t,item=>item.params.name==='get_status'?(item.params.arguments.request_id?native(bound({error:{code:'REQUEST_NOT_FOUND',message:'not retained'}}),true):native(bound({paused:false,stopped:false,executing_request_id:null}))):undefined);
 await legacyPending(client,{tool:'tap',requestId:'old-tap',createdAt:Date.now()-5000});
 await assert.rejects(client.call(device,'tap',{...actionArgs,request_id:'blind-tap'}),isCode('outcome_unknown'));
 assert.equal(tools().some(call=>call.params.name==='tap'),false);
});

test('late status without a retained receipt still cannot authorize another action',async t=>{
 const {client,tools}=await setup(t,async()=>{await new Promise(resolve=>setTimeout(resolve,30));return native(bound({error:{code:'REQUEST_NOT_FOUND',message:'not retained'}}),true);});
 await legacyPending(client);await assert.rejects(client.call(device,'launch_app',{package_name:'com.android.settings',request_id:'late'}),isCode('outcome_unknown'));
 assert.ok(tools().filter(item=>item.params.name==='get_status').length<=2);assert.equal(tools().some(item=>item.params.name==='launch_app'),false);
});
test('legacy recovery budget expires before sending a new effect and preserves unknown history',async t=>{
 const {client,tools}=await setup(t,item=>item.params.name==='get_status'?never():undefined,{navigationRecoveryTimeout:25});
 await legacyPending(client);const original=await fs.readFile(client.pendingPath,'utf8');
 await assert.rejects(client.call(device,'launch_app',{package_name:'com.android.settings',request_id:'must-not-send'}),error=>error.code==='outcome_unknown'&&error.dispatchState==='not_sent');
 assert.equal(await fs.readFile(client.pendingPath,'utf8'),original);assert.equal(tools().some(item=>item.params.name==='launch_app'),false);
});


const unknownStatusReceipt=id=>native(bound({paused:false,stopped:false,executing_request_id:null,
 request:bound({state:'unknown',request_id:id,action_executed:null,error:{code:'RESULT_UNKNOWN',reason:'launch_not_confirmed'}})}),true);
test('native isError unknown status remains an unknown receipt for the exact request',async t=>{
 const {client,tools}=await setup(t,()=>unknownStatusReceipt('nav'));
 const receipt=await client.status(device,{requestId:'nav'});
 assert.equal(receipt.request.state,'unknown');assert.equal(receipt.request.action_executed,null);
 assert.equal(tools().length,1);assert.equal(tools()[0].params.name,'get_status');
});
test('native unknown status never accepts foreign, missing, active or unrelated error envelopes',async t=>{
 const variants=[r=>r.device_id='other',r=>r.request.device_id='other',r=>r.request.service_instance_id='other',
  r=>r.request.request_id='other',r=>r.executing_request_id='active',r=>r.error={code:'TLS_IDENTITY_MISMATCH'},
  r=>r.request.error.code='STOPPED',r=>r.request.action_executed=true,r=>r.paused=true,r=>r.paused='no',r=>delete r.service_instance_id];
 for(const mutate of variants){const raw=unknownStatusReceipt('nav'),state=JSON.parse(raw.content[0].text);mutate(state);raw.content[0].text=JSON.stringify(state);
  const {client}=await setup(t,()=>raw);await assert.rejects(client.status(device,{requestId:'nav'}),isCode('phoneuse_error'));
 }
 const {client}=await setup(t,()=>unknownStatusReceipt('nav'));await assert.rejects(client.status(device),isCode('phoneuse_error'));
});
test('real native unknown envelope reconciles navigation only after matching foreground and idle service proof',async t=>{
 const {client}=await setup(t,()=>unknownStatusReceipt('nav'));
 await legacyPending(client,{requestId:'nav',navigationTarget:'com.android.settings'});
 const frame={native:{deviceId:device,serviceInstanceId:instance,observationId:'current-nav',at:Date.now()},tree:native({ok:true,result:{display:'main',windowPkg:'com.android.settings',foreground:'com.android.settings/.Settings'}})};
 assert.equal((await client.reconcileNavigation('nav',{deviceId:device,capture:async()=>({...frame,tree:native({ok:true,result:{display:'main',windowPkg:'com.other.app',foreground:'com.other.app'}})})})).resolved,false);
 assert.equal((await client.pendingSummary()).count,1);
 const result=await client.reconcileNavigation('nav',{deviceId:device,capture:async()=>frame});
 assert.equal(result.outcome,'navigation_observed');assert.equal(result.nativeOutcome,'unknown');
 const stored=JSON.parse(await fs.readFile(client.pendingPath,'utf8')).pending[0];assert.equal(stored.state,'unknown');assert.equal(stored.resolution.packageName,'com.android.settings');
});

test('read failures are explicitly known not to dispatch a phone input action',async t=>{
 const {client}=await setup(t,()=>native(bound({error:{code:'ACCESSIBILITY_UNAVAILABLE',message:'off'}}),true));
 await assert.rejects(client.call(device,'list_apps',{}),e=>e.code==='phoneuse_error'&&e.dispatchState==='not_sent');
 assert.equal((await client.pendingSummary()).count,0);
});

test('Samsung battery system module can reconcile only a requested Settings navigation with exact foreground identity',async t=>{
 const {client}=await setup(t,()=>unknownStatusReceipt('nav'));await legacyPending(client,{requestId:'nav',navigationTarget:'com.android.settings'});
 const frame=pkg=>({native:{deviceId:device,serviceInstanceId:instance,observationId:'os-settings-module',at:Date.now()},tree:native({ok:true,result:{display:'main',windowPkg:pkg,foreground:pkg+'/Activity'}})});
 assert.equal((await client.reconcileNavigation('nav',{deviceId:device,capture:async()=>frame('com.samsung.android.unrelated')})).resolved,false);
 const verified=await client.reconcileNavigation('nav',{deviceId:device,capture:async()=>frame('com.samsung.android.sm_cn')});assert.equal(verified.outcome,'navigation_observed');assert.equal(verified.nativeOutcome,'unknown');assert.equal(verified.resolution.packageName,'com.android.settings');assert.equal(verified.resolution.observedPackageName,'com.samsung.android.sm_cn');
 const saved=JSON.parse(await fs.readFile(client.pendingPath,'utf8'));assert.equal(saved.pending[0].state,'unknown');
 const fresh=new PhoneUseClient({dataDir:client.dataDir,clientPath:officialPath});await fresh.loadPending();assert.equal((await fresh.pendingSummary()).count,0);await fresh.close();
});


test('navigation proof cannot commit after cancellation during its final status check',async t=>{
 const controller=new AbortController();let reads=0;
 const {client}=await setup(t,item=>{
  if(item.params.name==='launch_app')return unknown('cancel-nav');
  if(item.params.name==='get_status'){if(++reads===2)controller.abort();return native(bound({executing_request_id:null,request:bound({state:'unknown',request_id:'cancel-nav',action_executed:null})}));}
 });
 await assert.rejects(client.call(device,'launch_app',{package_name:'com.android.settings',request_id:'cancel-nav'}),isCode('outcome_unknown'));
 const capture=async()=>({native:{deviceId:device,serviceInstanceId:instance,observationId:'fresh',at:Date.now()},tree:native({ok:true,result:{display:'main',windowPkg:'com.android.settings',foreground:'com.android.settings/Activity'}})});
 await assert.rejects(client.reconcileNavigation('cancel-nav',{deviceId:device,signal:controller.signal,capture}),isCode('cancelled'));
 assert.equal((await client.pendingSummary()).count,1);
});

test('an unconfirmed open-app is superseded as soon as the phone reports itself idle; a typed action only after half a minute',async t=>{
  let now=Date.now();const idleStatus=id=>native(bound({paused:false,stopped:false,executing_request_id:null,request:bound({state:'unknown',request_id:id,action_executed:null})}));
  const {client,dataDir}=await setup(t,item=>item.params.name==='launch_app'&&item.params.arguments.request_id==='old-launch'?unknown('old-launch'):item.params.name==='input_text'&&item.params.arguments.request_id==='old-type'?unknown('old-type'):item.params.name==='get_status'?idleStatus(item.params.arguments.request_id):undefined,{clock:()=>now});
  await assert.rejects(client.call(device,'launch_app',{package_name:'com.taobao.idlefish',request_id:'old-launch'}),isCode('outcome_unknown'));
  // Opening an app commits nothing; an idle phone lets the very next step go ahead.
  await client.call(device,'tap',{...actionArgs,request_id:'next-step'});
  const saved=JSON.parse(await fs.readFile(client.pendingPath,'utf8')).pending.find(row=>row.requestId==='old-launch');
  assert.equal(saved.resolution.kind,'superseded_after_idle');assert.equal(saved.resolution.newRequestId,'next-step');assert.equal(saved.resolution.serviceInstanceId,instance);
  const restarted=new PhoneUseClient({dataDir,clientPath:officialPath});t.after(()=>restarted.close());assert.equal((await restarted.pendingSummary()).count,0,'the record survives a restart as resolved');
  await assert.rejects(client.call(device,'input_text',{...actionArgs,text:'x',request_id:'old-type'}),isCode('outcome_unknown'));
  await assert.rejects(client.call(device,'tap',{...actionArgs,request_id:'after-type'}),isCode('outcome_unknown'),'a recent unconfirmed typed action still blocks');
  now+=31000;
  await client.call(device,'tap',{...actionArgs,request_id:'after-wait'});
  assert.equal(JSON.parse(await fs.readFile(client.pendingPath,'utf8')).pending.find(row=>row.requestId==='old-type').resolution.kind,'expired_after_idle');
});


test('old launch recovery never reuses an idle observation after a busy or failed status',async t=>{
 for(const latest of ['busy','error']){
  let now=Date.now(),mode='idle';const f=await setup(t,item=>{
   const name=item.params.name,id=item.params.arguments?.request_id;
   if(name==='launch_app')return unknown(id);
   if(name==='get_status'){if(mode==='error')throw Error('status unavailable');return native(bound({paused:false,executing_request_id:mode==='busy'?'other-request':null,request:bound({state:'unknown',request_id:id,action_executed:null})}));}
  },{clock:()=>now});
  await assert.rejects(f.client.call(device,'launch_app',{package_name:'com.taobao.idlefish',request_id:'stale-idle-launch'}));
  // An idle report from just before must not be reused once the phone is busy or unreadable.
  f.client.idleInstance={deviceId:device,id:instance,at:now};now+=2000;mode=latest;
  await assert.rejects(f.client.call(device,'tap',{...actionArgs,request_id:'blocked-after-age'}),isCode('outcome_unknown'));
  assert.equal(f.client.idleInstance,null);assert.ok(!f.tools().some(c=>c.params.name==='tap'),'no tap was dispatched');
 }
});

test('after the phone app restarts and forgets the old open-app, its plain idle status still lets the next action supersede it',async t=>{
  let now=Date.now();
  const {client}=await setup(t,item=>{
   const name=item.params.name,id=item.params.arguments?.request_id;
   if(name==='launch_app'&&id==='before-update')return unknown(id);
   if(name==='get_status')return id?native(bound({error:{code:'REQUEST_NOT_FOUND',message:'not retained'}}),true):native(bound({paused:false,stopped:false,executing_request_id:null}));
  },{clock:()=>now});
  await assert.rejects(client.call(device,'launch_app',{package_name:'com.tencent.qqmusic',request_id:'before-update'}),isCode('outcome_unknown'));
  now+=10*60000;
  await client.call(device,'tap',{...actionArgs,request_id:'after-update'});
  assert.equal((await client.pendingSummary()).count,0);
});
