import {DISTRIBUTION,ANDROID_PACKAGE} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {RemoteService} from '../src/remote/service.mjs';
import {atomicJSON} from '../src/remote/state.mjs';
import {Store} from '../src/core/store.mjs';

test('authenticated phone telemetry expires, revokes and disconnects without persisting or granting phone control',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-device-telemetry-')),remote=path.join(dir,'remote');fs.mkdirSync(remote,{mode:0o700});
 const keyFile=path.join(dir,'fixture.key'),certFile=path.join(remote,'gateway.crt');
 execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-keyout',keyFile,'-out',certFile,'-days','365','-subj','/CN=Temporary Bound Telemetry Test'],{stdio:'ignore'});
 const key=fs.readFileSync(keyFile),cert=fs.readFileSync(certFile),deviceId=randomUUID(),store=new Store(dir,{lock:false});let clock=Date.now(),connectorOptions;
 atomicJSON(path.join(remote,'config.json'),{enabled:true,deviceId,relayUrl:'wss://relay.invalid/v1/tunnel'});
 const connection={dataConnected:true,controlConnected:true,phoneDataPort:32001,phoneControlPort:32002},phone={lease:null,async setRemoteTransport(){}};
 const service=new RemoteService({dataDir:dir,store,engine:{active:new Map()},phone,clock:()=>clock,secrets:{async get(name){return name==='private-key'?key:'synthetic-fixture-token';}},connectorFactory:options=>{connectorOptions=options;return {async start(){},pause(){},async close(){},status(){return connection;}};}});
 t.after(async()=>{await service.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});await service.start();
 const send=body=>new Promise((resolve,reject)=>{const request=https.request({host:'127.0.0.1',port:service.gateway.server.address().port,path:'/v1/device/status',method:'POST',headers:{Host:'boujoy.gateway','Content-Type':'application/json'},key,cert,rejectUnauthorized:false,minVersion:'TLSv1.3'},response=>{let text='';response.setEncoding('utf8');response.on('data',part=>text+=part);response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(text)}));});request.on('error',reject);request.end(JSON.stringify(body));});
 const payload={edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,timezone:'Asia/Shanghai',observedAt:new Date().toISOString(),deviceId:'spoofed',paused:false};assert.equal((await send(payload)).status,403);
 const pairing=service.state.issuePairing({deviceId}),{X509Certificate}=await import('node:crypto'),fp=createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');service.state.bind(fp,{pairToken:pairing.pairToken});
 const control=structuredClone(service.state.data.control),original=fs.readFileSync(service.state.file,'utf8');
 assert.equal((await send(payload)).status,200);clock=Date.now();const value=phone.remoteDeviceTelemetry();assert.equal(value.timezone,'Asia/Shanghai');assert.equal(value.deviceId,deviceId);assert.equal(value.certificateFingerprint,fp);assert.equal(value.source,'boujoy_android_authenticated');assert.equal(value.fresh,true);assert.deepEqual(service.state.data.control,control);assert.equal(fs.readFileSync(service.state.file,'utf8'),original);
 assert.equal(value.edition,DISTRIBUTION.edition);assert.equal(value.androidApplicationId,ANDROID_PACKAGE);
 const other=DISTRIBUTION.edition==='xiaomi'?'phoneuse':'xiaomi';
 for(const identity of [{edition:undefined,androidApplicationId:undefined},{edition:other,androidApplicationId:'dev.boujoy.'+other},{edition:DISTRIBUTION.edition,androidApplicationId:'dev.boujoy.personalagent'}]){
  const rejected=await send({...payload,...identity});assert.equal(rejected.status,409);assert.equal(rejected.body.error.code,'edition_mismatch');assert.equal(phone.remoteDeviceTelemetry(),null,'identity mismatch invalidates the prior telemetry');assert.deepEqual(service.state.data.control,control);
  assert.equal(fs.readFileSync(service.state.file,'utf8'),original);assert.equal((await send(payload)).status,200);clock=Date.now();
 }
 const buildPayload={...payload,apkSha256:'a'.repeat(64),versionCode:DISTRIBUTION.androidVersionCode,versionName:DISTRIBUTION.androidVersion,secret:'must-not-propagate',build:{edition:other,secret:'must-not-propagate'}};
 assert.equal((await send(buildPayload)).status,200);clock=Date.now();
 const build=phone.remoteDeviceTelemetry().build;assert.deepEqual(build,{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,apkSha256:'a'.repeat(64),versionCode:DISTRIBUTION.androidVersionCode,versionName:DISTRIBUTION.androidVersion});
 assert.equal(JSON.stringify(phone.remoteDeviceTelemetry()).includes('must-not-propagate'),false);
 assert.deepEqual(service.state.data.deviceBuilds[deviceId],{...build,observedAt:payload.observedAt});assert.deepEqual(service.state.data.control,control);
 clock=Date.parse(phone.remoteDeviceTelemetry().receivedAt)+30001;assert.equal(phone.remoteDeviceTelemetry(),null);clock=Date.now();
 connection.controlConnected=false;connectorOptions.onStatus(connection);assert.equal(phone.remoteDeviceTelemetry(),null);connection.controlConnected=true;connectorOptions.onStatus(connection);assert.equal(phone.remoteDeviceTelemetry(),null,'reconnection must not revive previous telemetry');
 await send(payload);clock=Date.now();assert(phone.remoteDeviceTelemetry());phone.remoteMaintenance=true;assert.equal(phone.remoteDeviceTelemetry(),null);phone.remoteMaintenance=false;
 assert.equal((await send({...payload,timezone:'Invalid/Timezone'})).status,400);assert.equal(phone.remoteDeviceTelemetry(),null,'unsupported new zone invalidates older zone evidence');
 await send(payload);clock=Date.now();service.state.revoke(deviceId);assert.equal(phone.remoteDeviceTelemetry(),null);assert.equal((await send(payload)).status,403);
 await service.closeTransport();assert.equal(service.latestDeviceTelemetry,null);assert.equal(phone.remoteDeviceTelemetry(),null);
});
