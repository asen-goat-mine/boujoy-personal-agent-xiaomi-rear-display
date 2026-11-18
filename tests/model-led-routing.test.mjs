// 2026-10-31 architecture change: the model chooses tools and apps; the contract
// only withholds consequential effects the user did not ask for.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createTaskContract,validateTaskContract} from '../src/core/task-contract.mjs';
import {toolsForTask} from '../src/tools/broker.mjs';
import {generalAppGrant} from '../src/adapters/phone-general-navigation.mjs';
import {conversationTranscript,buildConversationContext} from '../src/core/conversation-context.mjs';
import {effectiveTimezone,systemTimezone} from '../src/core/timezone.mjs';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';

function task(prompt,extra={}){const value={id:'t',status:'running',source:'user',prompt,kind:'general',cloudConsent:true,memoryConsent:false,createdAt:'2026-10-31T10:00:00.000Z',messages:[{id:'u',role:'user',content:prompt,at:'2026-10-31T10:00:00.000Z'}],children:[],...extra};value.taskContract=createTaskContract(value);return value;}
const names=t=>toolsForTask(t).map(tool=>tool.name);

test('requests outside the old verb and app lists become tasks the model can act on',()=>{
 for(const prompt of ['小宇宙上有什么好听的AI播客','周杰伦最新的歌','你好，帮我看看明天天气','最近油价为什么涨了']){
  const t=task(prompt);assert.equal(t.taskContract.intent,'task',prompt);assert.ok(t.taskContract.effects.includes('navigate'),prompt);
  assert.ok(names(t).includes('phone_use'),prompt);assert.ok(names(t).includes('web_search'),prompt);
 }
 assert.equal(task('小宇宙上有什么好听的AI播客').taskContract.routing,'inferred');
 assert.equal(validateTaskContract(task('小宇宙上有什么好听的AI播客')).valid,true);
});
test('pure small talk and knowledge questions stay conversation; vague references ask',()=>{
 for(const prompt of ['你好','在吗？','什么是量子计算'])assert.equal(task(prompt).taskContract.intent,'conversation',prompt);
 {const chat=names(task('你好'));assert.ok(chat.includes('phone_use'),'a direct user chat keeps phone control; the model decides');for(const n of ['web_search','watch_cancel','routine_pause','task_lookup'])assert.ok(chat.includes(n),n);}
 for(const prompt of ['1','继续','那个东西'])assert.equal(task(prompt).taskContract.intent,'clarification',prompt);
});
test('inferred routing never grants consequential effects by itself',()=>{
 const t=task('小宇宙上有什么好听的AI播客');assert.deepEqual(t.taskContract.effects.sort(),['navigate','read']);
 const send=task('给张三发消息说“我到了”');assert.ok(send.taskContract.effects.includes('send'));assert.equal(send.taskContract.routing,undefined);
});
test('the Harness picks the app for a direct user task; a delegated task gets no grant of its own',()=>{
 const music=task('放首周杰伦的歌'),app={packageName:'com.tencent.qqmusic',label:'QQ音乐',appName:'QQ音乐',aliases:['QQ音乐']};
 // Direct user tasks: the Harness owns the choice of app, including following the user's own "don't".
 for(const prompt of ['放首周杰伦的歌','打开QQ音乐放首歌','放首歌，不要打开QQ音乐']){const grant=generalAppGrant(task(prompt),app);assert.equal(grant?.mode,'general',prompt);assert.equal(grant.decisionOwner,'harness',prompt);assert.equal(grant.sourceMessageId,'u');}
 assert.equal(generalAppGrant(task('放首周杰伦的歌',{source:'delegation',parentId:'p',depth:1}),app),null);
 assert.equal(generalAppGrant(task('你好',{messages:[]}),app),null,'no user message, no grant');
});
test('a new task in the same conversation sees the earlier turns in order',()=>{
 const first={id:'a',conversationId:'a',source:'user',createdAt:'2026-10-31T10:00:00.000Z',messages:[{id:'m1',role:'user',content:'帮我查一下明天洛杉矶天气',at:'2026-10-31T10:00:00.000Z'},{id:'m2',role:'assistant',content:'明天晴，18–26°C。',at:'2026-10-31T10:00:05.000Z'}]};
 const second={id:'b',conversationId:'a',source:'user',createdAt:'2026-10-31T10:01:00.000Z',messages:[{id:'m3',role:'user',content:'那后天呢',at:'2026-10-31T10:01:00.000Z'}]};
 const other={id:'c',conversationId:'c',source:'user',createdAt:'2026-10-31T09:00:00.000Z',messages:[{id:'x',role:'user',content:'别的对话',at:'2026-10-31T09:00:00.000Z'}]};
 const store={data:{tasks:[other,second,first]}};
 const merged=conversationTranscript(second,store);assert.deepEqual(merged.messages.map(m=>m.id),['m1','m2','m3']);
 const packed=buildConversationContext(merged);assert.match(packed.text,/洛杉矶天气/);assert.doesNotMatch(packed.text,/别的对话/);
 assert.equal(conversationTranscript(other,store),other);
});
test('time follows the Mac unless the user chose a zone; the old built-in default no longer forces Beijing time',()=>{
 assert.equal(effectiveTimezone({timezone:'Asia/Shanghai'}),systemTimezone());
 assert.equal(effectiveTimezone({timezone:'Asia/Shanghai',timezoneManual:true}),'Asia/Shanghai');
 assert.equal(effectiveTimezone({timezone:'America/New_York'}),'America/New_York');
 assert.equal(effectiveTimezone({timezone:'America/New_York',timezoneManual:false}),systemTimezone());
 assert.equal(effectiveTimezone({timezone:'Not/AZone',timezoneManual:true}),systemTimezone());
});

