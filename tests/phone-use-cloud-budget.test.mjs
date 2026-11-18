import test from 'node:test';import assert from 'node:assert/strict';import {Phone} from '../src/adapters/phone.mjs';
const tree=pkg=>({content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:pkg,windowPkg:pkg,tree:`window pkg=${pkg} bounds=0,0,968,2376\n FrameLayout bounds=0,0,968,2376\n  Button "电池" clickable bounds=100,200,500,300`}})}]});
function fixture({foreign=false,afterForeign=false,slow=3400}={}){
 let now=Date.now()-(slow+300),captures=0;const calls=[],scope={taskId:'t',sourceMessageId:'human',packageName:'com.android.settings',appName:'设置',mode:'read_navigation',navigationTerms:['电池用量']};
 const store={data:{settings:{phoneEnabled:true,phoneBackend:'phoneuse',phoneUseDeviceId:'phone'},tasks:[]}},image={content:[{type:'image',mimeType:'image/png',data:'fixture'}]},ocr={width:968,height:2376,lines:[]};
 const driver={client:{remoteTransport:{dataPort:10001,controlPort:10002}},capture:async()=>{captures++;now+=slow;return {tree:tree(foreign||afterForeign?'com.other.app':'com.android.settings'),image,mapping:{}};},recognize:async()=>{now+=300;return ocr;}};
 const phone=new Phone(store,{phoneUse:driver,clock:()=>now,wait:async()=>{}});phone.call=async name=>{calls.push(name);now+=slow;return tree(foreign?'com.other.app':'com.android.settings');};
 return {phone,scope,captures:()=>captures,calls};
}
test('real cloud round trips and OCR share enough bounded budget for the actual scoped observation pipeline',async()=>{
 const f=fixture();const reply=await f.phone.observeUse('t',f.scope);assert.equal(reply.meta.stability,'fresh');assert.equal(reply.meta.elapsedMs,3700);assert.equal(f.captures(),1);assert.deepEqual(f.calls,[]);assert.equal(f.phone.observation.taskId,'t');
});
test('cloud budget retains foreground gates before OCR and before returning any changed-app content',async()=>{
 let f=fixture({foreign:true});let reply=await f.phone.observeUse('t',f.scope);assert.equal(f.captures(),1);assert.equal(f.phone.observation,null);assert.ok(!reply.content.some(c=>c.type==='image'));
 f=fixture({afterForeign:true});reply=await f.phone.observeUse('t',f.scope);assert.equal(f.captures(),1);assert.equal(f.phone.observation,null);assert.ok(!reply.content.some(c=>c.type==='image'));assert.equal(reply.meta.foregroundPackage,'com.other.app');assert.equal(reply.meta.reason,'outside_task_scope');assert.ok(!reply.content.some(c=>c.type==='image')); 
});
test('exhausted cloud budget stays bounded and exposes its failure category without returning a false empty success',async()=>{
 const f=fixture({slow:12500});const reply=await f.phone.observeUse('t',f.scope);assert.equal(reply.meta.stability,'uncertain');assert.equal(reply.meta.failureCode,'screen_unstable');assert.equal(f.phone.observation,null);assert.ok(!reply.content.some(c=>c.type==='image'));
});


test('a pre-input cloud read timeout is not an unknown sent action and uses the remote budget',async()=>{
 const f=fixture({slow:0}),calls=[];let timeout;
 const state=tree('com.android.settings');
 f.phone.observation={id:'obs',taskId:'t',at:Date.now(),tree:state,ocr:{width:968,height:2376,lines:[]},stability:'fresh',stabilityScope:'phone_use',phoneUseGrant:f.scope};
 f.phone.phoneUse.capture=async(id,options)=>{timeout=options.timeout;throw Object.assign(Error('read timeout'),{code:'rpc_timeout'});};
 f.phone.call=async()=>{calls.push('input');};
 await assert.rejects(f.phone.act('t',{observationId:'obs',action:'back'}),error=>error.code==='rpc_timeout'&&error.dispatchState==='not_sent');
 assert.equal(timeout,12000);assert.deepEqual(calls,[]);
});


