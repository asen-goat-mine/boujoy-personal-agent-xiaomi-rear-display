import test from 'node:test';
import assert from 'node:assert/strict';
import {PhoneUseDriver} from '../src/adapters/phoneuse-driver.mjs';
import {Phone} from '../src/adapters/phone.mjs';

const mcp=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const outcome=(state='executed',executed=true)=>mcp({state,action_executed:executed});
const native={deviceId:'phone-a',serviceInstanceId:'service-a',observationId:'service-a:fresh',windowId:4,elements:[{element_id:'0/1',visible:true,enabled:true,focused:true,editable:true,password:false,actions:['set_text']}]};
function fixture(result=outcome()){
 const calls=[],client={call:async(...args)=>{calls.push(args);return typeof result==='function'?result(...args):result;},close:async()=>{}};
 return {driver:new PhoneUseDriver({client}),calls,client};
}

test('driver sends exact physical coordinates with the fresh observation and window guards',async()=>{
 const f=fixture();await f.driver.call('phone-a','tap',{x:700,y:1800},8000,{native});
 assert.equal(f.calls.length,1);assert.equal(f.calls[0][1],'tap');
 assert.deepEqual(f.calls[0][2],{observation_id:'service-a:fresh',expected_window_id:4,service_instance_id:'service-a',x:700,y:1800});
});
test('Chinese input uses the sole focused native editor and never a coordinate fallback',async()=>{
 const f=fixture();await f.driver.call('phone-a','type',{text:'牛肉面',mode:'replace'},8000,{native});
 assert.equal(f.calls[0][1],'input_text');assert.equal(f.calls[0][2].element_id,'0/1');assert.equal(f.calls[0][2].text,'牛肉面');
 await assert.rejects(f.driver.call('phone-a','type',{text:'咖啡',mode:'replace'},8000,{native:{...native,elements:[]}}),error=>error.code==='phone_input_unavailable'&&error.dispatchState==='not_sent');
 for(const elements of [[{...native.elements[0],password:true}],[...native.elements,...native.elements]]){
  await assert.rejects(f.driver.call('phone-a','type',{text:'咖啡',mode:'replace'},8000,{native:{...native,elements}}),{code:elements.some(e=>e.password)?'user_only_step':'phone_input_unavailable'});
 }
 assert.equal(f.calls.length,1);
});
test('wireless actions reject absent references, foreign devices, and cancellation before dispatch',async()=>{
 const f=fixture();
 await assert.rejects(f.driver.call('phone-a','tap',{x:1,y:2}),{code:'stale_observation'});
 await assert.rejects(f.driver.call('phone-b','tap',{x:1,y:2},8000,{native}),{code:'stale_observation'});
 await assert.rejects(f.driver.call('phone-a','open_app',{packageName:'com.taobao.taobao'},8000,{signal:AbortSignal.abort()}),{code:'action_cancelled'});
 assert.equal(f.calls.length,0);
});
test('HTTP success and accepted receipts never become a completed action',async()=>{
 for(const [state,executed,code] of [['accepted',false,'outcome_unknown'],['executing',null,'outcome_unknown'],['unknown',null,'outcome_unknown'],['failed',false,'action_cancelled'],['cancelled',false,'action_cancelled']]){
  const f=fixture(outcome(state,executed));await assert.rejects(f.driver.call('phone-a','key',{key:'back'},8000,{native}),{code});assert.equal(f.calls.length,1);
 }
 const f=fixture(mcp({request:{state:'executed',action_executed:true}}));await f.driver.call('phone-a','key',{key:'back'},8000,{native});
});
test('wireless application directory is device-bound, refreshed on a miss or after ten minutes, and does not use ADB',async()=>{
 let now=1000;
 const f=fixture((id,tool)=>{assert.equal(tool,'list_apps');return mcp({apps:id==='phone-a'?[{package_name:'com.taobao.taobao',label:'OTHER'},{package_name:'com.example.weather',label:'天气'}]:[{package_name:'com.android.settings',label:'设置'}]});});f.driver.clock=()=>now;
 const first=await f.driver.listApps('phone-a','闪购');assert.equal(first.source,'phoneuse');assert.equal(first.apps[0].packageName,'com.taobao.taobao');assert.equal(first.apps[0].label,'淘宝');
 assert.equal((await f.driver.resolveApp('phone-a','com.example.weather')).label,'天气');assert.equal(f.calls.length,1);
 await assert.rejects(f.driver.resolveApp('phone-b','com.taobao.taobao'),{code:'app_not_installed'});assert.equal(f.calls.length,2);
 now+=15001;await f.driver.listApps('phone-a','天气');assert.equal(f.calls.length,2);
 await f.driver.listApps('phone-a','新装应用');assert.equal(f.calls.length,3);
 now+=600001;await f.driver.listApps('phone-a','天气');assert.equal(f.calls.length,4);
});