function fixture(t,reply){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-model-led-')),store=new Store(dir);
 const broker={calls:new Map(),approvals:{cancelTask(){}},phone:{release(){},close(){}},browser:{close(){}}};
 const engine=new Engine({store,broker,secrets:{get:async()=>'synthetic'},memory:{observe:async()=>{}},runFactory:options=>({async start(){reply(options,store);},async stop(){},async dispose(){}})});engine.pump=async()=>{};
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {store,engine};}
async function run(f,task){const active={taskId:task.id,controller:new AbortController(),token:'synthetic-token'};f.engine.active.set(task.id,active);f.engine.tokens.set(active.token,active);await f.engine.run(task.id,active);}
const say=text=>options=>options.onEvent({type:'assistant/message',data:{content:[{type:'text',text}]}});

test('an English answer is kept as the reply instead of being dropped as narration',async t=>{
 const f=fixture(t,say('Sure — here is the summary: the meeting moved to 3pm.'));const chat=f.engine.create({prompt:'什么是会议纪要',cloudConsent:true});await run(f,chat);
 const done=f.store.task(chat.id);assert.equal(done.status,'completed');assert.match(done.result,/meeting moved/);
});
test('an open question answered directly completes; an explicit action answered only with words does not',async t=>{
 const f=fixture(t,say('小宇宙上可以试试《AI炼金术》和《硅谷101》。'));
 const open=f.engine.create({prompt:'小宇宙上有什么好听的AI播客',cloudConsent:true});await run(f,open);assert.equal(f.store.task(open.id).status,'completed');
 const action=f.engine.create({prompt:'打开设置查看电池',cloudConsent:true});await run(f,action);assert.equal(f.store.task(action.id).status,'needs_review');
});
test('an explicit request answered after a read-only lookup completes without finish_task',async t=>{
 const f=fixture(t,(options,store)=>{store.event(options.task.id,'tool','正在执行：web_search',{tool:'web_search'});say('明天洛杉矶晴，18–26°C。')(options);});
 const lookup=f.engine.create({prompt:'帮我查一下明天洛杉矶天气',cloudConsent:true});await run(f,lookup);assert.equal(f.store.task(lookup.id).status,'completed');
});
test('the model sees the earlier turns of the same conversation when a new goal starts a new task',async t=>{
 let seen='';const f=fixture(t,options=>{seen=options.prompt;say('好的。')(options);});
 const first=f.engine.create({prompt:'帮我查一下明天洛杉矶天气',cloudConsent:true});
 f.store.updateTask(first.id,row=>{row.status='completed';row.messages.push({id:'r1',role:'assistant',content:'明天洛杉矶晴，18–26°C。',at:new Date().toISOString()});});
 const second=f.engine.create({prompt:'那后天呢',cloudConsent:true,conversationId:first.id});await run(f,second);
 assert.match(seen,/明天洛杉矶晴/);assert.match(seen,/那后天呢/);
});

