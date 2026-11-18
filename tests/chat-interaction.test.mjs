import {conversationTranscript} from '../src/core/conversation-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import {webcrypto,randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {Approvals} from '../src/core/approvals.mjs';
import {LocalMessageUploads} from '../src/core/input-files.mjs';
const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const privateTaskSource=source.slice(source.indexOf('const privateTask='),source.indexOf('const latest='));
const flush=()=>new Promise(setImmediate);
function setup({storage=new Map(),taskId=null,roleId='concierge'}={}){
 let resolve,reject;const request=new Promise((a,b)=>{resolve=a;reject=b;});request.catch(()=>{});
 const key=taskId||'new-'+roleId,route=taskId?'#task/'+taskId:'#role/'+roleId;
 const form={isConnected:true,dataset:{draftKey:key,taskId:taskId||'',roleId,navigation:'0',route},elements:{message:{value:'  Original message  '}}};
 const c={form,sending:new Set(),voiceStarting:false,voiceRecording:null,voicePending:false,fileReading:0,fileDrafts:new Map(),renderDraftFiles(){},selectedRole:roleId,selectedId:taskId,detail:taskId?{id:taskId,status:'running'}:null,navigationVersion:0,location:{hash:route},drafts:new Map(),prefs:new Map(),pendingSends:new Map(),taskControlsPending:new Set(),SEND_RECEIPTS_KEY:'boujoy.pending-sends.v1',sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},selections:{},liveAnswers:new Set(),composerKey:key,crypto:{subtle:webcrypto.subtle,randomUUID},TextEncoder,localStorage:{setItem(){}},updateSend(){},toast(value){c.toasts.push(value);},toasts:[],chatPreferences:()=>({cloudConsent:false}),calls:[],api:(url,body)=>{c.sent={url,body};c.calls.push(c.sent);return request;},refresh:async()=>{c.refreshed=true;}};
 c.$=()=>c.form;c.currentKey=()=>c.selectedId||'new-'+c.selectedRole;c.rememberSelection=()=>{c.selections[c.selectedRole]=c.selectedId||'new';};
 vm.createContext(c);vm.runInContext(privateTaskSource,c);vm.runInContext(source.slice(source.indexOf('function readSendReceipts('),source.indexOf("document.addEventListener('click',event=>")),c);
 return {c,form,resolve,reject,storage};
}
function load(c,start,end){vm.runInContext(source.slice(source.indexOf(start),source.indexOf(end)),c);}
test('clear immediately and never save sent text under a task selected by an early SSE refresh',async()=>{
 const {c,form,resolve}=setup();const run=c.submitChat(form);assert.equal(form.elements.message.value,'');assert.equal(c.drafts.get('new-concierge'),'');
 c.selectedId='new-task';c.saveDraft(form);assert.equal(c.drafts.has('new-task'),false);resolve({id:'new-task'});await run;assert.equal(c.drafts.has('new-concierge'),false);assert.equal(c.drafts.get('new-task')||'','');assert.equal(c.sent.body.prompt,'Original message');
});
test('typing during request is preserved in the created conversation',async()=>{
 const {c,form,resolve}=setup();const run=c.submitChat(form);form.elements.message.value='Next unsent draft';c.saveDraft(form);resolve({id:'new-task'});await run;assert.equal(c.drafts.get('new-task'),'Next unsent draft');
});
test('late completion cannot hijack another assistant or its draft',async()=>{
 const {c,form,resolve}=setup();const run=c.submitChat(form);c.navigationVersion++;c.selectedRole='work';c.location.hash='#role/work';c.form={isConnected:true,dataset:{draftKey:'new-work'},elements:{message:{value:'Work draft'}}};c.saveDraft(c.form);resolve({id:'new-task'});await run;assert.equal(c.selectedRole,'work');assert.equal(c.location.hash,'#role/work');assert.equal(c.drafts.get('new-work'),'Work draft');assert.equal(c.refreshed,undefined);
});
test('a deliberately opened new chat keeps its fresh draft and selection',async()=>{
 const {c,form,resolve}=setup();const run=c.submitChat(form);c.navigationVersion++;form.elements.message.value='Different new chat';c.saveDraft(form);resolve({id:'new-task'});await run;assert.equal(c.selectedId,null);assert.equal(c.selections.concierge,'new');assert.equal(c.drafts.get('new-concierge'),'Different new chat');
});
test('failed send restores original text but never overwrites newer typing',async()=>{
 for(const newer of ['', 'Keep this draft']){const {c,form,reject}=setup();const run=c.submitChat(form);form.elements.message.value=newer;c.saveDraft(form);reject(new Error('offline'));await assert.rejects(run);assert.equal(form.elements.message.value,newer||'  Original message  ');assert.equal(c.drafts.get('new-concierge'),newer||'  Original message  ');assert.match(c.pendingSends.get('new-concierge').id,/^[a-f0-9-]{36}$/);}
});
test('accepted send followed by refresh failure never restores sent content',async()=>{
 const {c,form,resolve}=setup();c.refresh=async()=>{throw Error('refresh failed');};const run=c.submitChat(form);resolve({id:'new-task'});await assert.rejects(run);assert.equal(c.drafts.get('new-task')||'','');assert.equal(form.elements.message.value,'');assert.equal(c.pendingSends.size,0);
});
test('detached input change is ignored and existing-task next draft survives',async()=>{
 const {c,form,resolve}=setup({taskId:'existing'});const run=c.submitChat(form);form.elements.message.value='Follow-up draft';c.saveDraft(form);resolve({id:'existing'});await run;assert.equal(c.drafts.get('existing'),'Follow-up draft');form.isConnected=false;form.elements.message.value='stale';c.saveDraft(form);assert.equal(c.drafts.get('existing'),'Follow-up draft');
});
test('completed replies render all text immediately after running, without animation timers',()=>{
 const timeline={scrollHeight:100,scrollTop:0,clientHeight:100,innerHTML:''},answer='完整结果'.repeat(1000)+'最终结尾';
 const c={esc:String,online:true,selectedRole:'concierge',role:()=>({id:'concierge',name:'Assistant'}),state:{approvals:[],tasks:[],platforms:[]},detail:{id:'live',status:'running',messages:[{role:'user',content:'处理请求'}],events:[]},ACTIVE:['running'],STATUS:{completed:'已完成'},TOOLS:{},robotCompanion:()=>'',approvals:()=>'',comparisons:()=>'',button:()=>'',icon:()=>'',requestAnimationFrame(){throw Error('final answer must not wait for animation');},setTimeout(){throw Error('final answer must not wait for timer');}};
 c.$=selector=>selector==='#timeline'?timeline:null;vm.createContext(c);vm.runInContext(privateTaskSource,c);load(c,'function normalizeMessage(', 'function approvals(');load(c,'function renderTimeline(', 'function chatPreferences(');
 c.renderTimeline();c.detail={...c.detail,status:'completed',result:answer,messages:[...c.detail.messages,{role:'assistant',content:answer}]};c.renderTimeline();assert.ok(timeline.innerHTML.includes(answer));assert.ok(timeline.innerHTML.includes('最终结尾'));assert.equal((timeline.innerHTML.match(/最终结尾/g)||[]).length,1);
});

