import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import tls from 'node:tls';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {X509Certificate,randomUUID} from 'node:crypto';
import {ensureIdentity,certificateStatus,spkiPin,atomicJSON} from '../src/remote/state.mjs';
import {RemoteService} from '../src/remote/service.mjs';
import {Store} from '../src/core/store.mjs';
const execute=promisify(execFile),DAY=86400000;
function fixture(t,{days=1}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-identity-')),remote=path.join(dir,'remote');fs.mkdirSync(remote,{mode:0o700});const keyFile=path.join(dir,'synthetic.key'),certFile=path.join(remote,'gateway.crt');
 execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-keyout',keyFile,'-out',certFile,'-days',String(days),'-subj','/CN=Boujoy Test Identity'],{stdio:'ignore'});
 const key=fs.readFileSync(keyFile,'utf8'),cert=fs.readFileSync(certFile,'utf8'),calls=[];const secrets={async get(name){return name==='private-key'?key:'synthetic-route-token-that-is-long-enough';},async set(name){calls.push(name);throw Error('Existing identity must not change Keychain');}};
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,remote,key,cert,certFile,secrets,calls};
}
test('near-expiry and expired gateway certificates renew with the original key and unchanged SPKI',async t=>{
 for(const offset of [0,2*DAY]){const f=fixture(t),now=()=>Date.now()+offset,result=await ensureIdentity(f.dir,f.secrets,{now});assert.equal(result.renewed,true);assert.equal(result.key,f.key);assert.equal(result.pin,spkiPin(f.cert));assert(result.certificate.daysRemaining>300);assert.equal(result.certificate.needsMaintenance,false);assert.deepEqual(f.calls,[]);assert.notEqual(result.cert,f.cert);assert.equal(fs.statSync(f.certFile).mode&0o777,0o600);assert.deepEqual(fs.readdirSync(f.remote),['gateway.crt']);}
});
test('healthy certificates are validated without renewal, while a mismatched key is never used to replace a certificate',async t=>{
 const f=fixture(t,{days:365});let executions=0;const value=await ensureIdentity(f.dir,f.secrets,{runOpenSSL:async()=>{executions++;}});assert.equal(value.renewed,false);assert.equal(executions,0);const other=fixture(t);
 await assert.rejects(ensureIdentity(f.dir,{...f.secrets,get:async()=>other.key}),e=>e.code==='gateway_identity_mismatch');assert.equal(fs.readFileSync(f.certFile,'utf8'),f.cert);assert.equal(executions,0);
});
test('renewal execution/validation failure and late busy admission leave the original certificate and key intact',async t=>{
 const f=fixture(t);await assert.rejects(ensureIdentity(f.dir,f.secrets,{runOpenSSL:async()=>{throw Error('synthetic signing failure');}}),/synthetic signing failure/);assert.equal(fs.readFileSync(f.certFile,'utf8'),f.cert);
 await assert.rejects(ensureIdentity(f.dir,f.secrets,{runOpenSSL:async(_command,args)=>{fs.writeFileSync(args[args.indexOf('-out')+1],'invalid certificate');}}),e=>e.code==='gateway_identity_invalid');assert.equal(fs.readFileSync(f.certFile,'utf8'),f.cert);
 const deferred=await ensureIdentity(f.dir,f.secrets,{beforeRenewalCommit:()=>false});assert.equal(deferred.renewalDeferred,true);assert.equal(fs.readFileSync(f.certFile,'utf8'),f.cert);assert.deepEqual(f.calls,[]);assert.deepEqual(fs.readdirSync(f.remote),['gateway.crt']);
});
test('simultaneous renewals serialize and do not generate multiple identities',async t=>{
 const f=fixture(t);let count=0;const options={runOpenSSL:async(...args)=>{count++;return execute(...args);}};const values=await Promise.all([ensureIdentity(f.dir,f.secrets,options),ensureIdentity(f.dir,f.secrets,options)]);assert.equal(count,1);assert.equal(values[0].pin,values[1].pin);assert.equal(values[0].cert,values[1].cert);assert.equal(values[1].renewed,false);
});
test('a durability failure after certificate rename rolls back to the original certificate',async t=>{
 const f=fixture(t),original=fs.fsyncSync;let calls=0;t.mock.method(fs,'fsyncSync',function(fd){if(++calls===2)throw Error('synthetic directory sync failure');return original.call(fs,fd);});
 await assert.rejects(ensureIdentity(f.dir,f.secrets),e=>e.code==='gateway_certificate_commit_failed');assert.equal(fs.readFileSync(f.certFile,'utf8'),f.cert);assert.deepEqual(f.calls,[]);assert.deepEqual(fs.readdirSync(f.remote),['gateway.crt']);
});
async function serviceFixture(t,options={}){
 const f=fixture(t),store=new Store(f.dir,{lock:false}),engine={active:new Map(),async stop(){throw Error('Maintenance must not cancel a task');}},events=[],phone={lease:null,phoneUse:{client:{active:new Map(),rpc:{pending:new Map()},controlRpc:{pending:new Map()}}},async setRemoteTransport(ports){assert.equal(this.remoteMaintenance,true);events.push(['transport',ports]);await options.onTransport?.(ports);}};
 store.data.tasks.push({id:'held',status:'queued'});atomicJSON(path.join(f.remote,'config.json'),{enabled:true,deviceId:randomUUID(),relayUrl:'wss://relay.invalid/v1/tunnel'});
 const connectors=[];const connectorFactory=()=>{const n=connectors.length,connector={async start(){events.push(['start',n]);},status(){return {dataConnected:true,controlConnected:true,phoneDataPort:30001+n*2,phoneControlPort:30002+n*2};},pause(){events.push(['pause',n]);},async close(){events.push(['close',n]);}};connectors.push(connector);return connector;};
 const service=new RemoteService({dataDir:f.dir,store,engine,phone,secrets:f.secrets,connectorFactory,identityOptions:options.identityOptions||{},maintenanceIntervalMs:options.maintenanceIntervalMs||86400000});
 t.after(async()=>{await service.close();store.close();});await service.start();store.data.tasks=[];return {...f,service,store,engine,phone,events,connectors};
}
function peerCertificate(port){return new Promise((resolve,reject)=>{const socket=tls.connect({host:'127.0.0.1',port,rejectUnauthorized:false,minVersion:'TLSv1.3'});socket.once('error',reject);socket.once('secureConnect',()=>{const cert=socket.getPeerCertificate().raw;socket.destroy();resolve(new X509Certificate(cert));});});}
test('idle daily maintenance replaces the live TLS gateway and connector, preserves binding, and remains paused at a new epoch',async t=>{
 const f=await serviceFixture(t),oldGateway=f.service.gateway,oldCert=await peerCertificate(oldGateway.server.address().port);f.service.state.update(s=>{s.control={paused:false,controlEpoch:8};s.devices.synthetic={active:true,id:'same-device'};});
 const result=await f.service.maintainIdentity(),newCert=await peerCertificate(f.service.gateway.server.address().port);assert.equal(result.identity.maintenanceState,'renewed');assert.equal(result.identity.needsMaintenance,false);assert(result.identity.lastRenewedAt);assert.equal(spkiPin(newCert.raw),spkiPin(oldCert.raw));assert.notDeepEqual(newCert.raw,oldCert.raw);assert.equal(oldGateway.server.listening,false);assert.equal(f.connectors.length,2);assert.equal(f.phone.remoteMaintenance,false);assert.equal(result.control.paused,true);assert.equal(result.control.controlEpoch,9);assert.equal(result.control.reason,'maintenance');assert.equal(result.control.maintenanceResumeEpoch,8);assert.ok(Date.parse(result.control.pausedAt));assert.equal(f.service.state.data.devices.synthetic.active,true);assert.equal(f.events.filter(e=>e[0]==='close').length,1);assert.equal(f.events.filter(e=>e[0]==='transport').length,2);
});
test('active, queued, approval, child-waiting, lease and native RPC work all defer maintenance without disconnecting',async t=>{
 const f=await serviceFixture(t),epoch=f.service.state.data.control.controlEpoch;
 for(const status of ['queued','running','waiting_approval','waiting_children']){f.store.data.tasks=[{id:'busy',status}];const r=await f.service.maintainIdentity();assert.equal(r.identity.maintenanceState,'deferred_active');}
 f.store.data.tasks=[];for(const map of [f.engine.active,f.phone.phoneUse.client.active,f.phone.phoneUse.client.rpc.pending,f.phone.phoneUse.client.controlRpc.pending]){map.set('busy',{});await f.service.maintainIdentity();map.clear();}
 f.phone.lease='busy';await f.service.maintainIdentity();f.phone.lease=null;assert.equal(f.events.filter(e=>e[0]==='close').length,0);assert.equal(f.connectors.length,1);assert.equal(f.service.state.data.control.controlEpoch,epoch);assert.equal(fs.readFileSync(f.certFile,'utf8'),f.cert);
});
test('a task arriving during signing prevents commit and leaves the existing live connection untouched',async t=>{
 let service;const f=await serviceFixture(t,{identityOptions:{runOpenSSL:async(...args)=>{await execute(...args);service.store.data.tasks.push({id:'arrived',status:'queued'});}}});service=f;
 const previous=f.service.gateway,epoch=f.service.state.data.control.controlEpoch,result=await f.service.maintainIdentity();assert.equal(result.identity.maintenanceState,'deferred_active');assert.equal(f.service.gateway,previous);assert.equal(previous.server.listening,true);assert.equal(f.service.state.data.control.controlEpoch,epoch);assert.equal(f.phone.remoteMaintenance,false);assert.equal(f.connectors.length,1);assert.equal(fs.readFileSync(f.certFile,'utf8'),f.cert);
});
test('signing failure keeps the usable connection and original certificate, reporting maintenance required',async t=>{
 const f=await serviceFixture(t,{identityOptions:{runOpenSSL:async()=>{throw Error('synthetic unavailable signer');}}}),gateway=f.service.gateway;await assert.rejects(f.service.maintainIdentity(),/unavailable signer/);const state=f.service.status();assert.equal(state.identity.maintenanceState,'failed');assert.equal(state.identity.needsMaintenance,true);assert.equal(f.service.gateway,gateway);assert.equal(gateway.server.listening,true);assert.equal(f.phone.remoteMaintenance,false);assert.equal(fs.readFileSync(f.certFile,'utf8'),f.cert);
});
test('maintenance is scheduled and cannot reopen connections after service close while signing',async t=>{
 let enter,release;const entered=new Promise(r=>enter=r),barrier=new Promise(r=>release=r);const f=await serviceFixture(t,{identityOptions:{runOpenSSL:async(...args)=>{enter();await barrier;return execute(...args);}}});assert(f.service.maintenanceTimer);const work=f.service.maintainIdentity();await entered;const close=f.service.close();release();await work;await close;assert.equal(f.service.maintenanceTimer,null);assert.equal(f.service.gateway,null);assert.equal(f.service.connector,null);assert.equal(f.connectors.length,1);assert.equal(fs.readFileSync(f.certFile,'utf8'),f.cert);
});
test('transport rebuild failure remains paused and blocks phone access until a successful full restart',async t=>{
 let fail=false;const f=await serviceFixture(t,{onTransport:async()=>{if(fail)throw Error('synthetic transport rebuild failure');}});fail=true;const epoch=f.service.state.data.control.controlEpoch;
 await assert.rejects(f.service.maintainIdentity(),/transport rebuild failure/);assert.equal(f.service.gateway,null);assert.equal(f.service.connector,null);assert.equal(f.phone.remoteMaintenance,true);assert.equal(f.service.state.data.control.paused,true);assert.equal(f.service.state.data.control.controlEpoch,epoch+1);assert.equal(f.service.status().identity.maintenanceState,'failed');assert.equal(spkiPin(fs.readFileSync(f.certFile)),spkiPin(f.cert));
 fail=false;await f.service.start();assert.equal(f.phone.remoteMaintenance,false);assert.equal(f.service.state.data.control.paused,true);assert.equal(f.service.status().identity.maintenanceState,'ready');
});
test('starting a service with a due certificate renews it before the first gateway accepts TLS',async t=>{
 const f=fixture(t),store=new Store(f.dir,{lock:false}),engine={active:new Map()},phone={lease:null,async setRemoteTransport(){assert.equal(this.remoteMaintenance,true);}};atomicJSON(path.join(f.remote,'config.json'),{enabled:true,deviceId:randomUUID(),relayUrl:'wss://relay.invalid/v1/tunnel'});
 const service=new RemoteService({dataDir:f.dir,store,engine,phone,secrets:f.secrets,connectorFactory:()=>({async start(){},pause(){},async close(){},status(){return {phoneDataPort:32001,phoneControlPort:32002};}})});t.after(async()=>{await service.close();store.close();});
 const status=await service.start(),peer=await peerCertificate(service.gateway.server.address().port);assert.equal(status.identity.maintenanceState,'renewed');assert(certificateStatus(peer.raw).daysRemaining>300);assert.equal(spkiPin(peer.raw),spkiPin(f.cert));assert.equal(status.control.paused,true);assert.equal(phone.remoteMaintenance,false);
});