test('opening a foreground target reuses only its recent atomic frame and still rejects foreign content',async()=>{
 const f=fixture({slow:0});const capture={at:Date.now()-1000,tree:tree('com.android.settings'),image:{content:[{type:'image',mimeType:'image/png',data:'fixture'}]},mapping:{}};
 let result=await f.phone.observeUse('t',f.scope,{initialCapture:capture});assert.equal(f.captures(),0);assert.equal(result.meta.stability,'fresh');
 result=await f.phone.observeUse('t',f.scope,{initialCapture:{...capture,tree:tree('com.other.private')}});assert.equal(f.captures(),0);assert.equal(result.meta.reason,'outside_task_scope');assert.ok(!result.content.some(c=>c.type==='image'));
 await f.phone.observeUse('t',f.scope,{initialCapture:{...capture,at:Date.now()-6000}});assert.equal(f.captures(),1,'expired initial frames trigger a fresh capture');
});


test('commerce query and full verification use cloud budgets without weakening full two-frame stability',async()=>{
 const f=fixture({slow:3600});let captures=0,clock=Date.now()-10000;
 f.phone.clock=()=>clock;f.phone.phoneUse.capture=async()=>{captures++;clock+=3600;return {tree:tree('com.taobao.taobao'),image:{content:[{type:'image',mimeType:'image/png',data:'fixture'}]},mapping:{}};};
 f.phone.phoneUse.recognize=async()=>{clock+=300;return {width:968,height:2376,lines:[{id:'search',text:'搜索',bounds:[800,130,930,190],center:{x:865,y:160}}]};};
 let reply=await f.phone.observeQuery('t',{platform:'taobao',query:'冰美式'});assert.equal(reply.meta.stability,'fresh');assert.equal(captures,1);
 captures=0;reply=await f.phone.observeStable('t');assert.equal(reply.meta.stability,'stable');assert.equal(reply.meta.stabilityScope,'full');assert.equal(captures,2);
});

test('general opening reuses its current atomic capture but refreshes expired or post-action frames',async()=>{
 const f=fixture({slow:0}),scope={...f.scope,mode:'general'},capture={at:Date.now()-1000,tree:tree(scope.packageName),image:{content:[{type:'image',mimeType:'image/png',data:'fixture'}]},mapping:{}};
 let result=await f.phone.observeGeneral('t',scope,{initialCapture:capture});assert.equal(f.captures(),0);assert.equal(result.meta.stability,'fresh');
 await f.phone.observeGeneral('t',scope,{initialCapture:{...capture,at:Date.now()-6000}});assert.equal(f.captures(),1);
 await f.phone.observeGeneral('t',scope,{initialCapture:capture,afterAction:true});assert.equal(f.captures(),2,'never reuse the pre-action image after an effect');
});
test('an unchanged general frame returns once for model judgment without hidden reads or actions',async()=>{
 const f=fixture({slow:0}),scope={...f.scope,mode:'general'};await f.phone.observeGeneral('t',scope);f.phone.actionBaseline={...f.phone.observation};
 const before=f.captures(),result=await f.phone.observeGeneral('t',scope,{afterAction:true});assert.equal(f.captures()-before,1);assert.equal(result.meta.changedSinceAction,false);assert.equal(result.meta.attempts,1);assert.deepEqual(f.calls,[]);
});
test('a foreign general frame never triggers unledgered close or launch actions',async()=>{
 const f=fixture({foreign:true,slow:0}),scope={...f.scope,mode:'general'};
 f.phone.phoneUse.recognize=async()=>({width:968,height:2376,lines:[{id:'close',text:'关闭',bounds:[10,10,100,60],center:{x:55,y:35}}]});
 const result=await f.phone.observeGeneral('t',scope);assert.equal(result.meta.reason,'outside_task_scope');assert.equal(result.meta.foregroundPackage,'com.other.app');assert.equal(f.captures(),1);assert.deepEqual(f.calls,[]);assert.equal(f.phone.observation,null);assert.ok(!result.content.some(c=>c.type==='image'));
});
test('general read propagates identity, control and unknown-result barriers without a recovery action',async()=>{
 for(const failure of [{code:'outcome_unknown'},{code:'execution_revoked'},{code:'phoneuse_error',phoneuseCode:'PAIRING_REVOKED'},{code:'phoneuse_error',phoneuseCode:'DEVICE_MISMATCH'}]){
  const f=fixture({slow:0}),error=Object.assign(Error('barrier'),failure);f.phone.phoneUse.capture=async()=>{throw error;};
  await assert.rejects(f.phone.observeGeneral('t',{...f.scope,mode:'general'}),e=>e===error);assert.deepEqual(f.calls,[]);
 }
});
