import {DISTRIBUTION,ANDROID_PACKAGE} from '../src/distribution.mjs';
import test from 'node:test';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {Approvals} from '../src/core/approvals.mjs';
import {RemoteState,spkiPin} from '../src/remote/state.mjs';
import {createGateway} from '../src/remote/gateway.mjs';
import {identities,request} from './helpers/remote-tls.mjs';

async function setup(t,options={}){const id=identities();t.after(id.cleanup);const store=new Store(id.dir,{lock:false});t.after(()=>store.close());store.data.settings.chatCloudConsent=false;const state=new RemoteState(id.dir),deviceId=randomUUID();const engine={active:new Map(),creates:0,create(input){this.creates++;const row={...input,id:randomUUID(),title:input.prompt,prompt:input.prompt,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),status:input.cloudConsent?'queued':'waiting_consent',messages:[{role:'user',content:input.prompt,clientRequestId:input.clientRequestId,inputDigest:input.inputDigest}],events:[]};store.transaction(s=>{s.tasks.push(row);s.artifacts.push(...(input.inputArtifacts||[]).map(a=>({...a,taskId:row.id})));});return row;},async stop(id){store.updateTask(id,t=>t.status='paused');},async continue(id){store.updateTask(id,t=>t.status='queued');},async message(){throw Error('not used');}};const gateway=createGateway({identity:id.server,state,store,engine,phone:options.phone||{lease:null},onControl:options.onControl,removeRole:options.removeRole,dataDir:id.dir});const port=await gateway.listen();t.after(()=>gateway.close());const call=(pathname,body,who=id.client)=>request({port,identity:who,pin:spkiPin(id.server.cert),pathname,method:body?'POST':'GET',body});const pairing=state.issuePairing({deviceId});return {id,store,state,engine,call,pairing,deviceId,gateway,port};}
async function pair(x){assert.equal((await x.call('/v1/pair',{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,pairToken:x.pairing.pairToken})).status,200);assert.equal((await x.call('/v1/device/control',{messageId:randomUUID(),controlEpoch:1,paused:false,reason:'new_task'})).status,200);}
const message=()=>({messageId:randomUUID(),text:'你好',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),controlEpoch:1});
test('gateway requires pinned device binding, consumes pair challenge, revokes active identity',async t=>{const x=await setup(t);assert.equal((await x.call('/v1/state')).status,403);await pair(x);assert.equal((await x.call('/v1/state')).status,200);assert.equal((await x.call('/v1/pair',{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,pairToken:x.pairing.pairToken},x.id.other)).status,400);assert.equal((await x.call('/v1/state',undefined,x.id.other)).status,403);x.state.revoke(x.deviceId);assert.equal((await x.call('/v1/state')).status,403);});
test('remote task replay creates one task and never grants cloud authorization from mobile payload',async t=>{const x=await setup(t);await pair(x);const m={...message(),cloudConsent:true};const a=await x.call('/v1/messages',m),b=await x.call('/v1/messages',m);assert.equal(a.status,200);assert.deepEqual(a.body,b.body);assert.equal(x.engine.creates,1);assert.equal(x.store.data.tasks[0].cloudConsent,false);assert.equal((await x.call('/v1/messages',{...m,text:'different'})).status,400);const q=await x.call('/v1/messages/'+m.messageId);assert.equal(q.body.taskId,a.body.taskId);assert.equal(q.body.received,true);});
test('expired, paused, malformed attachments and stale epoch do not dispatch tasks',async t=>{const x=await setup(t);await pair(x);const m=message();m.createdAt=new Date(Date.now()-120000).toISOString();m.expiresAt=new Date(Date.now()-60000).toISOString();assert.equal((await x.call('/v1/messages',m)).status,410);assert.equal((await x.call('/v1/messages',{...message(),attachments:[{name:'x',base64:'!'}]})).status,400);await x.call('/v1/device/control',{messageId:randomUUID(),controlEpoch:2,paused:true});assert.equal((await x.call('/v1/messages',message())).status,400);assert.equal((await x.call('/v1/device/control',{messageId:randomUUID(),controlEpoch:1,paused:false,reason:'user_resume'})).status,400);assert.equal(x.engine.creates,0);});
test('remote route allowlist never exposes loopback sessions, secrets or runtime tokens',async t=>{const x=await setup(t);await pair(x);for(const route of ['/api/session','/api/secrets','/internal/tools/list','/v1/../api/session'])assert.equal((await x.call(route)).status,404);});
test('lost receipt is recovered from durable task mapping without repeating execution',async t=>{const x=await setup(t);await pair(x);const m=message(),a=await x.call('/v1/messages',m);x.state.update(s=>{delete s.messages[x.deviceId+':'+m.messageId];});await x.call('/v1/device/control',{messageId:randomUUID(),controlEpoch:2,paused:true});const replay=await x.call('/v1/messages',m);assert.equal(replay.body.taskId,a.body.taskId);assert.equal(x.engine.creates,1);});
test('lost pairing receipt is repeatable only by the bound client identity',async t=>{const x=await setup(t);const first=await x.call('/v1/pair',{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,pairToken:x.pairing.pairToken});const retry=await x.call('/v1/pair',{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,pairToken:x.pairing.pairToken});assert.equal(retry.status,200);assert.equal(retry.body.deviceId,first.body.deviceId);assert.equal((await x.call('/v1/pair',{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,pairToken:x.pairing.pairToken},x.id.other)).status,400);});
test('attachment bytes and task reference exist together, changed attachment cannot reuse a receipt',async t=>{const x=await setup(t);await pair(x);const m={...message(),attachments:[{name:'note.txt',mime:'text/plain',base64:Buffer.from('original').toString('base64')}]};const first=await x.call('/v1/messages',m);assert.equal(first.status,200);assert.equal(x.store.data.artifacts.length,1);assert.equal(x.store.data.artifacts[0].taskId,first.body.taskId);x.state.update(s=>{delete s.messages[x.deviceId+':'+m.messageId];});const same=await x.call('/v1/messages',m);assert.equal(same.body.taskId,first.body.taskId);assert.equal((await x.call('/v1/messages',{...m,attachments:[{...m.attachments[0],base64:Buffer.from('changed').toString('base64')}]})).status,400);assert.equal(x.engine.creates,1);});