test('a direct user task grants the app the Harness opens; delegated tasks still stay within named apps',()=>{
 const wechat={packageName:'com.tencent.mm',label:'微信',appName:'微信'};
 assert.equal(generalAppGrant(task('在支付宝里看看账单'),wechat)?.decisionOwner,'harness');
 assert.equal(generalAppGrant(task('在支付宝里看看账单',{source:'delegation',parentId:'p',depth:1}),wechat),null);
});
test('in an app the model chose itself, the model decides which control to tap',async t=>{
 const {Broker}=await import('../src/tools/broker.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-model-led-broker-')),store=new Store(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const row=task('放首周杰伦的歌',{id:'mt',conversationId:'mt',status:'running',events:[],quotes:[],timeline:null});row.taskContract=createTaskContract(row);
 row.phoneUseScope={taskId:'mt',packageName:'com.tencent.qqmusic',appName:'QQ音乐',mode:'general',modelSelected:true,sourceMessageId:'u'};
 store.transaction(s=>{s.tasks.push(row);});
 const pkg='com.tencent.qqmusic',frame=label=>({id:'obs',taskId:'mt',at:Date.now(),hash:'h',ocr:{width:1000,height:2000,lines:[{id:'x',text:label,bounds:[420,1770,580,1830],center:{x:500,y:1800}}]},
  tree:{content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:pkg,windowPkg:pkg,tree:`window pkg=${pkg} id=1 bounds=0,0,1000,2000\nFrameLayout bounds=0,0,1000,2000`}})}]}});
 const acted=[],blocked=[];
 const phone={observation:frame('关注'),async actGeneral(taskId,args){acted.push(args);return {accepted:true};},async observeGeneral(){return {content:[{type:'text',text:JSON.stringify({observationId:'obs'})}]};}};
 const broker=new Broker({store,phone,approvals:{cancelTask(){}},dataDir:dir});broker.engine={blockToolFailure:(id,reason)=>blocked.push(reason)};
 await broker.generalAction('mt',{observationId:'obs',action:'tap',textTargetId:'x'});assert.equal(acted.length,1,'no code gate on 关注; the Harness chose it');assert.equal(blocked.length,0);
 phone.observation=frame('周杰伦 晴天');await broker.generalAction('mt',{observationId:'obs',action:'tap',textTargetId:'x'});assert.equal(acted.length,2);
});

