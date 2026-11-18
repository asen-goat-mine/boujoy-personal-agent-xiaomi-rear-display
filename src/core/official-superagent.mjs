// Boujoy adapters around the unmodified DeepSeek Super-agent domain engine.
import {Engine as OfficialEngine,latestAssignment,key,ticketStage} from '../vendor/dsh-superagent-core.mjs';
const copy=value=>structuredClone(value);
const empty=()=>({triggers:{},dispositions:{},threads:{},tickets:{},decisions:{},effects:[],receipts:{},bindings:{}});
export class OfficialRepositories {
 constructor(store){this.store=store;this.draft=null;
  const rows=(name,idField)=>({get:id=>copy(this.state[name][id]),save:row=>{this.state[name][row[idField]]=copy(row);},list:()=>Object.values(this.state[name]).map(copy)});
  this.triggers={...rows('triggers','id'),disposition:id=>copy(this.state.dispositions[id]),saveDisposition:(id,row)=>{this.state.dispositions[id]=copy(row);}};
  this.threads={...rows('threads','key'),active:()=>this.threads.list().filter(t=>t.pending.length||t.evaluating)};
  this.tickets={...rows('tickets','id'),list:()=>Object.values(this.state.tickets).reverse().map(copy),open:()=>this.tickets.list().filter(t=>!t.ended),active:()=>this.tickets.list().filter(t=>t.undelivered.length||['pending','running'].includes(latestAssignment(t)?.state))};
  this.decisions={...rows('decisions','id'),byThread:id=>Object.values(this.state.decisions).filter(d=>d.threadKey===id).map(copy)};
 }
 get state(){return this.draft||this.store.data.officialSuperagent||empty();}
 atomic(work){if(this.draft){const before=copy(this.draft);try{return work();}catch(e){this.draft=before;throw e;}}
  return this.store.transaction(s=>{this.draft=copy(s.officialSuperagent||empty());try{const result=work();s.officialSuperagent=this.draft;return result;}finally{this.draft=null;}});
 }
 enqueue(kind,data){const id=key(kind,JSON.stringify(data));if(!this.state.effects.some(e=>e.id===id))this.state.effects.push({id,kind,data:copy(data)});}
}
export class OfficialSuperagent {
 constructor({store,host}){this.store=store;this.host=host;this.repo=new OfficialRepositories(store);const r=this.repo;
  this.engine=new OfficialEngine({repo:r,scope:{scope:input=>input.source==='boujoy'?{listened:true,observed:false}:{listened:false,reason:'source_not_configured'}},
   policy:()=>({version:'boujoy-1',paused:!!store.data.schedulerPaused||!!store.data.recoveryFence?.required,evalTimeoutMs:120000,
    gate:t=>t.source==='boujoy'&&t.meta?.taskId&&store.data.tasks.some(x=>x.id===t.meta.taskId)?{admissible:true,strength:'explicit',basis:{via:'addressed',addressed:'direct',source:'boujoy',sender:t.actor.id}}:{admissible:false,reason:'unbound_source'},
    revalidate:m=>m.actor.source==='boujoy'&&!store.data.recoveryFence?.required,admitsInferred:()=>false}),
   assessor:{request:c=>r.enqueue('assess',c),release:id=>{r.state.effects=r.state.effects.filter(e=>e.kind!=='assess'||e.data.evalId!==id);}},
   executor:{start:(ticket,assignment)=>r.enqueue('start',{ticketId:ticket.id,assignmentId:assignment.id}),deliver:(ticket,assignment)=>r.enqueue('deliver',{ticketId:ticket.id,assignmentId:assignment.id,inputIds:ticket.undelivered}),stop:(ticket,assignment,reason)=>r.enqueue('stop',{ticketId:ticket.id,assignmentId:assignment.id,reason})},
   outbox:{send:m=>{if(!r.state.receipts[m.id]){r.state.receipts[m.id]={...m,status:'pending'};r.enqueue('reply',m);}},status:id=>r.state.receipts[id]?.status,withdraw:id=>{if(r.state.receipts[id]?.status==='pending'){delete r.state.receipts[id];r.state.effects=r.state.effects.filter(e=>e.kind!=='reply'||e.data.id!==id);}}}});
 }
 // Bind an already accepted Boujoy request. The official executor adopts it;
 // it must never submit a duplicate task to the phone or a local agent.
 bind(taskId){const task=this.store.task(taskId);let ticketId=this.repo.state.bindings[taskId];if(ticketId)return ticketId;
  const source=task.messages?.find(m=>m.role==='user');if(!source)throw Error('Missing original user request');
  this.repo.atomic(()=>{const trigger={id:`boujoy:${taskId}:${source.id}`,source:'boujoy',threads:[{source:'boujoy',id:taskId}],actor:{source:'boujoy',id:task.roleId},human:task.source==='user',addressed:'direct',at:source.at||task.createdAt,text:source.content,channel:{source:'boujoy',thread:taskId,address:{taskId,conversationId:task.conversationId||taskId}},meta:{taskId}};
   this.engine.receive(trigger);const decision=this.engine.decide(trigger.id,{kind:'accept',title:task.title,scope:task.prompt,reason:'Accepted by Boujoy task ingress'});ticketId=decision.ticketId;if(!ticketId)throw Error('Official admission did not create a ticket');this.repo.state.bindings[taskId]=ticketId;
  });return ticketId;
 }
 taskFor(ticketId){return Object.entries(this.repo.state.bindings).find(([,id])=>id===ticketId)?.[0];}
 snapshot(taskId){const id=this.repo.state.bindings[taskId],ticket=id&&this.repo.tickets.get(id);return ticket?{ticket,stage:ticketStage(ticket),pendingEffects:this.repo.state.effects.filter(e=>e.data.ticketId===id).length}:null;}
 async drain(){if(this.draining)return;this.draining=true;try{for(const effect of [...this.repo.state.effects]){const d=effect.data,taskId=this.taskFor(d.ticketId);if(effect.kind==='assess')continue;
   try{if(effect.kind==='start'){if(!taskId)throw Error('Unbound official assignment');this.engine.assignmentStarted(d.ticketId,d.assignmentId);}
    else if(effect.kind==='deliver'){if(!taskId)throw Error('Unbound official delivery');const ticket=this.repo.tickets.get(d.ticketId),texts=ticket.inputs.filter(i=>d.inputIds.includes(i.id)).map(i=>i.kind==='trigger'?this.repo.triggers.get(i.triggerId)?.text:i.text).filter(Boolean);if(texts.length){this.store.updateTask(taskId,t=>{(t.superagentInbox||=[]).push({id:effect.id,text:texts.join('\n'),authority:false});});}this.engine.inputsDelivered(d.ticketId,d.assignmentId,d.inputIds);}
    else if(effect.kind==='stop'){const task=taskId&&this.store.task(taskId);if(task&&['running','queued','waiting_children'].includes(task.status))await this.host.stop(taskId,{pause:true});}
    else if(effect.kind==='reply'){const target=d.channel.address.taskId;this.store.updateTask(target,t=>{if(!t.messages.some(m=>m.id===d.id))t.messages.push({id:d.id,role:'assistant',content:d.text,at:new Date().toISOString()});});this.repo.atomic(()=>{this.repo.state.receipts[d.id].status='sent';});}
    this.repo.atomic(()=>{this.repo.state.effects=this.repo.state.effects.filter(e=>e.id!==effect.id);});
   }catch(error){this.lastError=error.message;break;}
  }}finally{this.draining=false;}}
 sync(taskId){const ticketId=this.repo.state.bindings[taskId];if(!ticketId)return;const ticket=this.repo.tickets.get(ticketId),task=this.store.task(taskId);if(ticket.ended)return;
  const states={completed:'ready',ready_for_user:'blocked',failed:'failed',blocked:'blocked',unknown_result:'blocked',paused:'waiting',interrupted:'waiting',waiting_approval:'waiting',waiting_children:'waiting',cancelled:'failed',stopped:'failed',expired:'failed',needs_review:'blocked'};const state=states[task.status];if(!state)return;
  const summary=task.result||task.blockedReason||task.status;if(latestAssignment(ticket)?.report?.state===state&&latestAssignment(ticket)?.report?.summary===summary)return;
  this.engine.report(ticketId,{state,summary});
 }
 takeInbox(taskId){const rows=this.store.task(taskId).superagentInbox||[];if(!rows.length)return [];this.store.updateTask(taskId,t=>{t.superagentInbox=[];});const ticketId=this.repo.state.bindings[taskId];if(ticketId){const ticket=this.repo.tickets.get(ticketId);this.engine.inputsRead(ticketId,ticket.inputs.filter(i=>i.kind==='trigger'&&i.readAt===null).map(i=>i.id));}return rows;}
 close(){this.closed=true;}
}
