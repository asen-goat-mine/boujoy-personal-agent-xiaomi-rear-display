import {assertExecutionPermission} from './execution-permissions.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DATA,MEMORY_VAULT} from '../config.mjs';
import {parseCard,renderCard} from '../adapters/memory.mjs';
import {readDocumentBuffer} from '../tools/documents.mjs';
import {requireValue,shortText} from './errors.mjs';
import {demonstrationDraft} from './demonstration-draft.mjs';
import {requestHash,validateTaskContract} from './task-contract.mjs';
import {affirmativeInstructions} from './instruction-scope.mjs';
import {groupTaskContext} from './groups.mjs';

const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[a-z][a-zA-Z0-9_]{0,39}$/;
const FIELDS=new Set(['goal','recipient','content','topic','query','field','value','when','dialRecipient','dialNumber','fileName','filePath','newName','destination','orderId','account','audience','socialTarget']);
const MAX=128*1024;
const EFFECT_PROOFS={send:['message_sent','attachment_sent','mail_sent'],call:['call_initiated'],setting:['setting_verified'],schedule:['alarm_verified','calendar_verified'],file:['file_renamed','file_moved'],capture:['photo_saved'],social:['post_published','comment_sent','post_bookmarked','media_published'],order:['order_cancelled','order_status_read']};
const digest=value=>requestHash(JSON.stringify(value));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const placeholders=text=>[...text.matchAll(/\{\{([a-z][a-zA-Z0-9_]*)\}\}/g)].map(match=>match[1]);
function exactKeys(value,keys){requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key)),'工作流字段无效');}
function texts(value,name,{min=0,max=10}={}){requireValue(Array.isArray(value)&&value.length>=min&&value.length<=max,`${name}数量无效`);return value.map(item=>shortText(item,name,600));}
export function validateWorkflowDraft(input){
 exactKeys(input,['name','description','parameters','steps','preconditions','postconditions']);
 requireValue(Buffer.byteLength(JSON.stringify(input))<=32000,'工作流定义过大');
 const name=shortText(input.name,'工作流名称',120),description=shortText(input.description,'工作流说明',1200);
 requireValue(Array.isArray(input.parameters)&&input.parameters.length>0&&input.parameters.length<=12,'工作流需要 1–12 个参数');
 const parameters=input.parameters.map(row=>{exactKeys(row,['name','type','description','sourceField']);requireValue(KEY.test(row.name)&&['string','number','boolean'].includes(row.type),'工作流参数格式无效');requireValue(row.sourceField===undefined||FIELDS.has(row.sourceField),'工作流参数来源字段无效');return {name:row.name,type:row.type,description:shortText(row.description,'参数说明',300),...(row.sourceField?{sourceField:row.sourceField}:{})};});
 const names=new Set(parameters.map(row=>row.name));requireValue(names.size===parameters.length,'工作流参数不可重复');
 requireValue(Array.isArray(input.steps)&&input.steps.length>0&&input.steps.length<=20,'工作流步骤数量无效');
 const steps=input.steps.map((row,index)=>{
  exactKeys(row,['instruction','preconditions','postconditions','verify']);const instruction=shortText(row.instruction,'步骤',1200);
  const verify=row.verify||{kind:'manual'};exactKeys(verify,['kind','format','effect']);requireValue(['artifact','phone_effect','system_navigation','range_value','manual'].includes(verify.kind),'工作流核验类型无效');
  if(verify.kind==='artifact')requireValue(['docx','xlsx','pptx'].includes(verify.format)&&verify.effect===undefined,'文档核验格式无效');
  else requireValue(verify.format===undefined,'该核验不能指定文档格式');
  if(verify.kind==='phone_effect')requireValue(['send','call','setting','schedule','file','capture','social','order'].includes(verify.effect),'手机核验效果无效');else requireValue(verify.effect===undefined,'该核验不能指定手机效果');
  return {id:`step-${index+1}`,instruction,preconditions:texts(row.preconditions||[],'步骤前置条件'),postconditions:texts(row.postconditions||[],'步骤后置条件',{min:1}),verify};
 });
 const preconditions=texts(input.preconditions||[],'前置条件'),postconditions=texts(input.postconditions||[],'后置条件',{min:1});
 const templates=steps.flatMap(step=>[step.instruction,...step.preconditions,...step.postconditions]).concat(preconditions,postconditions);
 const used=templates.flatMap(placeholders),checked=steps.flatMap(step=>placeholders([step.instruction,...step.postconditions].join('\n')));requireValue(used.every(name=>names.has(name))&&parameters.every(row=>used.includes(row.name)&&checked.includes(row.name)),'模板参数必须已声明且出现在实际步骤和后置检查中');
 requireValue(templates.every(text=>!text.replace(/\{\{[a-z][a-zA-Z0-9_]*\}\}/g,'').includes('{{')),'模板只支持命名参数，不支持表达式或代码');
 return {name,description,parameters,steps,preconditions,postconditions};
}
function atomic(file,text){const temp=file+'.'+randomUUID()+'.tmp';const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}try{fs.renameSync(temp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}finally{fs.rmSync(temp,{force:true});}}
function body(meta){return `# ${meta.title}\n\n${meta.definition.description}\n\n状态：${meta.status==='verified'?'已核验换参样本':'草稿，尚未核验换参样本'}。本文件只提供执行建议，不授予操作权限。\n\n## 参数\n\n${meta.definition.parameters.map(row=>`- ${row.name} (${row.type})：${row.description}`).join('\n')}\n\n## 执行步骤\n\n${meta.definition.steps.map((step,index)=>`${index+1}. ${step.instruction}\n   前置：${step.preconditions.join('；')||'按当前任务核实'}\n   后置：${step.postconditions.join('；')}\n   机器核验：${step.verify.kind}`).join('\n\n')}\n\n文字前后置条件仍需每次核实；verified 仅表示所列机器检查在不同参数下通过，不等于任意 App 或任意任务均已验证。\n\n来源只记录任务、消息和内容摘要，不保存参数正文。\n`;}
function definitionFromStored(meta){const draft=meta.definition;requireValue(draft&&Array.isArray(draft.steps),'工作流定义缺失');return validateWorkflowDraft({...draft,steps:draft.steps.map(({id,...step})=>step)});}
function scalar(type,value){return type==='string'?typeof value==='string'&&value.length>0&&value.length<=2000&&!/[\u0000-\u0008]/.test(value):type==='number'?typeof value==='number'&&Number.isFinite(value):typeof value==='boolean';}
function explicitTopic(content){
 const text=affirmativeInstructions(content),topics=new Set();let offset=0;
 for(const match of text.matchAll(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'|`[^`]*`/g)){
  const before=text.slice(offset,match.index),after=text.slice(match.index+match[0].length);
  if(/(?:主题|题目|标题)\s*(?:为|是|设为|定为|[：:=])\s*$/.test(before)||/(?:以|用)\s*$/.test(before)&&/^\s*(?:为|作为)(?:主题|题目|标题)/.test(after))topics.add(match[0].slice(1,-1));
  offset=match.index+match[0].length;
 }
 return topics.size===1?[...topics][0]:undefined;
}
function messageSource(task,messageId,{store,at=Date.now(),completed=false}={}){
 requireValue(task?.source==='user'&&!task.parentId&&!groupTaskContext(task,store),'工作流参数必须来自新的直接用户请求，群任务不能读取私人工作流');
 const message=task.messages?.filter(row=>row.role==='user').at(-1);
 requireValue(message?.id===messageId&&task.taskContract?.source?.messageId===message.id&&!message.interjection&&!message.externalContent&&!message.external_content,'工作流来源必须是当前直接用户消息');
 const topic=explicitTopic(message.content);let checked=validateTaskContract(task,{store,at});
 // Earlier contracts stored the explicit report subject in objects.content.
 // Verify every other field with today's parser without modifying the grant.
 if(checked.reason==='objects_changed'&&topic!==undefined&&task.taskContract.objects?.content===topic){
  const objects={...task.taskContract.objects};delete objects.content;
  checked=validateTaskContract({...task,taskContract:{...task.taskContract,objects}},{store,at});
 }
 requireValue(checked.valid&&checked.contract.intent==='task','当前任务授权或来源已经变化');
 requireValue(completed||!['cancelled','failed','expired','paused','unknown_result'].includes(task.status),'当前任务不能使用工作流');
 // Existing workflow cards call this field content. Resolve the legacy alias
 // only inside workflow data binding, outside the phone/message authority.
 const objects={...checked.contract.objects,topic,content:checked.contract.objects.content??topic};
 return {message,contract:checked.contract,objects};
}
function bindParameters(definition,parameters,source){
 exactKeys(parameters,definition.parameters.map(row=>row.name));
 const values={};
 for(const row of definition.parameters){
  const value=parameters[row.name];requireValue(scalar(row.type,value),`参数 ${row.name} 格式无效`);
  if(row.sourceField)requireValue(JSON.stringify(row.sourceField==='goal'?source.contract.goal:source.objects[row.sourceField])===JSON.stringify(value),`参数 ${row.name} 必须来自当前用户请求的绑定对象`);
  else{
   // A model may select a workflow, but it cannot invent an unmentioned parameter value.
   const escaped=String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
   requireValue(new RegExp(`(?:^|[，。；;\\n\\s])${row.name}\\s*[:：=]\\s*[“「"]?${escaped}[”」"]?(?=$|[，。；;\\n\\s])`).test(source.message.content),`参数 ${row.name} 需要用户明确给定 name=value`);
  }
  values[row.name]=value;
 }
 return values;
}
function expanded(definition,values){const apply=text=>text.replace(/\{\{([a-z][a-zA-Z0-9_]*)\}\}/g,(_,name)=>String(values[name]));return {preconditions:definition.preconditions.map(apply),postconditions:definition.postconditions.map(apply),steps:definition.steps.map(step=>({...step,instruction:apply(step.instruction),preconditions:step.preconditions.map(apply),postconditions:step.postconditions.map(apply)}))};}

export class WorkflowLibrary{
 constructor({store,root=path.join(MEMORY_VAULT,'03-Knowledge/workflows'),dataDir=DATA,clock=Date.now}={}){requireValue(store?.data,'工作流需要本机任务状态');this.store=store;this.root=path.resolve(root);this.dataDir=path.resolve(dataDir);this.clock=clock;}
 directory(){assertExecutionPermission(undefined,'files');fs.mkdirSync(this.root,{recursive:true,mode:0o700});requireValue(!fs.lstatSync(this.root).isSymbolicLink(),'工作流目录不可为符号链接');return fs.realpathSync(this.root);}
 file(id){requireValue(ID.test(id),'工作流编号无效');const file=path.join(this.directory(),id+'.md');try{requireValue(fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink(),'工作流文件类型无效');}catch(error){if(error.code!=='ENOENT')throw error;}return file;}
 read(id){const file=this.file(id),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let text;try{requireValue(fs.fstatSync(fd).size<=MAX,'工作流文件过大');text=fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}const {meta}=parseCard(text);requireValue(meta.id===id&&meta.protocol==='boujoy-workflow'&&meta.schema_version===1&&['draft','verified'].includes(meta.status),'不是可用的工作流文件');const definition=definitionFromStored(meta);requireValue(digest(definition)===meta.definition_sha256,'工作流定义校验不一致');requireValue(Array.isArray(meta.instances)&&Array.isArray(meta.outcomes),'工作流记录格式无效');return {...meta,definition,hash:requestHash(text)};}
 list(){return fs.readdirSync(this.directory()).filter(name=>ID.test(name.replace(/\.md$/,''))&&name.endsWith('.md')).map(name=>{const row=this.read(name.slice(0,-3));return {id:row.id,name:row.title,status:row.status,parameters:row.definition.parameters,verifiedSamples:row.outcomes.filter(outcome=>outcome.verified).length};});}
 save(meta,expectedHash){const file=this.file(meta.id);if(expectedHash)requireValue(requestHash(fs.readFileSync(file,'utf8'))===expectedHash,'工作流已被其他操作修改，请重新读取','workflow_conflict');else requireValue(!fs.existsSync(file),'工作流编号已存在');const {hash,...persisted}=meta;const text=renderCard(persisted,body(persisted));requireValue(Buffer.byteLength(text)<=MAX,'工作流历史已达到大小限制');atomic(file,text);return this.read(meta.id);}
 createDemonstrationDraft(session){return demonstrationDraft(this,session,validateWorkflowDraft);}
 createDraft(input,{sourceTaskId,sourceMessageId}={}){
  const definition=validateWorkflowDraft(input),task=this.store.task(sourceTaskId),source=messageSource(task,sourceMessageId,{store:this.store,at:this.clock()}),at=new Date(this.clock()).toISOString();
  const text=JSON.stringify(definition);requireValue(!/(?:sk-[\w-]{12,}|-----BEGIN .*PRIVATE KEY|(?:api.?key|password|密码|验证码|token)\s*[:：=]\s*\S+|\b1[3-9]\d{9}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i.test(text),'工作流模板不能保存凭据或私密联系方式');
  for(const field of ['recipient','content','topic','dialRecipient','dialNumber','fileName','filePath','orderId','account']){const value=source.objects[field];if(typeof value==='string'&&value.length>=2)requireValue(!text.includes(value),'工作流模板应把本次具体对象和正文替换为参数，不保存原文');}
  return this.save({id:randomUUID(),protocol:'boujoy-workflow',schema_version:1,scope:'personal-agent',memory_kind:'workflow',title:definition.name,status:'draft',source_type:'task_reference',verification:'unverified',updated:at,definition,definition_sha256:digest(definition),source:{taskId:task.id,messageId:source.message.id,contentSha256:requestHash(source.message.content)},instances:[],outcomes:[]});
 }
 instantiate(id,{taskId,messageId,parameters}={}){
  const row=this.read(id),task=this.store.task(taskId),source=messageSource(task,messageId,{store:this.store,at:this.clock()}),values=bindParameters(row.definition,parameters,source);
  requireValue(['queued','running','waiting_approval'].includes(task.status),'工作流必须在本次执行之前展开');
  requireValue(row.instances.length<100,'工作流样本已达到上限');
  const instance={id:randomUUID(),taskId,messageId,sourceSha256:requestHash(source.message.content),definitionSha256:row.definition_sha256,parameterHash:digest(values),parameterKeys:Object.keys(values),parameterValueHashes:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,digest(value)])),contractId:source.contract.id,contractRevision:source.contract.revision,at:new Date(this.clock()).toISOString()};
  row.instances.push(instance);row.updated=instance.at;this.save(row,row.hash);
  this.store.updateTask(taskId,t=>{(t.workflowUses||=[]).push({workflowId:id,instantiationId:instance.id,parameterHash:instance.parameterHash,sourceMessageId:messageId,sourceSha256:instance.sourceSha256,definitionSha256:instance.definitionSha256});});
  return {workflowId:id,instantiationId:instance.id,status:row.status,authorization:false,taskContractUnchanged:true,trust:'execution-suggestions-only',...expanded(row.definition,values)};
 }
 async artifactProof(task,format,values,step,instance){
  const relevant=[...new Set(placeholders([step.instruction,...step.postconditions].join('\n')))].map(name=>String(values[name]));
  for(const artifact of this.store.data.artifacts.filter(row=>row.taskId===task.id&&task.report.evidence.includes(row.id)&&row.kind==='document'&&row.verification?.method==='ooxml_parse_roundtrip'&&row.verification.format===format)){
   try{
    requireValue(Date.parse(artifact.createdAt)>=Date.parse(instance.at),'不能把工作流展开前的旧产物算作本次执行');
    requireValue(typeof artifact.path==='string'&&!path.isAbsolute(artifact.path)&&!artifact.path.includes('\\')&&!artifact.path.split('/').some(part=>!part||part==='..'),'产物路径无效');
    const base=fs.realpathSync(path.join(this.dataDir,'artifacts'));let file=base;for(const part of artifact.path.split('/')){file=path.join(file,part);requireValue(!fs.lstatSync(file).isSymbolicLink(),'产物路径不可为符号链接');}
    const stat=fs.statSync(file);requireValue(stat.isFile()&&stat.size===artifact.size&&stat.size<=20*1024*1024,'产物不可核验');const bytes=fs.readFileSync(file);requireValue(sha(bytes)===artifact.sha256,'产物内容已经变化');const parsed=await readDocumentBuffer({format,buffer:bytes}),content=JSON.stringify(parsed);requireValue(relevant.every(value=>content.includes(value)),'产物没有包含本次参数');
    return {verified:true,kind:'artifact',artifactId:artifact.id,sha256:artifact.sha256,format,method:'ooxml_parse_roundtrip',rendered:false};
   }catch{/* A corrupt or unrelated artifact is not evidence of a successful sample. */}
  }
  return {verified:false,reason:'missing_verified_artifact'};
 }
 async recordOutcome(id,{instantiationId,taskId}={}){
  const row=this.read(id),instance=row.instances.find(item=>item.id===instantiationId&&item.taskId===taskId);requireValue(instance,'工作流样本不存在');
  const existing=row.outcomes.find(item=>item.instantiationId===instantiationId&&item.verified);if(existing)return {status:row.status,...existing};
  const task=this.store.task(taskId),completedAt=Date.parse(task.completedAt);let checks=[],reason;
  try{
   requireValue(Number.isFinite(completedAt)&&['completed','ready_for_user'].includes(task.status)&&['completed','ready_for_user'].includes(task.report?.outcome)&&Array.isArray(task.report.evidence)&&task.completionKind!=='conversation','任务还没有真实完成报告');
   const source=messageSource(task,instance.messageId,{store:this.store,at:completedAt,completed:true});requireValue(instance.sourceSha256===requestHash(source.message.content)&&instance.contractId===source.contract.id&&instance.contractRevision===source.contract.revision&&instance.definitionSha256===row.definition_sha256,'工作流样本来源已经变化');
   requireValue(task.workflowUses?.some(use=>use.workflowId===id&&use.instantiationId===instance.id&&use.parameterHash===instance.parameterHash&&use.sourceSha256===instance.sourceSha256&&use.definitionSha256===instance.definitionSha256),'工作流缺少实际任务使用记录');
   const values={};for(const parameter of row.definition.parameters){if(parameter.sourceField)values[parameter.name]=parameter.sourceField==='goal'?source.contract.goal:source.objects[parameter.sourceField];else{const match=source.message.content.match(new RegExp(`(?:^|[，。；;\\n\\s])${parameter.name}\\s*[:：=]\\s*[“「"]?([^”」"，。；;\\n]+)`));requireValue(match,'缺少本次用户参数');const raw=match[1].trim();values[parameter.name]=parameter.type==='number'?Number(raw):parameter.type==='boolean'?raw==='true'?true:raw==='false'?false:null:raw;}}
   const bound=bindParameters(row.definition,values,source);requireValue(digest(bound)===instance.parameterHash,'工作流参数与用户输入不一致');
   requireValue(!this.store.data.actions.some(action=>action.taskId===task.id&&['unknown','executing'].includes(action.status)&&!action.resolution),'仍有结果未知的操作');
   for(const step of row.definition.steps){
    let check;if(step.verify.kind==='artifact')check=await this.artifactProof(task,step.verify.format,bound,step,instance);
    else if(['phone_effect','system_navigation','range_value'].includes(step.verify.kind)){
     const proof=task[step.verify.kind==='phone_effect'?'phoneEffectResult':step.verify.kind==='system_navigation'?'phoneSystemResult':'phoneRangeResult'];
     const verified=proof?.verified===true&&proof.contractId===source.contract.id&&proof.contractRevision===source.contract.revision&&task.report.evidence.includes(proof.observationId)&&Number.isFinite(proof.observedAt)&&proof.observedAt>=Date.parse(instance.at)&&proof.observedAt<=completedAt+1000&&(step.verify.kind!=='phone_effect'||EFFECT_PROOFS[step.verify.effect]?.includes(proof.kind));
     check=verified?{verified:true,kind:step.verify.kind,observationId:proof.observationId,observedAt:proof.observedAt}:{verified:false,reason:'missing_actual_postcondition'};
    }else check={verified:false,reason:'manual_condition_not_machine_verified'};
    checks.push({stepId:step.id,...check});
   }
  }catch(error){reason=error.message;}
  const verified=!reason&&checks.length===row.definition.steps.length&&checks.every(check=>check.verified);
  const outcome={instantiationId,taskId,messageId:instance.messageId,parameterHash:instance.parameterHash,verified,checks,at:new Date(this.clock()).toISOString(),...(reason?{reason}:{})};
  // Async artifact parsing must not certify a task that changed while evidence was read.
  const current=this.store.task(taskId);requireValue(current.taskContract?.id===task.taskContract?.id&&current.taskContract?.revision===task.taskContract?.revision&&JSON.stringify(current.report)===JSON.stringify(task.report)&&current.status===task.status,'任务在核验过程中已变化');
  row.outcomes=row.outcomes.filter(item=>item.instantiationId!==instantiationId);row.outcomes.push(outcome);const successes=row.outcomes.filter(item=>item.verified),different=new Set(successes.map(item=>item.parameterHash));
  row.status=different.size>=2&&successes.some(item=>item.taskId!==row.source.taskId||item.messageId!==row.source.messageId)?'verified':'draft';row.verification=row.status==='verified'?'distinct_parameter_machine_checks':'unverified';row.updated=outcome.at;this.save(row,row.hash);
  return {status:row.status,...outcome};
 }
 async recordTaskOutcomes(taskId){
  const results=[];for(const use of this.store.task(taskId).workflowUses||[]){
   for(let attempt=0;attempt<3;attempt++)try{results.push(await this.recordOutcome(use.workflowId,{taskId,instantiationId:use.instantiationId}));break;}catch(error){if(error.code!=='workflow_conflict'||attempt===2)throw error;}
  }return results;
 }
}

