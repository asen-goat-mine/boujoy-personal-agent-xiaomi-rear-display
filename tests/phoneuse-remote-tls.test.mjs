import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import https from 'node:https';
import {createHash,randomBytes,randomUUID,X509Certificate} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PhoneUseClient,unwrapPhoneUseMcp,PHONEUSE_CLIENT_SHA256} from '../src/adapters/phoneuse-client.mjs';
import {PhoneUseDriver} from '../src/adapters/phoneuse-driver.mjs';
import {MacConnector,RelayClient,pipeSocket} from '../src/remote/transport.mjs';
import {createRelay} from '../src/remote/relay.mjs';
import {hash} from '../src/remote/protocol.mjs';
import {nativeEnvelope,nativeNode} from './helpers/phone-native-fixture.mjs';
import {staleInputFixture,proofFrame} from './helpers/stale-input-fixture.mjs';
import {INPUT_PROOF_FRAME} from '../src/adapters/input-recovery-capture.mjs';

const execute=promisify(execFile);
const officialPath=path.join(os.homedir(),'Library/Application Support/Boujoy Personal Agent/tools/phoneuse/1.3.0/phoneuse_client.py');
const device='local-tls-fixture-device',instance='local-tls-fixture-service',token='fixture-credential-never-used-outside-local-test';
const bound=value=>({device_id:device,service_instance_id:instance,...value});
const mcp=value=>({content:[{type:'text',text:JSON.stringify(bound(value))}]});
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});
function deadline(promise,ms=2500){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Independent control channel did not respond')),ms);})]).finally(()=>clearTimeout(timer));}

// The only network destination in this fixture is a loopback mock phone. Both
// proxies forward encrypted bytes without TLS termination or header rewriting.
async function fixture(t,{wrongPin=false,identityDevice=device,handle,realRelay=false,dataPaused=false,closeHttp=false}={}){
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'boujoy-phoneuse-real-tls-'));
 const keyPath=path.join(dataDir,'key.pem'),certPath=path.join(dataDir,'cert.pem');
 await execute('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-subj','/CN=127.0.0.1','-days','1'],{timeout:5000});
 const [key,cert,official]=await Promise.all([fs.readFile(keyPath),fs.readFile(certPath),fs.readFile(officialPath)]);
 assert.equal(createHash('sha256').update(official).digest('hex'),PHONEUSE_CLIENT_SHA256);
 const pin=createHash('sha256').update(new X509Certificate(cert).publicKey.export({type:'spki',format:'der'})).digest('hex');
 const requests=[],connections={data:0,control:0},sockets=new Set(),lanes=new Map();
 const server=https.createServer({key,cert},async(req,res)=>{
  let bytes='';for await(const chunk of req)bytes+=chunk;
  const body=bytes?JSON.parse(bytes):null,row={lane:lanes.get(req.socket.remotePort),url:req.url,method:req.method,headers:req.headers,body};requests.push(row);
  const reply=value=>{if(!res.destroyed&&!res.writableEnded){res.writeHead(200,{'Content-Type':'application/json',...(closeHttp?{Connection:'close'}:{})});res.end(JSON.stringify(value));}};
  if(req.url==='/identity')return reply({device_id:identityDevice,service_instance_id:instance,name:'local test phone'});
  assert.equal(req.url,'/mcp');assert.equal(req.headers.authorization,'Bearer '+token);
  if(handle&&await handle(row,reply,()=>req.socket.destroy()))return;
  const name=body.params.name,value=name==='get_status'?{paused:false,stopped:false,executing_request_id:null}:name==='cancel'?{state:'cancel_requested'}:{accessibility:{enabled:true}};
  reply({jsonrpc:'2.0',id:body.id,result:mcp(value)});
 });
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});server.on('tlsClientError',()=>{});
 const phonePort=await listen(server),proxies=[];
 const ports={};
 for(const lane of ['data','control']){
  const proxy=net.createServer(incoming=>{
   connections[lane]++;sockets.add(incoming);incoming.on('close',()=>sockets.delete(incoming));
   const upstream=net.connect({host:'127.0.0.1',port:phonePort},()=>{lanes.set(upstream.localPort,lane);incoming.pipe(upstream);upstream.pipe(incoming);});
   sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream));incoming.on('error',()=>upstream.destroy());upstream.on('error',()=>incoming.destroy());
  });proxies.push(proxy);ports[lane+'Port']=await listen(proxy);
 }
 const client=new PhoneUseClient({dataDir,clientPath:officialPath,controlTimeout:2200});
 await fs.mkdir(path.dirname(client.configPath),{recursive:true});
 await fs.writeFile(client.configPath,JSON.stringify({version:2,devices:{[device]:{device_id:device,url:'https://unroutable-local-fixture.invalid:8443',token,tls_pin:wrongPin?'0'.repeat(64):pin}}}));
 let closeRelay=async()=>{};
 t.after(async()=>{await client.close();await closeRelay();for(const socket of sockets)socket.destroy();await Promise.all([...proxies,server].map(item=>new Promise(resolve=>item.close(resolve))));await fs.rm(dataDir,{recursive:true,force:true});});
 if(realRelay){
  const routeId=randomUUID(),macToken=randomBytes(32).toString('hex'),phoneToken=randomBytes(32).toString('hex');
  const relay=createRelay({routes:{[routeId]:{macTokenHash:hash(macToken),androidTokenHash:hash(phoneToken)}}});
  const relayAddress=await relay.listen(),url=`ws://127.0.0.1:${relayAddress.port}/v1/tunnel`;
  const mac=new MacConnector({config:{relayUrl:url,deviceId:routeId,macRouteToken:macToken,allowLoopback:true},gatewayPort:phonePort,controlState:()=>({controlEpoch:8,paused:dataPaused})});
  const peers=['data','control'].map(lane=>new RelayClient({url,deviceId:routeId,routeToken:phoneToken,role:'android',lane,allowLoopback:true,reconnect:false,onStream:stream=>pipeSocket(stream,{port:ports[lane+'Port']})}));
  closeRelay=async()=>{for(const peer of peers)peer.close();await mac.close();await relay.close();};
  await mac.start();for(const peer of peers)peer.start();
  for(let i=0;i<300&&!peers.every(peer=>peer.peerOnline);i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(peers.every(peer=>peer.peerOnline));
  await client.setRemoteTransport({dataPort:mac.status().phoneDataPort,controlPort:mac.status().phoneControlPort});
 }else await client.setRemoteTransport(ports);
 return {client,requests,connections,pin,ports};
}

