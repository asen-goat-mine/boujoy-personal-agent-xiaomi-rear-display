import assert from 'node:assert/strict';
import {nativeTask,nativeEnvelope} from './phone-native-fixture.mjs';
import {effectIdentity,effectPlan} from '../../src/adapters/phone-effects.mjs';
import {PhoneUseClient} from '../../src/adapters/phoneuse-client.mjs';
import {INPUT_PROOF_FRAME} from '../../src/adapters/input-recovery-capture.mjs';
import {Broker} from '../../src/tools/broker.mjs';

export function proofFrame(deviceId,instance,seq){
 const raw=nativeEnvelope({packageName:'com.tencent.mm'},[]);
 Object.assign(raw,{device_id:deviceId,service_instance_id:instance,observation_id:instance+':'+seq});
 const at=raw.captured_at_ms;
 raw.screenshot={available:true,width:500,height:1200,scale_x:2,scale_y:2,offset_x:0,offset_y:0,mime_type:'image/jpeg',data_base64:'ZGF0YQ==',started_at_ms:at-2,finished_at_ms:at-1};
 return raw;
}
export function staleInputFixture({deviceId='native-fixture',instance='session-fixture',client}={}){
 const task=nativeTask('在微信给文件传输助手发送“合成原文”',{status:'unknown_result',remoteDeviceId:'bound-phone',remoteControlEpoch:7,deadlineAt:'2001-01-01T00:00:00.000Z'});
 const scope=task.phoneUseScope={taskId:task.id,packageName:'com.tencent.mm',mode:'general',contractId:task.taskContract.id,contractRevision:task.taskContract.revision,effectPlan:effectPlan(task.taskContract)};
 const action={id:'original',taskId:task.id,status:'unknown',tool:'phone_action',phoneOperation:'type',nativeRequestId:'00000000-0000-4000-8000-000000000001',phoneEffect:{kind:'effect_message_input',packageName:scope.packageName,witness:{contractId:scope.contractId,contractRevision:scope.contractRevision,effectKey:effectIdentity(scope)}}};
 const store={data:{settings:{phoneEnabled:true,executionEpochs:{phone:2}},tasks:[task],actions:[action]},task:()=>task,transaction:fn=>fn(store.data)};
 const control={paused:false,controlEpoch:8},telemetry={deviceId:'bound-phone',fresh:true,typingProtocol:2,certificateFingerprint:'fixture-cert'};
 const calls=[],frames=[],proofs=[],options=[];
 const line=(text,bounds)=>({text,bounds,center:{x:(bounds[0]+bounds[2])/2,y:(bounds[1]+bounds[3])/2}});
 const ocr={width:500,height:1200,lines:[line('文件传输助手',[175,65,300,90]),line('合成原文',[60,720,250,750]),line('发送',[435,720,475,750])]};
 const hooks={};
 client||={controlRpc:{},active:new Map(),start:async()=>{},status:async()=>{calls.push('status');const value={device_id:deviceId,service_instance_id:instance,stopped:false,executing_request_id:null};hooks.status?.(value);return value;},
  async invoke(rpc,tool,args){assert.equal(rpc,this.controlRpc);assert.equal(tool,'observe');assert.deepEqual(args,{device_id:deviceId,...INPUT_PROOF_FRAME});calls.push('capture');const raw=proofFrame(deviceId,instance,frames.length+1);frames.push(raw);hooks.frame?.(raw,frames.length);return {content:[{type:'text',text:JSON.stringify(raw)}]};},
  observeForInputVerification(device,opts){options.push(opts);return PhoneUseClient.prototype.observeForInputVerification.call(this,device,opts);}
 };
 const phone={store,phoneUse:{client},remoteControlState:()=>control,remoteDeviceTelemetry:()=>telemetry,phoneUseDevice:()=>deviceId,
  acquire(id){assert.ok(!this.lease);this.lease=id;},release(id){assert.equal(this.lease,id);this.lease=null;},
  recognize:async()=>{hooks.ocr?.(ocr);return ocr;},observeGeneral:()=>assert.fail('ordinary data lane'),actGeneral:()=>assert.fail('action'),ime:{request:()=>assert.fail('input'),verify:async input=>{
   calls.push('verify');assert.deepEqual(input,{text:'合成原文',packageName:'com.tencent.mm',referenceId:action.nativeRequestId,controlEpoch:8});
   const result={id:'verify-'+(proofs.length+1),status:'verified',proof:{referenceId:input.referenceId,controlEpoch:8,editorIdentity:'a'.repeat(64),exact:true,reads:2}};
   proofs.push(result);hooks.proof?.(result,proofs.length);return result;
  }}};
 return {task,action,store,phone,client,deviceId,instance,control,telemetry,ocr,calls,frames,proofs,options,hooks,run:()=>Broker.prototype.reconcilePhoneNavigation.call({store,phone},task.id)};
}
