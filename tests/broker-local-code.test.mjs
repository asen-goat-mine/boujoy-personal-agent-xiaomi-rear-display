import test from 'node:test';
import {NEEDS_SANDBOX_PYTHON} from './helpers/requirements.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Broker,toolsForTask} from '../src/tools/broker.mjs';
import {createTaskContract,initializeTimeline} from '../src/core/task-contract.mjs';
function fixture(t,{failRegistration=false,pauseBeforeRegistration=false}={}){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-broker-python-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));fs.mkdirSync(path.join(dataDir,'artifacts'));
 const prompt='请用 Python 计算 1+1 并生成 result.txt',task={id:'t',source:'user',status:'running',prompt,messages:[{id:'u',role:'user',content:prompt}],quotes:[]};initializeTimeline(task,{budgetMs:60000});task.taskContract=createTaskContract(task);
 const data={tasks:[task],artifacts:[],actions:[],settings:{memoryEnabled:false}},store={data,task(){const runs=path.join(dataDir,'code-runs');if(pauseBeforeRegistration&&fs.readdirSync(path.join(dataDir,'artifacts')).length&&fs.existsSync(runs)&&fs.readdirSync(runs).length===0)task.status='paused';return task;},event(){},transaction(fn){if(failRegistration)throw Error('fixture disk write failure');fn(data);}};
 return {dataDir,task,data,store,broker:new Broker({store,dataDir})};
}
const args={code:'print(1+1)\nopen(OUTPUTS["result.txt"],"w").write("2")',outputNames:['result.txt']};
test('Broker registers real computation outputs and keeps general Python available behind the files permission',{skip:NEEDS_SANDBOX_PYTHON},async t=>{
 const f=fixture(t),result=await f.broker.execute('t','python_run',args),body=JSON.parse(result.content[0].text);assert.equal(body.completed,true);assert.equal(f.data.artifacts.length,1);assert.equal(fs.readFileSync(path.join(f.dataDir,'artifacts',body.artifacts[0].path),'utf8'),'2');assert.equal(f.broker.evidence.get(body.observationId).source,'local_code');assert.ok(toolsForTask(f.task,{store:f.store}).some(tool=>tool.name==='python_run'));
 const phone={...f.task,prompt:'在淘宝点一份牛肉面',messages:[{id:'u2',role:'user',content:'在淘宝点一份牛肉面'}],phoneQuery:{platform:'taobao',query:'牛肉面'}};phone.taskContract=createTaskContract(phone);assert.equal(toolsForTask(phone,{store:f.store}).some(tool=>tool.name==='python_run'),true);
 f.data.settings.filesEnabled=false;
 assert.equal(toolsForTask(phone,{store:f.store}).some(tool=>tool.name==='python_run'),false);
 await assert.rejects(f.broker.execute('t','python_run',args),{code:'execution_disabled'});
 assert.equal(f.data.artifacts.length,1,'disabled execution must not create another output');
});
test('Broker removes only newly unregistered Python outputs when persistence fails or the task pauses after compute',{skip:NEEDS_SANDBOX_PYTHON},async t=>{
 for(const options of [{failRegistration:true},{pauseBeforeRegistration:true}]){
  const f=fixture(t,options);await assert.rejects(f.broker.execute('t','python_run',args));assert.equal(f.data.artifacts.length,0);assert.deepEqual(fs.readdirSync(path.join(f.dataDir,'artifacts')),[]);assert.deepEqual(fs.readdirSync(path.join(f.dataDir,'code-runs')),[]);
 }
});
test('failed code exposes its failure without a successful computation evidence or registered output',{skip:NEEDS_SANDBOX_PYTHON},async t=>{
 const f=fixture(t),result=await f.broker.execute('t','python_run',{...args,code:'raise ValueError("fixture failure")'}),body=JSON.parse(result.content[0].text);assert.equal(body.completed,false);assert.equal(body.observationId,undefined);assert.equal(f.data.artifacts.length,0);assert.equal(f.broker.evidence.size,0);
});
