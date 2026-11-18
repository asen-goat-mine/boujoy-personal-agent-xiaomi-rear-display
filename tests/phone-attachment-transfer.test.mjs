import {ANDROID_PACKAGE} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Phone} from '../src/adapters/phone.mjs';
import {PhoneUseDriver} from '../src/adapters/phoneuse-driver.mjs';
import {Broker} from '../src/tools/broker.mjs';
import {initializeTimeline,createTaskContract} from '../src/core/task-contract.mjs';
import {nativeNode as n,nativeButton as b,nativePage as page,nativeTask} from './helpers/phone-native-fixture.mjs';
const mcp=result=>({content:[{type:'text',text:JSON.stringify(result)}]});
const APP={packageName:'com.tencent.mm',appName:'微信',label:'微信'},BRIDGE={packageName:ANDROID_PACKAGE,label:'Boujoy'};
const editor=()=>n('消息',1900,{class:'android.widget.EditText',editable:true,focused:true,actions:['set_text','tap']});
const empty=()=>page(APP,[n('张三',80),editor(),b('发送',2100)]);
function fileCard(name,size,preview){return n(preview?'附件预览':null,500,{bounds:[50,500,900,1100],children:[n(name,600),n(size+' B',700)]});}
async function fixture(t,{badBridge=false,bridgePackage=ANDROID_PACKAGE,tapError=false,outbound=null,blankOutboundBody=false,lostQueueReply=false}={}){
 const bridgeApp={...BRIDGE,packageName:bridgePackage};
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'boujoy-attach-transfer-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const app=outbound==='media'?{packageName:'com.xingin.xhs',appName:'小红书',label:'小红书'}:outbound==='mail'?{packageName:'com.google.android.gm',appName:'Gmail',label:'Gmail'}:APP;
 const prompt=outbound==='media'?'在小红书账号“test-user”发布图片“photo.png”，正文“今天的照片”，可见范围“仅自己”':outbound==='mail'?'用Gmail账户“sender@example.com”给“receiver@example.com”发送邮件，主题“测试附件”，正文“请查收”，附件“报告.txt”':'把文件“报告.txt”通过微信发给张三';
 const task=nativeTask(prompt,{cloudConsent:true});initializeTimeline(task,{budgetMs:60000});task.taskContract=createTaskContract(task);
 const bytes=outbound==='media'?Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=','base64'):Buffer.from('真实文件'),artifact={id:randomUUID(),taskId:task.id,name:outbound==='media'?'photo.png':'报告.txt',mime:outbound==='media'?'image/png':'text/plain',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),path:'t/report.txt'};await fs.mkdir(path.join(dir,'artifacts','t'),{recursive:true});await fs.writeFile(path.join(dir,'artifacts',artifact.path),bytes);
 const data={tasks:[task],actions:[],artifacts:[artifact],settings:{phoneEnabled:true,phoneBackend:'phoneuse',phoneUseDeviceId:'fixture',memoryEnabled:false}},store={data,task:()=>task,event(){},transaction:fn=>fn(data),updateTask:(id,fn)=>fn(task,data)};
 const outboundFields={...(outbound==='mail'?{'发件人':'sender@example.com','收件人':'receiver@example.com','主题':'测试附件','正文':'请查收'}:{'账号':'test-user','正文':'今天的照片','可见范围':'仅自己'})};
 const outboundPage=(stage='empty')=>page(app,[...Object.entries(outboundFields).map(([description,text],i)=>n(stage==='draft'&&blankOutboundBody&&description==='正文'?'正文':text,80+i*100,{description,...(stage!=='sent'&&description==='正文'?{class:'android.widget.EditText',editable:true,focused:true,actions:['set_text','tap']}:{})})),...(stage!=='empty'?[n(stage==='sent'?(outbound==='mail'?'已发送附件':'已发布素材'):(outbound==='mail'?'附件预览':'图片预览'),700,{bounds:[50,700,900,1300],children:[n(artifact.name,800),n(artifact.size+' B',900)]})]:[]),...(stage==='sent'?[n(outbound==='mail'?'已发送':'发布成功',1600),n('receipt-123456',1700,{description:outbound==='mail'?'邮件ID':'作品ID'}),n(new Date().toISOString(),1800,{description:outbound==='mail'?'发送时间':'发布时间'})]:[b(outbound==='mail'?'发送':'发布',2100)])]);
 let state=outbound?outboundPage():empty(),job=null;const calls=[],queueRequests=[];
 const client={call:async(id,name,args)=>{calls.push({name,args});if(name==='list_apps')return mcp({apps:[app,BRIDGE].map(a=>({package_name:a.packageName,label:a.label}))});
  if(name==='launch_app'){state=page(bridgeApp,[n(artifact.name+'\n目标 App：'+app.label+'\n大小：'+artifact.size+' 字节\n附件任务：'+(badBridge?randomUUID():job.jobId),100,{description:'附件任务：'+(badBridge?'wrong':job.jobId)}),b(job.buttonText,1300)]);}
  else if(name==='tap'&&state.tree.content[0].text.includes(BRIDGE.packageName)){if(tapError){const e=new Error('lost acknowledgement');e.code='outcome_unknown';throw e;}job={...job,status:'intent_dispatched',dispatchAttemptId:randomUUID(),dispatchedAt:new Date().toISOString()};state=outbound?outboundPage('draft'):page(APP,[n('张三',80),fileCard(artifact.name,artifact.size,true),editor(),b('发送',2100)]);}
  else if(name==='input_text'){blankOutboundBody=false;state=outboundPage('draft');}
  else if(name==='tap'){state=outbound?outboundPage('sent'):page(APP,[n('张三',80),fileCard(artifact.name,artifact.size,false),editor(),b('发送',2100)]);}
  else throw Error(name);return mcp({state:'executed',action_executed:true});}};
 const driver=new PhoneUseDriver({client});driver.capture=async()=>({...state,image:{content:[{type:'image',mimeType:'image/png',data:'iVBOR'}]},mapping:{}});driver.recognize=async()=>state.ocr;
 const phone=new Phone(store,{phoneUse:driver,wait:async()=>{}});phone.remoteAttachments={prepareShare:async args=>{queueRequests.push(args.requestId);job||={jobId:randomUUID(),taskId:task.id,status:'prepared',expiresAt:task.taskContract.expiresAt,...artifact,targetPackage:app.packageName,targetLabel:app.label};job.buttonText='准备附件 '+job.jobId.slice(0,8);if(lostQueueReply){lostQueueReply=false;throw Error('queue reply lost');}return job;},shareStatus:async()=>job};
 const broker=new Broker({store,phone,dataDir:dir,approvals:{request(){throw Error('Unexpected approval');}}});broker.engine={finishReport(){task.status='completed';}};return {dir,task,artifact,app,phone,broker,data,calls,queueRequests,setState:v=>state=v};
}
test('Broker → Phone → official driver transfers exact artifact, verifies draft and sends only after new file message proof',async t=>{
 const f=await fixture(t);await f.broker.execute('t','phone_use',{action:'open_app',app:'微信'});
 const prepared=await f.broker.execute('t','phone_prepare_attachment',{action:'prepare'});assert.equal(JSON.parse(prepared.content[0].text).status,'draft_ready');assert.equal(JSON.parse(prepared.content[0].text).sent,false);
 assert.equal(f.calls.filter(c=>c.name==='tap').length,1);await assert.rejects(f.broker.execute('t','finish_task',{outcome:'completed',summary:'已发送',evidence:[f.phone.observation.id]}),e=>e.code==='effect_not_verified');
 await f.broker.execute('t','phone_use',{action:'tap',target:'发送'});await f.broker.execute('t','finish_task',{outcome:'completed',summary:'irrelevant',evidence:[f.phone.observation.id]});assert.equal(f.task.phoneEffectResult.kind,'attachment_sent');assert.match(f.task.report.summary,/报告.txt/);assert.equal(f.calls.filter(c=>c.name==='tap').length,2);
 const send=f.data.actions.find(a=>a.phoneEffect?.kind==='effect_attachment_send');assert.equal(send.verification,'verified');assert.equal(f.data.actions.find(a=>a.tool==='phone_attachment_dispatch').verification,'pending');
});
test('wrong full job identity never presses the attachment bridge',async t=>{
 const f=await fixture(t,{badBridge:true});await f.broker.execute('t','phone_use',{action:'open_app',app:'微信'});await assert.rejects(f.broker.execute('t','phone_prepare_attachment',{action:'prepare'}),e=>e.code==='attachment_bridge_not_visible');assert.equal(f.calls.filter(c=>c.name==='tap').length,0);
 await f.broker.execute('t','phone_prepare_attachment',{action:'prepare'});assert.equal(f.calls.filter(c=>c.name==='launch_app').length,1);
});
test('unknown dispatch remains unknown and cannot queue or tap again',async t=>{
 const f=await fixture(t,{tapError:true});await f.broker.execute('t','phone_use',{action:'open_app',app:'微信'});await assert.rejects(f.broker.execute('t','phone_prepare_attachment',{action:'prepare'}));assert.equal(f.task.status,'unknown_result');assert.equal(f.data.actions.find(a=>a.tool==='phone_attachment_dispatch').status,'unknown');await assert.rejects(f.broker.execute('t','phone_prepare_attachment',{action:'prepare'}));assert.equal(f.calls.filter(c=>c.name==='tap').length,1);
});
test('file replacement and occupied composer block before any bridge launch',async t=>{
 const f=await fixture(t);await f.broker.execute('t','phone_use',{action:'open_app',app:'微信'});await fs.writeFile(path.join(f.dir,'artifacts',f.artifact.path),'changed');await assert.rejects(f.broker.execute('t','phone_prepare_attachment',{action:'prepare'}),e=>e.code==='artifact_changed');assert.equal(f.calls.filter(c=>c.name==='launch_app').length,0);
});