test('pause and resume serialize across asynchronous cancellation, stale stop cannot cancel the new epoch',async t=>{
 const phone={lease:null},x=await setup(t,{phone});await pair(x);const created=await x.call('/v1/messages',message());phone.lease=created.body.taskId;
 let entered,release;const didEnter=new Promise(r=>entered=r),barrier=new Promise(r=>release=r);const original=x.engine.stop.bind(x.engine);let stops=0;
 x.engine.stop=async id=>{stops++;entered();await barrier;return original(id);};
 const paused=x.call('/v1/device/control',{messageId:randomUUID(),controlEpoch:2,paused:true});await didEnter;
 const resumed=x.call('/v1/device/control',{messageId:randomUUID(),controlEpoch:3,paused:false,reason:'user_resume'});
 await new Promise(r=>setTimeout(r,30));assert.equal(x.state.data.control.controlEpoch,2);assert.equal(x.state.data.control.paused,true);assert.equal(x.state.data.control.reason,'unspecified');release();
 assert.equal((await paused).status,200);assert.equal((await resumed).status,200);assert.deepEqual(x.state.data.control,{controlEpoch:3,paused:false});
 assert.equal((await x.call('/v1/tasks/'+phone.lease+'/stop',{messageId:randomUUID(),controlEpoch:2})).status,400);assert.equal(stops,1);
 assert.equal((await x.call('/v1/device/control',{messageId:randomUUID(),controlEpoch:4,paused:true})).status,200);
 assert.equal((await x.call('/v1/device/control',{messageId:randomUUID(),controlEpoch:4,paused:false,reason:'user_resume'})).status,400);
});
test('local takeover pauses before cancellation and invalidates an in-flight remote generation',async t=>{
 const phone={lease:null},x=await setup(t,{phone});await pair(x);const created=await x.call('/v1/messages',message());phone.lease=created.body.taskId;
 await x.gateway.pause();assert.equal(x.state.data.control.controlEpoch,2);assert.equal(x.state.data.control.paused,true);assert.equal(x.state.data.control.reason,'user_takeover');assert.equal(x.state.data.control.maintenanceResumeEpoch,undefined);assert.equal(x.store.task(phone.lease).status,'paused');
 assert.equal((await x.call('/v1/messages',message())).status,400);assert.equal(x.engine.creates,1);
});
test('approval can bind a live waiting task to explicit new epoch but cannot revive a cancelled operation',async t=>{
 const x=await setup(t);await pair(x);const created=await x.call('/v1/messages',message()),id=created.body.taskId;
 x.engine.broker={approvals:new Approvals(x.store)};const approvals=x.engine.broker.approvals;
 const waiting=approvals.request(id,{tool:'browser_action',args:{action:'click'},summary:'打开选定页面'});const approval=x.store.data.approvals.at(-1);
 await x.call('/v1/device/control',{messageId:randomUUID(),controlEpoch:2,paused:false,reason:'explicit_approval'});
 const allowed=await x.call('/v1/approvals/'+approval.id,{messageId:randomUUID(),controlEpoch:2,allow:true,fingerprint:approval.fingerprint});assert.equal(allowed.status,200);await waiting;assert.equal(x.store.task(id).remoteControlEpoch,2);
 const cancelled=approvals.request(id,{tool:'browser_action',args:{action:'click'},summary:'新的页面'}).catch(e=>e.code);const old=x.store.data.approvals.at(-1);approvals.cancelTask(id);await cancelled;x.store.updateTask(id,t=>t.status='paused');
 const rejected=await x.call('/v1/approvals/'+old.id,{messageId:randomUUID(),controlEpoch:2,allow:true,fingerprint:old.fingerprint});assert.equal(rejected.status,409);assert.equal(rejected.body.error.code,'approval_expired');assert.equal(x.store.task(id).status,'paused');
});
test('explicit per-task consent grants only that waiting user task, never global model or memory permission',async t=>{
 const x=await setup(t);await pair(x);const created=await x.call('/v1/messages',message()),id=created.body.taskId;let input;
 x.engine.continue=async(taskId,value)=>{input=value;x.store.updateTask(taskId,t=>{t.status='queued';t.cloudConsent=value.cloudConsent;t.memoryConsent=value.memoryConsent;});};
 const consent={messageId:randomUUID(),controlEpoch:1,cloudConsent:true,memoryConsent:true};assert.equal((await x.call('/v1/tasks/'+id+'/consent',consent)).status,200);assert.equal(input.cloudConsent,true);assert.equal(input.memoryConsent,false);assert.equal(x.store.data.settings.chatCloudConsent,false);assert.equal(x.store.data.settings.chatMemoryConsent,false);
 assert.equal((await x.call('/v1/tasks/'+id+'/consent',consent)).status,200);assert.equal((await x.call('/v1/tasks/'+id+'/consent',{...consent,messageId:randomUUID()})).status,400);
});