test('slow navigation cannot send the still-connected original composer into the next task',async()=>{
 const {c,form}=setup({taskId:'task-A'});const tasks=[{id:'task-A',roleId:'concierge'},{id:'task-B',roleId:'work'}];
 Object.assign(c,{state:{tasks,roles:[{id:'concierge'},{id:'work'}]},refreshVersion:0,online:true,role:id=>c.state.roles.find(r=>r.id===id),latest:id=>c.state.tasks.find(t=>t.roleId===id),render(){c.rendered=c.detail;}});
 let resolveDetail;const pending=new Promise(r=>resolveDetail=r);c.api=async(url,body)=>{assert.equal(body,undefined,'navigation must not POST');if(url==='/state')return c.state;if(url==='/tasks/task-B')return pending;throw Error(url);};
 load(c,'function parseRoute(', 'function renderSidebar(');load(c,'async function refresh(', 'function openSheet(');
 c.location.hash='#task/task-B';c.navigationVersion++;c.detail=null;const refresh=c.refresh(true);await flush();assert.equal(c.selectedId,'task-B');assert.equal(form.isConnected,true);
 await c.submitChat(form);assert.equal(c.sending.size,0);assert.equal(c.drafts.get('task-A'),'  Original message  ');assert.equal(form.elements.message.value,'  Original message  ');assert.match(c.toasts.at(-1),/正在切换/);
 form.elements.message.value='Original draft typed while loading';c.saveDraft(form);resolveDetail(tasks[1]);await refresh;assert.equal(c.rendered.id,'task-B');assert.equal(c.drafts.get('task-A'),'Original draft typed while loading');assert.equal(c.drafts.has('task-B'),false);
});

