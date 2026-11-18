import {parseScreenshotScheduleRequest} from './screenshot-schedule-contract.mjs';
import {initializeScreenshotGraph,screenshotGraphScope,advanceScreenshotGraph,finishScreenshotGraph,screenshotGraphStatus} from './screenshot-schedule-graph.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {validateTaskContract,taskDeadline} from './task-contract.mjs';
import {requireValue} from './errors.mjs';
import {effectGoalStatus} from '../adapters/phone-effects.mjs';

const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const clean=value=>String(value||'').normalize('NFKC').trim();
const apps={微信:['com.tencent.mm'],QQ:['com.tencent.mobileqq'],腾讯QQ:['com.tencent.mobileqq'],短信:['com.google.android.apps.messaging','com.samsung.android.messaging'],Telegram:['org.telegram.messenger'],WhatsApp:['com.whatsapp']};
const maps={'高德地图':['com.autonavi.minimap'],'百度地图':['com.baidu.BaiduMap']};
const QUOTE='[“「"]([^”」"\\n]{1,100})[”」"]';
const nameSafe=value=>typeof value==='string'&&value.length>0&&value.length<=40&&!/[“”「」"\n<>]|指令|系统消息|忽略|转账|验证码|密码/.test(value);
const live=task=>['running','waiting_approval'].includes(task?.status)&&task.cloudConsent===true;
const nodeIds=['address','route','reply'];
export function parseTaskGraphRequest(raw){
 const screenshot=parseScreenshotScheduleRequest(raw);if(screenshot)return screenshot;
 const text=String(raw||''),instruction=text.replace(/[“「"]([^”」"]*)[”」"]/g,'[数据]');
 if(!/地址|地点|位置/.test(text)||!/预计(?:用时|到达时间)|ETA|需要多久|多久到/.test(text)||!/(?:回复|发给|告诉)/.test(instruction))return null;
 if(/^(?:如何|怎么|解释|介绍)|(?:不要|不用|别|禁止).{0,10}(?:读|查|回|发)|网页.{0,8}(?:说|要求)|忽略.{0,8}(?:授权|规则)|下单|叫车|预订|预约|转账|支付|付款/.test(instruction))return null;
 const source=text.match(new RegExp('(?:读取|查看|读|找到)(微信|腾讯QQ|QQ|短信|Telegram|WhatsApp)(?:里|中|的|与)?\\s*(?:'+QUOTE+'|([^，。；：“「"\\s]{1,40}?))(?:(?:的)?(?:会话|聊天)|(?:发来|发送)的|的(?:地址|地点|位置))','i'));
 const mapNames=Object.keys(maps).filter(app=>instruction.includes(app)),modes=[...new Set(instruction.match(/步行|驾车|骑行|公交/g)||[])];
 const origin=text.match(new RegExp('从\\s*'+QUOTE+'\\s*到(?:这个|该|上述|那个|消息中的|消息里(?:的)?)(?:地址|地点|位置)'));
 const reply=text.match(new RegExp('(?:回复给|回复|发给|告诉)\\s*(?:'+QUOTE+'|([^，。；!！?？\\s]{1,40}))(?=[，。；!！?？\\s]|$)'));
 if(!source||!origin||!reply||mapNames.length!==1||modes.length!==1||!/查|规划/.test(instruction))return null;
 const sourceApp=Object.keys(apps).find(app=>app.toLowerCase()===source[1].toLowerCase()),sourceContact=clean(source[2]||source[3]),recipient=clean(reply[1]||reply[2]);
 if(!nameSafe(sourceContact)||!nameSafe(recipient)||!clean(origin[1])||origin[1].length>100)return null;
 const selector=text.match(new RegExp('(?:包含|内容为)\\s*'+QUOTE+'\\s*(?:的)?(?:地址|地点|位置)?消息'))?.[1]||null;
 return {schemaVersion:1,kind:'message_route_reply',sourceApp,sourceContact,requireSender:/(?:发来|发送)的/.test(source[0]),messageSelector:selector,mapApp:mapNames[0],origin:clean(origin[1]),mode:modes[0],replyApp:sourceApp,recipient,replyTemplate:'route_eta_v1'};
}
function origin(task){const c=task.taskContract;return {messageId:c.source.originMessageId||c.source.messageId,contentSha256:c.source.originContentSha256||c.source.contentSha256,segmentId:task.timeline?.segmentId||null};}
function sameOrigin(graph,task,plan){return graph?.schemaVersion===1&&graph.taskId===task.id&&graph.planHash===hash(plan)&&JSON.stringify(graph.source)===JSON.stringify(origin(task));}
export function initializeTaskGraph(task){
 if(parseScreenshotScheduleRequest(task.taskContract?.goal))return initializeScreenshotGraph(task);
 const plan=parseTaskGraphRequest(task.taskContract?.goal);if(!plan||!task.taskContract?.effects?.includes('send'))return null;
 if(sameOrigin(task.taskGraph,task,plan))return task.taskGraph;
 if(task.taskGraph)(task.taskGraphHistory||=[]).push(task.taskGraph);
 task.taskGraph={schemaVersion:1,id:randomUUID(),taskId:task.id,plan,planHash:hash(plan),source:origin(task),createdAt:new Date().toISOString(),stage:'address',status:'running',nodes:nodeIds.map((id,index)=>({id,status:index?'waiting':'active',dependsOn:index?[nodeIds[index-1]]:[],evidence:[]}))};return task.taskGraph;
}
function authority(task,store,at=Date.now()){
 const checked=validateTaskContract(task,{store,at}),plan=checked.valid?parseTaskGraphRequest(checked.contract.goal):null;
 if(!checked.valid||!plan||!live(task)||taskDeadline(task)<=at||!checked.contract.effects.includes('send')||!['user','routine','event'].includes(task.source||'user'))return null;
 if(![plan.sourceApp,plan.mapApp].every(app=>checked.contract.allowedApps.includes(app)))return null;
 const graph=task.taskGraph;if(!sameOrigin(graph,task,plan)||!nodeIds.includes(graph.stage))return null;
 if(store?.data?.recoveryFence?.required||store?.data?.actions?.some(a=>a.taskId===task.id&&['executing','unknown'].includes(a.status)&&!a.resolution))return null;
 return {contract:checked.contract,graph,plan};
}
function validProof(proof){return proof&&proof.digest===hash(proof.value)&&typeof proof.observationId==='string'&&Number.isFinite(proof.observedAt)&&typeof proof.nativeHash==='string';}
export function taskGraphScope(task,{store,at=Date.now()}={}){
 if(parseScreenshotScheduleRequest(task.taskContract?.goal))return screenshotGraphScope(task,{store,at});
 const auth=authority(task,store,at);if(!auth)return null;const {contract,graph,plan}=auth;
 let goal,objects,effects,allowedApps;
 if(graph.stage==='address'){goal=`在${plan.sourceApp}搜索${plan.sourceContact}，查看${plan.sourceContact}的聊天消息`;objects={rawRequest:goal};effects=['read','navigate'];allowedApps=[plan.sourceApp];}
 else{
  const address=graph.nodes[0].proof;if(!validProof(address)||graph.nodes[0].status!=='completed'||address.value.sourceContact!==plan.sourceContact||address.value.sourceApp!==plan.sourceApp)return null;
  const route={origin:plan.origin,destination:address.value.address,mode:plan.mode};
  if(graph.stage==='route'){goal=`在${plan.mapApp}查询从“${route.origin}”到“${route.destination}”的${route.mode}路线`;objects={rawRequest:goal,route,routeRequested:true};effects=['read','navigate'];allowedApps=[plan.mapApp];}
  else{
   const proof=graph.nodes[1].proof,facts=proof?.value;
   if(!validProof(proof)||graph.nodes[1].status!=='completed'||facts.origin!==route.origin||facts.destination!==route.destination||facts.mode!==route.mode||!Number.isInteger(facts.etaSeconds)||facts.etaSeconds<=0||at-proof.observedAt>300000)return null;
   const content=graphReplyText(facts);goal=`在${plan.replyApp}给${plan.recipient}发送“${content}”`;objects={rawRequest:goal,recipient:plan.recipient,content};effects=['read','navigate','send'];allowedApps=[plan.replyApp];
  }
 }
 return {...contract,id:`${contract.id}:graph:${graph.id}:${graph.stage}`,goal,objects,effects,allowedApps,graph:{id:graph.id,nodeId:graph.stage,parentContractId:contract.id,parentContractRevision:contract.revision,source:graph.source}};
}
export function graphReplyText(facts){return `已核实${facts.mode}路线：从${facts.origin}到${facts.destination}，页面预计用时${facts.etaSeconds/60}分钟。`;}
function native(observation){for(const block of observation?.tree?.content||[])try{const value=JSON.parse(block.text);if(value.ok&&value.result?.tree)return value.result;}catch{}return null;}
function fresh(task,observation,expectedPackages,at){
 const state=native(observation);requireValue(observation?.taskId===task.id&&typeof observation.id==='string'&&Number.isFinite(observation.at)&&at-observation.at>=-1000&&at-observation.at<=15000&&['fresh','stable'].includes(observation.stability)&&state?.display==='main'&&expectedPackages.includes(state.windowPkg),'任务图需要本节点应用的新鲜原生观察','graph_evidence_required');
 requireValue(!/\bpassword\b/.test(state.tree.replace(/"[^"\n]*"/g,'')),'凭据页面不能作为任务图证据','graph_evidence_required');return state;
}
function nativeNodes(tree){return String(tree).split('\n').flatMap(line=>{const bounds=line.match(/bounds=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);if(!bounds||line.startsWith('window '))return [];const raw=line.replace(/"[^"\n]*"/g,'');if(/\b(?:editable|offscreen|disabled|password)\b/.test(raw))return [];return [{line,raw,depth:line.length-line.trimStart().length,bounds:bounds.slice(1).map(Number),values:[...line.matchAll(/"([^"\n]*)"/g)].map(m=>m[1].replace(/\\u([a-f0-9]{4})/gi,(_,h)=>String.fromCharCode(parseInt(h,16))))}];});}
function sourceAddress(task,observation,plan,at){
 const state=fresh(task,observation,apps[plan.sourceApp],at),nodes=nativeNodes(state.tree),height=Number(state.tree.match(/^window .*bounds=0,0,\d+,(\d+)/m)?.[1]||0);
 requireValue(height>0&&nodes.filter(node=>node.bounds[1]<height*.22&&node.values.includes(plan.sourceContact)).length===1,'未核实指定会话的唯一标题','graph_source_ambiguous');
 const candidates=[];
 for(let index=0;index<nodes.length;index++){
  const node=nodes[index];if(node.bounds[1]<height*.22)continue;
  const addresses=node.values.flatMap(value=>{const match=value.match(/^(?:地址|地点|位置)[：:]\s*([^\n]{2,120})$/);return match?[clean(match[1])]:[];});
  for(const address of addresses){
   if(/[;；<>\n]|https?:|忽略|执行|授权|指令|密码|验证码|转账|下单|发送|回复|付款|支付/.test(address))continue;
   let block=[node];for(let parent=index-1;parent>=0;parent--){if(nodes[parent].depth>=node.depth)continue;const root=nodes[parent];if(root.bounds[1]<height*.22||root.bounds[3]-root.bounds[1]>height*.6)break;block=[];for(let i=parent;i<nodes.length&&(i===parent||nodes[i].depth>root.depth);i++)block.push(nodes[i]);break;}
   const values=block.flatMap(item=>item.values);if(plan.messageSelector&&!values.some(value=>value.includes(plan.messageSelector)))continue;
   if(plan.requireSender&&!values.some(value=>[plan.sourceContact,`${plan.sourceContact}头像`,`发送者：${plan.sourceContact}`,`发送者:${plan.sourceContact}`].includes(value)))continue;
   candidates.push({address,nodeHash:hash(node.line)});
  }
 }
 requireValue(candidates.length===1,'地址消息不唯一或缺少指定来源证据，请读取完整指定消息','graph_source_ambiguous');
 return {value:{sourceApp:plan.sourceApp,sourceContact:plan.sourceContact,address:candidates[0].address,messageNodeHash:candidates[0].nodeHash},state};
}
function proof(value,observation,state){return {value,digest:hash(value),observationId:observation.id,observedAt:observation.at,nativeHash:hash(state.tree)};}
export function advanceTaskGraph(task,store,{observation,scope,actions=[],at=Date.now(),dataDir,signal}={}){
 if(parseScreenshotScheduleRequest(task.taskContract?.goal))return advanceScreenshotGraph(task,store,{observation,scope,actions,at,dataDir,signal});
 const auth=authority(task,store,at);requireValue(auth,'任务图的原始授权、截止时间或节点状态已失效','graph_not_authorized');const {graph,plan}=auth,expected=taskGraphScope(task,{store,at});
 requireValue(expected&&scope?.contractId===expected.id&&scope.contractRevision===expected.revision,'当前观察不属于任务图活动节点','graph_scope_changed');
 requireValue(graph.stage!=='reply','回复必须核实发送后通过 finish_task 完成，不能跳过发送','graph_reply_pending');
 let captured;
 if(graph.stage==='address'){const {value,state}=sourceAddress(task,observation,plan,at);captured=proof(value,observation,state);}
 else{const state=fresh(task,observation,maps[plan.mapApp],at),result=effectGoalStatus(observation,scope,actions);requireValue(result?.verified&&result.kind==='route_verified','路线尚未经过原生起终点、方式和预计时间核验','graph_route_unverified');captured=proof(result.facts,observation,state);}
 const stage=graph.stage;store.updateTask(task.id,t=>{requireValue(t.taskGraph?.id===graph.id&&t.taskGraph.stage===stage,'任务图节点已变化','graph_scope_changed');const node=t.taskGraph.nodes.find(row=>row.id===stage);node.status='completed';node.proof=captured;node.evidence=[captured.observationId];node.completedAt=new Date(at).toISOString();const next=t.taskGraph.nodes[nodeIds.indexOf(stage)+1];next.status='active';t.taskGraph.stage=next.id;t.phoneUseScope=null;});
 return taskGraphStatus(store.task(task.id),{store,at});
}
export function finishTaskGraph(task,store,{observation,scope,actions=[],at=Date.now()}={}){
 if(parseScreenshotScheduleRequest(task.taskContract?.goal))return finishScreenshotGraph(task,store,{at});
 const auth=authority(task,store,at),expected=taskGraphScope(task,{store,at});requireValue(auth&&auth.graph.stage==='reply'&&expected&&scope?.contractId===expected.id&&scope.contractRevision===expected.revision,'任务图尚未到达已授权的回复节点','graph_incomplete');
 const state=fresh(task,observation,apps[auth.plan.replyApp],at),result=effectGoalStatus(observation,scope,actions);requireValue(result?.verified&&result.kind==='message_sent','尚未核实指定收件人的准确回复，不能完成任务图','graph_reply_unverified');
 const captured=proof({recipient:auth.plan.recipient,content:expected.objects.content,routeDigest:auth.graph.nodes[1].proof.digest},observation,state);
 store.updateTask(task.id,t=>{const node=t.taskGraph.nodes[2];node.status='completed';node.proof=captured;node.evidence=[observation.id];t.taskGraph.status='completed';t.taskGraph.completedAt=new Date(at).toISOString();});
 return {summary:`已从${auth.plan.sourceApp}的${auth.plan.sourceContact}会话核实地址，用${auth.plan.mapApp}查询${auth.plan.mode}路线，并向${auth.plan.recipient}发送：${expected.objects.content}`,evidence:auth.graph.nodes.flatMap(node=>node.evidence),kind:'message_route_reply_completed'};
}
export function taskGraphStatus(task,{store,at=Date.now()}={}){if(parseScreenshotScheduleRequest(task.taskContract?.goal))return screenshotGraphStatus(task,{store,at});const plan=parseTaskGraphRequest(task.taskContract?.goal);if(!plan)return null;const graph=task.taskGraph,scope=taskGraphScope(task,{store,at});return {id:graph?.id||null,kind:plan.kind,status:graph?.status||'not_started',stage:graph?.stage||'address',nodes:graph?.nodes.map(node=>({id:node.id,status:node.status,evidence:node.evidence}))||[],currentScope:scope?{app:scope.allowedApps[0],goal:scope.goal,effects:scope.effects,objects:scope.objects}:null,deadlineAt:task.deadlineAt||task.taskContract.expiresAt,authorityValid:!!scope};}
