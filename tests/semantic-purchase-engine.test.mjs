import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {validateTaskContract} from '../src/core/task-contract.mjs';
test('purchase planning is requested by the executor and never becomes submit authority',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'semantic-engine-')),store=new Store(dir);let seen;
 const broker={calls:new Map(),approvals:{cancelTask(){}},phone:{release(){},close(){}},browser:{close(){}},allToolNames:()=>[]};
 const engine=new Engine({store,broker,secrets:{get:async()=>'synthetic'},memory:{},runFactory:options=>({async start(){await engine.preparePurchase(options.task.id);seen=structuredClone(store.task(options.task.id));store.updateTask(options.task.id,row=>{row.report={outcome:'blocked',summary:'合成执行器不操作手机',evidence:[]};});},async dispose(){},async stop(){}})});
 engine.interpretPurchase=async task=>({kind:'purchase',platform:'taobao',query:'水果',quantity:1,maxTotalFen:2000,purchaseChannel:'delivery',allowTopUp:true,sourceQuotes:[task.prompt]});
 t.after(async()=>{await engine.shutdown();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const task=engine.create({prompt:'去淘宝搞点水果吃吃 点外卖 20块预算你看着配',cloudConsent:true});await engine.pump();await engine.active.get(task.id)?.completion;
 assert.ok(seen);assert.deepEqual(seen.phoneQuery,{platform:'taobao',query:'水果'});assert.ok(seen.taskContract.effects.includes('prepare_purchase'));assert.ok(!seen.taskContract.effects.includes('submit_order'));assert.equal(validateTaskContract(seen).valid,true);
});

test('ordinary tasks start without a purchase model request; plan failure remains a recoverable tool error',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'semantic-engine-')),store=new Store(dir);let starts=0,calls=0;
 const broker={calls:new Map(),approvals:{cancelTask(){}},phone:{release(){},close(){}},browser:{close(){}},allToolNames:()=>[]};
 const engine=new Engine({store,broker,secrets:{get:async()=>'synthetic'},memory:{},runFactory:options=>({async start(){starts++;if(options.task.prompt==='test planning'){await assert.rejects(engine.preparePurchase(options.task.id),e=>e.code==='purchase_plan_failed');assert.equal(store.task(options.task.id).status,'running');}store.updateTask(options.task.id,row=>{row.report={outcome:'completed',summary:'executor remains usable',evidence:[]};});},async dispose(){},async stop(){}})});
 engine.interpretPurchase=async()=>{calls++;throw Error('raw failure must not leak');};
 t.after(async()=>{await engine.shutdown();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 for(const prompt of ['解释一个概念','整理表格','test planning']){const task=engine.create({prompt,cloudConsent:true});await engine.pump();await engine.active.get(task.id)?.completion;assert.equal(store.task(task.id).status,'completed');}
 assert.equal(starts,3);assert.equal(calls,1);
});