test('hash changes before hashchange dispatch and same-key fresh navigation both invalidate an old form',async()=>{
 for(const change of [c=>{c.location.hash='#role/work';},c=>{c.navigationVersion++;}]){const {c,form}=setup();change(c);await c.submitChat(form);assert.equal(c.calls.length,0);assert.equal(c.drafts.get('new-concierge'),'  Original message  ');}
});

test('double submit is guarded during hashing and receipt persistence before any network call',async()=>{
 const {c,form,resolve}=setup();const first=c.submitChat(form);form.elements.message.value='new draft';c.saveDraft(form);await c.submitChat(form);resolve({id:'created'});await first;assert.equal(c.calls.length,1);assert.equal(c.drafts.get('created'),'new draft');
});

test('reload after a lost committed reply finds its original new task without another POST and stores no content',async()=>{
 const original=setup(),secretText='私密附件处理要求';original.form.elements.message.value=secretText;original.c.fileDrafts.set('new-concierge',[{id:'local-only',name:'private.txt',mime:'text/plain',size:7,base64:'cHJpdmF0ZQ=='}]);
 let accepted;original.c.api=async(url,body)=>{accepted={id:'created',roleId:'concierge',clientRequestId:body.clientRequestId};throw Error('reply lost');};await assert.rejects(original.c.submitChat(original.form),/reply lost/);
 const persisted=original.storage.get(original.c.SEND_RECEIPTS_KEY);assert.ok(persisted);for(const text of [secretText,'private.txt','cHJpdmF0ZQ=='])assert.equal(persisted.includes(text),false);assert.deepEqual(Object.keys(JSON.parse(persisted)[0]).sort(),['digest','id','key','roleId','taskId']);
 const retry=setup({storage:original.storage});retry.c.chatPreferences=()=>({cloudConsent:true,memoryConsent:true,memoryMode:'default'});retry.form.elements.message.value=secretText;retry.c.fileDrafts.set('new-concierge',original.c.fileDrafts.get('new-concierge'));let reads=0;retry.c.api=async(url,body)=>{assert.equal(body,undefined);assert.equal(url,'/state');reads++;return {tasks:[accepted]};};
 await retry.c.submitChat(retry.form);assert.equal(reads,1);assert.equal(retry.c.selectedId,'created');assert.deepEqual(JSON.parse(persisted)[0].id,accepted.clientRequestId);assert.equal(retry.storage.get(retry.c.SEND_RECEIPTS_KEY),'[]');
});