function phoneFixture(driver){
 const store={data:{settings:{phoneEnabled:true,phoneBackend:'phoneuse',phoneUseDeviceId:'phone-a'}},transaction(fn){return fn(this.data);}};
 return {store,phone:new Phone(store,{phoneUse:driver,recognize:async()=>({width:500,height:1000,lines:[]})})};
}
test('pending pair never activates a new device; completed pair records only its identity',async()=>{
 const f=fixture();let confirmed=false;
 f.client.connect=async args=>{confirmed=args.confirmPairing;return {status:confirmed?'paired':'pending',device_id:'phone-new',verification_code:'12345678'};};
 const {store,phone}=phoneFixture(f.driver);store.data.settings={phoneEnabled:false,phoneBackend:'pony'};
 await phone.pair({backend:'phoneuse',address:'https://192.168.1.2:8443'});assert.equal(store.data.settings.phoneBackend,'pony');assert.equal(store.data.settings.phoneEnabled,false);
 await phone.pair({backend:'phoneuse',deviceId:'phone-new',confirmPairing:true});assert.equal(confirmed,true);assert.deepEqual(store.data.settings,{phoneEnabled:true,phoneBackend:'phoneuse',phoneUseDeviceId:'phone-new'});
});
test('disabling the phone creates a reopenable transport while retaining the selected device settings',async()=>{
 let closed=0,created=0;
 const factory=()=>{created++;let stopped=false;return new PhoneUseDriver({client:{close:async()=>{stopped=true;closed++;},connect:async()=>{assert.equal(stopped,false);return {status:'paired',device_id:'phone-a'};}}});};
 const store={data:{settings:{phoneEnabled:true,phoneBackend:'phoneuse',phoneUseDeviceId:'phone-a'}},transaction(fn){return fn(this.data);}};
 const phone=new Phone(store,{phoneUseFactory:factory});store.data.settings.phoneEnabled=false;await phone.close();
 await phone.pair({backend:'phoneuse',deviceId:'phone-a'});assert.equal(created,2);assert.equal(closed,1);assert.equal(store.data.settings.phoneEnabled,true);assert.equal(store.data.settings.phoneUseDeviceId,'phone-a');
});
test('Phone selects native wireless catalog and launch without starting Pony or ADB',async()=>{
 const f=fixture((id,tool)=>tool==='list_apps'?mcp({apps:[{package_name:'com.android.settings',label:'设置'}]}):outcome());
 const {phone}=phoneFixture(f.driver);phone.apps={list(){assert.fail('ADB');},resolve(){assert.fail('ADB');}};phone.start=()=>assert.fail('Pony');
 assert.equal((await phone.listApps('设置')).apps[0].packageName,'com.android.settings');await phone.resolveApp('com.android.settings');await phone.openPackage('task','com.android.settings');
 assert.deepEqual(f.calls.map(c=>c[1]),['list_apps','launch_app']);
});

