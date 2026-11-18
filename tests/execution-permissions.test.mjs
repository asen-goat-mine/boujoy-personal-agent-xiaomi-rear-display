import test from 'node:test';
import {NEEDS_SANDBOX_PYTHON} from './helpers/requirements.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store,initialState,fenceRecoveredState} from '../src/core/store.mjs';
import {createTaskContract,initializeTimeline} from '../src/core/task-contract.mjs';
import {assertExecutionPermission,withExecutionPermission,setExecutionPermissions,toolExecutionDomains} from '../src/core/execution-permissions.mjs';
import {Broker,toolsForTask} from '../src/tools/broker.mjs';
import {PhoneUseDriver} from '../src/adapters/phoneuse-driver.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(t,prompt='请计算并生成报告文件'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-execution-permissions-')),store=new Store(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const task={id:'t',source:'user',status:'running',prompt,messages:[{id:'u',role:'user',content:prompt}],quotes:[],children:[],events:[],roleId:'work'};initializeTimeline(task,{budgetMs:60000});task.taskContract=createTaskContract(task);store.transaction(s=>{s.tasks.push(task);s.settings.phoneEnabled=true;});
 return {dir,store,task:()=>store.task('t')};
}
test('independent persisted defaults migrate; recovery fences all three domains and never enables them when acknowledged',async t=>{
 const defaults=initialState();assert.equal(defaults.settings.browserEnabled,true);assert.equal(defaults.settings.filesEnabled,true);assert.equal(defaults.settings.phoneEnabled,false);
 const x=setup(t);x.store.transaction(s=>{delete s.settings.browserEnabled;delete s.settings.filesEnabled;delete s.settings.executionEpochs;});x.store.close();const reopened=new Store(x.dir);t.after(()=>reopened.close());assert.equal(reopened.data.settings.browserEnabled,true);assert.equal(reopened.data.settings.filesEnabled,true);
 reopened.transaction(s=>fenceRecoveredState(s,{id:'f',required:true}));for(const domain of ['browser','files','phone'])assert.throws(()=>assertExecutionPermission(reopened,[domain]),{code:'execution_disabled'});
 await assert.rejects(setExecutionPermissions({store:reopened},{filesEnabled:true}),{code:'recovery_fenced'});reopened.transaction(s=>s.recoveryFence.required=false);for(const domain of ['browser','files','phone'])assert.throws(()=>assertExecutionPermission(reopened,[domain]),{code:'execution_disabled'});
 assert.equal(reopened.task('t').status,'paused');
});
test('disable pauses only tasks using its domain and keeps unknown receipts; enable never resumes them',async t=>{
 const x=setup(t);x.store.transaction(s=>{s.tasks[0].executionDomains=['files'];s.tasks.push({...s.tasks[0],id:'b',executionDomains:['browser']},{...s.tasks[0],id:'p',executionDomains:['phone']});s.actions.push({id:'old',taskId:'t',tool:'artifact_write',status:'unknown',nativeRequestId:'original'});});
 const paused=[],closed=[];const engine={stop:async(id)=>{paused.push(id);x.store.updateTask(id,t=>t.status=id==='t'?'unknown_result':'paused');}};
 await setExecutionPermissions({store:x.store,engine,browser:{close:async()=>closed.push('browser')},phone:{close:async()=>closed.push('phone')}},{filesEnabled:false});assert.deepEqual(paused,['t']);assert.deepEqual(closed,[]);assert.equal(x.store.task('b').status,'running');assert.equal(x.store.task('p').status,'running');assert.equal(x.store.data.actions[0].status,'unknown');assert.equal(x.store.data.actions[0].nativeRequestId,'original');
 await setExecutionPermissions({store:x.store,engine},{filesEnabled:true});assert.equal(x.task().status,'unknown_result');assert.equal(x.store.data.settings.executionEpochs.files,2);
});
test('off then on invalidates the pinned permit across awaits and new independent work still runs',async t=>{
 const x=setup(t),wait=deferred(),began=deferred();let continued=false;
 const pending=withExecutionPermission(x.store,['files'],'t',async()=>{began.resolve();await wait.promise;assertExecutionPermission(x.store,['files']);continued=true;});await began.promise;
 await setExecutionPermissions({store:x.store},{filesEnabled:false});await setExecutionPermissions({store:x.store},{filesEnabled:true});wait.resolve();await assert.rejects(pending,{code:'execution_revoked'});assert.equal(continued,false);
 assert.equal(await withExecutionPermission(x.store,['browser'],null,async()=>7),7);assert.equal(await withExecutionPermission(x.store,['files'],null,async()=>8),8);
});
test('Broker blocks real file tools before IO and hides disabled domain tools but preserves reporting',async t=>{
 const x=setup(t),broker=new Broker({store:x.store,dataDir:x.dir});await setExecutionPermissions({store:x.store},{filesEnabled:false,browserEnabled:false,phoneEnabled:false});
 await assert.rejects(broker.execute('t','artifact_write',{name:'result.txt',content:'not written'}),e=>e.code==='execution_disabled'&&e.dispatchState==='not_sent');assert.equal(fs.existsSync(path.join(x.dir,'artifacts')),false);
 const names=toolsForTask(x.task(),{store:x.store}).map(tool=>tool.name);assert(names.includes('task_context'));assert(names.includes('finish_task'));for(const name of names)assert.deepEqual(toolExecutionDomains(name,x.task()),[]);
});
test('a response arriving after a dispatched action was revoked stays unknown and keeps its original evidence',async t=>{
 const x=setup(t),broker=new Broker({store:x.store,approvals:{request:async()=>{}}}),wait=deferred(),began=deferred();broker.evidence.set('o',{taskId:'t'});
 const pending=withExecutionPermission(x.store,['browser'],'t',()=>broker.action('t','browser_action',{observationId:'o',reason:'actual requested action'},null,async()=>{began.resolve();await wait.promise;return {accepted:true};}));await began.promise;
 await setExecutionPermissions({store:x.store},{browserEnabled:false});wait.resolve();await assert.rejects(pending,{code:'execution_disabled'});const record=x.store.data.actions[0];assert.equal(record.status,'unknown');assert.equal(record.observationId,'o');assert.equal(x.task().status,'unknown_result');assert.equal(record.verification,'pending');
});
test('actual driver protocol calls reject disabled and suppress late responses after re-enabling',async t=>{
 const x=setup(t),wait=deferred(),began=deferred();let calls=0;const driver=new PhoneUseDriver({client:{call:async()=>{calls++;began.resolve();await wait.promise;return {ok:true};}}});driver.executionStore=x.store;
 const pending=driver.request('d','get_status',{});await began.promise;await setExecutionPermissions({store:x.store},{phoneEnabled:false});await setExecutionPermissions({store:x.store},{phoneEnabled:true});wait.resolve();await assert.rejects(pending,{code:'execution_revoked'});assert.equal(calls,1);
 await setExecutionPermissions({store:x.store},{phoneEnabled:false});await assert.rejects(driver.request('d','get_status',{}),e=>e.code==='execution_disabled'&&e.dispatchState==='not_sent');assert.equal(calls,1);
});

