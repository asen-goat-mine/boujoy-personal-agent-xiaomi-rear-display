import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {WorkflowLibrary} from '../src/core/workflows.mjs';
import {createDocumentArtifact} from '../src/tools/documents.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const draft={name:'主题报告',description:'读取实际报告核实主题。',parameters:[{name:'topic',type:'string',description:'本轮主题',sourceField:'content'}],steps:[{instruction:'创建 {{topic}} 报告',preconditions:['用户提供主题'],postconditions:['报告包含 {{topic}}'],verify:{kind:'artifact',format:'docx'}}],preconditions:['用户授权'],postconditions:['报告包含主题']};
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-workflow-revoke-')),store=new Store(dir);
 const broker={calls:new Map(),approvals:{cancelTask(){}},phone:{release(){}}},engine=new Engine({store,broker,memory:{},secrets:{get:async()=>null}});engine.pump=async()=>{};
 const library=new WorkflowLibrary({store,root:path.join(dir,'workflows'),dataDir:dir});broker.workflows=library;
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const task=engine.create({prompt:'创建一份报告，主题为“网络排障”',cloudConsent:true,memoryConsent:true});store.updateTask(task.id,row=>row.status='running');
 const card=library.createDraft(draft,{sourceTaskId:task.id,sourceMessageId:task.messages[0].id});library.instantiate(card.id,{taskId:task.id,messageId:task.messages[0].id,parameters:{topic:'网络排障'}});
 const artifact=await createDocumentArtifact({taskId:task.id,dataDir:dir,args:{format:'docx',name:'报告',title:'网络排障',content:{sections:[{paragraphs:['网络排障']}]}}});
 store.transaction(state=>state.artifacts.push(artifact));store.updateTask(task.id,row=>row.report={outcome:'completed',summary:'完成实际报告',evidence:[artifact.id]});
 const file=library.file(card.id),before=fs.readFileSync(file,'utf8');
 return {store,engine,library,task,card,file,before};
}
test('completed task background workflow verification does not read or write after files were disabled',async t=>{
 const f=await fixture(t);let calls=0;const original=f.library.recordTaskOutcomes.bind(f.library);f.library.recordTaskOutcomes=(...args)=>{calls++;return original(...args);};
 f.store.transaction(state=>{state.settings.filesEnabled=false;state.settings.executionEpochs.files++;});
 f.engine.finishReport(f.task.id);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.store.task(f.task.id).status,'completed');assert.equal(calls,0);assert.equal(fs.readFileSync(f.file,'utf8'),f.before);
});
for(const reenable of [false,true])test(`actual OOXML workflow evidence cannot commit after file permission revocation${reenable?' and re-enable':''}`,async t=>{
 const f=await fixture(t),entered=deferred(),gate=deferred(),settled=deferred();t.after(()=>gate.resolve());
 const proof=f.library.artifactProof.bind(f.library);f.library.artifactProof=async(...args)=>{entered.resolve();await gate.promise;return proof(...args);};
 const record=f.library.recordTaskOutcomes.bind(f.library);f.library.recordTaskOutcomes=async(...args)=>{try{return await record(...args);}finally{settled.resolve();}};
 f.engine.finishReport(f.task.id);await entered.promise;
 f.store.transaction(state=>{state.settings.filesEnabled=false;state.settings.executionEpochs.files++;});
 if(reenable)f.store.transaction(state=>{state.settings.filesEnabled=true;state.settings.executionEpochs.files++;});
 gate.resolve();await settled.promise;await new Promise(resolve=>setImmediate(resolve));
 assert.equal(fs.readFileSync(f.file,'utf8'),f.before,'a revoked background operation must not save a verified or failed sample');
 assert.equal(f.store.task(f.task.id).status,'completed','document completion remains true; only background learning was revoked');
 assert.ok(f.store.task(f.task.id).executionDomains.includes('files'));
});
