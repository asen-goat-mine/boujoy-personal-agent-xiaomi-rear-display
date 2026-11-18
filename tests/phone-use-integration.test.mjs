import test from 'node:test';
import assert from 'node:assert/strict';
import {Phone} from '../src/adapters/phone.mjs';
import {Broker} from '../src/tools/broker.mjs';
import {Engine} from '../src/core/engine.mjs';
import {createTaskContract} from '../src/core/task-contract.mjs';
const WEATHER={packageName:'com.example.weather',label:'天气',aliases:['天气','Weather']};
const SETTINGS={packageName:'com.android.settings',label:'设置',aliases:['设置','Settings']};
const WECHAT={packageName:'com.tencent.mm',label:'微信',aliases:['微信','WeChat']};
const line=(id,text,y=200,x=100,width=500)=>({id,text,bounds:[x,y,x+width,y+60],center:{x:x+width/2,y:y+30}});
function tree(pkg,body='',{foreground=pkg+'/Activity',display='main'}={}){
 return {content:[{type:'text',text:JSON.stringify({ok:true,result:{display,foreground,windowPkg:pkg,window:'main',tree:'window pkg='+pkg+' bounds=0,0,1000,2000\n'+body}})}]};
}
const frame=(pkg,lines=[],body='',extra)=>({tree:tree(pkg,body,extra),ocr:{width:1000,height:2000,lines}});
const weatherHome=()=>frame(WEATHER.packageName,[line('search','搜索')],'Button "搜索" clickable bounds=100,200,600,260');
const weatherInput=(value='')=>frame(WEATHER.packageName,[line('input',value||'搜索城市',200,100,650),line('search','搜索',200,820,150)],
 'EditText "搜索城市" editable focused clickable bounds=100,200,750,260\n Button "搜索" clickable bounds=820,200,970,260');
const weatherResult=()=>frame(WEATHER.packageName,[line('city','上海',200),line('temp','当前温度 18°C',500),line('details','详情',800)],
 'Button "详情" clickable bounds=100,800,600,860');
const settingHome=()=>frame(SETTINGS.packageName,[line('battery','电池')],'Button "电池" clickable bounds=100,200,600,260');
const battery=()=>frame(SETTINGS.packageName,[line('title','电池用量'),line('level','当前电量80%',500)]);
const contacts=()=>frame(WECHAT.packageName,[line('contacts','通讯录'),line('chat','聊天',500)],'Button "通讯录" clickable bounds=100,200,600,260\n Text "聊天" bounds=100,500,600,560');
function fixture({prompt='打开天气，搜索上海',app=WEATHER,current=weatherHome(),opened=current,next=[]}={}){
 const task={id:'t',source:'user',status:'running',kind:'general',depth:0,parentId:null,phoneQuery:null,phoneUseScope:null,prompt,messages:[{id:'human-current',role:'user',content:prompt}],quotes:[],children:[],events:[]};
 const data={tasks:[task],actions:[],artifacts:[],roles:[{id:'concierge',hidden:false}],settings:{phoneEnabled:true,memoryEnabled:false}};
 let state=current,queue=[...next],approvalCount=0,finished=0;const calls=[],directoryCalls=[];
 const store={data,task(id){assert.equal(id,'t');return task;},event(){},transaction(fn){return fn(data);},updateTask(id,fn){assert.equal(id,'t');fn(task,data);return task;}};
 const phone=new Phone(store,{wait:async()=>{},recognize:async image=>JSON.parse(Buffer.from(image.content[0].data,'base64').toString()).ocr});
 phone.apps={list:async query=>{directoryCalls.push({method:'list',query});return {source:'adb',cached:false,apps:[{...app}],totalMatched:1};},resolve:async packageName=>{directoryCalls.push({method:'resolve',packageName});assert.equal(packageName,app.packageName);return {...app,source:'adb',cached:false};}};
 phone.call=async(name,args)=>{
  calls.push({name,args});assert.equal(args.display,'main');
  if(name==='ui_tree')return state.tree;
  if(name==='screenshot')return {content:[{type:'image',mimeType:'image/png',data:Buffer.from(JSON.stringify(state)).toString('base64')}]};
  if(name==='open_app'){assert.equal(args.packageName,app.packageName);state=opened;return {content:[{type:'text',text:'{"ok":true}'}]};}
  if(['tap','long_press','type','key','swipe'].includes(name)){if(queue.length)state=queue.shift();return {content:[{type:'text',text:'{"ok":true}'}]};}
  if(name==='wait_idle')return {content:[{type:'text',text:'{"ok":true,"result":{"settled":true,"waitedMs":0}}'}]};
  throw Error('Unexpected '+name);
 };
 const approvals={request:async()=>{approvalCount++;},cancelTask(){}};
 const broker=new Broker({store,phone,approvals});broker.engine={finishReport(){finished++;task.status='completed';task.result=task.report.summary;},blockToolFailure(){}};
 return {task,data,store,phone,broker,calls,directoryCalls,approvals,counts:()=>({approvals:approvalCount,finished}),setState(s){state=s;}};
}
const object=r=>r.content.filter(c=>c.type==='text').map(c=>{try{return JSON.parse(c.text);}catch{return null;}}).filter(Boolean);
const observation=r=>object(r).find(o=>o.observationId||o.stability);
const action=(id,target)=>({observationId:id,action:'tap',textTargetId:target,reason:'Only current app navigation'});

