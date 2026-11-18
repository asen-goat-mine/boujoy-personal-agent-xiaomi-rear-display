import {DISTRIBUTION,ANDROID_PACKAGE} from '../src/distribution.mjs';
// Launched by the Android JVM interop suite. All state and identities are temporary.
// Uses the production relay, gateway, MacConnector, Store and Approvals; no model or phone.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import readline from 'node:readline';
import {randomUUID,randomBytes} from 'node:crypto';
import {createRelay} from '../src/remote/relay.mjs';
import {createGateway} from '../src/remote/gateway.mjs';
import {MacConnector} from '../src/remote/transport.mjs';
import {RemoteState,spkiPin} from '../src/remote/state.mjs';
import {RemoteService} from '../src/remote/service.mjs';
import {hash} from '../src/remote/protocol.mjs';
import {Store} from '../src/core/store.mjs';
import {Approvals} from '../src/core/approvals.mjs';
import {Browser} from '../src/adapters/browser.mjs';
import {chromium} from 'playwright';
import {LocalVoiceService} from '../src/adapters/voice.mjs';
import {createTaskContract,initializeTimeline} from '../src/core/task-contract.mjs';
import {attachmentPlan} from '../src/core/attachment-contract.mjs';
import {WorkflowLibrary} from '../src/core/workflows.mjs';