test('Broker → Phone attachment bridge opens exact mail/media draft and verified send/publish preserves account and scope',async t=>{
 for(const outbound of ['mail','media']){const f=await fixture(t,{outbound});await f.broker.execute('t','phone_use',{action:'open_app',app:f.app.label});const prepared=await f.broker.execute('t','phone_prepare_attachment',{action:'prepare'});assert.equal(JSON.parse(prepared.content[0].text).status,'draft_ready');await f.broker.execute('t','phone_use',{action:'tap',target:outbound==='mail'?'发送':'发布'});await f.broker.execute('t','finish_task',{outcome:'completed',summary:'wrong account',evidence:[f.phone.observation.id]});assert.equal(f.task.phoneEffectResult.kind,outbound==='mail'?'mail_sent':'media_published');assert.match(f.task.report.summary,outbound==='mail'?/sender@example.com/:/仅自己/);assert.equal(f.calls.filter(c=>c.name==='tap').length,2);}
});

test('media account, audience or file drift after transfer never permits publish',async t=>{
 for(const [from,to]of [['test-user','other-user'],['仅自己','公开'],['photo.png','other.png']]){const f=await fixture(t,{outbound:'media'});await f.broker.execute('t','phone_use',{action:'open_app',app:f.app.label});await f.broker.execute('t','phone_prepare_attachment',{action:'prepare'});const changed=structuredClone(f.phone.observation);changed.tree.content[0].text=changed.tree.content[0].text.replaceAll(from,to);changed.ocr.lines=changed.ocr.lines.map(l=>({...l,text:l.text.replaceAll(from,to)}));f.setState(changed);await f.broker.execute('t','phone_use',{action:'read'});await assert.rejects(f.broker.execute('t','phone_use',{action:'tap',target:'发布'}));assert.equal(f.calls.filter(c=>c.name==='tap').length,1);}
});

