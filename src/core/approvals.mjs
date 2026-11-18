import { randomUUID, createHash } from 'node:crypto';
import { AppError, now } from './errors.mjs';

// Must end inside one tool call (bridge 230 s, Harness 240 s).
const APPROVAL_MS=180000;

export class Approvals {
  constructor(store){this.store=store;this.waiters=new Map();}
  async request(taskId,{tool,args,summary,evidence},signal){
    if(signal?.aborted)throw new AppError('cancelled','任务已停止',409);
    const id=randomUUID();const fingerprint=createHash('sha256').update(JSON.stringify({tool,args,evidence})).digest('hex');
    const record={id,taskId,tool,args,summary,evidence,fingerprint,status:'pending',createdAt:now(),expiresAt:new Date(Date.now()+APPROVAL_MS).toISOString()};
    this.store.updateTask(taskId,(t,s)=>{t.status='waiting_approval';s.approvals.push(record);t.messages.push({id:randomUUID(),role:'assistant',content:`需要你确认：${String(summary||'下一步操作').slice(0,200)}。请在 ${APPROVAL_MS/60000} 分钟内点「允许」或「拒绝」。`,at:now(),approvalId:id});});
    try{this.onWaiting?.(taskId);}catch{}
    const granted=await new Promise((resolve,reject)=>{
      const settle=(value,error)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.waiters.delete(id);error?reject(error):resolve(value);};
      const abort=()=>settle(false,new AppError('cancelled','任务已停止',409));
      const timer=setTimeout(()=>settle(false),APPROVAL_MS);this.waiters.set(id,value=>settle(value));signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();
    });
    // Approval resolution wakes a promise; a stop can win before it resumes.
    // Never hand that old permit to a native tool or agent after cancellation.
    if(signal?.aborted||!['running','waiting_approval'].includes(this.store.task(taskId).status))throw new AppError('cancelled','任务已停止',409);
    this.store.updateTask(taskId,(t,s)=>{const a=s.approvals.find(a=>a.id===id);if(a.status==='pending'){a.status='expired';a.resolvedAt=now();}if(t.status==='waiting_approval')t.status='running';});
    if(!granted)throw new AppError('not_approved','这项操作没有获得确认，不可重试。',403);
    return record;
  }
  resolve(id,allow){
    const a=this.store.data.approvals.find(a=>a.id===id);
    const expiresAt=Date.parse(a?.expiresAt);
    if(!a||a.status!=='pending'||!Number.isFinite(expiresAt)||expiresAt<=Date.now()||!this.waiters.has(id))throw new AppError('approval_expired','请求已过期，请重新查看任务。',409);
    this.store.transaction(s=>{const row=s.approvals.find(a=>a.id===id);row.status=allow?'approved':'denied';row.resolvedAt=now();});this.waiters.get(id)(allow);
  }
  cancelTask(taskId){
    for(const a of this.store.data.approvals.filter(a=>a.taskId===taskId&&a.status==='pending')){
      this.store.transaction(s=>{const row=s.approvals.find(x=>x.id===a.id);row.status='cancelled';row.resolvedAt=now();});this.waiters.get(a.id)?.(false);
    }
  }
}