test('reload after an unreceived request queries first and then reuses its exact id; different pending drafts remain recorded',async()=>{
 const first=setup();first.c.api=async()=>{throw Error('offline');};await assert.rejects(first.c.submitChat(first.form));const old=JSON.parse(first.storage.get(first.c.SEND_RECEIPTS_KEY))[0];
 const retry=setup({storage:first.storage}),calls=[];retry.c.api=async(url,body)=>{calls.push({url,body});return body?{id:'created'}:{tasks:[]};};await retry.c.submitChat(retry.form);assert.deepEqual(calls.map(c=>c.url),['/state','/tasks']);assert.equal(calls[1].body.clientRequestId,old.id);
 const changed=setup({storage:new Map([[first.c.SEND_RECEIPTS_KEY,JSON.stringify([old])]])});changed.form.elements.message.value='Different explicit request';const checked=[];changed.c.api=async(url,body)=>{checked.push({url,body});if(!body)return {tasks:[{id:'original',roleId:'concierge',clientRequestId:old.id}]};throw Error('second reply lost');};await assert.rejects(changed.c.submitChat(changed.form));const saved=JSON.parse(changed.storage.get(changed.c.SEND_RECEIPTS_KEY));assert.equal(saved.length,2);assert.equal(saved[0].id,old.id);assert.equal(checked[0].url,'/state');assert.notEqual(checked[1].body.clientRequestId,old.id);
});

test('storage failure or corrupt receipt never POSTs and restores the draft',async()=>{
 for(const mode of ['write','parse']){const {c,form,storage}=setup();if(mode==='write')c.sessionStorage.setItem=()=>{throw Error('quota');};else storage.set(c.SEND_RECEIPTS_KEY,'not valid json');await assert.rejects(c.submitChat(form),/发送凭据/);assert.equal(c.calls.length,0);assert.equal(form.elements.message.value,'  Original message  ');assert.equal(c.drafts.get('new-concierge'),'  Original message  ');assert.equal(c.sending.size,0);}
});

test('removing an attachment during a pending read does not restore it or move files to another chat',async()=>{
 const {c,form}=setup();c.btoa=value=>Buffer.from(value,'binary').toString('base64');load(c,'async function addDraftFiles(', 'async function recordVoice(');load(c,'async function action(', 'function readSendReceipts(');
 c.fileDrafts.set('new-concierge',[{id:'removed',name:'old.txt',size:1}]);let finish;const bytes=new Promise(r=>finish=r);const reading=c.addDraftFiles([{name:'new.txt',size:1,type:'text/plain',arrayBuffer:()=>bytes}]);
 await c.action({dataset:{action:'remove-attachment',id:'removed',draftKey:form.dataset.draftKey}});assert.equal(c.fileDrafts.get('new-concierge').length,0);c.selectedRole='work';c.form={isConnected:true,dataset:{draftKey:'new-work'},elements:{message:{value:'Work'}}};c.fileDrafts.set('new-work',[{id:'work-file',name:'work.txt',size:1}]);finish(Uint8Array.of(65).buffer);await reading;
 assert.deepEqual(Array.from(c.fileDrafts.get('new-concierge'),f=>f.name),['new.txt']);assert.equal(c.fileDrafts.get('new-work')[0].id,'work-file');
});

test('running tasks retain a stop button while typing; pending control blocks another stop or adjustment',async()=>{
 const {c,form}=setup({taskId:'active'}),controls={};c.ACTIVE=['running'];c.esc=String;c.icon=()=>'';c.button=(action,label,icon,extra)=>`<button data-action="${action}" ${extra||''}></button>`;c.$=selector=>selector==='#composer'?form:selector==='#send-controls'?controls:null;load(c,'function updateSend(', 'function renderDraftFiles(');
 c.updateSend();assert.match(controls.innerHTML,/data-action="stop-task"/);assert.match(controls.innerHTML,/type="submit"/);
 let finishStop;const stopped=new Promise(r=>finishStop=r);let posts=0;c.closeSheet=()=>{};c.api=async()=>{posts++;await stopped;};load(c,'async function action(', 'function readSendReceipts(');const stop=c.action({dataset:{action:'stop-task',id:'active'}});await c.action({dataset:{action:'stop-task',id:'active'}});await c.submitChat(form);assert.equal(posts,1);assert.match(controls.innerHTML,/data-action="stop-task"[^>]*disabled/);assert.equal(form.elements.message.value,'  Original message  ');finishStop();await stop;assert.equal(c.taskControlsPending.size,0);
});

