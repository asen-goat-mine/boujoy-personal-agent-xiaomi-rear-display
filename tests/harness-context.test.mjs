import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {harnessRoleContext,harnessTaskContext,harnessToolDefinitions} from '../src/core/harness-context.mjs';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {Broker,TOOL_DEFINITIONS} from '../src/tools/broker.mjs';
test('direct context omits generated restrictions while preserving user requirements and disabled capabilities',()=>{
 const task={source:'user',prompt:'读完后删除我指定的草稿',taskContract:{effects:['read'],allowedApps:[]},messages:[],deadlineAt:'deadline'};
 const p=harnessTaskContext({task,settings:{phoneEnabled:false},history:'用户：只删指定草稿，保留其他文件',inputArtifacts:[]});
 assert.match(p,/只删指定草稿/);assert.match(p,/"phoneEnabled":false/);assert.doesNotMatch(p,/allowedApps|taskContract|付款前交接计划/);
 const role={name:'助手',instruction:'不代为付款'};
 assert.doesNotMatch(harnessRoleContext(task,role),/不代为付款/);
 assert.match(harnessRoleContext({source:'watch'},role),/不代为付款/);
 assert.equal(role.instruction,'不代为付款');
});
test('actual Broker catalog replaces legacy handoff descriptions without mutating shared definitions',()=>{
 const store={data:{settings:{},tasks:[],roles:[]}},b=new Broker({store});
 const task={id:'t',source:'user',kind:'general',prompt:'去淘宝挑商品',messages:[],taskContract:{intent:'task',effects:['read','navigate'],allowedApps:['淘宝']}};
 const defs=b.catalog(task);const finish=defs.find(d=>d.name==='finish_task');assert.ok(finish);assert.doesNotMatch(finish.description,/到确认订单页就 ready_for_user/);assert.match(finish.description,/由你判断任务终点/);
 const chat=b.catalog({...task,taskContract:{intent:'conversation',effects:[],allowedApps:[]}});assert.ok(chat.some(d=>d.name==='phone_use'));
 assert.doesNotMatch(chat.find(d=>d.name==='task_context').description,/任务契约限制/);
 assert.match(TOOL_DEFINITIONS.find(d=>d.name==='finish_task').description,/到确认订单页就 ready_for_user/);
 assert.equal(harnessToolDefinitions({source:'watch'},TOOL_DEFINITIONS),TOOL_DEFINITIONS);
});
test('Engine sends clean direct-user prompt to Harness run factory',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harness-context-')),store=new Store(dir);let captured;
 const broker={calls:new Map(),approvals:{cancelTask(){}},phone:{release(){},close(){}},browser:{close(){}},allToolNames:()=>[]};
 const engine=new Engine({store,broker,secrets:{get:async()=>'synthetic'},memory:{},runFactory:o=>({async start(){captured=o.prompt;store.updateTask(o.task.id,row=>{row.report={outcome:'completed',summary:'synthetic',evidence:[]};});},async dispose(){},async stop(){}})});
 t.after(async()=>{await engine.shutdown();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const task=engine.create({prompt:'核对购物清单，按我的要求决定在哪一步交接',cloudConsent:true});await engine.pump();await engine.active.get(task.id)?.completion;
 assert.ok(captured);assert.match(captured,/当前用户要求：核对购物清单/);
 assert.doesNotMatch(captured,/本轮任务契约|本轮付款前交接计划|仅当前任务的原始用户要求及契约|不代为付款/);
});
test('work the user asked for is model-led, subtasks included; routines and their subtasks keep the rule path',async()=>{
 const {isHarnessTask,isUserOrigin}=await import('../src/core/harness-context.mjs');
 const {generalAppGrant}=await import('../src/adapters/phone-general-navigation.mjs');
 const base={id:'t',status:'running',messages:[{id:'m',role:'user',content:'打开微信看看'}]};
 assert.equal(isHarnessTask({source:'user'}),true);
 assert.equal(isHarnessTask({source:'delegation',originSource:'user',parentId:'p'}),true);
 assert.equal(isHarnessTask({source:'delegation',originSource:'routine',parentId:'p'}),false);
 assert.equal(isHarnessTask({source:'delegation',parentId:'p'}),false);
 assert.equal(isHarnessTask({source:'routine'}),false);assert.equal(isUserOrigin({source:'watch'}),false);
 const grant=generalAppGrant({...base,source:'delegation',originSource:'user',parentId:'p',depth:1},{packageName:'com.tencent.mm',label:'微信'});
 assert.equal(grant.mode,'general');assert.equal(grant.decisionOwner,'harness');
 assert.equal(generalAppGrant({...base,source:'delegation',originSource:'routine',parentId:'p',depth:1},{packageName:'com.tencent.mm',label:'微信'}),null);
});
