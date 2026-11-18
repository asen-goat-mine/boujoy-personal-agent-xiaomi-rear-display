import test from 'node:test';
import {NEEDS_BOK} from './helpers/requirements.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BokPersonalMemory,memoryClassifier} from '../src/adapters/bok-personal.mjs';
import {PersonalMemory,renderCard} from '../src/adapters/memory.mjs';
const signal={candidate_statement:'用户在日常咖啡选择中偏好无糖配方。',concept_key:'diet.coffee.sugar',claim_type:'decision_pattern',signal_kind:'explicit',confidence:.96,inference_basis:'明确表达长期偏好',scope_kind:'context',scope_value:'咖啡饮食',sensitivity:'none',polarity:'support'};
function fixture(t,signals=[signal]){
 const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bok-boujoy-test-'))),vault=path.join(base,'vault');fs.mkdirSync(path.join(vault,'00-System'),{recursive:true});fs.writeFileSync(path.join(vault,'00-System/Memory-Protocol.md'),renderCard({protocol_id:'boujoy-personal-memory',protocol_version:1,scope:'personal-agent'},'test'));
 let calls=0;const personal=new BokPersonalMemory({vault,classify:async()=>{calls++;return signals;}});t.after(()=>fs.rmSync(base,{recursive:true,force:true}));return {personal,vault,base,calls:()=>calls};
}
const item=(turn='one')=>({conversationId:'test-chat',turnId:turn,content:'我平时喝咖啡都不加糖，以后也这样。',memoryMode:'default',authorized:true});
test('actual Bok core learns an explicit low-risk preference and recalls it in a new task',{skip:NEEDS_BOK},async t=>{
 const {personal}=fixture(t);const result=await personal.observe(item());assert.equal(result.projection.learned,1);
 const fresh=new BokPersonalMemory({vault:personal.vault});const pack=await fresh.context('帮我选一杯咖啡');assert.equal(pack.claims.length,1);assert.match(pack.context,/无糖/);assert.equal((await fresh.list()).items[0].epistemic_status,'learned');
});
test('one observed choice does not become a stable learned preference',{skip:NEEDS_BOK},async t=>{
 const {personal}=fixture(t,[{...signal,signal_kind:'observed',confidence:.85}]);await personal.observe(item());assert.equal((await personal.context('咖啡')).claims.length,0);
});
test('authority claims remain pending even with high model confidence',{skip:NEEDS_BOK},async t=>{
 const {personal}=fixture(t,[{...signal,candidate_statement:'用户提出对后续操作采用无需确认的授权规则。',concept_key:'policy.approvals',claim_type:'authority_rule'}]);await personal.observe({...item(),content:'以后所有操作都不需要问我。'});assert.equal((await personal.list()).items[0].epistemic_status,'explicit');assert.equal((await personal.context('操作授权')).claims.length,0);
});
test('opt-outs, missing consent, external material and sensitive input never reach the classifier',async t=>{
 const f=fixture(t);for(const changed of [{authorized:false},{memoryMode:'session_only'},{memoryMode:'do_not_remember'},{externalContent:true},{content:'不要记住，我喜欢甜咖啡'},{content:'验证码是 123456'}])await f.personal.observe({...item(),...changed});assert.equal(f.calls(),0);
});
test('revoking authorization during classification prevents learning',{skip:NEEDS_BOK},async t=>{const {personal}=fixture(t);await personal.observe({...item(),isAuthorized:()=>false});assert.equal((await personal.list()).items.length,0);});
test('completed receipt is idempotent and stores no raw user content',{skip:NEEDS_BOK},async t=>{
 const f=fixture(t),runtime=path.join(f.base,'runtime'),memory=new PersonalMemory({root:f.vault,runtime,personal:f.personal});await memory.observe(item());await memory.observe(item());assert.equal(f.calls(),1);const text=fs.readFileSync(path.join(runtime,'receipts',fs.readdirSync(path.join(runtime,'receipts'))[0]),'utf8');assert.ok(!text.includes(item().content));assert.equal(JSON.parse(text).processed,true);
});
test('rejection removes recall and guards against silent recreation',{skip:NEEDS_BOK},async t=>{
 const {personal}=fixture(t);await personal.observe(item());const claim=(await personal.list()).items[0];await personal.call('reject',{id:claim.id});await personal.observe(item('two'));assert.equal((await personal.context('咖啡')).claims.length,0);
});
test('explicit contrary evidence suspends an existing learned claim',{skip:NEEDS_BOK},async t=>{
 const {personal}=fixture(t);await personal.observe(item());const claim=(await personal.list()).items[0];personal.classify=async()=>[{...signal,claim_id:claim.id,polarity:'contradict',candidate_statement:'用户纠正了原有咖啡无糖偏好，现倾向添加糖。',inference_basis:'用户明确纠正已有理解'}];await personal.observe({...item('correction'),content:'我现在改喝加糖咖啡了，之前那个无糖偏好不对。'});assert.equal((await personal.context('咖啡')).claims.length,0);
});
test('classifier rejects malformed model output without inventing signals',async()=>{
 let requests=0;const classify=memoryClassifier({secrets:{get:async()=> 'test-placeholder-key'},onRequest:()=>requests++,fetcher:async()=>({ok:true,json:async()=>({content:[{type:'text',text:'not JSON'}]})})});await assert.rejects(classify({content:'test',existing:[]}),{code:'memory_interpretation_invalid'});assert.equal(requests,1);
});