test('sending is checked against the user\'s own words, not a sentence pattern',async()=>{
 const {sendMatchesUserWords}=await import('../src/tools/broker.mjs');
 const task={messages:[{role:'user',content:'打开微信给文件助手发个测试一下的信息'}]};
 const screen=title=>({ocr:{height:2000,lines:[{text:title,bounds:[100,120,600,180]},{text:'发送',bounds:[800,1800,950,1850]}]}});
 assert.equal(sendMatchesUserWords(task,screen('文件传输助手'),'测试一下'),true);
 assert.equal(sendMatchesUserWords(task,screen('张三'),'测试一下'),false);
 assert.equal(sendMatchesUserWords(task,screen('文件传输助手'),'转账给我'),false);
 assert.equal(sendMatchesUserWords(task,screen('文件传输助手'),undefined),false);
 assert.equal(sendMatchesUserWords({messages:[{role:'user',content:'帮我看看文件助手',externalContent:true}]},screen('文件传输助手'),'看看'),false);
});
test('Taobao sales counts are not mistaken for a payment step',async()=>{
 const {classifyGeneralAction}=await import('../src/adapters/phone-general-navigation.mjs');
 const pkg='com.taobao.taobao',frame=label=>({id:'obs',taskId:'t',at:Date.now(),ocr:{width:1000,height:2000,lines:[{id:'x',text:label,bounds:[300,700,700,800],center:{x:500,y:750}}]},tree:{content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:pkg,windowPkg:pkg,tree:`window pkg=${pkg} id=1 bounds=0,0,1000,2000`}})}]}});
 const grant={taskId:'t',packageName:pkg,mode:'general'};const tap={observationId:'obs',action:'tap',textTargetId:'x'};
 assert.equal(classifyGeneralAction('t',tap,frame('维达抽纸 3层 ¥19.9 1万+人付款'),grant).kind,'general_tap');
 assert.equal(classifyGeneralAction('t',tap,frame('提交订单'),grant).handoff,true);
 assert.equal(classifyGeneralAction('t',tap,frame('立即付款'),grant).handoff,true);
});
test('a related app opened by the task\'s own tap stays in scope',async()=>{
 const {classifyGeneralAction}=await import('../src/adapters/phone-general-navigation.mjs');
 const frame=pkg=>({id:'obs',taskId:'t',at:Date.now(),ocr:{width:1000,height:2000,lines:[{id:'x',text:'电池',bounds:[300,700,700,800],center:{x:500,y:750}}]},tree:{content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:pkg,windowPkg:pkg,tree:`window pkg=${pkg} id=1 bounds=0,0,1000,2000`}})}]}});
 const grant={taskId:'t',packageName:'com.android.settings',mode:'general'},tap={observationId:'obs',action:'tap',textTargetId:'x'};
 assert.equal(classifyGeneralAction('t',tap,frame('com.samsung.android.lool'),grant),null);
 assert.equal(classifyGeneralAction('t',tap,frame('com.samsung.android.lool'),{...grant,followedPackages:['com.samsung.android.lool']}).kind,'general_tap');
});
test('in apps without accessibility text the model can tap a screenshot position, mapped to physical pixels',async t=>{
 const {Broker}=await import('../src/tools/broker.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-point-')),store=new Store(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const row=task('打开微信给文件传输助手发个测试一下',{id:'pt',status:'running',events:[],quotes:[]});row.taskContract=createTaskContract(row);
 row.phoneUseScope={taskId:'pt',packageName:'com.tencent.mm',appName:'微信',mode:'general',sourceMessageId:'u'};store.transaction(s=>{s.tasks.push(row);});
 const phone={observation:{id:'obs',taskId:'pt',at:Date.now(),mapping:{physicalWidth:1080,physicalHeight:2400},ocr:{lines:[]}}};
 const broker=new Broker({store,phone,approvals:{cancelTask(){}},dataDir:dir});
 const route=await broker.simplePhoneRoute(store.task('pt'),{action:'tap',x:500,y:950});
 assert.deepEqual(route,{name:'phone_action',args:{observationId:'obs',action:'tap',x:540,y:2280,reason:'model_point'}});
 store.updateTask('pt',t=>{t.phoneUseScope={...t.phoneUseScope,mode:'task_effects'};});
 await assert.rejects(broker.simplePhoneRoute(store.task('pt'),{action:'tap',x:500,y:950}),{code:'phone_target_missing'});
 assert.throws(()=>broker.validate('phone_use',{action:'tap',x:1200,y:5}),/0–1000/);
});
test('short requests are tasks, and an app the system inferred does not stop the model from choosing another',()=>{
 const t=task('要外卖');assert.equal(t.taskContract.intent,'task');assert.ok(names(t).includes('phone_use'));
 const coffee=task('给我点杯咖啡要外卖的');const meituan={packageName:'com.sankuai.meituan',label:'美团',appName:'美团',aliases:['美团']};
 const grant=generalAppGrant(coffee,meituan);assert.equal(grant?.mode,'general');
 assert.equal(generalAppGrant(task('在淘宝买包纸巾'),meituan)?.decisionOwner,'harness','the model may switch apps for a direct user task');
});