test('real pinned Python traverses two opaque loopback proxies with original SPKI and fixed inner Host',{timeout:15000},async t=>{
 const f=await fixture(t);const main=unwrapPhoneUseMcp(await f.client.call(device,'get_capabilities',{}, {timeout:4000}));assert.equal(main.device_id,device);
 assert.equal((await f.client.status(device,{timeout:4000})).service_instance_id,instance);
 assert.equal(f.connections.data,1);assert.equal(f.connections.control,1);
 await f.client.call(device,'get_capabilities',{}, {timeout:4000});
 await f.client.status(device,{timeout:4000});
 assert.equal(f.connections.data,1,'identity and repeated calls reuse one pinned data TLS connection');
 assert.equal(f.connections.control,1,'status retains its independent pinned control TLS connection');
 assert.deepEqual(f.requests.filter(row=>row.url==='/mcp').map(row=>[row.lane,row.body.params.name]),[['data','get_capabilities'],['control','get_status'],['data','get_capabilities'],['control','get_status']]);
 assert.ok(f.requests.every(row=>row.headers.host==='127.0.0.1:8443'));
 assert.ok(f.requests.filter(row=>row.url==='/identity').every(row=>row.headers.authorization===undefined));
 const saved=JSON.parse(await fs.readFile(f.client.configPath,'utf8')).devices[device];assert.equal(saved.tls_pin,f.pin);assert.equal(saved.token,token);
});

test('wrong inner TLS pin is rejected before any HTTP bytes or credential reaches the tunneled phone',{timeout:15000},async t=>{
 const f=await fixture(t,{wrongPin:true});await assert.rejects(f.client.call(device,'get_capabilities',{}, {timeout:4000}),error=>error.phoneuseCode==='TLS_IDENTITY_MISMATCH');
 assert.equal(f.connections.data,1);assert.equal(f.requests.length,0);
});

