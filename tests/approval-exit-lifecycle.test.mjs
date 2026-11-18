import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {Approvals} from '../src/core/approvals.mjs';
import {approvalView} from '../src/core/approval-view.mjs';
import {Broker} from '../src/tools/broker.mjs';

const ROOT=path.resolve(import.meta.dirname,'..');
async function eventually(predicate,message='fixture did not reach barrier'){
 for(let i=0;i<150;i++){const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,20));}
 throw Error(message);
}
function agentFixture(t){
 const fixtureRoot=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-approval-agent-'));t.mock.method(os,'homedir',()=>fixtureRoot);
 const store=new Store(path.join(fixtureRoot,'data')),approvals=new Approvals(store),controller=new AbortController();
 const broker=new Broker({store,approvals,browser:{},phone:null,memory:{},dataDir:path.join(fixtureRoot,'data')});
 const engine=new Engine({store,broker,secrets:{get:async()=>''},memory:{}});
 const task=engine.newTask({prompt:'让 Codex 修复这个测试',cloudConsent:true});task.status='running';store.transaction(s=>s.tasks.push(task));
 const active={taskId:task.id,controller};engine.active.set(task.id,active);
 broker._agentDirectory={at:Date.now(),value:{agents:[{id:'fixture',name:'Fixture',callable:true,readOnlySupported:true,bin:'/never-execute-fixture'}]}};
 const starts=[];broker._localAgents={start(input){starts.push(input);return {jobId:'synthetic-job',mode:input.mode};}};
 t.after(()=>{approvals.cancelTask(task.id);store.close();fs.rmSync(fixtureRoot,{recursive:true,force:true});});
 return {store,approvals,controller,engine,task,starts,async pending(){const result=broker.executeTool(task.id,'agent_run',{agent:'fixture',prompt:'synthetic only',write:true},controller.signal);await eventually(()=>approvals.waiters.size===1);return {result,id:store.data.approvals.at(-1).id};}};
}
for(const change of ['stop','replace','permission'])test(`agent_run revalidates ${change} at the actual spawn boundary after approval resumes`,async t=>{
 const f=agentFixture(t),{result,id}=await f.pending();f.approvals.resolve(id,true);
 // The inner Approvals await resumes first; this stop runs before the Broker
 // caller resumes. No native process is launched: only start is observed.
 queueMicrotask(()=>{if(change==='stop'){f.store.updateTask(f.task.id,row=>{row.status='paused';});f.controller.abort();}else if(change==='replace')f.engine.active.set(f.task.id,{taskId:f.task.id,controller:new AbortController()});else f.store.transaction(s=>{s.settings.filesEnabled=false;});});
 await assert.rejects(result,error=>['cancelled','execution_disabled'].includes(error.code));assert.equal(f.starts.length,0);
});
test('an unchanged approval still starts exactly one selected agent',async t=>{
 const f=agentFixture(t),{result,id}=await f.pending();f.approvals.resolve(id,true);await result;assert.equal(f.starts.length,1);assert.equal(f.starts[0].mode,'write');
});