test('closing gateway prevents a queued old resume from overwriting maintenance pause',async t=>{
 const phone={lease:null},x=await setup(t,{phone});await pair(x);const created=await x.call('/v1/messages',message());phone.lease=created.body.taskId;
 let entered,release;const didEnter=new Promise(r=>entered=r),barrier=new Promise(r=>release=r);x.engine.stop=async()=>{entered();await barrier;};
 const pausing=x.call('/v1/device/control',{messageId:randomUUID(),controlEpoch:2,paused:true}).catch(()=>null);await didEnter;
 const late=x.call('/v1/device/control',{messageId:randomUUID(),controlEpoch:3,paused:false}).catch(()=>null);await new Promise(r=>setTimeout(r,35));
 x.state.update(s=>{s.control={paused:true,controlEpoch:4};});await x.gateway.close();release();await Promise.all([pausing,late]);await new Promise(r=>setTimeout(r,20));
 assert.deepEqual(x.state.data.control,{paused:true,controlEpoch:4});await assert.rejects(x.gateway.pause(),e=>e.code==='gateway_closed');
});


test('mobile task diagnostics expose fixed categories and metrics, never raw errors or screen contents',async t=>{
 const x=await setup(t);await pair(x);const created=await x.call('/v1/messages',message()),id=created.body.taskId;
 x.store.event(id,'phone_read_unavailable','raw page text must not escape',{reason:'outside_task_scope',foregroundPackage:'com.example.other',transport:'cloud_relay',elapsedMs:42,screenText:'secret screen',image:'secret pixels'});
 const result=await x.call('/v1/tasks/'+id);assert.equal(result.status,200);
 assert.equal(result.body.diagnostics.at(-1).reason,'outside_task_scope');
 assert.ok(!JSON.stringify(result.body.diagnostics).includes('secret'));assert.ok(!JSON.stringify(result.body.diagnostics).includes('raw page text'));
});
test('a bound phone receives exactly one typing job over the encrypted channel',async t=>{
 const x=await setup(t);await pair(x);
 const waiting=x.call('/v1/device/typing');
 await new Promise(resolve=>setTimeout(resolve,30));
 const result=x.gateway.typing.request({deviceId:x.deviceId,text:'猪脚饭',mode:'replace'});
 const polled=await waiting;assert.equal(polled.status,200);assert.equal(polled.body.job.text,'猪脚饭');assert.equal(polled.body.job.mode,'replace');
 const posted=await x.call('/v1/device/typing',{messageId:randomUUID(),id:polled.body.job.id,status:'typed'});
 assert.equal(posted.status,200);assert.deepEqual(await result,{id:polled.body.job.id,status:'typed'});
 assert.equal((await x.call('/v1/device/typing',{messageId:randomUUID(),id:polled.body.job.id,status:'failed'})).body.duplicate,true);
});