test('Enter sends once, while IME composition and Shift+Enter never submit',()=>{
 const {c,form,resolve}=setup(),listeners={};c.document={addEventListener:(name,fn)=>listeners[name]=fn};c.showSearch=()=>{};let submits=0;form.requestSubmit=()=>{submits++;};const start=source.indexOf("document.addEventListener('keydown',event=>");vm.runInContext(source.slice(start,source.indexOf("$('#sidebar-backdrop')",start)),c);
 for(const extra of [{isComposing:true},{keyCode:229},{shiftKey:true}])listeners.keydown({target:{id:'message-input'},key:'Enter',preventDefault(){throw Error('must leave composition/newline intact');},...extra});assert.equal(submits,0);listeners.keydown({target:{id:'message-input'},key:'Enter',preventDefault(){}});assert.equal(submits,1);resolve({});
});

test('actual Engine and attachment submit reuse receipt IDs for both new tasks and later messages',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-chat-receipts-')),store=new Store(dir,{lock:false}),broker={calls:new Map(),approvals:new Approvals(store)},engine=new Engine({store,broker,secrets:{get:async()=>null},memory:{}});engine.pump=async()=>{};const uploads=new LocalMessageUploads({store,engine,dataDir:dir});t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const call=async(url,body)=>{if(url==='/state')return {tasks:store.data.tasks};if(!body){const task=store.task(url.split('/')[2]);return {...task,conversation:{id:task.conversationId||task.id,messages:conversationTranscript(task,store).messages}};}if(url==='/tasks')return engine.create(body);if(url==='/chat/submit')return uploads.submit(body);return engine.message(url.split('/')[2],body);};
 for(const attached of [false,true]){
  const first=setup();if(attached)first.c.fileDrafts.set('new-concierge',[{name:'receipt.txt',mime:'text/plain',size:1,base64:'QQ=='}]);let captured;
  first.c.api=async(url,body)=>{captured={url,body:structuredClone(body)};await call(url,body);throw Error('lost response');};await assert.rejects(first.c.submitChat(first.form));const count=store.data.tasks.length,original=store.data.tasks.at(-1);await call(captured.url,captured.body);assert.equal(store.data.tasks.length,count);
  const retry=setup({storage:first.storage});if(attached)retry.c.fileDrafts.set('new-concierge',first.c.fileDrafts.get('new-concierge'));retry.c.api=call;await retry.c.submitChat(retry.form);assert.equal(retry.c.selectedId,original.id);assert.equal(store.data.tasks.length,count);assert.equal(original.messages.length,1);
  const next=setup({taskId:original.id});next.form.elements.message.value='New follow-up';if(attached)next.c.fileDrafts.set(original.id,[{name:'next.txt',mime:'text/plain',size:1,base64:'Qg=='}]);next.c.api=async(url,body)=>{captured={url,body:structuredClone(body)};await call(url,body);throw Error('lost response');};await assert.rejects(next.c.submitChat(next.form));await call(captured.url,captured.body);assert.equal(conversationTranscript(store.data.tasks.at(-1),store).messages.length,2);
  const followup=setup({taskId:original.id,storage:next.storage});followup.form.elements.message.value='New follow-up';if(attached)followup.c.fileDrafts.set(original.id,next.c.fileDrafts.get(original.id));followup.c.api=call;await followup.c.submitChat(followup.form);assert.equal(conversationTranscript(store.data.tasks.at(-1),store).messages.length,2);assert.equal(store.data.artifacts.filter(a=>a.taskId===original.id).length,attached?1:0);assert.equal(store.data.artifacts.filter(a=>a.taskId===store.data.tasks.at(-1).id).length,attached?1:0);
 }
});