test('target already in actual main foreground is observed once without redundant open_app',async()=>{
 const f=fixture(),result=await f.broker.execute('t','phone_open_app',{packageName:WEATHER.packageName}),info=object(result)[0];
 assert.equal(info.alreadyForeground,true);assert.equal(f.calls.some(c=>c.name==='open_app'),false);assert.equal(f.calls.filter(c=>c.name==='screenshot').length,1);assert.ok(observation(result).observationId);
});
test('windowPkg alone is not evidence of target main foreground and must still launch the requested app',async()=>{
 for(const extra of [{foreground:'com.other/Activity'},{display:'background'}]){
  const current=weatherHome();current.tree=tree(WEATHER.packageName,'',extra);
  const f=fixture({current,opened:weatherHome()}),result=await f.broker.execute('t','phone_open_app',{packageName:WEATHER.packageName});
  assert.equal(object(result)[0].alreadyForeground,false);assert.equal(f.calls.filter(c=>c.name==='open_app').length,1);assert.ok(observation(result).observationId);
 }
});
test('opening the user-named app returns its page without granting a send',async()=>{
 const blocked=fixture({prompt:'打开微信',app:WECHAT,current:contacts()});
 const hidden=await blocked.broker.execute('t','phone_open_app',{packageName:WECHAT.packageName});assert.equal(observation(hidden).stability,'fresh');assert.equal(hidden.content.some(c=>c.type==='image'),true);assert.equal(blocked.calls.some(c=>['tap','type'].includes(c.name)),false);
 const permitted=fixture({prompt:'打开微信，查看张三的聊天消息，不发送',app:WECHAT,current:contacts()});
 const shown=await permitted.broker.execute('t','phone_open_app',{packageName:WECHAT.packageName});assert.equal(observation(shown).stabilityScope,'general');assert.equal(permitted.task.phoneUseScope.mode,'general');assert.ok(shown.content.some(c=>c.type==='image'));
});
test('cancel during installed-directory lookup prevents launch and screen reads',async()=>{
 const f=fixture({current:frame('com.android.launcher',[]),opened:weatherHome()}),controller=new AbortController();
 const original=f.phone.apps.resolve;f.phone.apps.resolve=async(...args)=>{controller.abort();return original(...args);};
 await assert.rejects(f.broker.execute('t','phone_open_app',{packageName:WEATHER.packageName},controller.signal),e=>e.code==='cancelled');
 assert.equal(f.calls.length,0);assert.equal(f.data.actions.length,0);
});
test('cancel while generic app effect transport starts prevents RPC launch after reconnect',async()=>{
 const f=fixture({current:frame('com.android.launcher',[]),opened:weatherHome()}),controller=new AbortController();
 const engine=new Engine({store:f.store,broker:f.broker,secrets:{},memory:{}});engine.active.set('t',{controller,run:{stop:async()=>{}}});
 const original=f.phone.call;let starts=0,begin,release;const began=new Promise(resolve=>{begin=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const rpc={request:async(method,params)=>original(params.name,params.arguments)};
 f.phone.start=async()=>{if(++starts===2){begin();await gate;}return rpc;};f.phone.call=Phone.prototype.call.bind(f.phone);
 const pending=f.broker.execute('t','phone_open_app',{packageName:WEATHER.packageName},controller.signal),outcome=assert.rejects(pending,e=>e.code==='action_cancelled');
 await began;await engine.stop('t',{pause:true});release();await outcome;
 assert.equal(f.calls.some(c=>c.name==='open_app'),false);assert.equal(f.data.actions[0].status,'not_executed');assert.notEqual(f.task.status,'unknown_result');
});
test('cancellation before a general input prevents dispatch without requiring another screen read',async()=>{
 const f=fixture({current:weatherInput()}),m=observation(await f.broker.execute('t','phone_open_app',{packageName:WEATHER.packageName})),controller=new AbortController();
 controller.abort();const start=f.calls.length;
 await assert.rejects(f.broker.execute('t','phone_action',{observationId:m.observationId,action:'type',text:'上海',inputMode:'replace',reason:'Search current city'},controller.signal),e=>e.code==='cancelled');
 assert.equal(f.calls.length,start);assert.equal(f.data.actions.length,0);
});

test('real Broker→Phone settings goal may use settings search without explicit search wording',async()=>{
 const home=frame(SETTINGS.packageName,[line('search','搜索设置')],'Button "搜索设置" clickable bounds=100,200,600,260');
 const input=frame(SETTINGS.packageName,[line('input','搜索设置')],'EditText "搜索设置" editable focused clickable bounds=100,200,750,260');
 const typed=frame(SETTINGS.packageName,[line('input','电池'),line('battery','电池',650)],'EditText "搜索设置" editable focused clickable bounds=100,200,750,260\n Button "电池" clickable bounds=100,650,600,710');
 const f=fixture({prompt:'打开设置里的电池页面，查看电量，再返回设置首页',app:SETTINGS,current:home,next:[input,typed,battery(),home]});
 let m=observation(await f.broker.execute('t','phone_open_app',{packageName:SETTINGS.packageName}));
 assert.equal(f.task.phoneUseScope.mode,'general');
 m=observation(await f.broker.execute('t','phone_action',action(m.observationId,'search')));
 assert.equal(m.stability,'fresh','Native search focus changed although the OCR label and bounds stayed identical');
 m=observation(await f.broker.execute('t','phone_action',{observationId:m.observationId,action:'type',text:'电池',inputMode:'replace',reason:'Search user requested settings section'}));
 m=observation(await f.broker.execute('t','phone_action',action(m.observationId,'battery')));
 assert.equal(f.phone.observation.ocr.lines[1].text,'当前电量80%');
 m=observation(await f.broker.execute('t','phone_action',{observationId:m.observationId,action:'back',reason:'Return to requested settings home'}));
 await f.broker.execute('t','finish_task',{outcome:'completed',summary:'电量80%，已返回设置首页',evidence:[m.observationId]});
 assert.deepEqual(f.calls.filter(c=>['tap','type','key','swipe'].includes(c.name)).map(c=>c.name),['tap','type','tap','key']);
 assert.deepEqual(f.counts(),{approvals:0,finished:1});
});

test('for a direct user task the model report finishes even business effects; the contract still records them',async()=>{
 for(const prompt of ['在微信给张三发送消息','打开设置删除文件','在微信拨打张三的电话','在小红书发布“测试”']){
  const f=fixture({prompt});f.task.taskContract=createTaskContract(f.task);
  assert.ok(f.task.taskContract.effects.some(effect=>['send','delete','call','publish'].includes(effect)),prompt);
  await f.broker.execute('t','finish_task',{outcome:'completed',summary:'模型称已经完成',evidence:[]});assert.equal(f.task.status,'completed');
 }
});
test('phone_use long_press resolves only the exact requested native target and verifies its actual selection menu',async()=>{
 const app={packageName:'com.sec.android.app.myfiles',label:'文件',aliases:['文件']};
 const current=frame(app.packageName,[line('file','报告.txt')],'TextView "报告.txt" long_clickable bounds=100,200,600,260');
 const menu=frame(app.packageName,[line('copy','复制',500),line('share','分享',650)],'PopupWindow bounds=0,0,1000,2000\n Button "复制" clickable bounds=100,500,600,560\n Button "分享" clickable bounds=100,650,600,710');
 const f=fixture({prompt:'打开文件，长按“报告.txt”',app,current,next:[menu]});f.task.taskContract=createTaskContract(f.task);
 await f.broker.execute('t','phone_use',{action:'open_app',app:'文件'});
 const result=observation(await f.broker.execute('t','phone_use',{action:'long_press',target:'报告.txt'}));assert.equal(result.stability,'fresh');assert.equal(f.calls.filter(c=>c.name==='long_press').length,1);
 assert.equal(f.calls.filter(call=>call.name==='tap').length,0);
 await f.broker.execute('t','finish_task',{outcome:'completed',summary:'报告.txt的选择菜单已打开',evidence:[result.observationId]});assert.equal(f.task.status,'completed');
});

test('phone execution revocation before dispatch remains effective after re-enabling',async()=>{
 const {setExecutionPermissions}=await import('../src/core/execution-permissions.mjs');const f=fixture();const meta=observation(await f.broker.execute('t','phone_open_app',{packageName:WEATHER.packageName})),original=f.phone.actGeneral.bind(f.phone);
 f.phone.actGeneral=async(...args)=>{await setExecutionPermissions({store:f.store},{phoneEnabled:false});await setExecutionPermissions({store:f.store},{phoneEnabled:true});f.task.status='running';return original(...args);};
 await assert.rejects(f.broker.execute('t','phone_action',action(meta.observationId,'search')),e=>e.code==='execution_revoked');assert.equal(f.calls.some(call=>call.name==='tap'),false);assert.equal(f.data.actions[0].status,'not_executed');
});

function returningChild({next=[],unconfirmed=false}={}){
 const child='org.example.settingshelper',current=frame(child,[line('private','AUXILIARY-DATA')],'TextView "AUXILIARY-DATA" bounds=100,200,600,260');
 const f=fixture({prompt:'打开设置，查看电池',app:SETTINGS,current,opened:current,next:next.map(p=>p==='parent'?settingHome():p==='foreign'?frame('org.other.app',[line('secret','FOREIGN-DATA')]):current)});
 f.data.tasks.push({id:'prior',phoneUseScope:{mode:'general',packageName:SETTINGS.packageName,returnWindow:{key:JSON.stringify(['device','service',2,child]),at:Date.now()}}});
 const capture=f.phone.captureStableFrame.bind(f.phone);
 f.phone.captureStableFrame=async(...args)=>{
  const p=await capture(...args),pkg=JSON.parse(p.tree.content[0].text).result.windowPkg,id=pkg===child?2:pkg===SETTINGS.packageName?1:3;
  return {...p,native:{packageName:pkg,deviceId:'device',serviceInstanceId:'service',windowId:id,windows:[{display_id:0,window_id:id,type:1,active:true}],elements:[]}};
 };
 if(unconfirmed){const call=f.phone.call;f.phone.call=async(name,args)=>{if(name==='key')throw Object.assign(new Error('lost receipt'),{code:'outcome_unknown',requestId:'original-back'});return call(name,args);};}
 return f;
}