test('target app may open a blank caption without losing trusted transfer scope; only exact requested body completes the draft',async t=>{
 const f=await fixture(t,{outbound:'media',blankOutboundBody:true});await f.broker.execute('t','phone_use',{action:'open_app',app:f.app.label});const prepared=await f.broker.execute('t','phone_prepare_attachment',{action:'prepare'});assert.equal(JSON.parse(prepared.content[0].text).draftVerified,false);assert.equal(f.task.phoneUseScope.attachmentTransfer.status,'intent_dispatched');await f.broker.execute('t','phone_use',{action:'type',text:'今天的照片',inputMode:'replace'});await f.broker.execute('t','phone_use',{action:'tap',target:'发布'});await f.broker.execute('t','finish_task',{outcome:'completed',summary:'done',evidence:[f.phone.observation.id]});assert.equal(f.task.phoneEffectResult.kind,'media_published');
});

test('lost queue acknowledgement recovers only the same idempotent ticket before any launch',async t=>{const f=await fixture(t,{lostQueueReply:true});await f.broker.execute('t','phone_use',{action:'open_app',app:'微信'});await assert.rejects(f.broker.execute('t','phone_prepare_attachment',{action:'prepare'}));assert.equal(f.task.phoneAttachment.status,'queueing');assert.equal(f.calls.filter(c=>c.name==='launch_app').length,0);await f.broker.execute('t','phone_prepare_attachment',{action:'prepare'});assert.equal(f.queueRequests.length,2);assert.equal(f.queueRequests[0],f.queueRequests[1]);assert.equal(f.calls.filter(c=>c.name==='launch_app').length,1);assert.equal(f.calls.filter(c=>c.name==='tap').length,1);});


test('an attachment bridge from another Boujoy installation is never pressed',async t=>{
 for(const bridgePackage of ['dev.boujoy.personalagent','dev.boujoy.phoneuse','dev.boujoy.xiaomi'].filter(value=>value!==ANDROID_PACKAGE)){
  const f=await fixture(t,{bridgePackage});await f.broker.execute('t','phone_use',{action:'open_app',app:'微信'});
  await assert.rejects(f.broker.execute('t','phone_prepare_attachment',{action:'prepare'}),e=>e.code==='attachment_bridge_not_visible');
  assert.deepEqual(f.calls.filter(c=>c.name==='launch_app').map(c=>c.args.package_name),[ANDROID_PACKAGE]);assert.equal(f.calls.filter(c=>c.name==='tap').length,0);
 }
});