test('correct TLS key with wrong phone installation identity never receives an authenticated request',{timeout:15000},async t=>{
 const f=await fixture(t,{identityDevice:'other-installation'});await assert.rejects(f.client.call(device,'get_capabilities',{}, {timeout:4000}),error=>error.phoneuseCode==='DEVICE_IDENTITY_MISMATCH');
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,'/identity');assert.equal(f.requests[0].headers.authorization,undefined);
});

test('real control lane cancels and verifies a blocked main action without waiting for its device lock',{timeout:15000},async t=>{
 let entered,releaseMain;const began=new Promise(resolve=>{entered=resolve;});
 const f=await fixture(t,{handle:async(row,reply)=>{
  const {name,arguments:args}=row.body.params;
  if(name==='launch_app'){releaseMain=()=>reply({jsonrpc:'2.0',id:row.body.id,result:mcp({state:'cancelled',action_executed:false,request_id:args.request_id})});entered();return true;}
  if(name==='get_status'&&args.request_id){reply({jsonrpc:'2.0',id:row.body.id,result:mcp({paused:false,stopped:false,executing_request_id:null,request:bound({state:'cancelled',request_id:args.request_id,action_executed:false})})});releaseMain?.();return true;}
  return false;
 }});
 const controller=new AbortController(),pending=f.client.call(device,'launch_app',{package_name:'com.example.fixture',request_id:'fixture-only-navigation'},{signal:controller.signal,timeout:7000});
 const result=assert.rejects(pending,error=>error.code==='action_cancelled');
 await deadline(began);controller.abort();await deadline(result);
 const calls=f.requests.filter(row=>row.url==='/mcp').map(row=>[row.lane,row.body.params.name]);assert.deepEqual(calls,[['data','launch_app'],['control','cancel'],['control','get_status']]);
 assert.equal((await f.client.pendingSummary()).count,0,'only native cancelled=false-action proof clears this mock request');
});

test('real pinned Python control tunnel allows only the fixed tree-only user demo read', {timeout:15000},async t=>{
 const f=await fixture(t,{handle:async(row,reply)=>{if(row.body.params.name==='observe'){const args=row.body.params.arguments;assert.equal(args.mode,'tree');assert.equal(args.compact,true);assert.equal(args.include_details,false);assert.equal(args.timeout_ms,1500);reply({jsonrpc:'2.0',id:row.body.id,result:mcp({observation_status:'complete',screenshot:null,tree:{available:true,elements:[]}})});return true;}return false;}}),lease={};f.client.demoLeaseGuard=(candidate,id)=>candidate===lease&&id===device;
 assert.equal((await f.client.observeForDemo(device,{lease})).device_id,device);assert.deepEqual(f.requests.filter(row=>row.url==='/mcp').map(row=>[row.lane,row.body.params.name]),[['control','observe']]);
 const denied=await f.client.invoke(f.client.controlRpc,'observe',{device_id:device,mode:'both',output:'legacy',compact:true,include_details:false,diagnostics:false,stable_wait_ms:0,max_attempts:1,timeout_ms:1500},2000);assert.equal(unwrapPhoneUseMcp(denied).error.code,'CONTROL_TOOL_DENIED');assert.equal(f.requests.filter(row=>row.url==='/mcp').length,1);
});


test('cloud telemetry measures actual requests and handshakes without tokens or UI text', {timeout:15000},async t=>{
 const f=await fixture(t),rows=[];f.client.onTransportMetrics=row=>rows.push(row);
 await f.client.call(device,'get_capabilities',{}, {timeout:4000});
 await f.client.call(device,'get_capabilities',{}, {timeout:4000});
 assert.deepEqual(rows.map(r=>[r.httpRequests,r.tlsHandshakes]),[[2,1],[1,0]]);
 assert.ok(rows.every(r=>r.transport==='cloud_relay'&&r.receivedBytes>0&&r.durationMs>=0));
 assert.ok(!JSON.stringify(rows).includes(token));
});