const dir=process.argv[2];
if(!dir||!path.isAbsolute(dir))throw Error('Absolute fixture directory required');
const deviceId=randomUUID(),macToken=randomBytes(32).toString('base64url'),androidToken=randomBytes(32).toString('base64url');
const store=new Store(path.join(dir,'state'),{lock:false}),state=new RemoteState(path.join(dir,'state'));
store.transaction(s=>s.settings.phoneEnabled=true); // Synthetic phone peer is explicitly enabled for interop, never the user's device.
const approvals=new Approvals(store),approvalOutcomes=new Map();
let demoLabel='搜索';const demoClient={active:new Map(),calls:0,async observeForDemo(id,{lease}){if(!this.demoLeaseGuard(lease,id))throw Error('Demo lease invalid');this.calls++;return {device_id:id,package_name:'com.example.fixture',captured_at_ms:Date.now(),observation_status:'complete',screenshot:null,tree:{available:true,elements:[{element_id:'0',view_id:'com.example.fixture:id/button',class:'android.widget.Button',text:demoLabel,bounds:[0,0,100,100],actions:['tap']}]}};}};const phone={lease:null,phoneUse:{client:demoClient}},browser=new Browser();let browserRuntime;
const engine={active:new Map(),creates:0,stopDelayMs:0,stopEntered:false,broker:{approvals,browser,workflows:new WorkflowLibrary({store,dataDir:path.join(dir,'state'),root:path.join(dir,'workflows')})},create(input){
 this.creates++;const row={...input,id:randomUUID(),title:input.prompt,prompt:input.prompt,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),status:input.cloudConsent?'queued':'waiting_consent',messages:[{role:'user',content:input.prompt,clientRequestId:input.clientRequestId,inputDigest:input.inputDigest}],events:[]};
 store.transaction(s=>{s.tasks.push(row);s.artifacts.push(...(input.inputArtifacts||[]).map(a=>({...a,taskId:row.id})));});return row;
},async stop(id){this.stopEntered=true;if(this.stopDelayMs)await new Promise(r=>setTimeout(r,this.stopDelayMs));store.updateTask(id,t=>t.status='paused');approvals.cancelTask(id);},async continue(id,input){store.updateTask(id,t=>{if(input.cloudConsent===true)t.cloudConsent=true;if(input.memoryConsent===false)t.memoryConsent=false;t.status=t.cloudConsent?'queued':'waiting_consent';t.remoteControlEpoch=input.remoteControlEpoch;});},async message(){throw Error('Fixture does not synthesize follow-up effects');}};
const relay=createRelay({routes:{[deviceId]:{macTokenHash:hash(macToken),androidTokenHash:hash(androidToken)}}});
const relayAddress=await relay.listen(),frontSockets=new Set();
const front=tls.createServer({cert:fs.readFileSync(path.join(dir,'outer.crt')),key:fs.readFileSync(path.join(dir,'outer.key'))},socket=>{
 frontSockets.add(socket);const target=net.connect(relayAddress.port,'127.0.0.1');frontSockets.add(target);
 socket.on('error',()=>target.destroy());target.on('error',()=>socket.destroy());socket.on('close',()=>{frontSockets.delete(socket);target.destroy();});target.on('close',()=>{frontSockets.delete(target);socket.destroy();});socket.pipe(target);target.pipe(socket);
});
front.on('tlsClientError',()=>{});await new Promise(r=>front.listen(0,'127.0.0.1',r));
const relayUrl=`wss://127.0.0.1:${front.address().port}/v1/tunnel`;
const identity={cert:fs.readFileSync(path.join(dir,'gateway.crt')),key:fs.readFileSync(path.join(dir,'gateway.key'))};
let mac,deviceTelemetry=null;
const voice=new LocalVoiceService({dataDir:path.join(dir,'state'),store,...(process.env.BOUJOY_TEST_VOICE_RUNTIME?{runtimeDir:process.env.BOUJOY_TEST_VOICE_RUNTIME}:{})});
const gateway=createGateway({identity,state,store,engine,phone,voice,dataDir:path.join(dir,'state'),onControl:async control=>{if(control.paused)mac?.pause();},onDeviceStatus:value=>{deviceTelemetry=value;}});
let dropPair=false,dropMessage=false,typingResult;
gateway.server.prependListener('request',(req,res)=>{
 const drop=req.url==='/v1/pair'&&dropPair||req.url==='/v1/messages'&&dropMessage;
 if(drop){if(req.url==='/v1/pair')dropPair=false;else dropMessage=false;res.end=()=>{req.socket.destroy();return res;};}
});
const gatewayPort=await gateway.listen();
mac=new MacConnector({config:{relayUrl,deviceId,macRouteToken:macToken},gatewayPort,controlState:()=>state.data.control,onStatus:status=>{if(!status.dataConnected||!status.controlConnected)gateway.disconnectWorkspace();}});await mac.start();
const pair=state.issuePairing({deviceId});
console.log(JSON.stringify({type:'ready',binding:{version:1,edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,relayUrl,deviceId,routeToken:androidToken,gatewayPin:spkiPin(identity.cert),...pair}}));
const commands=readline.createInterface({input:process.stdin});
async function phoneProbe(lane,payload){return new Promise(resolve=>{
 const port=mac.status()[lane==='control'?'phoneControlPort':'phoneDataPort'];let received=Buffer.alloc(0),settled=false;
 const socket=net.connect(port,'127.0.0.1');
 const done=reason=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();resolve({reason,received:received.toString()});};
 const timer=setTimeout(()=>done('timeout'),1500);
 socket.on('connect',()=>socket.write(payload));socket.on('data',data=>{received=Buffer.concat([received,data]);if(received.length>=Buffer.byteLength(payload))done('data');});socket.on('error',()=>done('error'));socket.on('close',()=>done('closed'));
});}
for await(const line of commands){
 let input;try{input=JSON.parse(line);let result={};switch(input.op){
  case 'demoTask':{const prompt='在京东搜索牛肉面',task={id:randomUUID(),source:'user',roleId:'work',status:'running',prompt,title:prompt,messages:[{id:randomUUID(),role:'user',content:prompt}],events:[],cloudConsent:true,remoteDeviceId:deviceId,remoteControlEpoch:state.data.control.controlEpoch};initializeTimeline(task,{budgetMs:60000});task.taskContract=createTaskContract(task);store.transaction(s=>{s.tasks.push(task);s.settings.phoneUseDeviceId='fixture-demo-phone';});result={taskId:task.id};break;}
  case 'demoPage':demoLabel=input.label;await gateway.demonstrations.sample();result={calls:demoClient.calls};break;
  case 'demoDraft':result={draft:engine.broker.workflows.read(input.draftId)};break;
  case 'attachmentTask':{
   const prompt='把文件“测试附件.txt”通过腾讯QQ发给张三',task={id:randomUUID(),source:'user',roleId:'work',status:'running',prompt,title:prompt,messages:[{id:randomUUID(),role:'user',content:prompt}],events:[],cloudConsent:true,remoteDeviceId:deviceId,remoteControlEpoch:state.data.control.controlEpoch};initializeTimeline(task,{budgetMs:60000});task.taskContract=createTaskContract(task);
   const bytes=Buffer.from('Cross-language attachment fixture only.'),artifact={id:randomUUID(),taskId:task.id,name:'测试附件.txt',mime:'text/plain',size:bytes.length,sha256:hash(bytes),path:task.id+'/file.txt',createdAt:new Date().toISOString()};fs.mkdirSync(path.join(dir,'state/artifacts',task.id),{recursive:true});fs.writeFileSync(path.join(dir,'state/artifacts',artifact.path),bytes);store.transaction(s=>{s.tasks.push(task);s.artifacts.push(artifact);});
   const authorization=attachmentPlan(task,{store}),job=await gateway.attachments.prepareShare({taskId:task.id,artifactId:artifact.id,targetPackage:'com.tencent.mobileqq',requestId:randomUUID(),authorization});result={job,bytesBase64:bytes.toString('base64')};break;
  }
  case 'attachmentStatus':result=gateway.attachments.shareStatus(input.jobId);break;
  case 'attachmentExpire':gateway.attachments.jobs.get(input.jobId).expiresAt=new Date(0).toISOString();break;
  case 'snapshot':result={control:state.data.control,deviceTelemetry,messageReceipts:Object.keys(state.data.messages).length,creates:engine.creates,devices:Object.values(state.data.devices).length,paired:!state.data.pairing,mac:mac.status(),approvals:store.data.approvals,stopEntered:engine.stopEntered,tasks:store.data.tasks,defaults:{cloudConsent:store.data.settings.chatCloudConsent,memoryConsent:store.data.settings.chatMemoryConsent}};break;
  case 'stopDelay':engine.stopDelayMs=input.milliseconds;engine.stopEntered=false;break;
  case 'phoneLease':phone.lease=input.taskId||null;break;
  case 'dropPair':dropPair=true;break;
  case 'expirePair':state.update(s=>{if(s.pairing)s.pairing.expiresAt=1;});result={pairingPresent:Boolean(state.data.pairing)};break;
  case 'dropMessage':dropMessage=true;break;
  case 'control':state.update(s=>{s.control={controlEpoch:input.epoch,paused:input.paused};});if(input.paused)mac.pause();break;
  case 'maintenance':RemoteService.prototype.pauseForMaintenance.call({phone,state,clock:Date.now,connector:mac});phone.remoteMaintenance=false;result={control:state.data.control};break;
  case 'largeState':{
   const now=new Date().toISOString();store.transaction(s=>{for(let n=0;n<240;n++)s.tasks.push({id:randomUUID(),roleId:'concierge',status:'completed',source:'user',remoteDeviceId:deviceId,title:`Synthetic history ${n}`,prompt:'Synthetic fixture only',result:'Synthetic fixture '.repeat(160),createdAt:now,updatedAt:now,messages:[],events:[]});});result={tasks:store.data.tasks.length};break;
  }
  case 'largeGzipState':{
   const now=new Date().toISOString(),rows=Array.from({length:150},(_,n)=>({id:randomUUID(),roleId:'concierge',status:'completed',source:'user',remoteDeviceId:deviceId,title:`Opaque synthetic ${n}`,prompt:'Synthetic transport bytes only',result:randomBytes(1024).toString('base64'),createdAt:now,updatedAt:now,messages:[],events:[]}));
   store.transaction(s=>s.tasks.push(...rows));result={tasks:rows.length,resultHash:hash(rows.map(row=>row.result).join('\n'))};break;
  }
  case 'backpressure':{
   const delay=Math.max(0,Math.min(50,Number(input.milliseconds)||0)),client=mac.clients.data,send=client.sendBinary.bind(client);
   client.sendBinary=async(...args)=>{await send(...args);await new Promise(resolve=>setTimeout(resolve,delay));};result={milliseconds:delay};break;
  }
  case 'taskStatus':store.updateTask(input.taskId,t=>{t.status=input.status;t.result=input.result||'';});break;
  case 'browserPage':{
   if(!browserRuntime){browserRuntime=await chromium.launch({headless:true,...(fs.existsSync(chromium.executablePath())?{}:{channel:'chrome'})});browser.context=await browserRuntime.newContext({viewport:{width:800,height:600},serviceWorkers:'block'});await browser.context.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Local fixture work page</title><h1>Work page</h1><button onclick="this.textContent=\'Clicked once\'">Click fixture</button><input placeholder="Fixture note"><p id="result">Ready</p>'}));}
   const page=await browser.context.newPage();await page.goto('https://fixture.invalid/work');browser.pages.set(input.taskId,page);result={available:true};break;
  }
  case 'browserSensitive':await browser.existingPage(input.taskId).evaluate(()=>{const frame=document.createElement('iframe');document.body.append(frame);frame.contentDocument.body.innerHTML='<input type="password" value="must-not-leave-page">';});break;
  case 'browserText':result={text:await browser.existingPage(input.taskId).locator('body').innerText(),locked:browser.manualOwners.has(input.taskId)};break;
  case 'browserExpire':for(const session of gateway.workspace.sessions.values())session.expiresAt=Date.now()-1;gateway.workspace.invalidateChanged();break;
  case 'revoke':state.revoke(deviceId);gateway.disconnectWorkspace();break;
  case 'symlinkArtifact':{
   const id=randomUUID(),outside=path.join(dir,'outside-artifact.txt'),relative='symlink-fixture-'+id;const bytes=Buffer.from('must not cross artifact root');
   fs.writeFileSync(outside,bytes);fs.symlinkSync(outside,path.join(dir,'state/artifacts',relative));
   store.transaction(s=>s.artifacts.push({id,taskId:input.taskId,name:'escape.txt',mime:'text/plain',size:bytes.length,sha256:hash(bytes),path:relative,createdAt:new Date().toISOString()}));result={artifactId:id};break;
  }
  case 'approval':{
   const summary='在测试任务中发送指定内容，必须逐项确认';
   const pending=approvals.request(input.taskId,{tool:'phone.send_message',args:{recipient:'fixture',text:'fixture only'},summary,evidence:{screen:'fixture-evidence'}}).then(()=>approvalOutcomes.set(input.taskId,'approved'),()=>approvalOutcomes.set(input.taskId,'denied'));
   result={approval:store.data.approvals.at(-1)};break;
  }
  case 'startTyping':{
   const request={deviceId,text:'联通样例',mode:'replace',packageName:'com.example.fixture'};
   if(input.referenceId)Object.assign(request,{operation:'verify_replace',referenceId:input.referenceId,controlEpoch:state.data.control.controlEpoch});
   typingResult=gateway.typing.request(request).then(receipt=>({receipt}),error=>({errorCode:error.code}));
   result={queued:true};break;
  }
  case 'typingReceipt':result=await typingResult;break;
  case 'phoneProbe':result=await phoneProbe(input.lane,input.payload||'fixture-probe');break;
  case 'disconnectAndroid':for(const lane of relay.lanes.values())lane.peers.android?.close(1001,'interop transport loss');break;
  case 'disconnectMac':await mac.close();break;
  case 'exit':console.log(JSON.stringify({id:input.id,ok:true}));process.exit(0);
  default:throw Error('Unknown fixture command');
 }console.log(JSON.stringify({id:input.id,ok:true,...result}));}
 catch(error){console.log(JSON.stringify({id:input?.id,ok:false,error:String(error.message)}));}
}
for(const a of store.data.approvals)if(a.status==='pending')approvals.cancelTask(a.taskId);
voice.close();await mac.close();await gateway.close();await browser.close();await browserRuntime?.close();await relay.close();for(const socket of frontSockets)socket.destroy();await new Promise(r=>front.close(r));store.close();