test('Phone capture and final action use physical OCR and the new native snapshot, never an older reference',async()=>{
 const f=fixture();let frames=0;
 const frame=()=>({tree:mcp({ok:true,result:{display:'main',foreground:'com.android.settings',windowPkg:'com.android.settings',window:'4',tree:'window pkg=com.android.settings bounds=0,0,1000,2000\n  Button "电池" clickable bounds=200,400,400,460'}}),image:{content:[{type:'image',mimeType:'image/png',data:'AA=='}]},mapping:{physicalWidth:1000,physicalHeight:2000,imageWidth:500,imageHeight:1000,scaleX:2,scaleY:2,offsetX:0,offsetY:0},native:{...native,observationId:'service-a:fresh-'+(++frames)}});
 f.driver.capture=async()=>frame();
 const {phone}=phoneFixture(f.driver);phone.start=()=>assert.fail('Pony started');
 phone.recognize=async()=>({width:500,height:1000,lines:[{id:'text-1',text:'电池',bounds:[100,200,200,230],center:{x:150,y:215}}]});
 const result=await phone.observe('t'),meta=JSON.parse(result.content[0].text);
 assert.deepEqual(meta.screenSize,{width:1000,height:2000});assert.deepEqual(meta.textTargets[0].center,{x:300,y:430});
 await phone.act('t',{observationId:meta.observationId,action:'tap',textTargetId:'text-1'});
 assert.equal(frames,2);assert.equal(f.calls.length,1);assert.equal(f.calls[0][2].observation_id,'service-a:fresh-2');assert.equal(f.calls[0][2].x,300);assert.equal(f.calls[0][2].y,430);
 assert.equal(JSON.stringify(result).includes('service-a:fresh'),false);
});

function nativeObservation(){
 const now=Date.now(),states={enabled:true,visible:true,editable:false,password:false,focused:false,checkable:false,checked:false,selected:false,content_invalid:false};
 const elements=[{...states,element_id:'0',parent_id:null,class:'android.widget.FrameLayout',bounds:[0,0,968,2376],actions:[]},{...states,element_id:'0.0',parent_id:'0',class:'android.widget.EditText',bounds:[100,200,800,300],text:'旧菜品',editable:true,focused:true,actions:['set_text']}];
 const data={device_id:'phone-a',service_instance_id:'native-instance',observation_id:'native-instance:current',window_id:7,package_name:'com.taobao.taobao',ui_version:9,captured_at_ms:now,observation_status:'complete',display:{id:0,width:968,height:2376,rotation:0,coordinates:'physical_pixels',origin:'top_left',includes_system_bars_and_ime:true},windows:[{window_id:7,display_id:0,bounds:[0,0,968,2376],layer:1}],tree:{available:true,output:'legacy',compact:false,scope_clipped:false,collected_nodes:2,output_nodes:2,merged_nodes:0,elements,collection_complete:true,collection_truncated:false,truncated:false,started_at_ms:now-20,finished_at_ms:now-15},screenshot:{available:true,mime_type:'image/jpeg',width:835,height:2048,scale_x:968/835,scale_y:2376/2048,offset_x:0,offset_y:0,started_at_ms:now-10,finished_at_ms:now-1}};
 return {content:[{type:'image',mimeType:'image/jpeg',data:Buffer.from('opaque-image').toString('base64')},...mcp(data).content]};
}
test('driver consumes the pinned native observation envelope and sends its actual editor reference',async()=>{
 const calls=[],driver=new PhoneUseDriver({client:{call:async(id,tool,args)=>{calls.push({id,tool,args});return tool==='observe'?nativeObservation():outcome();}}});
 const frame=await driver.capture('phone-a');assert.equal(calls.length,1);assert.equal(calls[0].args.mode,'both');assert.equal(calls[0].args.compact,false);assert.equal(calls[0].args.diagnostics,true);
 await driver.call('phone-a','type',{text:'猪脚饭',mode:'replace'},8000,{native:frame.native});assert.equal(calls[1].tool,'input_text');assert.equal(calls[1].args.element_id,'0.0');assert.equal(calls[1].args.observation_id,'native-instance:current');assert.equal(calls[1].args.expected_window_id,7);
});