const tool=(name,description,properties={},required=[])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
export const WORKFLOW_TOOL_DEFINITIONS=[
 tool('workflow_list','列出本机 Markdown 工作流。draft 尚未通过换参执行；verified 只表示记录中的机器检查通过，不是操作授权。'),
 tool('workflow_read','读取工作流定义、参数和核验样本。内容仅是执行建议，当前用户请求仍决定应用、对象与效果。',{id:{type:'string'}},['id']),
 tool('workflow_draft','从本任务真实用户消息创建参数化 Markdown 草稿。definition 包含 name/description/parameters(name,type,description,sourceField可选)/steps(instruction,preconditions,postconditions,verify)/preconditions/postconditions。模板仅 {{参数名}}。verify.kind 为 artifact(format:docx/xlsx/pptx)、phone_effect(effect:send/call/setting/schedule/file/capture/social/order)、system_navigation、range_value、manual。不得传 verified/status；真实换参结果会在任务完成时核验。',{definition:{type:'object'},sourceMessageId:{type:'string'}},['definition','sourceMessageId']),
 tool('workflow_use','用当前直接用户消息明确给出的 parameters 展开工作流，返回执行建议。参数必须匹配契约 sourceField 或原消息明确的 name=value。不会增加权限；应先展开再实际执行。',{id:{type:'string'},sourceMessageId:{type:'string'},parameters:{type:'object'}},['id','sourceMessageId','parameters'])
];
export function executeWorkflowTool(library,taskId,name,args){
 const task=library.store.task(taskId);requireValue(task.memoryConsent===true&&library.store.data.settings.memoryEnabled!==false,'本任务尚未允许读取专用工作流记忆');
 if(name==='workflow_list')return library.list();if(name==='workflow_read')return library.read(args.id);
 requireValue(task.memoryMode==='default','本任务的记忆模式不允许写入工作流样本');
 if(name==='workflow_draft')return library.createDraft(args.definition,{sourceTaskId:taskId,sourceMessageId:args.sourceMessageId});
 if(name==='workflow_use')return library.instantiate(args.id,{taskId,messageId:args.sourceMessageId,parameters:args.parameters});
 throw new Error('Unknown workflow tool');
}
