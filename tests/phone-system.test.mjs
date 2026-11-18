import test from 'node:test';
import assert from 'node:assert/strict';
import {Phone} from '../src/adapters/phone.mjs';
import {PhoneUseDriver} from '../src/adapters/phoneuse-driver.mjs';
import {Broker} from '../src/tools/broker.mjs';
import {createTaskContract} from '../src/core/task-contract.mjs';
const element=(extra={})=>({element_id:'0.1',visible:true,enabled:true,password:false,view_id:'com.sec.android.app.launcher:id/workspace',actions:[],...extra});
function frame(elements=[],packageName='com.sec.android.app.launcher',instance='service'){return {at:Date.now(),native:{deviceId:'device',serviceInstanceId:instance,observationId:instance+':fresh',windowId:1,packageName,elements}};}
function fixture(prompt,frames){
 const task={id:'t',status:'running',source:'user',messages:[{id:'u',role:'user',content:prompt}],quotes:[],children:[]};task.taskContract=createTaskContract(task);
 const data={tasks:[task],actions:[],artifacts:[],settings:{phoneBackend:'phoneuse',phoneEnabled:true,phoneUseDeviceId:'device'}},calls=[];
 const store={data,task:()=>task,transaction:fn=>fn(data),updateTask:(id,fn)=>{fn(task,data);return task;},event(){}};
 const driver={capture:async(id,args)=>{calls.push({name:'capture',args});return frames.shift()||frame([]);},call:async(id,name,args,time,options)=>{calls.push({name,args,options});return {};}};
 const phone=new Phone(store,{phoneUse:driver}),broker=new Broker({store,phone,approvals:{request:async()=>assert.fail('unexpected approval')}});broker.engine={finishReport(){task.status='completed';}};
 return {task,data,calls,phone,broker};
}
const value=result=>JSON.parse(result.content[0].text);
test('phone_use home invalidates old screen and completes only after a real launcher workspace observation',async()=>{
 const f=fixture('回到桌面',[frame([], 'com.example.app'),frame([element()])]);f.phone.observation={id:'old',taskId:'t'};
 const result=value(await f.broker.execute('t','phone_use',{action:'home'}));assert.equal(result.verified,true);assert.equal(f.phone.observation,null);
 assert.deepEqual(f.calls.filter(c=>c.name==='key').map(c=>c.args),[{key:'home'}]);assert.ok(f.calls.filter(c=>c.name==='capture').every(c=>c.args.mode==='tree'));
 await f.broker.execute('t','finish_task',{outcome:'completed',summary:'已返回桌面',evidence:[result.observationId]});assert.equal(f.task.status,'completed');
});
test('launcher package alone or a changed service is reported unverified; the model decides whether it is done',async()=>{
 for(const after of [frame([]),frame([element({view_id:'com.sec.android.app.launcher:id/overview_panel'})]),frame([element()],undefined,'new-service')]){
  const f=fixture('回到桌面',[frame([], 'com.example.app'),after]),result=value(await f.broker.execute('t','phone_use',{action:'home'}));assert.equal(result.verified,false);
  await f.broker.execute('t','finish_task',{outcome:'completed',summary:'已完成',evidence:[result.observationId]});assert.equal(f.task.status,'completed');
 }
 const f=fixture('打开最近任务界面',[frame([element()]),frame([element({view_id:'com.sec.android.app.launcher:id/overview_panel'})])]);assert.equal(value(await f.broker.execute('t','phone_use',{action:'recents'})).verified,true);
});
test('real driver long press binds a fresh unique native element rather than using guessed coordinates',async()=>{
 const calls=[],driver=new PhoneUseDriver({client:{call:async(...args)=>{calls.push(args);return {content:[{type:'text',text:JSON.stringify({state:'executed',action_executed:true})}]};}}});
 const native=frame([element({actions:['long_press'],bounds:[100,200,400,300]})]).native;
 await driver.call('device','long_press',{x:200,y:250},8000,{native});assert.equal(calls[0][1],'long_press');assert.equal(calls[0][2].element_id,'0.1');assert.equal(calls[0][2].x,undefined);
 await assert.rejects(driver.call('device','long_press',{x:200,y:250},8000,{native:{...native,elements:[]}}),error=>error.code==='stale_observation');assert.equal(calls.length,1);
});
const slider=(n,actions=['scroll_forward','scroll_backward'])=>frame([element({text:'亮度',view_id:'com.android.settings:id/brightness',range:[0,0,100,n],actions})],'com.android.settings');
test('phone_use set_value uses native range increments with per-step readback and verifies the requested percent',async()=>{
 const f=fixture('打开设置，把亮度调到30%',[slider(20),slider(25),slider(30)]);f.phone.observation={id:'old',taskId:'t'};
 const result=value(await f.broker.execute('t','phone_use',{action:'set_value',field:'brightness',value:30}));assert.equal(result.verified,true);assert.equal(result.actual,30);assert.equal(result.steps,2);assert.equal(f.phone.observation,null);
 assert.ok(f.calls.filter(c=>c.name==='range_step').every(c=>c.args.direction==='forward'&&c.args.elementId==='0.1'&&c.args.x===undefined));
 await f.broker.execute('t','finish_task',{outcome:'completed',summary:'亮度已设为30%',evidence:[result.observationId]});assert.equal(f.task.status,'completed');
});
test('range guard refuses unsupported sliders and different target values, and reports overshoot as unverified',async()=>{
 const unsupported=fixture('打开设置，把亮度调到30%',[slider(20,[])]);await assert.rejects(unsupported.broker.execute('t','phone_use',{action:'set_value',field:'brightness',value:30}),error=>error.code==='phone_capability_unavailable');assert.equal(unsupported.calls.some(c=>c.name==='range_step'),false);
 const altered=fixture('打开设置，把亮度调到30%',[]);await assert.rejects(altered.broker.execute('t','phone_use',{action:'set_value',field:'brightness',value:80}),error=>error.code==='phone_use_scope_changed');assert.equal(altered.calls.length,0);
 const overshot=fixture('打开设置，把亮度调到30%',[slider(20),slider(40)]),result=value(await overshot.broker.execute('t','phone_use',{action:'set_value',field:'brightness',value:30}));assert.equal(result.verified,false);assert.equal(result.actual,40);assert.equal(result.steps,1);
 await overshot.broker.execute('t','finish_task',{outcome:'completed',summary:'亮度到了 40%，比目标高',evidence:[result.observationId]});assert.equal(overshot.task.status,'completed');
});
test('real range driver dispatches only advertised node scroll with native snapshot and no coordinates',async()=>{
 const calls=[],driver=new PhoneUseDriver({client:{call:async(...args)=>{calls.push(args);return {content:[{type:'text',text:'{"state":"executed","action_executed":true}'}]};}}});
 await driver.call('device','range_step',{elementId:'0.1',direction:'forward'},8000,{native:slider(20).native});assert.equal(calls[0][1],'scroll');assert.deepEqual(calls[0][2],{observation_id:'service:fresh',expected_window_id:1,service_instance_id:'service',element_id:'0.1',direction:'forward'});
 await assert.rejects(driver.call('device','range_step',{elementId:'0.1',direction:'forward'},8000,{native:slider(20,[]).native}),error=>error.code==='phone_capability_unavailable');assert.equal(calls.length,1);
});
test('remote certificate maintenance blocks every public phone entry without falling back to LAN',async()=>{
 let reads=0;const store={data:{settings:{phoneEnabled:true,phoneBackend:'phoneuse',phoneUseDeviceId:'device'}}};
 const driver={status:async()=>{reads++;return {connected:true};},client:{setRemoteTransport:async value=>({transport:value}),listDevices:async()=>{reads++;return [];}}};
 const phone=new Phone(store,{phoneUse:driver});phone.remoteMaintenance=true;
 const check=error=>error.code==='remote_connection_maintenance'&&error.dispatchState==='not_sent';
 assert.throws(()=>phone.acquire('t'),check);assert.equal(phone.lease,null);assert.throws(()=>phone.phoneUseDevice(),check);
 for(const call of [()=>phone.call('status'),()=>phone.status(),()=>phone.devices(),()=>phone.capabilities(),()=>phone.listApps('文件'),()=>phone.resolveApp('com.sec.android.app.myfiles'),()=>phone.pair(),()=>phone.captureStableFrame('t',{deadline:Date.now()+1000}),()=>phone.start()])await assert.rejects(call(),check);
 assert.equal(reads,0);await phone.setRemoteTransport({dataPort:34561,controlPort:34562});assert.equal(phone.remoteMaintenance,true,'only the renewal owner may clear maintenance after all steps succeed');
 phone.remoteMaintenance=false;assert.equal((await phone.status()).connected,true);assert.equal(reads,1);
});