const transientRead=(reasons=['NO_ACTIVE_WINDOW'],extra={})=>Object.assign(Error('Phone Use 未能返回完整可靠的读取结果'),{code:'phoneuse_error',phoneuseReasons:reasons,phoneuseReasonsComplete:true,phoneuseObservationStatus:'complete',...extra});
test('capture retries only the read once after explicit transient reasons and shares the original deadline',async()=>{
 let attempts=0;
 const f=fixture(()=>{if(!attempts++)throw transientRead(['NO_ACTIVE_WINDOW','SCREENSHOT_RATE_LIMITED']);return nativeObservation();});
 const frame=await f.driver.capture('phone-a',{timeout:1000});
 assert.equal(frame.native.observationId,'native-instance:current');assert.equal(f.calls.length,2);
 assert.ok(f.calls.every(call=>call[1]==='observe'));assert.equal(f.calls[0][2].stable_wait_ms,0);assert.equal(f.calls[1][2].stable_wait_ms,150);
 assert.ok(f.calls[1][3].timeout<=f.calls[0][3].timeout-290);assert.ok(f.calls[1][2].timeout_ms<f.calls[0][2].timeout_ms);
});
test('capture never retries generic, blocked, incomplete, cancelled or mixed observation failures',async()=>{
 for(const error of [
  transientRead(['SECURE_WINDOW']),transientRead(['NO_ACTIVE_WINDOW','LOCAL_CONTROL_UI']),transientRead(['ACCESSIBILITY_UNAVAILABLE']),
  transientRead(['NO_ACTIVE_WINDOW','STOPPED']),transientRead(['CANCELLED']),transientRead(['TLS_IDENTITY_MISMATCH']),
  transientRead(['NO_ACTIVE_WINDOW'],{phoneuseReasonsComplete:false}),transientRead([]),
  transientRead(['NO_ACTIVE_WINDOW'],{phoneuseObservationStatus:'condition_timeout'}),
  Object.assign(Error('SCREENSHOT_RATE_LIMITED'),{code:'phoneuse_error'}),Object.assign(Error('stopped'),{code:'cancelled'})
 ]){
  const f=fixture(()=>{throw error;});await assert.rejects(f.driver.capture('phone-a'),caught=>caught===error);assert.equal(f.calls.length,1);
 }
 const f=fixture(()=>{const raw=nativeObservation();raw.isError=true;return raw;});
 await assert.rejects(f.driver.capture('phone-a'),{code:'phoneuse_incomplete_observation'});assert.equal(f.calls.length,1);
});
test('a second transient read stops and a replacement incomplete frame is never accepted',async()=>{
 const twice=fixture(()=>{throw transientRead(['OBSERVATION_INCONSISTENT'],{phoneuseObservationStatus:'failed'});});
 await assert.rejects(twice.driver.capture('phone-a'),{code:'phoneuse_error'});assert.equal(twice.calls.length,2);
 let attempts=0;
 const incomplete=fixture(()=>{if(!attempts++)throw transientRead();const raw=nativeObservation(),block=raw.content.find(item=>item.type==='text'),value=JSON.parse(block.text);value.tree.collection_complete=false;block.text=JSON.stringify(value);return raw;});
 await assert.rejects(incomplete.driver.capture('phone-a'),{code:'phoneuse_incomplete_observation'});assert.equal(incomplete.calls.length,2);
});
test('abort interrupts the recovery wait promptly without a replacement read',async()=>{
 const controller=new AbortController(),f=fixture(()=>{setTimeout(()=>controller.abort(),20);throw transientRead();});
 const started=performance.now();await assert.rejects(f.driver.capture('phone-a',{signal:controller.signal}),{code:'cancelled'});
 assert.ok(performance.now()-started<250);assert.equal(f.calls.length,1);
 const stopped=fixture(nativeObservation());await assert.rejects(stopped.driver.capture('phone-a',{signal:AbortSignal.abort()}),{code:'cancelled'});assert.equal(stopped.calls.length,0);
});
test('capture deadline covers an unresponsive initial read and the retry wait plus second read',async()=>{
 const never=fixture(()=>new Promise(()=>{}));
 let started=performance.now();await assert.rejects(never.driver.capture('phone-a',{timeout:40}),{code:'rpc_timeout'});
 assert.ok(performance.now()-started<250);assert.equal(never.calls.length,1);assert.equal(never.calls[0][3].signal.aborted,true);
 let attempts=0;
 const retry=fixture(async()=>{if(!attempts++){await new Promise(resolve=>setTimeout(resolve,30));throw transientRead();}return new Promise(()=>{});});
 started=performance.now();await assert.rejects(retry.driver.capture('phone-a',{timeout:420}),{code:'rpc_timeout'});
 const elapsed=performance.now()-started;assert.ok(elapsed>=390&&elapsed<650,`shared deadline elapsed ${elapsed}ms`);assert.equal(retry.calls.length,2);
 assert.ok(retry.calls[1][3].timeout<100);assert.equal(retry.calls[1][3].signal.aborted,true);
 const exhausted=fixture(()=>{throw transientRead();});await assert.rejects(exhausted.driver.capture('phone-a',{timeout:100}),{code:'phoneuse_error'});assert.equal(exhausted.calls.length,1);
});


