import {AsyncLocalStorage} from 'node:async_hooks';
import {AppError,requireValue} from './errors.mjs';
const context=new AsyncLocalStorage();
export const EXECUTION_DOMAINS={browser:'browserEnabled',files:'filesEnabled',phone:'phoneEnabled'};
const labels={browser:'浏览器执行',files:'本机文件与计算',phone:'手机执行'};
const epoch=(store,domain)=>store?.data?.settings?.executionEpochs?.[domain]||0;
export function toolExecutionDomains(name,task){
 if(['bash','read','write','edit','glob','grep','read_image','workflow','skill','working_directory','job_list','job_output','job_kill','read_mcp_resource','list_mcp_resources','list_mcp_resource_templates'].includes(name))return ['files'];
 if(name==='phone_prepare_attachment')return ['phone','files'];
 if(name==='task_graph'&&task?.taskContract?.objects?.screenshotSchedule)return ['phone','files'];
 if(name==='shop_flow'||name.startsWith('phone_'))return ['phone'];
 if(name.startsWith('browser_')||name.startsWith('web_'))return ['browser'];
 if(/^(?:artifact_|document_create$|python_run$|memory_|workflow_|mac_files$|local_agents$|agent_run$|agent_wait$)/.test(name))return ['files'];
 return [];
}
export function assertExecutionPermission(store,domains){
 const active=context.getStore();store||=active?.store;if(!store?.data)return;
 for(const domain of Array.isArray(domains)?domains:[domains]){
  requireValue(Object.hasOwn(EXECUTION_DOMAINS,domain),'未知执行范围');
  if(store.data.recoveryFence?.required||store.data.settings?.[EXECUTION_DOMAINS[domain]]===false)throw new AppError('execution_disabled',`${labels[domain]}已关闭；请在设置中重新开启后继续`,409);
  if(active?.store===store&&Object.hasOwn(active.epochs,domain)&&active.epochs[domain]!==epoch(store,domain))throw new AppError('execution_revoked',`${labels[domain]}授权已变化；本次旧操作不能恢复`,409);
 }
}
export async function withExecutionPermission(store,domains,taskId,run){
 store||=context.getStore()?.store;if(!domains.length)return run();
 try{assertExecutionPermission(store,domains);}catch(error){error.dispatchState='not_sent';throw error;}
 const parent=context.getStore(),epochs={...(parent&&parent.store===store?parent.epochs:{})};for(const domain of domains)if(!Object.hasOwn(epochs,domain))epochs[domain]=epoch(store,domain);
 if(taskId&&store?.updateTask&&store?.data?.tasks?.some(t=>t.id===taskId)&&domains.some(d=>!store.data.tasks.find(t=>t.id===taskId).executionDomains?.includes(d)))store.updateTask(taskId,t=>{t.executionDomains=[...new Set([...(t.executionDomains||[]),...domains])];});
 return context.run({store,epochs},async()=>{assertExecutionPermission(store,domains);const result=await run();assertExecutionPermission(store,domains);return result;});
}
function affected(task,domains,actions){
 const used=new Set(task.executionDomains||[]);if(task.phoneQuery||task.phoneUseScope||task.taskContract?.allowedApps?.length||task.taskContract?.objects?.systemNavigation)used.add('phone');
 if(task.taskContract?.objects?.attachmentRequested||task.taskContract?.objects?.media||task.taskContract?.objects?.mail?.attachment||task.taskContract?.objects?.screenshotSchedule)used.add('files');
 for(const action of actions||[])if(action.taskId===task.id)for(const domain of toolExecutionDomains(action.tool||'',task))used.add(domain);
 return domains.some(domain=>used.has(domain));
}
// Persist revocation before cancelling work. Re-enabling changes the generation
// too and never resumes a task or makes an old in-flight permit current again.
export async function setExecutionPermissions({store,engine,phone,browser},patch){
 const entries=Object.entries(EXECUTION_DOMAINS).filter(([,field])=>Object.hasOwn(patch,field));
 for(const [,field]of entries)requireValue(typeof patch[field]==='boolean','执行开关必须是布尔值');
 requireValue(!store.data.recoveryFence?.required||entries.every(([,field])=>patch[field]===false),'恢复隔离尚未解除，不能开启执行权限','recovery_fenced');
 const revoked=entries.filter(([,field])=>patch[field]===false&&store.data.settings[field]!==false).map(([domain])=>domain);
 const taskIds=store.data.tasks.filter(t=>['running','waiting_approval','waiting_children','queued'].includes(t.status)&&affected(t,revoked,store.data.actions)).map(t=>t.id);
 store.transaction(s=>{s.settings.executionEpochs||={};for(const [domain,field]of entries){const old=s.settings[field]!==false;if(old!==patch[field])s.settings.executionEpochs[domain]=(s.settings.executionEpochs[domain]||0)+1;s.settings[field]=patch[field];}});
 const errors=[];
 // Jobs can outlive their task's execution slot (including expired tasks).
 if(revoked.includes('files'))try{engine?.broker?.localAgents?.cancelAll?.();}catch(error){errors.push({domain:'files',code:error.code||'agent_stop_failed'});}
 for(const id of taskIds){try{if(engine?.stop)await engine.stop(id,{pause:true});else store.updateTask(id,(task,s)=>{for(const a of s.actions.filter(a=>a.taskId===id&&a.status==='executing'))a.status='unknown';task.status=s.actions.some(a=>a.taskId===id&&['executing','unknown'].includes(a.status)&&!a.resolution)?'unknown_result':'paused';});}catch(error){errors.push({taskId:id,code:error.code||'stop_failed'});}}
 for(const [domain,adapter]of [['browser',browser],['phone',phone]])if(revoked.includes(domain)){try{await adapter?.close?.();}catch(error){errors.push({domain,code:error.code||'close_failed'});}}
 return {settings:Object.fromEntries(Object.values(EXECUTION_DOMAINS).map(field=>[field,store.data.settings[field]!==false])),revokedDomains:revoked,pausedTaskIds:taskIds,...(errors.length?{shutdownErrors:errors}:{})};
}
