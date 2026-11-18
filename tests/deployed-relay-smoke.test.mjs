import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {createRelay} from '../src/remote/relay.mjs';
import {hash} from '../src/remote/protocol.mjs';
import {eventually,identities} from './helpers/remote-tls.mjs';

const script=fileURLToPath(new URL('../scripts/verify-deployed-relay.mjs',import.meta.url));
function credentials(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-relay-smoke-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const value={deviceId:randomUUID(),macToken:randomBytes(32).toString('hex'),androidToken:randomBytes(32).toString('hex')},file=path.join(dir,'smoke.json');
  fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});return {dir,file,value};
}
function invoke(args,{env={},onStart}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script,...args],{env:{...process.env,NODE_TLS_REJECT_UNAUTHORIZED:'1',...env},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Smoke CLI did not exit within hard test limit'));},8000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',(code,signal)=>{clearTimeout(timer);try{resolve({code,signal,stdout,stderr,report:JSON.parse(stdout)});}catch{reject(Error('Smoke CLI did not emit one JSON result'));}});
    onStart?.(child);
  });
}
function redacted(result,c){
  assert.equal(result.stderr,'');assert.equal(result.signal,null);
  for(const value of [...Object.values(c.value),c.file])assert.equal((result.stdout+result.stderr).includes(value),false);
  assert.equal(result.stdout.trim().split('\n').length,1);
  assert.equal(typeof result.report.durationMs,'number');
}
async function relay(t,c,routes){
  const server=createRelay({routes:routes??{[c.value.deviceId]:{macTokenHash:hash(c.value.macToken),androidTokenHash:hash(c.value.androidToken)}}});
  const address=await server.listen();t.after(()=>server.close());return {server,url:`ws://127.0.0.1:${address.port}/v1/tunnel`};
}

test('real CLI verifies all four binary streams, both wrong role credentials, and control traffic after a data cut',async t=>{
  const c=credentials(t),r=await relay(t,c);
  const result=await invoke(['--url',r.url,'--credentials',c.file,'--allow-loopback-test','--timeout-ms','5000']);
  redacted(result,c);assert.equal(result.code,0,JSON.stringify(result.report));assert.equal(result.report.ok,true);
  assert.deepEqual(result.report.checks.map(x=>x.name),['authenticated_lanes','chat_round_trip','chat-control_round_trip','phone-data_round_trip','phone-control_round_trip','wrong_mac_credential_rejected','wrong_android_credential_rejected','data_cut_drops_active_stream','chat_control_after_data_cut','phone_control_after_data_cut']);
  assert(result.report.checks.every(x=>x.ok&&Number.isInteger(x.durationMs)));
  await eventually(()=>r.server.wss.clients.size===0&&r.server.lanes.size===0);
});

test('wrong smoke identity cannot produce a successful report and exits by its deadline without leaked peers',async t=>{
  const c=credentials(t),r=await relay(t,c,{});
  const result=await invoke(['--url',r.url,'--credentials',c.file,'--allow-loopback-test','--timeout-ms','1000']);
  redacted(result,c);assert.equal(result.code,1);assert.equal(result.report.ok,false);
  assert.deepEqual(result.report.error,{stage:'authenticated_lanes',code:'deadline_exceeded'});
  assert(result.report.durationMs>=950&&result.report.durationMs<4000);
  await eventually(()=>r.server.wss.clients.size===0&&r.server.lanes.size===0);
});

test('plaintext is rejected by default and the explicit test option never permits a non-loopback URL',async t=>{
  const c=credentials(t),r=await relay(t,c);
  for(const args of [['--url',r.url],['--url','ws://192.168.5.116/v1/tunnel','--allow-loopback-test']]){
    const result=await invoke([...args,'--credentials',c.file]);redacted(result,c);
    assert.equal(result.code,1);assert.equal(result.report.error.code,'relay_url_invalid');
    assert.deepEqual(result.report.checks,[]);
  }
  assert.equal(r.server.wss.clients.size,0);
});

test('global TLS verification bypass is refused before any connection',async t=>{
  const c=credentials(t),r=await relay(t,c);
  const result=await invoke(['--url',r.url,'--credentials',c.file,'--allow-loopback-test'],{env:{NODE_TLS_REJECT_UNAUTHORIZED:'0'}});
  redacted(result,c);assert.equal(result.code,1);assert.equal(result.report.error.code,'tls_validation_disabled');
  assert.equal(r.server.wss.clients.size,0);
});

test('credentials must be a protected absolute regular file with only the three dedicated smoke fields',async t=>{
  const c=credentials(t),linked=path.join(c.dir,'linked.json');fs.symlinkSync(c.file,linked);
  for(const file of ['relative.json',linked]){
    const result=await invoke(['--url','wss://127.0.0.1:1/v1/tunnel','--credentials',file]);redacted(result,c);assert.equal(result.code,1);assert.deepEqual(result.report.checks,[]);
  }
  fs.chmodSync(c.file,0o644);
  const exposed=await invoke(['--url','wss://127.0.0.1:1/v1/tunnel','--credentials',c.file]);redacted(exposed,c);assert.equal(exposed.report.error.code,'credentials_file_unprotected');
  fs.chmodSync(c.file,0o600);fs.writeFileSync(c.file,JSON.stringify({...c.value,productionKey:'not-allowed'}));
  const extra=await invoke(['--url','wss://127.0.0.1:1/v1/tunnel','--credentials',c.file]);redacted(extra,c);assert.equal(extra.report.error.code,'credentials_schema_invalid');
});

test('WSS rejects an untrusted TLS certificate without a trust bypass',async t=>{
  const c=credentials(t),id=identities();t.after(id.cleanup);
  let accepted=0;const server=https.createServer({key:id.server.key,cert:id.server.cert});server.on('secureConnection',()=>accepted++);server.on('tlsClientError',()=>{});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const result=await invoke(['--url',`wss://127.0.0.1:${server.address().port}/v1/tunnel`,'--credentials',c.file,'--timeout-ms','1000']);
  redacted(result,c);assert.equal(result.code,1);assert.equal(result.report.ok,false);assert.equal(accepted,0);
  assert.equal(result.report.error.stage,'authenticated_lanes');
});

test('SIGTERM during an unfinished upgrade aborts cleanly and closes every owned socket',async t=>{
  const c=credentials(t),sockets=new Set(),server=http.createServer();let child,interrupted=false;
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  server.on('upgrade',(_req,socket)=>{
    // An upgraded raw socket belongs to this fixture; consume the peer FIN and
    // close our half without ever completing its WebSocket handshake.
    socket.on('end',()=>socket.destroy());socket.resume();
    if(!interrupted){interrupted=true;child.kill('SIGTERM');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  const result=await invoke(['--url',`ws://127.0.0.1:${server.address().port}/v1/tunnel`,'--credentials',c.file,'--allow-loopback-test','--timeout-ms','5000'],{onStart:value=>{child=value;}});
  redacted(result,c);assert.equal(result.code,1);assert.equal(result.report.error.code,'interrupted');
  await eventually(()=>sockets.size===0);
});