test('paused cloud connection uses status-only control lane and is not misreported offline',async()=>{
 const f=fixture((id,tool)=>{assert.equal(tool,'get_status');return mcp({device_id:id,stopped:false,executing_request_id:null});});f.client.pendingSummary=async()=>({requests:[{deviceId:'phone-a'}]});
 const {phone}=phoneFixture(f.driver);phone.remoteControlState=()=>({paused:true});const status=await phone.status();assert.equal(status.connected,true);
 const value=JSON.parse(status.result.content[0].text);assert.equal(value.link,'paused');assert.equal(value.listening,false);assert.equal(value.pendingCount,1);assert.equal(f.calls.length,1);
});
test('paused status never fabricates online state for a foreign device or failed control transport',async()=>{
 for(const answer of [()=>mcp({device_id:'foreign',stopped:false}),()=>{throw Error('offline');}]){
  const f=fixture(answer);const status=await f.driver.status('phone-a',{paused:true});assert.equal(status.connected,false);assert.equal(f.calls.length,1);
 }
});


test('paused cloud data operations fail locally before bridge traffic while status remains available',async()=>{
 const f=fixture(()=>assert.fail('paused task must not make data requests'));const {phone}=phoneFixture(f.driver);
 f.client.remoteTransport={dataPort:34561,controlPort:34562};phone.remoteControlState=()=>({paused:true});
 const check=e=>e.code==='phone_control_paused'&&e.dispatchState==='not_sent';
 for(const operation of [()=>phone.listApps('设置'),()=>phone.resolveApp('com.android.settings'),()=>phone.call('ui_tree'),()=>phone.captureStableFrame('t',{deadline:Date.now()+1000})])await assert.rejects(operation(),check);
 assert.equal(f.calls.length,0);
 f.client.call=async(id,tool)=>{assert.equal(tool,'get_status');return mcp({device_id:id,stopped:false,executing_request_id:null});};
 assert.equal((await phone.status()).connected,true);
 phone.remoteControlState=()=>({paused:false});f.client.call=async(id,tool)=>mcp({apps:[{package_name:'com.android.settings',label:'设置'}]});
 assert.equal((await phone.listApps('设置')).apps[0].packageName,'com.android.settings');
});