test('a dropped pooled request is not replayed; the next explicit read reconnects and rechecks identity', {timeout:15000},async t=>{
 let count=0;
 const f=await fixture(t,{handle:async(row,reply,drop)=>{
  if(row.body.params.name==='get_capabilities'&&++count===2){drop();return true;}return false;
 }});
 await f.client.call(device,'get_capabilities',{}, {timeout:4000});
 await assert.rejects(f.client.call(device,'get_capabilities',{}, {timeout:4000}),error=>error.dispatchState==='not_sent');
 assert.equal(count,2,'failed request was not automatically replayed');
 await f.client.call(device,'get_capabilities',{}, {timeout:4000});
 assert.equal(count,3);assert.equal(f.connections.data,2);
 assert.equal(f.requests.filter(row=>row.url==='/identity').length,2,'a failed call drops the cached identity so the next call verifies the installation again');
});

function unknownStatus(id){
 return {stopped:false,executing_request_id:null,request:bound({request_id:id,state:'unknown',action_executed:null,error:{code:'RESULT_UNKNOWN'}})};
}
test('a bound unknown status retains cached identity only for an exact idle request and matching service', {timeout:15000},async t=>{
 let variant='valid';
 const f=await fixture(t,{closeHttp:true,handle:async(row,reply)=>{
  const {name,arguments:args}=row.body.params;if(name!=='get_status'||!args.request_id)return false;
  let status=unknownStatus(args.request_id);
  if(variant==='forgotten')status={error:{code:'REQUEST_NOT_FOUND'}};
  if(variant==='wrong_request')status.request.request_id='other';
  if(variant==='busy')status.executing_request_id='other';
  if(variant==='paused')status.paused=true;
  if(variant==='unbound_request')delete status.request.device_id;
  if(variant==='instance_change')status.request.service_instance_id='restarted';
  if(variant==='identity_error')status={error:{code:'TLS_IDENTITY_MISMATCH'}};
  if(variant==='rpc_error'){reply({jsonrpc:'2.0',id:row.body.id,error:{code:-32603,message:'synthetic error'}});return true;}
  reply({jsonrpc:'2.0',id:row.body.id,result:{...mcp(status),isError:true}});return true;
 }});
 const identities=()=>f.requests.filter(row=>row.url==='/identity').length;
 assert.equal((await f.client.status(device,{requestId:'original'})).request.state,'unknown');
 assert.equal((await f.client.status(device,{requestId:'original'})).request.state,'unknown');
 assert.equal(identities(),1);assert.equal(f.connections.control,3,'each of the three HTTP requests rechecks the TLS pin on its own connection');
 variant='forgotten';await assert.rejects(f.client.status(device,{requestId:'forgotten'}));await f.client.status(device);assert.equal(identities(),1,'query-specific not-found keeps identity without asserting execution');
 for(variant of ['wrong_request','busy','paused','unbound_request','instance_change','identity_error','rpc_error']){
  const before=identities();await assert.rejects(f.client.status(device,{requestId:'original'}));await f.client.status(device);
  assert.equal(identities(),before+1,variant+' must force fresh identity before the next request');
 }
 assert.equal(f.requests.filter(row=>row.url==='/mcp'&&row.body.params.name!=='get_status').length,0);
});

test('unknown status reads do not renew the twenty-second identity TTL', {timeout:35000},async t=>{
 const f=await fixture(t,{closeHttp:true,handle:async(row,reply)=>{
  const args=row.body.params.arguments;if(!args.request_id)return false;
  reply({jsonrpc:'2.0',id:row.body.id,result:{...mcp(unknownStatus(args.request_id)),isError:true}});return true;
 }});
 await f.client.status(device,{requestId:'original'});
 await new Promise(resolve=>setTimeout(resolve,10500));await f.client.status(device,{requestId:'original'});
 assert.equal(f.requests.filter(row=>row.url==='/identity').length,1);
 await new Promise(resolve=>setTimeout(resolve,10200));await f.client.status(device,{requestId:'original'});
 assert.equal(f.requests.filter(row=>row.url==='/identity').length,2,'refresh is based on original verification time, not last use');
});

