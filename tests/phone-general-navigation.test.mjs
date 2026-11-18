import test from 'node:test';
import assert from 'node:assert/strict';
import {generalAppGrant,classifyGeneralAction} from '../src/adapters/phone-general-navigation.mjs';

const WECHAT='com.tencent.mm';
const task=(content,extra={})=>({id:'t',source:'user',status:'running',depth:0,messages:[{id:'m',role:'user',content}],...extra});
const app={packageName:WECHAT,label:'微信',appName:'微信'};
const line=(id,text,y,x=500)=>({id,text,bounds:[x-80,y-30,x+80,y+30],center:{x,y}});
function frame(lines,{pkg=WECHAT,tree=''}={}){
  return {id:'obs',taskId:'t',at:Date.now(),ocr:{width:1000,height:2000,lines},
    tree:{content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:pkg,windowPkg:pkg,tree:`window pkg=${pkg} id=1 bounds=0,0,1000,2000\nFrameLayout bounds=0,0,1000,2000\n${tree}`}})}]}};
}
const grant={taskId:'t',packageName:WECHAT,appName:'微信',mode:'general'};
const tap=id=>({observationId:'obs',action:'tap',textTargetId:id});

test('an app named together with a concrete task is operable without a hand-written scenario',()=>{
  assert.equal(generalAppGrant(task('在微信文件助手里发句你好'),app)?.mode,'general');
  assert.equal(generalAppGrant(task('打开小红书搜一下露营装备'),{packageName:'com.xingin.xhs',label:'小红书'})?.packageName,'com.xingin.xhs');
});
test('a direct user task gives the Harness the app it opens; external text and delegated requests get no grant',()=>{
  for(const content of ['打开微信','在支付宝里看看账单','不要打开微信，帮我查天气'])assert.equal(generalAppGrant(task(content),app)?.decisionOwner,'harness',content);
  assert.equal(generalAppGrant({...task('在微信发句你好'),messages:[{id:'m',role:'user',content:'在微信发句你好',externalContent:true}]},app),null);
  assert.equal(generalAppGrant(task('在微信发句你好',{source:'delegation'}),app),null);
  assert.equal(generalAppGrant(task('在微信发句你好',{taskContract:{objects:{mailRequested:true}}}),app)?.mode,'general');
});
test('browsing, typing, scrolling and going back run automatically inside the named app',()=>{
  const f=frame([line('chat','文件传输助手',400),line('close','关闭',150,900)]);
  assert.equal(classifyGeneralAction('t',tap('chat'),f,grant).kind,'general_tap');
  assert.equal(classifyGeneralAction('t',tap('close'),f,grant).kind,'general_tap');
  assert.equal(classifyGeneralAction('t',{observationId:'obs',action:'type',text:'你好'},f,grant).kind,'general_type');
  assert.equal(classifyGeneralAction('t',{observationId:'obs',action:'swipe',x1:500,y1:1500,x2:500,y2:500},f,grant).kind,'general_scroll');
  assert.equal(classifyGeneralAction('t',{observationId:'obs',action:'back'},f,grant).kind,'general_back');
});
test('irreversible controls and switches need the user to confirm',()=>{
  for(const text of ['发送','删除','发布','关注','确定'])assert.equal(classifyGeneralAction('t',tap('x'),frame([line('x',text,1800)]),grant)?.confirm,true,text);
  const toggle=frame([line('x','夜间模式',600)],{tree:'Switch checkable unchecked clickable bounds=380,560,620,640'});
  assert.equal(classifyGeneralAction('t',tap('x'),toggle,grant)?.confirm,true);
});
test('payment, passwords and verification codes are handed to the user',()=>{
  for(const text of ['立即支付','确认付款','输入密码','获取验证码','转账'])assert.equal(classifyGeneralAction('t',tap('x'),frame([line('x',text,1800)]),grant)?.handoff,true,text);
  assert.equal(classifyGeneralAction('t',tap('i'),frame([line('t','收银台',100),line('i','微信支付',900)]),grant)?.handoff,true);
  assert.equal(classifyGeneralAction('t',{observationId:'obs',action:'type',text:'123456'},frame([line('p','密码',600)],{tree:'EditText password focused editable bounds=0,560,1000,640'}),grant)?.handoff,true);
});
test('another app in front, a stale frame or a foreign observation gets nothing',()=>{
  assert.equal(classifyGeneralAction('t',tap('a'),frame([line('a','设置',300)],{pkg:'com.android.settings'}),grant),null);
  assert.equal(classifyGeneralAction('t',tap('a'),{...frame([line('a','聊天',300)]),at:Date.now()-60000},grant),null);
  assert.equal(classifyGeneralAction('t',{...tap('a'),observationId:'other'},frame([line('a','聊天',300)]),grant),null);
});

