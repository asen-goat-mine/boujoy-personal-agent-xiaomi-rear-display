import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
import {requireValue} from './errors.mjs';

// Only authenticated HTTP entry points supply this context. JSON/model input
// cannot impersonate an endpoint, and remoteDeviceId remains execution scope.
const ingress=new AsyncLocalStorage();
export function withCrossEnd(origin,fn,{resumeInput}={}){
 requireValue(origin?.endpoint==='mac'||origin?.endpoint==='phone'&&typeof origin.deviceId==='string','跨端来源无效');
 return ingress.run({origin:{endpoint:origin.endpoint,...(origin.endpoint==='phone'?{deviceId:origin.deviceId}:{})},resumeInput},fn);
}
export function crossEndResumeInput(id,input){return ingress.getStore()?.resumeInput?.(id,input)||input;}
export function crossEndEndpoint(task){
 return task.crossEnd?.lastEndpoint||task.crossEnd?.origin||(task.remoteDeviceId?{endpoint:'phone',deviceId:task.remoteDeviceId}:{endpoint:'mac'});
}
// Called inside the SAME Store transaction as the accepted user message.
// This is an acceptance receipt, never proof of a completed business effect.
export function recordCrossEnd(task,input,operation,{previous=crossEndEndpoint(task)}={}){
 const origin=ingress.getStore()?.origin;
 if(!origin||(task.source||'user')!=='user'||task.parentId||task.groupContext)return;
 const message=task.messages?.findLast(m=>m.role==='user'&&m.clientRequestId===input.clientRequestId);
 if(message)message.crossEndOrigin={...origin};
 task.crossEnd||={origin:operation==='created'?{...origin}:{...previous},lastEndpoint:{...previous},receipts:[]};
 if(operation!=='created'){
  const id=input.clientRequestId||randomUUID();
  if(!task.crossEnd.receipts.some(r=>r.requestId===id))task.crossEnd.receipts.push({
   id:randomUUID(),requestId:id,taskId:task.id,conversationId:task.conversationId||task.id,
   from:{...previous},to:{...origin},crossed:previous.endpoint!==origin.endpoint,
   operation,acceptedAt:new Date().toISOString(),statusAtAcceptance:task.status,
   goalHash:createHash('sha256').update(task.taskContract?.goal||task.prompt||'').digest('hex'),
   contractId:task.taskContract?.id||null,deadlineAt:task.deadlineAt||null,
   inputDigest:input.inputDigest||null,businessCompleted:false
  });
 }
 task.crossEnd.lastEndpoint={...origin};
}
export function messageOwnedBy(task,id,deviceId){
 const message=task.messages?.find(m=>m.clientRequestId===id);
 if(message?.crossEndOrigin)return message.crossEndOrigin.endpoint==='phone'&&message.crossEndOrigin.deviceId===deviceId;
 return task.remoteDeviceId===deviceId;
}
export function crossEndSummary(task){
 if(!task.crossEnd)return null;
 const receipt=task.crossEnd.receipts.at(-1);
 return {origin:task.crossEnd.origin,lastEndpoint:task.crossEnd.lastEndpoint,receipt:receipt?{...receipt,inputDigest:undefined}:null};
}