test('slow app launch reconciles the original request from a bound foreground without dispatching a replacement',async()=>{
 const error=Object.assign(Error('unknown'),{code:'outcome_unknown',requestId:'original-nav',deviceId:'phone-a'});
 const f=fixture(()=>{throw error;});let checks=0;
 f.client.reconcileNavigation=async(id,options)=>{checks++;assert.equal(id,'original-nav');assert.equal(options.deviceId,'phone-a');return {resolved:true,outcome:'navigation_observed',resolution:{kind:'navigation_observed',packageName:'com.android.settings'}};};
 const result=await f.driver.call('phone-a','open_app',{packageName:'com.android.settings'});const value=JSON.parse(result.content[0].text);
 assert.equal(value.nativeOutcome,'unknown');assert.equal(value.navigationObserved,true);assert.equal(value.requestId,'original-nav');assert.equal(checks,1);assert.equal(f.calls.length,1);assert.equal(f.calls[0][1],'launch_app');
});
test('failed or foreign launch reconciliation preserves the original unknown and never dispatches again',async()=>{
 for(const mode of ['unresolved','foreign','offline']){
  const error=Object.assign(Error('unknown'),{code:'outcome_unknown',requestId:'nav',deviceId:mode==='foreign'?'other':'phone-a'}),f=fixture(()=>{throw error;});
  f.client.reconcileNavigation=async()=>{if(mode==='offline')throw Error('offline');return {resolved:false};};
  await assert.rejects(f.driver.call('phone-a','open_app',{packageName:'com.android.settings'}),e=>e===error);assert.equal(f.calls.length,1);
 }
});

test('definitive unsent typing retains its bound frame while unknown text outcomes discard it',async()=>{
 for(const dispatchState of ['not_sent','unknown']){
  const failure=Object.assign(Error('input failure'),{code:dispatchState==='not_sent'?'phone_input_unavailable':'outcome_unknown',dispatchState});
  const f=fixture(()=>{throw failure;});
  f.driver.capture=async()=>({tree:mcp({ok:true,result:{display:'main',foreground:'com.taobao.taobao',windowPkg:'com.taobao.taobao',tree:'window pkg=com.taobao.taobao bounds=0,0,1000,2000\nEditText "旧文字" editable focused clickable bounds=100,200,800,300'}}),image:{content:[{type:'image',mimeType:'image/png',data:'AA=='}]},mapping:{physicalWidth:1000,physicalHeight:2000,imageWidth:500,imageHeight:1000,scaleX:2,scaleY:2,offsetX:0,offsetY:0},native});
  const {phone}=phoneFixture(f.driver);await phone.observe('t');const before=phone.observation;
  await assert.rejects(phone.act('t',{action:'type',observationId:before.id,text:'新文字',inputMode:'replace'}),e=>e===failure);
  assert.equal(phone.observation,dispatchState==='not_sent'?before:null);assert.equal(f.calls.length,1);
 }
});

test('a transitional missing native class is recollected once without inventing a widget type',async()=>{
 const malformed=()=>{const raw=nativeObservation(),b=raw.content.find(c=>c.type==='text'),data=JSON.parse(b.text);delete data.tree.elements[1].class;b.text=JSON.stringify(data);return raw;};
 let attempts=0;const f=fixture(()=>attempts++?nativeObservation():malformed());const result=await f.driver.capture('phone-a',{timeout:1200});assert.equal(f.calls.length,2);assert.equal(result.native.elements[1].class,'android.widget.EditText');assert.ok(f.calls.every(c=>c[1]==='observe'));
 const broken=fixture(malformed);await assert.rejects(broken.driver.capture('phone-a',{timeout:1200}),{code:'phoneuse_invalid_observation'});assert.equal(broken.calls.length,2);
});

