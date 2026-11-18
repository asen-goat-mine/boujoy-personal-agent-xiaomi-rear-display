import {createHash,randomUUID} from 'node:crypto';
import {parseScreenshotScheduleRequest} from './screenshot-schedule-contract.mjs';
import {validateTaskContract,taskDeadline} from './task-contract.mjs';
import {parseScheduleRequest} from './schedule-contract.mjs';
import {createRoutine} from './scheduler.mjs';
import {recognizePhoneImage} from '../adapters/phone-ocr.mjs';
import {effectGoalStatus,effectIdentity} from '../adapters/phone-effects.mjs';
import {requireValue} from './errors.mjs';

const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const origin=task=>({messageId:task.taskContract.source.originMessageId||task.taskContract.source.messageId,contentSha256:task.taskContract.source.originContentSha256||task.taskContract.source.contentSha256,segmentId:task.timeline?.segmentId||null});
export function initializeScreenshotGraph(task){
 const plan=parseScreenshotScheduleRequest(task.taskContract?.goal);if(!plan||task.source!=='user'||!task.taskContract.effects.includes('create_schedule')||task.taskContract.effects.some(e=>!['read','navigate','create_schedule'].includes(e)))return null;
 if(task.taskGraph?.kind===plan.kind&&task.taskGraph.planHash===hash(plan)&&JSON.stringify(task.taskGraph.source)===JSON.stringify(origin(task)))return task.taskGraph;
 if(task.taskGraph)(task.taskGraphHistory||=[]).push(task.taskGraph);
 return task.taskGraph={schemaVersion:1,kind:plan.kind,id:randomUUID(),taskId:task.id,plan,planHash:hash(plan),source:origin(task),createdAt:new Date().toISOString(),stage:'screenshot',status:'running',nodes:['screenshot','calendar','reminder'].map((id,i)=>({id,status:i?'waiting':'active',dependsOn:i?[['screenshot','calendar'][i-1]]:[],evidence:[]}))};
}
function authority(task,store,at){
 const checked=validateTaskContract(task,{store,at}),plan=checked.valid?parseScreenshotScheduleRequest(checked.contract.goal):null,graph=task.taskGraph;
 if(!plan||task.source!=='user'||!['running','waiting_approval'].includes(task.status)||!task.cloudConsent||taskDeadline(task)<=at||!checked.contract.effects.includes('create_schedule')||checked.contract.effects.some(e=>!['read','navigate','create_schedule'].includes(e))||!checked.contract.allowedApps.includes('日历')||graph?.kind!==plan.kind||graph.planHash!==hash(plan)||JSON.stringify(graph.source)!==JSON.stringify(origin(task)))return null;
 if(store?.data.recoveryFence?.required||store?.data.roles?.some(r=>r.id===task.roleId&&r.deletedAt)||store?.data.actions?.some(a=>a.taskId===task.id&&['unknown','executing'].includes(a.status)&&!a.resolution))return null;
 return {contract:checked.contract,graph,plan};
}
function imageProofValid(task,store){
 const proof=task.taskGraph.nodes[0].proof,a=store?.data.artifacts?.find(a=>a.taskId===task.id&&a.id===proof?.artifact.id);
 return proof&&proof.digest===hash(proof.value)&&a&&a.sha256===proof.artifact.sha256&&a.name===task.taskGraph.plan.artifactName&&a.size===proof.artifact.size;
}
export function screenshotGraphScope(task,{store,at=Date.now()}={}){
 const auth=authority(task,store,at);if(!auth||auth.graph.stage!=='calendar'||!imageProofValid(task,store))return null;
 const schedule=auth.graph.nodes[0].proof.value.schedule;
 return {...auth.contract,id:`${auth.contract.id}:graph:${auth.graph.id}:calendar`,goal:auth.graph.nodes[0].proof.value.goal,objects:{rawRequest:auth.graph.nodes[0].proof.value.goal,schedule},effects:['read','navigate','create_schedule'],allowedApps:['日历'],graph:{id:auth.graph.id,nodeId:'calendar',parentContractId:auth.contract.id,parentContractRevision:auth.contract.revision,source:auth.graph.source}};
}
export function extractScreenshotSchedule(recognition,{timezone,referenceAt,leadMinutes}){
 const lines=(recognition?.lines||[]).filter(row=>row.kind!=='word').map(row=>String(row.text).normalize('NFKC').trim()).filter(Boolean);
 const field=(patterns)=>{const values=lines.flatMap(text=>{for(const pattern of patterns){const match=text.match(pattern);if(match)return [match[1].trim()];}return [];});return values.length===1?values[0]:null;};
 const title=field([/^(?:标题|日程|会议|Title|Event)\s*[:：]\s*(.{1,80})$/i]),date=field([/^(?:日期|Date)\s*[:：]\s*(\d{4}-\d{2}-\d{2})$/i]),start=field([/^(?:开始|开始时间|Start)\s*[:：]\s*((?:\d{4}-\d{2}-\d{2}\s+)?\d{2}:\d{2})$/i]),end=field([/^(?:结束|结束时间|End)\s*[:：]\s*((?:\d{4}-\d{2}-\d{2}\s+)?\d{2}:\d{2})$/i]);
 requireValue(title&&date&&start&&end&&!/[“”「」"\n]|忽略|授权|密码|验证码|转账|执行指令/.test(title),'截图需要唯一明确的标题、ISO日期、开始和结束时间；模糊或多个日程不会自动写入','graph_image_ambiguous');
 const startDate=start.length>5?start.slice(0,10):date,endDate=end.length>5?end.slice(0,10):date;
 requireValue(startDate===date,'截图日期与开始日期不一致','graph_image_ambiguous');
 const goal=`在日历新建${startDate} ${start.slice(-5)}到${endDate} ${end.slice(-5)}日程“${title}”，时区${timezone}`;
 const schedule=parseScheduleRequest(goal,{timezone,referenceAt});requireValue(schedule?.status==='ready'&&schedule.operation==='create'&&schedule.kind==='calendar'&&schedule.desired.endInstant,'截图日期、时间或时区无效','graph_image_ambiguous');
 const reminderAt=new Date(Date.parse(schedule.desired.instant)-leadMinutes*60000).toISOString();requireValue(Date.parse(reminderAt)>referenceAt,'提醒时间已经过去，不能自动改成其它时间','graph_reminder_past');
 return {goal,schedule,reminderAt};
}
export async function advanceScreenshotGraph(task,store,{observation,scope,actions=[],at=Date.now(),dataDir,signal}={}){
 const auth=authority(task,store,at);requireValue(auth,'截图任务图的原始授权或状态已失效','graph_not_authorized');
 if(auth.graph.stage==='screenshot'){
  const candidates=store.data.artifacts.filter(a=>a.taskId===task.id&&a.name===auth.plan.artifactName&&a.kind==='input'&&a.sourceMessageId===auth.graph.source.messageId);requireValue(candidates.length===1,'请使用原始请求附带的唯一截图文件','graph_image_ambiguous');
  const {readTaskArtifact}=await import('../tools/artifacts.mjs');const artifact=candidates[0];requireValue(/^[a-f0-9]{64}$/.test(artifact.sha256||'')&&Number.isSafeInteger(artifact.size),'截图来源缺少真实文件校验','graph_image_ambiguous');const read=await readTaskArtifact({taskId:task.id,id:artifact.id,artifacts:store.data.artifacts,dataDir});requireValue(read.content.some(c=>c.type==='image'),'来源不是可读取的截图','graph_image_ambiguous');
  const recognition=await recognizePhoneImage(read);requireValue(recognition&&!signal?.aborted,'本机截图识别未完成或任务已停止','graph_image_unreadable');
  const current=store.task(task.id),valid=authority(current,store,Date.now());requireValue(valid&&valid.graph.id===auth.graph.id&&valid.graph.stage==='screenshot','识别期间任务授权已变化','graph_not_authorized');
  const value=extractScreenshotSchedule(recognition,{timezone:auth.plan.timezone||task.timezone,referenceAt:Date.now(),leadMinutes:auth.plan.leadMinutes});
  const proof={artifact:{id:artifact.id,name:artifact.name,sha256:artifact.sha256,size:artifact.size},value,digest:hash(value),method:'macos_vision_local',recognizedAt:Date.now(),recognitionHash:hash(recognition),sourceMessageId:auth.graph.source.messageId,authorizationSource:false};
  store.updateTask(task.id,t=>{requireValue(t.taskGraph?.id===auth.graph.id&&t.taskGraph.stage==='screenshot','任务图已变化');Object.assign(t.taskGraph.nodes[0],{status:'completed',proof,evidence:[artifact.id]});t.taskGraph.nodes[1].status='active';t.taskGraph.stage='calendar';t.phoneUseScope=null;});
 }else{
  requireValue(auth.graph.stage==='calendar','该图已经完成，不能重复安排提醒','graph_incomplete');const expected=screenshotGraphScope(task,{store,at});requireValue(expected&&scope?.contractId===expected.id&&scope.contractRevision===expected.revision&&observation?.taskId===task.id&&at-observation.at>=-1000&&at-observation.at<=15000,'缺少本节点新鲜的日历核验','graph_scope_changed');
  const result=effectGoalStatus(observation,scope,actions);requireValue(result?.verified&&result.kind==='calendar_verified','必须核实日程保存后在列表重开仍存在，才能安排提醒','graph_calendar_unverified');
  const value=auth.graph.nodes[0].proof.value;requireValue(Date.parse(value.reminderAt)>at,'提醒时间已过，不会静默改时','graph_reminder_past');
  const routine=createRoutine({name:value.schedule.title+' 提醒',prompt:`${value.schedule.title}将在${value.schedule.date} ${value.schedule.time}（${value.schedule.timezone}）开始。`,roleId:task.roleId,taskKind:'reminder',kind:'once',nextAt:value.reminderAt,timezone:value.schedule.timezone,cloudConsent:false,memoryConsent:false},{at});
  routine.graphOrigin={taskId:task.id,graphId:auth.graph.id,source:auth.graph.source,imageSha256:auth.graph.nodes[0].proof.artifact.sha256,calendarObservationId:observation.id};
  store.updateTask(task.id,(t,s)=>{requireValue(t.taskGraph?.id===auth.graph.id&&t.taskGraph.stage==='calendar','任务图已变化');requireValue(!(s.routines||[]).some(r=>r.graphOrigin?.graphId===auth.graph.id),'提醒已安排，不会重复创建','graph_duplicate');s.routines||=[];s.routines.push(routine);Object.assign(t.taskGraph.nodes[1],{status:'completed',evidence:[observation.id],proof:{observationId:observation.id,observedAt:observation.at,kind:result.kind,contractId:scope.contractId,contractRevision:scope.contractRevision,nativeHash:hash(observation.tree)}});t.phoneEffectResult={verified:true,kind:result.kind,contractId:scope.contractId,contractRevision:scope.contractRevision,observationId:observation.id,observedAt:observation.at};for(const action of s.actions.filter(a=>a.taskId===task.id&&a.status==='completed'&&a.phoneEffect?.kind==='effect_schedule_save'&&a.phoneEffect.witness?.effectKey===effectIdentity(scope))){action.verification='verified';action.verificationEvidence={kind:result.kind,observationId:observation.id,observedAt:observation.at};}Object.assign(t.taskGraph.nodes[2],{status:'completed',evidence:[routine.id],proof:{routineId:routine.id,nextAt:routine.nextAt,cloudConsent:false}});t.taskGraph.status='completed';t.taskGraph.stage='reminder';t.taskGraph.completedAt=new Date(at).toISOString();});
 }
 return screenshotGraphStatus(store.task(task.id),{store,at:Date.now()});
}
export function finishScreenshotGraph(task,store,{at=Date.now()}={}){
 const auth=authority(task,store,at),graph=task.taskGraph;requireValue(auth&&graph.status==='completed'&&graph.stage==='reminder'&&imageProofValid(task,store),'截图日程和提醒尚未全部核实','graph_incomplete');
 const r=store.data.routines.find(r=>r.id===graph.nodes[2].proof.routineId),value=graph.nodes[0].proof.value;requireValue(r&&r.graphOrigin?.graphId===graph.id&&r.nextAt===value.reminderAt&&r.enabled,'提醒已被修改或停止','graph_incomplete');
 return {summary:`已将截图中的“${value.schedule.title}”写入日历，保存后重开核实为${value.schedule.date} ${value.schedule.time}至${value.schedule.desired.endDate} ${value.schedule.desired.endTime}（${value.schedule.timezone}）；已安排提前${auth.plan.leadMinutes}分钟的本机提醒。`,evidence:[...graph.nodes[0].evidence,...graph.nodes[1].evidence],kind:'screenshot_calendar_reminder_completed'};
}
export function screenshotGraphStatus(task,{store,at=Date.now()}={}){const graph=task.taskGraph,scope=screenshotGraphScope(task,{store,at});return {id:graph?.id,kind:'screenshot_calendar_reminder',stage:graph?.stage||'screenshot',status:graph?.status||'not_started',nodes:graph?.nodes.map(n=>({id:n.id,status:n.status,evidence:n.evidence}))||[],currentScope:scope?{app:'日历',goal:scope.goal,effects:scope.effects,objects:scope.objects}:null,nextAction:graph?.stage==='screenshot'?'task_graph advance 本机读取原请求截图':graph?.stage==='calendar'?'保存日程并从列表重开后 task_graph advance 核验并安排提醒':'finish_task completed',authorityValid:!!authority(task,store,at),deadlineAt:task.deadlineAt};}