test('real mTLS typing protocol keeps verify-only jobs from old phones and requires an independent bound proof',async t=>{
 const x=await setup(t);await pair(x);x.gateway.typing.pollMs=15;
 const referenceId=randomUUID(),result=x.gateway.typing.request({deviceId:x.deviceId,text:'exact draft',mode:'replace',packageName:'com.example.chat',operation:'verify_replace',referenceId,controlEpoch:1});
 assert.equal((await x.call('/v1/device/typing')).body.job,null,'an old APK would type any job, so it must never receive this job');
 assert.equal((await x.call('/v1/device/typing?typingProtocol=2',undefined,x.id.other)).status,403);
 const job=(await x.call('/v1/device/typing?typingProtocol=2')).body.job;assert.equal(job.operation,'verify_replace');assert.equal(job.referenceId,referenceId);
 assert.equal((await x.call('/v1/device/typing',{messageId:randomUUID(),id:job.id,status:'typed'})).status,400);
 const proof={referenceId,controlEpoch:1,editorIdentity:'a'.repeat(64),exact:true,reads:2};
 assert.equal((await x.call('/v1/device/typing',{messageId:randomUUID(),id:job.id,status:'verified',diagnostic:'readback_verified',proof})).status,200);
 assert.equal((await result).status,'verified');assert.equal(x.engine.creates,0);
});

test('phone progress exposes only the owned active task draft without persisting it as history or result',async t=>{
 const x=await setup(t);await pair(x);const created=await x.call('/v1/messages',message()),id=created.body.taskId;
 x.store.updateTask(id,task=>{task.status='running';});x.engine.active=new Map([[id,{}]]);x.engine.liveDrafts={get:taskId=>taskId===id?{text:'正在打开淘宝…'}:null};
 const original=JSON.stringify(x.store.task(id));let result=await x.call('/v1/state');assert.equal(result.body.tasks.find(task=>task.id===id).liveDraft,'正在打开淘宝…');
 result=await x.call('/v1/tasks/'+id);assert.equal(result.body.liveDraft,'正在打开淘宝…');assert.equal(JSON.stringify(x.store.task(id)),original);
 x.engine.active.delete(id);assert.equal((await x.call('/v1/tasks/'+id)).body.liveDraft,'');
 x.engine.active.set(id,{});x.store.updateTask(id,task=>{task.status='completed';});assert.equal((await x.call('/v1/tasks/'+id)).body.liveDraft,'');
});