test('damaged receipt ownership cannot redirect a retry or query a different conversation',async()=>{
 const first=setup();first.c.api=async()=>{throw Error('unconfirmed');};await assert.rejects(first.c.submitChat(first.form));const receipt=JSON.parse(first.storage.get(first.c.SEND_RECEIPTS_KEY))[0];
 for(const change of [{roleId:'work'},{taskId:'different-task'},{key:'new-work'}]){
  const damaged={...receipt,...change},retry=setup({storage:new Map([[first.c.SEND_RECEIPTS_KEY,JSON.stringify([damaged])]])});let calls=0;retry.c.api=async()=>{calls++;throw Error('unexpected query');};await assert.rejects(retry.c.submitChat(retry.form),/发送凭据/);assert.equal(calls,0);assert.equal(retry.form.elements.message.value,'  Original message  ');
 }
});

test('matching receipt id from a foreign role or wrong task is not accepted as the current send',async()=>{
 for(const [taskId,wrongTask] of [[null,false],['existing',false],['existing',true]]){
  const first=setup({taskId});first.c.api=async()=>{throw Error('unconfirmed');};await assert.rejects(first.c.submitChat(first.form));const receipt=JSON.parse(first.storage.get(first.c.SEND_RECEIPTS_KEY))[0];
  const retry=setup({taskId,storage:first.storage});let posts=0;retry.c.api=async(url,body)=>{if(body)posts++;const task={id:wrongTask?'different-task':taskId||'foreign',roleId:wrongTask?'concierge':'work',clientRequestId:receipt.id,messages:[{clientRequestId:receipt.id}]};return taskId?task:{tasks:[task]};};await assert.rejects(retry.c.submitChat(retry.form),/原发送记录与当前对话不一致/);assert.equal(posts,0);assert.equal(retry.c.selectedId,taskId);assert.equal(retry.c.drafts.get(receipt.key),'  Original message  ');assert.equal(JSON.parse(retry.storage.get(retry.c.SEND_RECEIPTS_KEY)).length,1);
 }
});

test('a valid pending receipt for another conversation remains separate and is never reused',async()=>{
 const first=setup({roleId:'work'});first.c.api=async()=>{throw Error('unconfirmed');};await assert.rejects(first.c.submitChat(first.form));const original=JSON.parse(first.storage.get(first.c.SEND_RECEIPTS_KEY))[0];
 const other=setup({storage:first.storage});let request;other.c.api=async(url,body)=>{request={url,body};return {id:'new-concierge-task',roleId:'concierge'};};await other.c.submitChat(other.form);assert.equal(request.url,'/tasks');assert.equal(request.body.roleId,'concierge');assert.notEqual(request.body.clientRequestId,original.id);assert.deepEqual(JSON.parse(other.storage.get(other.c.SEND_RECEIPTS_KEY)),[original]);
});

test('a pending send locks only its own conversation',async()=>{
 const {c,form,resolve}=setup();const first=c.submitChat(form);await flush();await flush();
 c.navigationVersion++;c.selectedRole='work';c.location.hash='#role/work';c.selectedId=null;c.detail=null;
 const secondForm={isConnected:true,dataset:{draftKey:'new-work',taskId:'',roleId:'work',navigation:String(c.navigationVersion),route:c.location.hash},elements:{message:{value:'Independent task'}}};c.form=secondForm;
 c.api=async()=>({id:'work-task',roleId:'work'});await c.submitChat(secondForm);assert.equal(c.selectedId,'work-task');assert.equal(c.sending.has('new-concierge'),true);
 resolve({id:'first-task',roleId:'concierge'});await first;assert.equal(c.selectedId,'work-task');assert.equal(c.sending.size,0);
});
test('lost transport receipt is reconciled automatically before restoring an already accepted draft',async()=>{
 const {c,form}=setup();let posts=0,record;
 c.api=async(url,body)=>{if(body){posts++;record={id:'accepted',roleId:'concierge',clientRequestId:body.clientRequestId};const error=new Error('Failed to fetch');error.name='TypeError';throw error;}return {tasks:[record]};};
 await c.submitChat(form);assert.equal(posts,1);assert.equal(c.selectedId,'accepted');assert.equal(form.elements.message.value,'');assert.equal(c.pendingSends.size,0);
});