test('Office output completing after file revocation is neither registered nor left as an orphan',async t=>{
 const x=setup(t),broker=new Broker({store:x.store,dataDir:x.dir});
 const pending=broker.execute('t','document_create',{format:'docx',name:'report.docx',title:'权限回归',content:{sections:[{heading:'检查',paragraphs:['此文件不能在撤销后登记。']}]}});await setExecutionPermissions({store:x.store},{filesEnabled:false});await assert.rejects(pending,e=>['execution_disabled','execution_revoked'].includes(e.code));assert.equal(x.store.data.artifacts.length,0);
 const root=path.join(x.dir,'artifacts'),files=fs.existsSync(root)?fs.readdirSync(root,{recursive:true}).filter(file=>fs.statSync(path.join(root,file)).isFile()):[];assert.deepEqual(files,[]);
});
test('actual sandboxed Python computation revoked while running cannot publish its declared file',{skip:NEEDS_SANDBOX_PYTHON},async t=>{
 const x=setup(t),broker=new Broker({store:x.store,dataDir:x.dir});
 const pending=broker.execute('t','python_run',{code:'import time\nopen(OUTPUTS["result.txt"],"w").write("started")\ntime.sleep(0.3)\nopen(OUTPUTS["result.txt"],"w").write("2")',outputNames:['result.txt']});
 const runs=path.join(x.dir,'code-runs');let started=false;for(let i=0;i<200&&!started;i++){if(fs.existsSync(runs))for(const run of fs.readdirSync(runs)){const output=path.join(runs,run,'output-0');if(fs.existsSync(output)&&fs.readFileSync(output,'utf8')==='started')started=true;}if(!started)await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(started,true,'actual sandbox worker reached its declared output');
 await setExecutionPermissions({store:x.store},{filesEnabled:false});await assert.rejects(pending,e=>['execution_disabled','execution_revoked'].includes(e.code));assert.equal(x.store.data.artifacts.length,0);
 const root=path.join(x.dir,'artifacts'),files=fs.existsSync(root)?fs.readdirSync(root,{recursive:true}).filter(file=>fs.statSync(path.join(root,file)).isFile()):[];assert.deepEqual(files,[]);
});

test('re-saving a disabled switch is idempotent and does not disrupt manual phone pairing',async t=>{
 const x=setup(t);await setExecutionPermissions({store:x.store},{phoneEnabled:false});let closed=0;const epoch=x.store.data.settings.executionEpochs.phone;
 const result=await setExecutionPermissions({store:x.store,phone:{close:async()=>closed++}},{phoneEnabled:false,filesEnabled:true});assert.equal(closed,0);assert.deepEqual(result.revokedDomains,[]);assert.equal(x.store.data.settings.executionEpochs.phone,epoch);
});


test('file revocation stops background agents even when their owning task has expired',async t=>{
 const x=setup(t);x.store.updateTask('t',row=>{row.status='expired';row.executionDomains=['files'];});let stopped=0;
 const result=await setExecutionPermissions({store:x.store,engine:{broker:{localAgents:{cancelAll(){stopped++;}}},stop(){throw Error('expired tasks have no active execution slot');}}},{filesEnabled:false});
 assert.equal(stopped,1);assert.deepEqual(result.pausedTaskIds,[]);assert.equal(x.task().status,'expired');
});