test('a return-only window cannot supply an input, click or scroll capability',()=>{
 const limited={...frame([]),returnOnly:true};
 assert.equal(classifyGeneralAction('t',{observationId:'obs',action:'back'},limited,grant)?.kind,'general_back');
 for(const action of ['tap','type','swipe','long_press'])assert.equal(classifyGeneralAction('t',{observationId:'obs',action},limited,grant),null);
});

test('only the observed companion window can return, without exposing its contents',async()=>{
 const {Phone}=await import('../src/adapters/phone.mjs');
 const parent='org.example.parent',child='org.example.aux';
 const scope={packageName:parent,appName:'Parent',mode:'general',taskId:'before'};
 const data={tasks:[{id:'before',phoneUseScope:scope},{id:'after',messages:[]}],settings:{}};
 const phone=Object.assign(Object.create(Phone.prototype),{store:{data,task:id=>data.tasks.find(t=>t.id===id),updateTask:(id,fn)=>fn(data.tasks.find(t=>t.id===id)),event(){}},clock:Date.now,acquire(){},isPhoneUse:()=>false});
 const native=(pkg,id)=>({packageName:pkg,deviceId:'d',serviceInstanceId:'s',windowId:id,windows:[{display_id:0,window_id:id,type:1,active:true}]});
 const page=(pkg,id)=>({at:Date.now(),native:native(pkg,id),tree:{content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',windowPkg:pkg,foreground:pkg,tree:'TextView "AUXILIARY-DATA" bounds=0,0,100,100'}})}]},ocr:{lines:[]},image:{content:[]}});
 phone.actionBaseline=page(parent,1);
 let current=page(child,2);phone.captureStableFrame=async()=>current;
 await phone.observeGeneral('before',scope,{afterAction:true});
 // Recreate persisted task state and discard the in-memory cache, as a service
 // reload does. Recovery still needs this exact device/service/window proof.
 data.tasks=JSON.parse(JSON.stringify(data.tasks));delete phone.returnWindows;
 const resumed={mode:'general',taskId:'after',packageName:parent,appName:'Parent'};
 let result=await phone.observeGeneral('after',resumed);
 assert.equal(result.meta.returnOnly,true);
 assert.doesNotMatch(JSON.stringify(result.content),/AUXILIARY-DATA/);
 assert.equal(phone.observation.tree,null);
 phone.actionBaseline=phone.observation;
 result=await phone.observeGeneral('after',resumed,{afterAction:true});
 assert.equal(result.meta.returnOnly,true,'closing a keyboard can leave the same bound child window in front');
 assert.equal(resumed.followedPackages,undefined);assert.doesNotMatch(JSON.stringify(result.content),/AUXILIARY-DATA/);
 current=page(child,3);
 result=await phone.observeGeneral('after',resumed);
 assert.equal(result.meta.reason,'outside_task_scope');assert.equal(phone.observation,null);
 current=page(child,2);current.native.serviceInstanceId='different-service';
 result=await phone.observeGeneral('after',resumed);
 assert.equal(result.meta.reason,'outside_task_scope');assert.equal(phone.observation,null);
 current=page(child,2);data.tasks[0].phoneUseScope.returnWindow.at=Date.now()-1800001;
 result=await phone.observeGeneral('after',resumed);
 assert.equal(result.meta.reason,'outside_task_scope');assert.equal(phone.observation,null);
});

// Device wording must not turn a general request into a dialer-only grant.
import {createTaskContract} from '../src/core/task-contract.mjs';
test('device nouns preserve model selection of installed apps without a task-specific flow',()=>{
 for(const content of ['Open Xianyu on my phone and compare used microphones. Only browse.', 'Find a useful note-taking app on my phone and show its available features.']){
  const t=task(content);t.taskContract=createTaskContract(t);assert.equal(t.taskContract.allowedApps.includes('Phone'),false);
  const selected=generalAppGrant(t,{packageName:'org.example.installed',appName:'本机实际安装的应用',label:'本机实际安装的应用'});assert.equal(selected?.decisionOwner,'harness');assert.equal(selected?.mode,'general');
 }
 for(const content of ['Open the Phone app', '打开Phone']){const t=task(content);t.taskContract=createTaskContract(t);assert.ok(t.taskContract.allowedApps.includes('Phone'));}
 const restricted=task('只在微信里查看消息');restricted.taskContract=createTaskContract(restricted);assert.equal(generalAppGrant(restricted,{packageName:'org.example.other',label:'Other App'})?.decisionOwner,'harness','the user\'s own limits are for the model to follow');
});