test('mobile assistant editing is authenticated, idempotent, and never copies memory or schedules',async t=>{
 const x=await setup(t);const input={messageId:randomUUID(),name:'采购助理',description:'比价',instruction:'先核对规格',botColor:'green'};
 assert.equal((await x.call('/v1/roles',input)).status,403);await pair(x);
 const created=await x.call('/v1/roles',input);assert.equal(created.status,200);assert.deepEqual((await x.call('/v1/roles',input)).body,created.body);
 const id=created.body.id;assert.equal(x.store.data.roles.filter(r=>r.id===id).length,1);
 x.state.update(s=>{delete s.messages[x.deviceId+':'+input.messageId];});
 assert.deepEqual((await x.call('/v1/roles',input)).body,created.body);assert.equal(x.store.data.roles.filter(r=>r.id===id).length,1);
 x.state.update(s=>{delete s.messages[x.deviceId+':'+input.messageId];});assert.equal((await x.call('/v1/roles',{...input,name:'changed'})).status,400);
 const role=x.store.data.roles.find(r=>r.id===id);role.notes=[{id:'note-one',text:'仅限原助理'}];role.brief={enabled:true,time:'09:00'};role.briefConversationId=randomUUID();
 const copied=await x.call('/v1/roles/'+id,{messageId:randomUUID(),copy:true});assert.equal(copied.status,200);const copy=x.store.data.roles.find(r=>r.id===copied.body.id);assert.deepEqual(copy.notes,[]);assert.equal(copy.brief,null);assert.equal(copy.briefConversationId,undefined);
 assert.equal((await x.call('/v1/roles/'+id,{messageId:randomUUID(),botColor:'bad'})).status,400);
 const changed=await x.call('/v1/roles/'+id,{messageId:randomUUID(),botColor:'blue',brief:{enabled:true,time:'10:45'}});assert.equal(changed.status,200);
 const before=x.state.data.control.controlEpoch;assert.equal((await x.call('/v1/roles/'+id,{messageId:randomUUID(),forgetNote:'note-one'})).status,200);assert.equal(x.state.data.control.controlEpoch,before);
 const overview=(await x.call('/v1/state')).body.roles.find(r=>r.id===id);assert.equal(overview.botColor,'blue');assert.deepEqual(overview.notes,[]);assert.equal(overview.brief.time,'10:45');
 const sent=await x.call('/v1/messages',{...message(),roleId:id});assert.equal(sent.status,200);assert.equal(x.store.task(sent.body.taskId).roleId,id);
 assert.equal((await x.call('/v1/messages',{...message(),roleId:'missing'})).status,400);
});

test('mobile assistant summaries never leak another device task',async t=>{
 const x=await setup(t);await pair(x);const roleId=x.store.data.roles.find(r=>!r.hidden).id;
 x.store.transaction(s=>{s.tasks.push({id:randomUUID(),roleId,remoteDeviceId:'other-phone',title:'private foreign task',status:'running',updatedAt:new Date().toISOString()});});
 const overview=await x.call('/v1/state');assert.equal(overview.status,200);assert.ok(!JSON.stringify(overview.body.roles).includes('private foreign task'));
});