test('three slow reads through the real relay verify the original foreground without replaying launch', {timeout:35000},async t=>{
 const requestId='slow-bound-navigation',target='com.example.fixture';
 const f=await fixture(t,{realRelay:true,closeHttp:true,handle:async(row,reply)=>{
  const {name,arguments:args}=row.body.params;
  if(name==='launch_app'){
   reply({jsonrpc:'2.0',id:row.body.id,result:{...mcp({state:'unknown',action_executed:null,request_id:args.request_id,error:{code:'RESULT_UNKNOWN'}}),isError:true}});return true;
  }
  if(!['get_status','observe'].includes(name))return false;
  await new Promise(resolve=>setTimeout(resolve,2850));
  if(name==='get_status')reply({jsonrpc:'2.0',id:row.body.id,result:{...mcp(unknownStatus(args.request_id)),isError:true}});
  else{
   const frame=nativeEnvelope({packageName:target},[nativeNode('Synthetic foreground',70)]);
   Object.assign(frame,{device_id:device,service_instance_id:instance,observation_id:instance+':current'});
   reply({jsonrpc:'2.0',id:row.body.id,result:mcp(frame)});
  }
  return true;
 }});
 await assert.rejects(f.client.call(device,'launch_app',{package_name:target,request_id:requestId}),{code:'outcome_unknown'});
 const driver=new PhoneUseDriver({client:f.client}),started=Date.now();
 const result=await driver.reconcileNavigation(device,requestId);
 assert.ok(Date.now()-started>8000);assert.equal(result.resolved,true);assert.equal(result.outcome,'navigation_observed');assert.equal(result.nativeOutcome,'unknown');
 const saved=JSON.parse(await fs.readFile(f.client.pendingPath,'utf8')).pending.find(row=>row.requestId===requestId);
 assert.equal(saved.state,'unknown');assert.equal(saved.resolution.packageName,target);
 assert.deepEqual(f.requests.filter(row=>row.url==='/mcp').map(row=>[row.lane,row.body.params.name]),[['data','launch_app'],['control','get_status'],['data','observe'],['control','get_status']]);
});

test('expired input verification over pinned TLS and the real relay reads two fixed control frames while the ordinary data lane is fenced', {timeout:20000},async t=>{
 let frames=0;
 const f=await fixture(t,{realRelay:true,dataPaused:true,handle:(row,reply)=>{
  if(row.body.params.name!=='observe')return false;
  assert.equal(row.lane,'control');assert.deepEqual(row.body.params.arguments,{...INPUT_PROOF_FRAME,device_id:device,service_instance_id:instance});
  reply({jsonrpc:'2.0',id:row.body.id,result:mcp(proofFrame(device,instance,++frames))});return true;
 }});
 const scenario=staleInputFixture({deviceId:device,instance,client:f.client});
 const result=await scenario.run();assert.equal(result.resolved,true,JSON.stringify(result.results));
 assert.deepEqual(f.requests.filter(r=>r.url==='/mcp').map(r=>[r.lane,r.body.params.name]),[['control','get_status'],['control','observe'],['control','observe'],['control','get_status']]);
 assert.equal(f.connections.data,0);assert.equal(scenario.task.remoteControlEpoch,7);assert.equal(scenario.action.status,'unknown');
 for(const [tool,fields] of [['tap',INPUT_PROOF_FRAME],['observe',{...INPUT_PROOF_FRAME,action:'tap'}],['observe',{...INPUT_PROOF_FRAME,timeout_ms:2500}]]){
  const denied=await f.client.invoke(f.client.controlRpc,tool,{device_id:device,...fields},2200);
  assert.equal(unwrapPhoneUseMcp(denied).error.code,'CONTROL_TOOL_DENIED');
 }
 assert.equal(f.requests.filter(r=>r.url==='/mcp').length,4);
});


test('closing HTTP peer resumes pinned TLS sessions without repeating tool requests',{timeout:15000},async t=>{
 const f=await fixture(t,{closeHttp:true});const metrics=[];f.client.onTransportMetrics=row=>metrics.push(row);
 for(let i=0;i<4;i++)await f.client.call(device,'get_capabilities',{}, {timeout:4000});
 assert.equal(f.requests.filter(row=>row.url==='/mcp').length,4);
 assert.equal(f.requests.filter(row=>row.url==='/identity').length,1);
 assert.ok(metrics.slice(1).some(row=>row.tlsResumed>0),JSON.stringify(metrics));
 assert.ok(metrics.every(row=>row.peerKeepAlive===false));
});
