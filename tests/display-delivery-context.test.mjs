import {BACKGROUND_SUPPORTED} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {Phone} from '../src/adapters/phone.mjs';
import {normalizePhoneUseObservation} from '../src/adapters/phoneuse-state.mjs';
import {modelToolResult} from '../src/adapters/model-tool-result.mjs';
const session={sessionId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',generation:3,displayId:19};
function raw(){
 const now=Date.now();return {observation_status:'complete',device_id:'bound-device',service_instance_id:'service-1',observation_id:'service-1:1',captured_at_ms:now,package_name:'com.example.app',window_id:11,ui_version:1,
  display:{id:19,width:720,height:1280,rotation:0,coordinates:'physical_pixels',origin:'top_left',includes_system_bars_and_ime:true},display_session:{...session},
  windows:[{window_id:11,display_id:19,package_name:'com.example.app',bounds:[0,0,720,1280],layer:1,type:1,active:true,focused:true}],
  tree:{available:true,started_at_ms:now-2,finished_at_ms:now-1,output:'legacy',compact:false,scope_clipped:false,collection_complete:true,collection_truncated:false,truncated:false,output_nodes:1,collected_nodes:1,merged_nodes:0,elements:[{element_id:'0',parent_id:null,class:'android.widget.FrameLayout',bounds:[0,0,720,1280],actions:[],enabled:true,visible:true,editable:false,password:false,focused:false,checkable:false,checked:false,selected:false,content_invalid:false,text:'Current page',description:null,hint:null}]},screenshot:{available:false}};
}
function fixture(mode='background'){
 const events=[],task={id:'task-1',status:'ready_for_user',title:'Current task',report:{summary:'Ready for the user'}};
 const store={data:{settings:{phoneEnabled:true,phoneBackend:'phoneuse',phoneExecutionMode:mode}},task:()=>task,event:(id,type,text,data)=>events.push({id,type,text,data})};
 const phone=new Phone(store,{phoneUse:{client:{},close:async()=>{}}});return {phone,events};
}
const textBlocks=result=>result.content.filter(b=>b.type==='text').map(b=>{try{return JSON.parse(b.text);}catch{return null;}}).filter(Boolean);
test('validated Android frame reaches the model as background while local guards retain their existing view contract',()=>{
 const wire=raw(),frame=normalizePhoneUseObservation(wire,{displaySession:session,requireScreenshot:false});
 const local=JSON.parse(frame.tree.content[0].text).result;
 assert.equal(local.display,'main');assert.equal(local.backend,'display');assert.equal(local.displayId,19);assert.deepEqual(local.displaySession,session);
 const {phone}=fixture();const result=phone.observationResult({...frame,native:frame.native},{taskId:'task-1',meta:{stabilityScope:'general'}});
 const context=textBlocks(result).find(x=>x.observationId);if(BACKGROUND_SUPPORTED){assert.equal(context.display,'background');assert.equal(context.displayId,19);assert.deepEqual(context.displaySession,session);}else{assert.equal(phone.displayUse,null);assert.equal(context.display,'main');assert.equal(context.displaySession,undefined);}
 const delivered=textBlocks(modelToolResult('phone_use',result)),tree=delivered.find(x=>x.result?.tree)?.result;
 assert.equal(tree.display,'background');assert.equal(tree.backend,'display');assert.equal(tree.displayId,19);assert.deepEqual(tree.displaySession,session);
 assert.equal(JSON.parse(frame.tree.content[0].text).result.display,'main','model formatting never rewrites the local action evidence');
});
test('an unavailable background frame reports no active display instead of borrowing an old telemetry session',()=>{
 const {phone}=fixture();phone.remoteDeviceTelemetry=()=>({displayBackend:{session:{...session,displayId:88}}});
 const data=textBlocks(phone.observationResult(null,{taskId:'task-1',actionable:false}))[0];
 if(!BACKGROUND_SUPPORTED){assert.equal(data.display,'main');assert.equal(data.backend,undefined);assert.equal(data.displayId,undefined);assert.equal(data.displaySession,undefined);return;}
 assert.equal(data.display,'background');assert.equal(data.backend,'display');assert.equal(data.displayId,null);assert.equal(data.displaySession,null);
 const bad={native:{display:{id:20},displaySession:session}};const mismatch=textBlocks(phone.observationResult(bad,{taskId:'task-1',actionable:false}))[0];assert.equal(mismatch.displayId,null);assert.equal(mismatch.displaySession,null);
});
test('main-screen observation retains its existing shape',()=>{
 const {phone}=fixture('main');const data=textBlocks(phone.observationResult(null,{taskId:'task-1',actionable:false}))[0];
 assert.equal(data.display,'main');assert.equal(data.backend,undefined);assert.equal(data.displaySession,undefined);
});
test('release describes only confirmed handoff or closure and never turns rejection or uncertainty into a closed page',async()=>{
 for(const receipt of [
  {handed:true,closed:false,state:'pending',reason:'pending',dispatchState:'confirmed'},
  {handed:false,closed:false,state:'failed',reason:'invalid_action',dispatchState:'not_sent'},
  {handed:false,closed:false,state:'unknown',reason:'outcome_unknown',dispatchState:'unknown'},
  {handed:false,closed:true,state:'closed',reason:'unsupported',dispatchState:'confirmed'},
  {handed:false,closed:false,state:'taken',reason:'taken',dispatchState:'confirmed'}]){
  const {phone,events}=fixture();phone.lease='task-1';if(!BACKGROUND_SUPPORTED){assert.equal(phone.displayUse,null);phone.release('task-1');await nextTurn();assert.equal(phone.lease,null);assert.deepEqual(events,[]);continue;}phone.displayUse.session={...session};let closes=0;
  phone.displayUse.handoffSession=async ({taskId})=>{assert.equal(taskId,'task-1');return receipt;};phone.displayUse.closeSession=async()=>{closes++;};
  phone.release('task-1');await nextTurn();assert.equal(events.length,1);assert.equal(events[0].id,'task-1');assert.equal(events[0].type,'phone_handoff');
  assert.equal(events[0].data.closed,receipt.closed);assert.equal(events[0].data.handed,receipt.handed);assert.equal(events[0].data.dispatchState,receipt.dispatchState);assert.equal(closes,0);
  if(receipt.handed)assert.match(events[0].text,/已留好页面/);
  else if(receipt.closed)assert.match(events[0].text,/后台显示已关闭/);
  else if(receipt.state==='taken')assert.match(events[0].text,/已交到手机主屏/);
  else assert.doesNotMatch(events[0].text,/后台显示已关闭|已留好页面|已交到手机主屏/);
 }
});

// The purchase preparation reader uses the same display identity as general reads;
// image-only evidence still cannot certify a quote or checkout.
test('purchase preparation keeps a verified same-app screenshot but still rejects foreign app content',async()=>{
 for(const packageName of ['com.taobao.taobao','com.example.other']){
  const wire=raw(),now=wire.captured_at_ms;wire.package_name=packageName;wire.windows[0].package_name=packageName;wire.tree={available:false};
  wire.screenshot={available:true,started_at_ms:now-2,finished_at_ms:now-1,width:720,height:1280,scale_x:1,scale_y:1,offset_x:0,offset_y:0,mime_type:'image/jpeg',data_base64:'aGVsbG8='};
  const frame=normalizePhoneUseObservation(wire,{displaySession:session,requireTree:false});
  const {phone}=fixture();let captures=0;phone.captureStableFrame=async()=>{captures++;return {...frame,native:frame.native,screenshotOnly:true,aligned:true,ocr:{width:720,height:1280,lines:[]}};};
  if(!BACKGROUND_SUPPORTED){await assert.rejects(phone.observePurchase('task-1',{taskId:'task-1',goal:'checkout',payment:'user',platform:'taobao'}),e=>e.code==='background_not_supported'&&e.dispatchState==='not_sent');assert.equal(captures,0);continue;}
  const reply=await phone.observePurchase('task-1',{taskId:'task-1',goal:'checkout',payment:'user',platform:'taobao'});
  const details=textBlocks(reply)[0];
  if(packageName==='com.taobao.taobao'){
   assert.equal(details.stability,'fresh');assert.equal(details.display,'background');assert.equal(details.purchaseBrowsingOnly,true);assert.equal(details.requiresFullObservationFor,'quotes,checkout');assert.ok(reply.content.some(b=>b.type==='image'));
  }else{
   assert.equal(details.stability,'uncertain');assert.equal(details.reason,'outside_task_scope');assert.equal(reply.content.some(b=>b.type==='image'),false);
  }
 }
});
