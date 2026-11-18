import {ANDROID_PACKAGE} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const ROOT=path.resolve(import.meta.dirname,'..');
async function fixture(t,{paused=false,status='typed'}={}){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-local-typing-')),data=path.join(base,'runtime'),vault=path.join(base,'vault');fs.mkdirSync(vault);
 const preload=path.join(base,'isolated-phone.mjs'),url=file=>JSON.stringify(pathToFileURL(path.join(ROOT,file)).href);
 // The actual HTTP auth/route, RemoteService pause gate and PhoneTyping queue
 // run unchanged. Only the bound phone acknowledgement and secret store are synthetic.
 fs.writeFileSync(preload,`import fs from 'node:fs';import path from 'node:path';
 import {ANDROID_PACKAGE} from ${url('src/distribution.mjs')};
 import {Secrets} from ${url('src/adapters/secrets.mjs')};
 import {RemoteService} from ${url('src/remote/service.mjs')};
 import {PhoneTyping} from ${url('src/remote/phone-typing.mjs')};
 Secrets.prototype.get=async()=>'';
 const base=${JSON.stringify(base)},deviceId='isolated-bound-phone',receiptStatus=${JSON.stringify(status)};
 RemoteService.prototype.start=async function(){
  this.state.update(s=>{s.control={paused:${paused},controlEpoch:31,...(${paused}?{reason:'user_stop'}:{})};s.devices={synthetic:{id:deviceId,active:true}};});
  const typing=new PhoneTyping({timeoutMs:500,pollMs:400}),request=typing.request.bind(typing);
  typing.request=input=>{fs.appendFileSync(path.join(base,'calls'),JSON.stringify(input)+'\\n');const result=request(input);queueMicrotask(async()=>{const job=await typing.wait(deviceId);if(job)typing.complete(deviceId,job.id,job.packageName===ANDROID_PACKAGE?receiptStatus:'unfocused',job.packageName!==ANDROID_PACKAGE?'focus_missing':receiptStatus==='typed'?'readback_verified':'readback_unavailable');});return result;};
  this.gateway={typing,close:async()=>{}};return this.status();
 };
 `);
 const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
 const child=spawn(process.execPath,['--import',preload,'src/server.mjs'],{cwd:ROOT,env:{...process.env,BOUJOY_DATA:data,BOUJOY_PORT:String(port),BOUJOY_MEMORY_VAULT:vault},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 t.after(async()=>{child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill('SIGKILL');resolve();},1500).unref();});fs.rmSync(base,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${port}`;let ready=false;
 for(let i=0;i<150;i++){try{if((await fetch(origin)).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,20));}assert.ok(ready,output);
 const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie').split(';')[0],{csrf}=await session.json();const headers={Cookie:cookie,'Content-Type':'application/json','x-boujoy-csrf':csrf};
 const call=async(value,override={})=>{const response=await fetch(origin+'/api/phone/type',{method:'POST',headers:{...headers,...override},body:JSON.stringify(value)});return {status:response.status,body:await response.json()};};
 const calls=()=>fs.existsSync(path.join(base,'calls'))?fs.readFileSync(path.join(base,'calls'),'utf8').trim().split('\n').map(JSON.parse):[];
 return {origin,call,calls,data};
}

test('manual phone typing HTTP forwards the explicit editor package without bypassing local authentication',async t=>{
 const f=await fixture(t),input={text:'真实手机输入框中的合成测试',packageName:ANDROID_PACKAGE};
 assert.equal((await f.call(input,{Cookie:''})).status,401);assert.equal((await f.call(input,{'x-boujoy-csrf':'invalid'})).status,403);assert.equal(f.calls().length,0);
 const result=await f.call(input);assert.equal(result.status,200);assert.equal(result.body.status,'typed');assert.equal(result.body.diagnostic,'readback_verified');
 assert.deepEqual(f.calls(),[{deviceId:'isolated-bound-phone',text:input.text,mode:'replace',packageName:input.packageName}]);
 const wrongFocus=await f.call({...input,packageName:'com.example.other'});assert.equal(wrongFocus.body.status,'unfocused');assert.equal(wrongFocus.body.diagnostic,'focus_missing');assert.equal(f.calls().length,2);
});

test('manual phone typing rejects absent or malformed targets before queueing any phone input',async t=>{
 const f=await fixture(t);
 for(const packageName of [undefined,null,'','dev','dev.boujoy personalagent','dev..boujoy','dev.boujoy\n','a.'.repeat(150)+'b',{},42]){
  const result=await f.call({text:'must not dispatch',packageName});assert.equal(result.status,400);assert.equal(result.body.error.code,'phone_input_unavailable');
 }
 assert.equal(f.calls().length,0);
});

test('manual phone typing keeps the existing user pause gate and control generation unchanged',async t=>{
 const f=await fixture(t,{paused:true}),before=JSON.parse(fs.readFileSync(path.join(f.data,'remote/state.json'))).control;
 const result=await f.call({text:'must remain paused',packageName:ANDROID_PACKAGE});assert.equal(result.status,409);assert.equal(result.body.error.code,'phone_input_unavailable');assert.equal(f.calls().length,0);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.data,'remote/state.json'))).control,before);
});

test('manual phone typing returns an unverified submitted receipt once without replay or false success',async t=>{
 const f=await fixture(t,{status:'submitted'}),result=await f.call({text:'unknown commit must not repeat',mode:'insert',packageName:ANDROID_PACKAGE});
 assert.equal(result.status,200);assert.equal(result.body.status,'submitted');assert.equal(result.body.diagnostic,'readback_unavailable');assert.equal(f.calls().length,1);
});
