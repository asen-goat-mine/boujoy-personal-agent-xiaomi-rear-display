import {randomUUID} from 'node:crypto';
import {AppError,requireValue} from '../core/errors.mjs';

/** Human-only control of an existing task page. No URL, filesystem or desktop API. */
export class BrowserWorkspace {
 constructor({browser,store,engine,state,clock=Date.now}){Object.assign(this,{browser,store,engine,state,clock});this.sessions=new Map();this.closed=false;this.timer=setInterval(()=>this.invalidateChanged(),1000);this.timer.unref();}
 available(taskId){return !!this.browser?.pages?.get(taskId)&&!this.browser.pages.get(taskId).isClosed();}
 valid(session){const task=this.store.data.tasks.find(t=>t.id===session.taskId);return !this.closed&&this.clock()<session.expiresAt&&this.clock()-session.usedAt<60000&&this.state.device(session.fingerprint)?.id===session.deviceId&&this.state.data.control.paused&&this.state.data.control.controlEpoch===session.controlEpoch&&['paused','ready_for_user','unknown_result'].includes(task?.status)&&this.available(session.taskId);}
 releaseWhenIdle(session){if(session.busy||this.browser.pending?.has(session.taskId)){const timer=setTimeout(()=>this.releaseWhenIdle(session),25);timer.unref();}else this.browser.clearManual(session.taskId,session.id);}
 end(session){if(!session)return;this.sessions.delete(session.id);this.releaseWhenIdle(session);session.frame=null;}
 invalidateChanged(){for(const session of this.sessions.values())if(!this.valid(session))this.end(session);}
 invalidateAll(){for(const session of this.sessions.values())this.end(session);}
 get(id,device,fp,taskId){const session=this.sessions.get(id);requireValue(session&&session.deviceId===device.id&&session.fingerprint===fp&&session.taskId===taskId,'工作页会话已失效，请重新接管','browser_session_expired');if(!this.valid(session)){this.end(session);throw new AppError('browser_session_expired','工作页连接已失效；任务保持暂停',409);}return session;}
 async begin(taskId,device,fp,epoch){
  requireValue(!this.closed&&this.browser,'工作页暂不可用');requireValue(this.state.data.control.paused&&this.state.data.control.controlEpoch===epoch,'请先接管并暂停任务');requireValue(this.available(taskId),'这项任务没有可接管的电脑工作页','browser_page_missing');
  for(const old of this.sessions.values())if(old.deviceId===device.id)this.end(old);
  const session={id:randomUUID(),taskId,deviceId:device.id,fingerprint:fp,controlEpoch:epoch,createdAt:this.clock(),usedAt:this.clock(),expiresAt:this.clock()+600000,frame:null,busy:false};
  this.browser.setManual(taskId,session.id);this.sessions.set(session.id,session);
  try{
   await this.engine.stop(taskId,{pause:true});const deadline=this.clock()+10000;
   while(this.engine.active.has(taskId)||this.browser.pending?.has(taskId)){this.get(session.id,device,fp,taskId);requireValue(this.clock()<deadline,'浏览器仍在停止中，请稍后接管','browser_still_stopping');await new Promise(r=>setTimeout(r,25));}
   this.get(session.id,device,fp,taskId);return {sessionId:session.id,taskId,controlEpoch:epoch,expiresAt:new Date(session.expiresAt).toISOString(),paused:true};
  }catch(error){this.end(session);throw error;}
 }
 async operate(taskId,device,fp,args,kind){
  const session=this.get(args.sessionId,device,fp,taskId);requireValue(args.controlEpoch===session.controlEpoch,'工作页控制代际已失效');requireValue(!session.busy,'上一项工作页操作仍在执行','browser_busy');session.busy=true;session.usedAt=this.clock();
  const guard=()=>this.get(session.id,device,fp,taskId);
  try{
   if(kind==='frame'){const frame=await this.browser.workspaceCapture(taskId,session.id,guard);guard();session.frame=frame;const {hash,at,...visible}=frame;return {...visible,sessionId:session.id,controlEpoch:session.controlEpoch};}
   if(kind==='act'){const frame=session.frame;session.frame=null;return await this.browser.workspaceAct(taskId,session.id,frame,args,guard);}
   throw new AppError('invalid_action','工作页操作无效');
  }finally{session.busy=false;}
 }
 finish(taskId,device,fp,args){const session=this.get(args.sessionId,device,fp,taskId);requireValue(args.controlEpoch===session.controlEpoch&&!session.busy,'工作页仍在处理或代际已变化');this.end(session);return {released:true,taskId,paused:true};}
 close(){this.closed=true;clearInterval(this.timer);this.invalidateAll();}
}