test('general capture immediately falls back to a fresh screenshot after a window failure',async()=>{
 const modes=[];
 const f=fixture((id,tool,args)=>{
  modes.push(args.mode);
  if(args.mode==='both')throw transientRead(['NO_ACTIVE_WINDOW']);
  const raw=nativeObservation(),body=JSON.parse(raw.content[1].text);body.tree=null;raw.content[1].text=JSON.stringify(body);return raw;
 });
 const {phone,store}=phoneFixture(f.driver);store.event=()=>{};
 phone.recognize=async()=>({width:835,height:2048,lines:[{id:'close',text:'关闭',bounds:[10,100,50,130],center:{x:30,y:115}}]});
 const grant={taskId:'t',mode:'general',packageName:'com.taobao.taobao',appName:'淘宝'};
 const result=await phone.observeGeneral('t',grant),meta=JSON.parse(result.content[0].text);
 assert.deepEqual(modes,['both','screenshot']);assert.equal(meta.observationMode,'screenshot_ocr');
 assert.equal(meta.stability,'fresh');assert.ok(meta.observationId);assert.match(meta.recovery,/不要机械重读/);
 assert.equal(phone.observation.tree,null);assert.equal(phone.observation.screenshotOnly,true);assert.deepEqual(phone.observation.native.elements,[]);
 assert.equal(phone.observation.native.windowId,7);assert.equal(phone.observation.native.observationId,'native-instance:current');
 const {classifyGeneralAction}=await import('../src/adapters/phone-general-navigation.mjs');
 assert.equal(classifyGeneralAction('t',{observationId:meta.observationId,action:'tap',textTargetId:'close'},phone.observation,grant).kind,'general_tap');
 phone.observation.ocr.lines[0].text='立即支付';assert.equal(classifyGeneralAction('t',{observationId:meta.observationId,action:'tap',textTargetId:'close'},phone.observation,grant).handoff,true);
});
test('screenshot fallback is bounded and cannot bypass secret, control, identity or unknown-result failures',async()=>{
 for(const error of [transientRead(['NO_ACTIVE_WINDOW','SECURE_WINDOW']),transientRead(['NO_ACTIVE_WINDOW','STOPPED']),transientRead(['NO_ACTIVE_WINDOW'],{phoneuseReasonsComplete:false}),Object.assign(Error('unknown'),{code:'outcome_unknown'})]){
  const f=fixture(()=>{throw error;});await assert.rejects(f.driver.capture('phone-a',{screenshotFallback:true}),e=>e===error);assert.equal(f.calls.length,1);
 }
 const f=fixture(()=>{throw transientRead(['WINDOW_MISMATCH']);});
 await assert.rejects(f.driver.capture('phone-a',{screenshotFallback:true}));assert.equal(f.calls.length,2);assert.deepEqual(f.calls.map(c=>c[2].mode),['both','screenshot']);
 const wrong=fixture((id,tool,args)=>{if(args.mode==='both')throw transientRead();const raw=nativeObservation(),body=JSON.parse(raw.content[1].text);body.tree=null;body.device_id='foreign';raw.content[1].text=JSON.stringify(body);return raw;});
 await assert.rejects(wrong.driver.capture('phone-a',{screenshotFallback:true}),{code:'stale_observation'});
});


