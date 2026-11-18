import {randomUUID} from 'node:crypto';
import {requestHash} from './task-contract.mjs';
import {requireValue} from './errors.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest=value=>requestHash(JSON.stringify(value));
const fields=new Set(['recipient','content','query','field','value','when','dialRecipient','dialNumber','fileName','filePath','newName','destination','orderId','account','audience','socialTarget']);
const labels=new Set(['搜索','确定','确认','返回','下一步','完成','保存','取消','发送','选择','添加','关闭','更多','设置','主页','Search','OK','Back','Next','Done','Save','Cancel','Send','Add','Close','Settings']);
// Only a trusted live gateway session calls this entry point. It is not a model tool.
export function demonstrationDraft(library,session,validate){
 requireValue(session&&UUID.test(session.id)&&session.startedBy==='authenticated_user','示范必须由用户主动开始');
 const task=library.store.task(session.sourceTaskId),message=task.messages.filter(m=>m.role==='user').at(-1);
 requireValue(task.source==='user'&&message?.id===session.sourceMessageId&&!message.externalContent&&!message.external_content&&requestHash(message.content)===session.sourceSha256,'示范来源已变化');
 requireValue(session.objective===task.taskContract?.goal&&task.taskContract?.source?.contentSha256===requestHash(message.content),'示范目标已变化');
 const start=Date.parse(session.startedAt),end=Date.parse(session.endedAt),expires=Date.parse(session.expiresAt);
 requireValue(Number.isFinite(start)&&Number.isFinite(end)&&Number.isFinite(expires)&&end>=start&&expires>start&&expires-start<=120000&&end<=expires+3000&&end<=library.clock()+3000,'示范时间无效');
 requireValue(Array.isArray(session.observations)&&session.observations.length>0&&session.observations.length<=60,'示范没有可用页面记录或超出上限');
 const seen=new Set(),observations=[];
 for(const row of session.observations){
  const at=typeof row.at==='number'?row.at:Date.parse(row.at);requireValue(Number.isFinite(at)&&at>=start&&at<=end&&typeof row.packageName==='string'&&/^[A-Za-z][\w]*(?:\.[\w]+)+$/.test(row.packageName)&&row.packageName.length<=150&&/^[a-f0-9]{64}$/.test(row.screenHash),'示范页面证据无效');
  if(seen.has(row.screenHash))continue;seen.add(row.screenHash);const summary=row.nodeSummary||{};requireValue(Number.isInteger(summary.nodeCount)&&summary.nodeCount>=0&&summary.nodeCount<=20000&&Number.isInteger(summary.editableCount)&&summary.editableCount>=0&&summary.editableCount<=summary.nodeCount&&Array.isArray(summary.controls),'示范结构摘要无效');
  const controls=summary.controls.slice(0,6).map(control=>({...(typeof control.viewId==='string'&&/^[\w.]+:id\/[\w$]+$/.test(control.viewId)&&control.viewId.length<=120?{viewId:control.viewId}:{}),...(typeof control.className==='string'&&/^[\w.]+$/.test(control.className)&&control.className.length<=80?{className:control.className}:{}),...(labels.has(control.label)?{label:control.label}:{})}));
  observations.push({at:new Date(at).toISOString(),packageName:row.packageName,screenHash:row.screenHash,nodeSummary:{nodeCount:summary.nodeCount,editableCount:summary.editableCount,controls}});
 }
 const parameters=Object.entries(task.taskContract.objects||{}).filter(([key,value])=>fields.has(key)&&(['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value))&&String(value).length>0&&String(value).length<=2000).slice(0,12).map(([key,value])=>({name:key,type:typeof value,sourceField:key,description:'本次用户明确指定的 '+key}));
 if(!parameters.length)parameters.push({name:'goal',type:'string',sourceField:'goal',description:'本次用户明确交代的目标'});
 const template=parameters.map(p=>p.name+'={{'+p.name+'}}').join('；'),effects=task.taskContract.effects.filter(e=>['send','call','setting','schedule','file','capture','social','order'].includes(e)),verify=effects.length===1?{kind:'phone_effect',effect:effects[0]}:{kind:'manual'};
 const definition=validate({name:'手机示范流程',description:'用户主动示范时观察到的页面顺序。记录不包含具体点击、输入正文或截图；每次使用须重新定位和核验。',parameters,steps:[{instruction:'参考示范页面顺序，在本轮任务授权范围内处理：'+template,preconditions:['当前应用和页面与示范适用场景一致；不复用旧坐标'],postconditions:['核实 '+template+' 对应的真实结果，页面变化或接口回执本身不算业务完成'],verify}],preconditions:['具体对象与效果仍由本轮用户消息决定'],postconditions:['结果有新鲜证据；需要接管时交还用户']});
 const demonstration={sessionId:session.id,startedAt:new Date(start).toISOString(),endedAt:new Date(end).toISOString(),stopReason:['user_stopped','timeout','disconnected','revoked','epoch_changed','source_changed','sensitive_screen','closed'].includes(session.stopReason)?session.stopReason:'stopped',observations,observationsSha256:digest(observations),captures:'page-structure-only',actionsRecorded:false,authorization:false};
 for(const listed of library.list()){const old=library.read(listed.id);if(old.source_type==='user_demonstration'&&old.demonstration?.sessionId===session.id){requireValue(old.demonstration.observationsSha256===demonstration.observationsSha256&&old.source.contentSha256===session.sourceSha256,'示范编号对应的记录已变化');return old;}}
 return library.save({id:randomUUID(),protocol:'boujoy-workflow',schema_version:1,scope:'personal-agent',memory_kind:'workflow',title:definition.name,status:'draft',source_type:'user_demonstration',verification:'unverified',updated:new Date(library.clock()).toISOString(),definition,definition_sha256:digest(definition),source:{taskId:task.id,messageId:message.id,contentSha256:session.sourceSha256},demonstration,instances:[],outcomes:[]});
}
