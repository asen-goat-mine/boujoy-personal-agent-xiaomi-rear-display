import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskContract} from '../src/core/task-contract.mjs';
import {phoneUseGrant,phoneUseCanObserve,classifyPhoneUseAction,effectGoalStatus} from '../src/adapters/phone-use.mjs';
import {buildSimplePhoneAction} from '../src/adapters/simple-phone-use.mjs';
const apps={wechat:{packageName:'com.tencent.mm',appName:'微信'},settings:{packageName:'com.android.settings',appName:'设置'},clock:{packageName:'com.sec.android.app.clockpackage',appName:'时钟'},calendar:{packageName:'com.samsung.android.calendar',appName:'日历'}};
function task(content){const task={id:'t',status:'running',source:'user',cloudConsent:true,messages:[{id:'u',role:'user',content}]};task.taskContract=createTaskContract(task);return task;}
function tree(app,body){return {content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',timezone:'Asia/Shanghai',foreground:app.packageName+'/Activity',windowPkg:app.packageName,tree:`window pkg=${app.packageName} bounds=0,0,1000,2000\n${body}`}})}]};}
function observe(app,body){return {taskId:'t',id:'o',at:Date.now(),stability:'fresh',stabilityScope:'phone_use',tree:tree(app,body),ocr:{width:1000,height:2000,lines:[]}};}
const body=(value='',recipient='张三')=>`TextView "${recipient}" bounds=100,50,600,120\nEditText "消息" "${value}" editable focused clickable bounds=100,1600,700,1700\nButton "发送" clickable bounds=750,1600,950,1700`;
const sendTap={action:'tap',observationId:'o',x:850,y:1650};
const classify=(obs,args,grant)=>classifyPhoneUseAction('t',args,obs,grant);
test('contract-bound send can enter the app and type only exact requested content into the correct recipient editor',()=>{
 const t=task('在微信给张三发送“我十分钟到”'),grant=phoneUseGrant(t,apps.wechat);assert.equal(grant.mode,'task_effects');assert.equal(phoneUseCanObserve('t',tree(apps.wechat,body()),grant),true);
 const args={action:'type',observationId:'o',text:'我十分钟到',inputMode:'replace'};
 assert.equal(classify(observe(apps.wechat,body()),args,grant)?.kind,'effect_message_input');
 for(const patch of [{text:'我半小时到'},{inputMode:'insert'}])assert.equal(classify(observe(apps.wechat,body()),{...args,...patch},grant),null);
 assert.equal(classify(observe(apps.wechat,body('','李四')),args,grant),null);
 assert.equal(classify(observe(apps.wechat,body('旧草稿')),args,grant)?.kind,'effect_message_input','the current task replaces old text only in its bound recipient');
 assert.equal(phoneUseGrant({...t,taskContract:{...t.taskContract,objects:{...t.taskContract.objects,recipient:'李四'}}},apps.wechat),null);
 assert.equal(phoneUseGrant({...t,messages:[{...t.messages[0],content:'查看微信消息'}]},apps.wechat),null);
});
test('send target requires exact recipient/body and completion requires a new observed message plus cleared editor',()=>{
 const t=task('在微信给张三发送“我十分钟到”'),grant=phoneUseGrant(t,apps.wechat),before=observe(apps.wechat,body('我十分钟到'));
 const decision=classify(before,sendTap,grant);assert.equal(decision.kind,'effect_send');assert.equal(decision.witness.beforeCount,0);
 for(const changed of [body('我十分钟到','李四'),body('我半小时到'),body('我十分钟到')+'\nEditText [password] editable password bounds=0,500,600,600'])assert.equal(classify(observe(apps.wechat,changed),sendTap,grant),null);
 const sent={status:'completed',phoneEffect:decision};
 assert.equal(effectGoalStatus(before,grant,[sent]).verified,false,'native input receipt alone is insufficient');
 const after=observe(apps.wechat,body()+'\nTextView "我十分钟到" bounds=100,900,700,1000');
 assert.equal(effectGoalStatus(after,grant,[sent]).verified,true);
 assert.equal(effectGoalStatus(after,grant,[]).verified,false);
 assert.equal(effectGoalStatus({...after,at:Date.now()-50000},grant,[sent]).verified,false);
 assert.equal(effectGoalStatus(observe(apps.wechat,body('','李四')+'\nTextView "我十分钟到" bounds=100,900,700,1000'),grant,[sent]).verified,false);
});
test('settings contract permits only requested Bluetooth toggle and verifies actual post-state without a new approval',()=>{
 const t=task('打开设置，开启蓝牙'),grant=phoneUseGrant(t,apps.settings);assert.equal(grant?.mode,'task_effects');
 const before=observe(apps.settings,'Switch "蓝牙" clickable unchecked bounds=100,500,800,600');
 const args=buildSimplePhoneAction(before,{action:'tap',target:'蓝牙'},{taskId:'t',allowScopedControls:true});assert.equal(classify(before,args,grant)?.kind,'effect_setting_toggle');
 assert.equal(classify(observe(apps.settings,'Switch "WiFi" clickable unchecked bounds=100,500,800,600'),args,grant),null);
 const after=observe(apps.settings,'Switch "蓝牙" clickable checked bounds=100,500,800,600');assert.equal(effectGoalStatus(after,grant).verified,true);assert.equal(classify(after,args,grant),null,'do not toggle back after already reaching target');
 const readonly=phoneUseGrant(task('打开设置查看蓝牙'),apps.settings);assert.equal(classify(before,args,readonly),null);
});
test('numeric settings require a real identified text field and exact value; arbitrary slider coordinates never infer percent',()=>{
 const t=task('打开设置，把亮度调到30%'),grant=phoneUseGrant(t,apps.settings);assert.equal(grant?.mode,'task_effects');
 const args={action:'type',observationId:'o',text:'30',inputMode:'replace'};
 assert.equal(classify(observe(apps.settings,'EditText "亮度" editable focused bounds=100,500,800,600'),args,grant)?.kind,'effect_setting_input');
 assert.equal(classify(observe(apps.settings,'EditText "音量" editable focused bounds=100,500,800,600'),args,grant),null);
 assert.equal(classify(observe(apps.settings,'SeekBar "亮度" clickable bounds=100,500,800,600'),{action:'tap',observationId:'o',x:300,y:550},grant),null);
 assert.equal(effectGoalStatus(observe(apps.settings,'TextView "亮度" "30%" bounds=100,500,800,600'),grant).verified,true);
 assert.equal(effectGoalStatus(observe(apps.settings,'TextView "亮度" "60%" bounds=100,500,800,600'),grant).verified,false);
});
test('dated alarm cannot be saved without the actual requested date and requires one enabled matching entry afterwards',()=>{
 const t=task('在时钟设置明早8点闹钟'),grant=phoneUseGrant(t,apps.clock);assert.equal(grant?.effectPlan?.kind,'alarm');const date=grant.effectPlan.date;assert.match(date,/^\d{4}-\d{2}-\d{2}$/);
 const base='TextView "08:00" "不重复" bounds=100,400,600,500\nButton "保存" clickable bounds=700,1600,950,1700';
 assert.equal(classify(observe(apps.clock,base),sendTap,grant),null);
 const decision=classify(observe(apps.clock,base+`\nTextView "${date}" bounds=100,600,600,700`),sendTap,grant);assert.equal(decision?.kind,'effect_schedule_save');
 const row=`Switch "08:00" "${date}" "不重复" checked bounds=100,400,900,600`,saved={status:'completed',phoneEffect:decision};assert.equal(effectGoalStatus(observe(apps.clock,row),grant,[saved]).verified,false);
 const list=`RecyclerView bounds=0,300,1000,1800\nView "08:00" "${date}" "不重复" clickable bounds=100,400,900,650\n  Switch "启用闹钟" checked bounds=700,500,890,600`;
 const reopened=classifyPhoneUseAction('t',{...sendTap,x:300,y:450},observe(apps.clock,list),grant,[saved]);assert.equal(reopened?.kind,'effect_schedule_reopen');assert.equal(effectGoalStatus(observe(apps.clock,row),grant,[saved,{status:'completed',phoneEffect:reopened}]).verified,true);
 assert.equal(effectGoalStatus(observe(apps.clock,row.replace('checked','unchecked')),grant,[{status:'completed',phoneEffect:decision}]).verified,false);
});
test('calendar save binds title date and time, and cannot claim a different event as completed',()=>{
 const t=task('在日历创建明天9点日程“项目会议”'),grant=phoneUseGrant(t,apps.calendar);assert.equal(grant?.effectPlan?.kind,'calendar');const plan=grant.effectPlan;
 const form=`TextView "${plan.time}" "${plan.date}" "${plan.title}" "不重复" bounds=100,400,900,700\nButton "保存" clickable bounds=750,1600,950,1700`;
 const decision=classify(observe(apps.calendar,form),sendTap,grant);assert.equal(decision?.kind,'effect_schedule_save');
 const after=`TextView "${plan.time}" "${plan.date}" "${plan.title}" "不重复" bounds=100,400,900,700`,saved={status:'completed',phoneEffect:decision};assert.equal(effectGoalStatus(observe(apps.calendar,after),grant,[saved]).verified,false);
 const reopened=classifyPhoneUseAction('t',{...sendTap,x:300,y:450},observe(apps.calendar,'RecyclerView bounds=0,300,1000,1800\n'+after.replace(' bounds=',' clickable bounds=')),grant,[saved]);assert.equal(reopened?.kind,'effect_schedule_reopen');assert.equal(effectGoalStatus(observe(apps.calendar,after),grant,[saved,{status:'completed',phoneEffect:reopened}]).verified,true);
 assert.equal(effectGoalStatus(observe(apps.calendar,after.replace(plan.title,'别的会议')),grant,[{status:'completed',phoneEffect:decision}]).verified,false);
});
test('message body proof preserves whitespace instead of treating a different text as exact content',()=>{
 const grant=phoneUseGrant(task('在微信给张三发送“a b”'),apps.wechat);
 assert.equal(classify(observe(apps.wechat,body('ab')),sendTap,grant),null);
 assert.equal(classify(observe(apps.wechat,body('a b')),sendTap,grant)?.kind,'effect_send');
});
test('outgoing call requires explicit call intent and an exact unique number, followed by observed call state',()=>{
 const app={packageName:'com.samsung.android.dialer',appName:'电话'},t=task('拨打13800138000'),grant=phoneUseGrant(t,app);assert.equal(grant?.effectPlan?.kind,'call');
 const dial='TextView "13800138000" bounds=100,200,600,300\nButton "拨打" clickable bounds=750,1600,950,1700',decision=classify(observe(app,dial),sendTap,grant);assert.equal(decision?.kind,'effect_call');
 assert.equal(classify(observe(app,dial.replace('13800138000','13800138001')),sendTap,grant),null);
 assert.equal(classify(observe(app,dial+'\nTextView "13800138001" bounds=100,400,600,500'),sendTap,grant),null);
 const incall={packageName:'com.samsung.android.incallui'},screen='TextView "13800138000" bounds=100,200,600,300\nTextView "正在呼叫" bounds=100,400,600,500\nButton "挂断" clickable bounds=100,1600,600,1700';
 const result=effectGoalStatus(observe(incall,screen),grant,[{status:'completed',phoneEffect:decision}]);assert.equal(result.verified,true);assert.equal(result.phase,'dialing');
 assert.equal(effectGoalStatus(observe(incall,screen.replace('正在呼叫','通话结束')),grant,[{status:'completed',phoneEffect:decision}]).verified,false);
 const readonly=task('在电话查看张三的号码，不要打电话');assert.equal(readonly.taskContract.effects.includes('call'),false);
});
test('contact call resolves a unique visible number for the exact requested contact before dialing',()=>{
 const app={packageName:'com.samsung.android.dialer',appName:'电话'},grant=phoneUseGrant(task('给张三打电话'),app);assert.equal(grant.effectPlan.recipient,'张三');
 const profile='TextView "张三" bounds=100,50,600,120\nTextView "13800138000" bounds=100,400,600,500\nButton "拨打" clickable bounds=750,1600,950,1700';
 assert.equal(classify(observe(app,profile),sendTap,grant)?.witness.number,'13800138000');assert.equal(classify(observe(app,profile.replace('张三','李四')),sendTap,grant),null);
});


test('an observed empty chat editor can be focused by semantic target only in the bound recipient',()=>{
 const t=task('在微信给张三发送“我十分钟到”'),grant=phoneUseGrant(t,apps.wechat);
 const current=observe(apps.wechat,'TextView "张三" bounds=100,50,600,120\nEditText editable clickable bounds=100,1600,700,1700');
 const args=buildSimplePhoneAction(current,{action:'tap',target:'消息输入框'},{taskId:'t',allowScopedControls:true});
 assert.equal(classify(current,args,grant)?.kind,'effect_message_focus');
 assert.equal(classify(observe(apps.wechat,'TextView "李四" bounds=100,50,600,120\nEditText editable clickable bounds=100,1600,700,1700'),args,grant),null);
 assert.equal(buildSimplePhoneAction({...current,tree:tree(apps.wechat,'TextView "张三" bounds=100,50,600,120\nEditText editable clickable bounds=100,1400,700,1500\nEditText editable clickable bounds=100,1600,700,1700')},{action:'tap',target:'消息输入框'},{taskId:'t',allowScopedControls:true}).y,1450);
});

test('opaque chat history cannot authorize a send or prove a second copy was delivered',()=>{
 const grant=phoneUseGrant(task('在微信给张三发送“a b”'),apps.wechat);
 const make=(rows,native='')=>{const o=observe(apps.wechat,native);o.ocr.lines=rows.map(([text,x,y,id])=>({text,id,bounds:[x,y,x+90,y+30],center:{x:x+45,y:y+15}}));return o;};
 const title=['张三',430,70,'header'],send=['发送',830,1620,'send'],draft=['a b',200,1618,'draft'],bubble=['a b',610,550,'bubble'];
 const press={action:'tap',observationId:'o',textTargetId:'send'};
 for(const o of [make([title,bubble,send]),make([title,['ab',200,1618,'draft'],send]),make([title,['a b extra',200,1618,'draft'],send]),make([title,draft,send],body('wrong')),make([title,draft,send,['发送',820,1200,'other-send']])])assert.equal(classify(o,press,grant),null);
 const decision=classify(make([title,bubble,draft,send]),press,grant);assert.equal(decision?.witness.requiresEditorProof,true);assert.equal(decision.witness.beforeOcrCount,1);
 const completed={status:'completed',phoneEffect:decision};
 assert.equal(effectGoalStatus(make([title,bubble]),grant,[completed]).verified,false,'an old matching bubble plus disappeared send button proves nothing');
 assert.equal(effectGoalStatus(make([title,bubble,['a b',615,1180,'new']]),grant,[completed]).verified,true);
});

test('opaque send needs exact bound read-only IME proof and unchanged device and control through the read',async()=>{
 const {verifyOpaqueSend}=await import('../src/tools/broker.mjs');const scope={effectPlan:{content:'a b'},packageName:'app.chat'},d={witness:{requiresEditorProof:true}},task={id:'t',remoteDeviceId:'bound'},native={packageName:'app.chat',deviceId:'native'},obs={native,at:Date.now()},binding={deviceId:'bound',certificateFingerprint:'cert',fresh:true};
 for(const variant of ['ok','wrongRef','absent','epoch','recipient','pause','swap','aborted']){
  let paused=false,device=binding,reads=0;const controller=new AbortController();const phone={lease:'t',phoneUseDevice:()=>'native',observation:obs,remoteControlState:()=>({paused,controlEpoch:22}),remoteDeviceTelemetry:()=>device,ime:{verify:async input=>{reads++;assert.deepEqual(input,{text:'a b',packageName:'app.chat',controlEpoch:22,referenceId:'new-confirmation'});if(variant==='pause')paused=true;if(variant==='swap')device={...binding,deviceId:'other'};return {status:variant==='absent'?'unverified':'verified',proof:{referenceId:variant==='wrongRef'?'other':'new-confirmation',controlEpoch:variant==='epoch'?23:22,editorIdentity:'editor'}};}}};
  if(variant==='aborted')controller.abort();const run=()=>verifyOpaqueSend(phone,task,scope,d,variant==='recipient'?{...obs,native:{...native,packageName:'other'}}:obs,'new-confirmation',controller.signal);
  if(variant==='ok')await run();else await assert.rejects(run(),e=>e.code==='editor_not_verified'&&e.dispatchState==='not_sent');assert.ok(reads<=1);
 }
});

test('a new send cannot use a covered native editor or a readback during which a system window took the foreground',async()=>{
 const {verifyOpaqueSend}=await import('../src/tools/broker.mjs'),target={window_id:2,display_id:0,type:1,layer:0,bounds:[0,0,1000,2400],active:true,focused:true};
 const overlay={...target,window_id:3,type:3,layer:100};
 for(const when of ['before','during','native-editor']){
  const native={windowId:2,windows:[{...target}],deviceId:'native',packageName:'app.chat'};
  const cover=()=>{native.windows[0].active=false;native.windows[0].focused=false;native.windows.push(overlay);};
  const observation={native,at:Date.now()},task={id:'t',remoteDeviceId:'phone'},scope={packageName:'app.chat',effectPlan:{content:'draft'}};let reads=0;
  const phone={lease:'t',observation,phoneUseDevice:()=>'native',remoteDeviceTelemetry:()=>({fresh:true,deviceId:'phone',certificateFingerprint:'cert'}),remoteControlState:()=>({paused:false,controlEpoch:1}),ime:{verify:async()=>{reads++;cover();return {status:'verified',proof:{referenceId:'proof',controlEpoch:1,editorIdentity:'editor'}};}}};
  if(when!=='during')cover();
  await assert.rejects(verifyOpaqueSend(phone,task,scope,{kind:'effect_send',witness:{requiresEditorProof:when!=='native-editor'}},observation,'proof'),e=>e.code==='editor_not_verified'&&e.dispatchState==='not_sent');
  assert.equal(reads,when==='during'?1:0);
 }
});
