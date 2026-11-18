import {validSession} from '../remote/display-commands.mjs';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function displaySession(value){
  if(!validSession(value))return null;
  const safe={sessionId:value.sessionId,generation:value.generation,displayId:value.displayId};
  for(const dimension of ['width','height'])if(Number.isSafeInteger(value[dimension])&&value[dimension]>0&&value[dimension]<=10000)safe[dimension]=value[dimension];
  return safe;
}
function progressRear(value){
  if(!object(value))return null;
  return {available:value.available===true,displayId:Number.isSafeInteger(value.displayId)&&value.displayId>0?value.displayId:null,
    showing:value.showing===true,role:'boujoy_progress_only'};
}
// The native adapter retains legacy display:'main' for existing local guards.
// Only a checked, self-consistent display session can relabel its model copy.
function modelDisplay(value){
  if(!object(value)||value.backend!=='display'||!['main','background'].includes(value.display))return value;
  const session=displaySession(value.displaySession);
  if(!session||value.displayId!==session.displayId)return value;
  return {...value,display:'background',displaySession:session};
}
function modelPhoneBlock(block){
  if(block?.type!=='text')return block;
  try{
    const value=JSON.parse(block.text);let copy=modelDisplay(value);
    const page=value?.result;
    if(value?.ok===true&&object(page)&&['main','background'].includes(page.display)&&typeof page.tree==='string'){
      let modelPage=modelDisplay(page);
      // Keep offscreen nodes in the original local tree, never as model visual evidence.
      const lines=page.tree.split('\n'),visible=lines.filter(line=>!/(?:^|\s)offscreen(?:\s|$)/.test(line.replace(/"[^"\n]*"/g,'')));
      if(visible.length!==lines.length)modelPage={...modelPage,tree:visible.join('\n'),omittedOffscreenNodes:lines.length-visible.length};
      if(modelPage!==page)copy={...copy,result:modelPage};
    }
    // Telemetry describes the Boujoy progress UI, not the target application's location.
    const telemetry=value?.connectorTelemetry,backend=telemetry?.displayBackend;
    if(object(telemetry)&&object(backend)&&object(backend.rear))copy={...copy,connectorTelemetry:{...telemetry,displayBackend:{...backend,rear:progressRear(backend.rear)}}};
    return copy===value?block:{...block,text:JSON.stringify(copy)};
  }catch{return block;}
}
// The local pairing UI needs credentials; a model only needs connection health.
export function modelToolResult(name, result){
  if(name!=='phone_status'){
    if(name.startsWith('phone_')&&Array.isArray(result?.content)){
      const content=result.content.map(modelPhoneBlock);
      if(content.some((block,index)=>block!==result.content[index]))result={...result,content};
      const refs=result.content.flatMap(block=>{try{const value=block.type==='text'?JSON.parse(block.text):null;return typeof value?.observationId==='string'&&value.observationId.startsWith('screen-')?[value.observationId]:[];}catch{return [];}});
      if(refs.length)return {...result,content:[{type:'text',text:JSON.stringify({finishEvidenceRefs:[...new Set(refs)],instruction:'finish_task.evidence 使用这里的观察编号，不使用原生请求编号或工具名。'})},...result.content]};
    }
    return result;
  }
  let status={};
  try{
    const wrapper=JSON.parse(result.content.find(c=>c.type==='text').text);
    status=wrapper.result?JSON.parse(wrapper.result.content.find(c=>c.type==='text').text):wrapper;
    status={...status,enabled:wrapper.enabled,backend:wrapper.backend??status.backend};
  }catch{}
  const links=new Set(['ready','away','reconnecting','ended','unpaired','connecting','not_ready','paused']);
  const background=status.backend==='display';
  const safe={enabled:status.enabled===true,connected:status.connected===true,link:links.has(status.link)?status.link:'unknown',listening:status.listening===true,display:background?'background':'main'};
  if(Number.isFinite(status.remainingMs))safe.remainingMs=Math.max(0,status.remainingMs);
  if(background||status.backend==='phoneuse')safe.backend=status.backend;
  if(background){
    safe.session=displaySession(status.session);safe.displayId=safe.session?.displayId??null;
    if(object(status.rear))safe.rear=progressRear(status.rear);
    if(['running','not_running','permission_required','unsupported'].includes(status.shizuku))safe.shizuku=status.shizuku;
    for(const key of ['executorService','userService'])if(typeof status[key]==='boolean')safe[key]=status[key];
    const reasons=new Set(['shizuku_not_running','shizuku_permission_required','user_service_unavailable','executor_service_disabled','display_unsupported','locked','locally_paused','permission_denied']);
    if(status.reason===null||reasons.has(status.reason))safe.reason=status.reason;
  }
  return {content:[{type:'text',text:JSON.stringify(safe)}]};
}