test('raw phone uploads stay device scoped, survive reconnect, become task files, and replay once',async t=>{
 const fs=await import('node:fs'),https=await import('node:https'),x=await setup(t);await pair(x);
 const raw=async(bytes,client=x.id.client)=>new Promise((resolve,reject)=>{const req=https.request({hostname:'127.0.0.1',port:x.gateway.server.address().port,path:'/v1/uploads',method:'POST',key:client.key,cert:client.cert,rejectUnauthorized:false,headers:{host:'boujoy.gateway','content-type':'video/mp4','content-length':bytes.length,'x-file-name':encodeURIComponent('验收 视频.mp4')}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.end(bytes);});
 const bytes=Buffer.alloc(9*1024*1024,23),uploaded=await raw(bytes);assert.equal(uploaded.status,200);assert.equal(uploaded.body.size,bytes.length);const {ChatUploads}=await import('../src/remote/chat-uploads.mjs');const recovered=new ChatUploads(x.id.dir);assert.equal(recovered.forDevice(x.deviceId).entries.get(uploaded.body.uploadId).size,bytes.length);assert.equal(recovered.forDevice(randomUUID()).entries.has(uploaded.body.uploadId),false);
 const unbound=await raw(Buffer.from('no'),x.id.other);assert.equal(unbound.status,403);
 const input={...message(),attachments:[{uploadId:uploaded.body.uploadId,name:'验收 视频.mp4',mime:'video/mp4'}]},first=await x.call('/v1/messages',input);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(x.store.data.artifacts[0].size,bytes.length);
 x.state.update(s=>{delete s.messages[x.deviceId+':'+input.messageId];});assert.equal((await x.call('/v1/messages',input)).body.taskId,first.body.taskId);assert.equal(x.engine.creates,1);
 assert.equal((await x.call('/v1/messages',{...message(),attachments:input.attachments})).status,400);
 const detail=await x.call('/v1/tasks/'+first.body.taskId);assert.equal(detail.body.artifacts[0].kind,'input');assert.ok(detail.body.createdAt);
});


test('large mobile state negotiates gzip without changing content or legacy responses',async t=>{
 const x=await setup(t);await pair(x);
 x.store.transaction(s=>s.tasks.push({id:randomUUID(),status:'completed',result:'传输验收内容'.repeat(30000),messages:[]}));
 const get=encoding=>request({port:x.port,identity:x.id.client,pin:spkiPin(x.id.server.cert),headers:encoding?{'Accept-Encoding':encoding}:{},rawResponse:true});
 const plain=await get(),zipped=await get('gzip'),disabled=await get('gzip;q=0, identity');
 assert.equal(plain.headers['content-encoding'],undefined);assert.equal(disabled.headers['content-encoding'],undefined);
 assert.equal(zipped.headers['content-encoding'],'gzip');assert.equal(Number(zipped.headers['content-length']),zipped.body.length);
 assert.ok(zipped.body.length<plain.body.length/4);
 const expected=JSON.parse(plain.body),actual=JSON.parse(gunzipSync(zipped.body));
 assert.deepEqual(actual.tasks,expected.tasks);assert.deepEqual(actual.roles,expected.roles);
 assert.equal(actual.tasks[0].result.length,180000);assert.equal(zipped.headers.vary,'Accept-Encoding');
});


test('phone bot removal uses the shared lifecycle once and rejects unbound clients',async t=>{
 let count=0;const x=await setup(t,{removeRole:async id=>{count++;return {id,removed:true};}});await pair(x);
 const body={messageId:randomUUID(),remove:true};const first=await x.call('/v1/roles/helper',body);assert.equal(first.status,200);assert.equal(first.body.removed,true);
 assert.deepEqual((await x.call('/v1/roles/helper',body)).body,first.body);assert.equal(count,1);
 assert.equal((await x.call('/v1/roles/helper',{messageId:randomUUID(),remove:true},x.id.other)).status,403);assert.equal(count,1);
});
test('image preview keeps original ownership and hash validation',{skip:process.platform!=='darwin'},async t=>{
 const x=await setup(t);await pair(x);const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFuoAAAAASUVORK5CYII=','base64');
 const task=await x.call('/v1/messages',{...message(),attachments:[{name:'preview.png',mime:'image/png',base64:bytes.toString('base64')}]});assert.equal(task.status,200);const artifact=x.store.data.artifacts.at(-1);
 const get=identity=>request({port:x.port,identity,pin:spkiPin(x.id.server.cert),pathname:'/v1/artifacts/'+artifact.id+'/preview',rawResponse:true});
 const preview=await get(x.id.client);assert.equal(preview.status,200);assert.equal(preview.headers['content-type'],'image/jpeg');assert.equal(preview.body[0],255);assert.equal(preview.body[1],216);
 assert.equal((await get(x.id.other)).status,403);x.store.data.artifacts.at(-1).sha256='bad';assert.equal((await get(x.id.client)).status,400);
});

test('invalid or group conversation destinations reject before dispatch and leave no false receipt',async t=>{
 const x=await setup(t);await pair(x);
 const created=await x.call('/v1/messages',message());x.store.updateTask(created.body.taskId,t=>{t.conversationId='group:example:role:concierge';});
 for(const conversationId of ['group:example:role:concierge',created.body.taskId,randomUUID()]){
  const m={...message(),text:'An arbitrary new user request, without a task template',conversationId};
  const response=await x.call('/v1/messages',m);assert.equal(response.status,400);assert.equal(response.body.error.code,'invalid_private_conversation');assert.equal((await x.call('/v1/messages/'+m.messageId)).body.received,false);
 }
 assert.equal(x.engine.creates,1);
});

test('authenticated approval details expose complete instructions but not arbitrary args or tokens',async t=>{
 const x=await setup(t);await pair(x);const created=await x.call('/v1/messages',message()),id=created.body.taskId;
 x.engine.broker={approvals:new Approvals(x.store)};const approvals=x.engine.broker.approvals;
 const prompt='Check the target and write only HELLO. '.repeat(100);
 const waiting=approvals.request(id,{tool:'agent_run',args:{agent:'codex',folder:'Documents/QA',write:true,prompt,token:'NEVER-EXPOSE',env:{SECRET:'NEVER-EXPOSE'}},summary:'short summary'}).catch(()=>{});
 const detail=await x.call('/v1/tasks/'+id);assert.equal(detail.status,200);assert.equal(detail.body.approvals[0].details.find(f=>f.label==='完整任务指令').value,prompt);assert(!JSON.stringify(detail.body.approvals).includes('NEVER-EXPOSE'));assert(!detail.body.approvals[0].args);
 approvals.cancelTask(id);await waiting;
});


test('paired mobile reasoning changes only shared reasoning and is reflected in state',async t=>{
 const x=await setup(t);assert.notEqual((await x.call('/v1/settings/reasoning')).status,200);await pair(x);
 const before=structuredClone(x.store.data.settings),initial=await x.call('/v1/settings/reasoning');assert.equal(initial.status,200);
 assert.deepEqual(initial.body.options.map(o=>o.value),['auto','off','low','high','max']);
 for(const value of ['max','low','off','high','auto']){const changed=await x.call('/v1/settings/reasoning',{messageId:randomUUID(),modelReasoning:value});assert.equal(changed.status,200);assert.equal(changed.body.modelReasoning,value);assert.equal((await x.call('/v1/state')).body.reasoning.modelReasoning,value);}
 const invalid=await x.call('/v1/settings/reasoning',{messageId:randomUUID(),modelReasoning:'anything'});assert.equal(invalid.status,400);
 const extra=await x.call('/v1/settings/reasoning',{messageId:randomUUID(),modelReasoning:'low',maxTaskMinutes:1});assert.equal(extra.status,400);
 const after={...x.store.data.settings};delete before.modelReasoning;delete after.modelReasoning;assert.deepEqual(after,before);assert.equal(x.engine.creates,0);
});


test('missing or foreign edition pairing never consumes the challenge or binds a device',async t=>{
 const x=await setup(t),challenge=structuredClone(x.state.data.pairing),other=DISTRIBUTION.edition==='xiaomi'?'phoneuse':'xiaomi';
 for(const identity of [{},{edition:DISTRIBUTION.edition},{androidApplicationId:ANDROID_PACKAGE},{edition:other,androidApplicationId:'dev.boujoy.'+other},{edition:DISTRIBUTION.edition,androidApplicationId:'dev.boujoy.personalagent'}]){
  const response=await x.call('/v1/pair',{pairToken:x.pairing.pairToken,...identity});
  assert.equal(response.status,400);assert.equal(response.body.error.code,'edition_mismatch');assert.deepEqual(x.state.data.pairing,challenge);assert.equal(Object.keys(x.state.data.devices).length,0);
 }
 const paired=await x.call('/v1/pair',{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,pairToken:x.pairing.pairToken});
 assert.equal(paired.status,200);assert.equal(paired.body.edition,DISTRIBUTION.edition);assert.equal(paired.body.androidApplicationId,ANDROID_PACKAGE);assert.equal(x.state.data.pairing,null);
 const wrongRetry=await x.call('/v1/pair',{edition:other,androidApplicationId:'dev.boujoy.'+other,pairToken:x.pairing.pairToken});
 assert.equal(wrongRetry.status,400);assert.equal(wrongRetry.body.error.code,'edition_mismatch');assert.equal(Object.keys(x.state.data.devices).length,1);
});