async function nativeFixture(t){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-native-exit-')),data=path.join(base,'data'),vault=path.join(base,'vault');fs.mkdirSync(vault);
 const preload=path.join(base,'isolate.mjs'),url=file=>JSON.stringify(pathToFileURL(path.join(ROOT,file)).href);
 fs.writeFileSync(preload,`import fs from 'node:fs';import path from 'node:path';
 import {Secrets} from ${url('src/adapters/secrets.mjs')};import {HarnessRun} from ${url('src/adapters/harness.mjs')};
 import {Engine} from ${url('src/core/engine.mjs')};import {Approvals} from ${url('src/core/approvals.mjs')};
 import {PersonalMemory} from ${url('src/adapters/memory.mjs')};import {MacPower} from ${url('src/adapters/mac-power.mjs')};
 const base=${JSON.stringify(base)},keys=new Map(),running=new Map();
 Secrets.prototype.get=async function(name){return name==='deepseek'?'synthetic-isolated-key':keys.get(name)||'';};Secrets.prototype.set=async function(name,value){keys.set(name,value);};Secrets.prototype.remove=async function(name){keys.delete(name);};
 PersonalMemory.prototype.start=async function(){};MacPower.prototype.setEnabled=function(){return this.status();};
 HarnessRun.prototype.start=async function(){fs.writeFileSync(path.join(base,this.task.id+'.runtime'),this.token);return await new Promise(resolve=>this.testResolve=resolve);};HarnessRun.prototype.stop=async function(){this.testResolve?.();};HarnessRun.prototype.dispose=async function(){};
 const authorize=Engine.prototype.authorizeRuntime;Engine.prototype.authorizeRuntime=function(active){const result=authorize.call(this,active);running.set(active.taskId,{active,engine:this});fs.appendFileSync(path.join(base,active.taskId+'.auth-count'),'x');return result;};
 const resolve=Approvals.prototype.resolve;Approvals.prototype.resolve=function(id,allow){const row=this.store.data.approvals.find(a=>a.id===id);resolve.call(this,id,allow);if(!allow||!['stop-at-exit','replace-at-exit'].includes(row.summary))return;queueMicrotask(()=>{const {active,engine}=running.get(row.taskId);if(row.summary==='stop-at-exit'){this.store.updateTask(row.taskId,t=>{t.status='paused';});active.controller.abort();}else engine.tokens.set(active.token,{...active,controller:new AbortController()});});};
 const localFetch=globalThis.fetch;globalThis.fetch=async function(url,init){const address=new URL(String(url));if(address.protocol==='http:'&&address.hostname==='127.0.0.1')return localFetch(url,init);if(String(url)!=='https://api.deepseek.com/anthropic/v1/messages')throw Error('External network blocked by fixture');return new Response(JSON.stringify({type:'message',content:[{type:'text',text:JSON.stringify({kind:'other'})}],usage:{input_tokens:0,output_tokens:0}}),{headers:{'content-type':'application/json'}});};
 `,{mode:0o600});
 const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 const child=spawn(process.execPath,['--import',preload,'src/server.mjs'],{cwd:ROOT,env:{...process.env,BOUJOY_PORT:String(port),BOUJOY_DATA:data,BOUJOY_MEMORY_VAULT:vault},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 t.after(async()=>{child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill('SIGKILL');resolve();},1500).unref();});fs.rmSync(base,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${port}`;await eventually(async()=>{try{return (await fetch(origin)).ok;}catch{return false;}},'isolated HTTP server unavailable: '+output);
 const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie').split(';')[0],{csrf}=await session.json();
 const call=async(route,value)=>{const r=await fetch(origin+route,{method:value===undefined?'GET':'POST',headers:{Cookie:cookie,'Content-Type':'application/json','x-boujoy-csrf':csrf},...(value===undefined?{}:{body:JSON.stringify(value)})});return {status:r.status,body:await r.json()};};
 const startTask=async()=>{const created=await call('/api/tasks',{prompt:'解释测试流程',cloudConsent:true,memoryConsent:false,memoryMode:'do_not_remember'});assert.equal(created.status,201);const taskId=created.body.id,token=await eventually(()=>fs.existsSync(path.join(base,taskId+'.runtime'))&&fs.readFileSync(path.join(base,taskId+'.runtime'),'utf8'));return {taskId,token};};
 return {async partialAuthorize(){
  const {taskId,token}=await startTask(),countFile=path.join(base,taskId+'.auth-count'),count=()=>fs.existsSync(countFile)?fs.statSync(countFile).size:0,before=count();let pendingRequest;
  const response=new Promise((resolve,reject)=>{pendingRequest=http.request({hostname:'127.0.0.1',port,path:'/internal/harness/native-authorize',method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))});}catch(error){reject(error);}});});pendingRequest.on('error',reject);pendingRequest.write('{"tool":');});
  t.after(()=>pendingRequest.destroy());
  // Harness is parked in its stub. This counter can advance only when the
  // real native route authorizes the token before awaiting the incomplete body.
  await eventually(()=>count()>before,'native route did not enter body read');
  return {async finish(){pendingRequest.end('"bash"}');return response;},async stop(){assert.equal((await call('/api/tasks/'+taskId+'/stop',{})).status,200);}};
 },async approval(summary,args={command:'synthetic-no-execution'}){const {taskId,token}=await startTask();
 const response=fetch(origin+'/internal/harness/approval',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({tool:'bash',args,summary,sessionId:'fixture',callId:'fixture'})}).then(async r=>({status:r.status,body:await r.json()}));
 const row=await eventually(()=>{const state=JSON.parse(fs.readFileSync(path.join(data,'state.json'),'utf8'));return state.approvals.find(a=>a.taskId===taskId&&a.status==='pending');});return {row,response,async allow(){assert.equal((await call('/api/approvals/'+row.id,{allow:true})).status,200);},async stop(){await call('/api/tasks/'+taskId+'/stop',{});}};}};
}
test('real native approval HTTP exit rejects a stop and replacement queued between its two awaits',async t=>{
 const f=await nativeFixture(t);
 for(const change of ['stop-at-exit','replace-at-exit']){const pending=await f.approval(change);await pending.allow();const response=await pending.response;assert.notEqual(response.body.outcome,'allowed-once',change);assert.ok(response.body.outcome==='cancelled'||response.body.error?.code==='runtime_unauthorized',JSON.stringify(response));await pending.stop();}
 const live=await f.approval('live-at-exit');await live.allow();assert.equal((await live.response).body.outcome,'allowed-once');await live.stop();
});
test('native approval records the real tool even when arguments contain nativeTool',async t=>{
 const f=await nativeFixture(t),pending=await f.approval('live-at-exit',{nativeTool:'read',command:'synthetic-only'});
 try{assert.equal(pending.row.args.nativeTool,'bash');assert.deepEqual(approvalView(pending.row).details.find(row=>row.label==='执行工具'),{label:'执行工具',value:'bash'});await pending.allow();assert.equal((await pending.response).body.outcome,'allowed-once');}finally{await pending.stop();await pending.response;}
});

// Stop goes through the actual API while a real HTTP request body is open.
test('native authorize rechecks a task stopped while reading its request body',async t=>{
 const f=await nativeFixture(t),stopped=await f.partialAuthorize();await stopped.stop();const rejected=await stopped.finish();
 assert.notEqual(rejected.body.allowed,true,JSON.stringify(rejected));assert.ok(['cancelled','runtime_unauthorized'].includes(rejected.body.error?.code));
 const live=await f.partialAuthorize();try{const allowed=await live.finish();assert.equal(allowed.status,200);assert.equal(allowed.body.allowed,true);}finally{await live.stop();}
});