test('late launch foreground is recollected once without replaying the unknown action',async()=>{
 const error=Object.assign(Error('unknown'),{code:'outcome_unknown',requestId:'late-nav',deviceId:'phone-a'}),f=fixture(()=>{throw error;});let checks=0;
 f.client.reconcileNavigation=async(id,options)=>{assert.equal(id,'late-nav');assert.ok(options.signal);return ++checks===1?{resolved:false,outcome:'navigation_not_observed'}:{resolved:true,outcome:'navigation_observed'};};
 const result=await f.driver.call('phone-a','open_app',{packageName:'com.taobao.taobao'});
 assert.equal(JSON.parse(result.content[0].text).nativeOutcome,'unknown');assert.equal(checks,2);assert.equal(f.calls.length,1);
});
test('a new launch blocked before dispatch cannot claim an older request reached its own target',async()=>{
 const error=Object.assign(Error('old unresolved navigation'),{code:'outcome_unknown',dispatchState:'not_sent',requestId:'old-target',deviceId:'phone-a'});
 const f=fixture(()=>{throw error;});f.client.reconcileNavigation=()=>assert.fail('must not use a previous request as new navigation evidence');
 await assert.rejects(f.driver.call('phone-a','open_app',{packageName:'com.example.newtarget'}),e=>e===error);assert.equal(f.calls.length,1);
});
test('navigation recovery stops at cancellation, identity change and a single total deadline',async()=>{
 for(const outcome of ['state_changed','not_quiescent','requires_business_reconciliation']){
  const f=fixture(()=>assert.fail('read-only recovery'));let checks=0;
  f.client.reconcileNavigation=async()=>{checks++;return {resolved:false,outcome};};
  assert.equal((await f.driver.reconcileNavigation('phone-a','nav')).outcome,outcome);assert.equal(checks,1);
 }
 const f=fixture(()=>assert.fail('no action')),controller=new AbortController();let checks=0;
 f.client.reconcileNavigation=async()=>{checks++;controller.abort();return {resolved:false,outcome:'navigation_not_observed'};};
 await assert.rejects(f.driver.reconcileNavigation('phone-a','nav',{signal:controller.signal}),{code:'cancelled'});assert.equal(checks,1);
 f.client.reconcileNavigation=async()=>new Promise(()=>{});
 await assert.rejects(f.driver.reconcileNavigation('phone-a','nav',{timeout:30}),{code:'rpc_timeout'});
});
test('a screen whose window tree fails validation falls back to screenshot + OCR for general navigation',async()=>{
 const brokenTree=()=>{const raw=nativeObservation(),b=raw.content.find(c=>c.type==='text'),data=JSON.parse(b.text);data.tree.elements[1].parent_id='9.9';b.text=JSON.stringify(data);return raw;};
 const f=fixture((id,tool,args)=>{if(args.mode==='both')return brokenTree();const raw=nativeObservation(),body=JSON.parse(raw.content[1].text);body.tree=null;raw.content[1].text=JSON.stringify(body);return raw;});
 const frame=await f.driver.capture('phone-a',{screenshotFallback:true,timeout:3000});
 assert.deepEqual(f.calls.map(c=>c[2].mode),['both','screenshot']);assert.equal(frame.screenshotOnly,true);assert.match(frame.windowFailure.code,/^phoneuse_(?:invalid|incomplete)_observation$/);
 const strict=fixture(brokenTree);await assert.rejects(strict.driver.capture('phone-a',{timeout:1200}),e=>/^phoneuse_(?:invalid|incomplete)_observation$/.test(e.code));assert.equal(strict.calls.length,1,'without the general fallback nothing changes');
});

test('a tree that times out on a huge screen falls back to screenshot + OCR, or retries once for a tree-only read',async()=>{
 const f=fixture((id,tool,args)=>{if(args.mode==='both')throw transientRead(['TREE_TIMEOUT'],{phoneuseObservationStatus:'failed'});const raw=nativeObservation(),body=JSON.parse(raw.content[1].text);body.tree=null;raw.content[1].text=JSON.stringify(body);return raw;});
 const frame=await f.driver.capture('phone-a',{screenshotFallback:true,timeout:3000});
 assert.deepEqual(f.calls.map(c=>c[2].mode),['both','screenshot']);assert.equal(frame.screenshotOnly,true);
 let attempts=0;const tree=fixture(()=>{if(!attempts++)throw transientRead(['TREE_TIMEOUT'],{phoneuseObservationStatus:'failed'});return nativeObservation();});
 const again=await tree.driver.capture('phone-a',{timeout:1000});assert.equal(tree.calls.length,2);assert.equal(again.native.observationId,'native-instance:current');
 const mixed=fixture(()=>{throw transientRead(['TREE_TIMEOUT','SECURE_WINDOW']);});
 await assert.rejects(mixed.driver.capture('phone-a',{screenshotFallback:true}));assert.equal(mixed.calls.length,1,'a secure window is never read around');
});
