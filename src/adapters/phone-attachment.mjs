import {parseAttachmentRequest} from '../core/attachment-contract.mjs';

const compact=value=>String(value??'').normalize('NFKC').replace(/\s+/g,'');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const inside=(p,b)=>p.x>=b[0]&&p.x<b[2]&&p.y>=b[1]&&p.y<b[3];
const forbidden=/密码|验证码|PIN|OTP|passcode|password|转账|付款|支付|登录|授权|允许/i;
const previewLabel=/^(?:待发送附件|附件预览|文件预览|要发送的文件|分享文件|Attachmentpreview|Filepreview|Selectedfile)$/i;
const placeholder=/^(?:消息|输入消息|输入|Message|Typeamessage|发送消息|添加留言|留言|Addamessage|Sayomething)?$/i;
const failed=/发送失败|发送中|未发送|正在发送|等待发送|重发|上传中|Sendfailed|Sending|Notdelivered|Uploading/i;
export function candidateAttachmentPlan(contract){
 if(!contract?.effects?.includes('send_attachment'))return null;const request=parseAttachmentRequest(contract.goal);
 return request&&same(request,contract.objects?.attachment)&&contract.allowedApps?.includes(request.app)?request:null;
}
function native(observation){for(const block of observation?.tree?.content||[])try{const state=JSON.parse(block.text)?.result;if(state?.tree)return state;}catch{}return null;}
function parseNodes(tree){
 return String(tree).split('\n').flatMap(line=>{const b=line.match(/bounds=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);if(!b||line.startsWith('window '))return [];const raw=line.replace(/"[^"\n]*"/g,''),bounds=b.slice(1).map(Number);if(/\boffscreen\b|\bdisabled\b/.test(raw)||bounds[2]<=bounds[0]||bounds[3]<=bounds[1])return [];const values=[...line.matchAll(/"([^"\n]*)"/g)].map(m=>m[1].replace(/\\u([0-9a-f]{4})/gi,(_,h)=>String.fromCharCode(parseInt(h,16))));return [{line,raw,bounds,values,labels:values.map(compact),depth:line.length-line.trimStart().length,editable:/\beditable\b/.test(raw),focused:/\bfocused\b/.test(raw),clickable:/\bclickable\b/.test(raw),secret:/\bpassword\b/.test(raw)}];});
}
function fresh(observation,grant){const state=native(observation),age=Date.now()-Number(observation?.at);return observation?.taskId===grant.taskId&&age>=-1000&&age<=15000&&['fresh','stable'].includes(observation.stability)&&state?.display==='main'&&state.windowPkg===grant.packageName?state:null;}
function binding(grant){const p=grant?.effectPlan;return p?.kind==='send_attachment'&&p.artifact?.taskId===grant.taskId&&typeof p.recipient==='string'&&p.recipient&&typeof p.artifact.name==='string'&&/^[a-f0-9]{64}$/.test(p.artifact.sha256||'')&&p.contractId===grant.contractId&&p.contractRevision===grant.contractRevision&&Date.parse(p.expiresAt)>Date.now()?p:null;}
function header(nodes,plan,tree){const height=Number(String(tree).match(/^window .*bounds=-?\d+,-?\d+,-?\d+,(-?\d+)/m)?.[1]||0);return height>0&&nodes.filter(n=>!n.editable&&n.bounds[1]<height*.24&&n.labels.some(v=>[compact(plan.recipient),'发送给:'+compact(plan.recipient),'发送给：'+compact(plan.recipient),'Sendto'+compact(plan.recipient)].includes(v))).length===1;}
function sizeMatches(label,bytes){const m=compact(label).match(/^(?:大小[:：]?)?(\d+(?:\.\d+)?)\s*(B|Bytes?|字节|KB|KiB|MB|MiB)$/i);if(!m)return false;const unit=m[2].toLowerCase(),digits=(m[1].split('.')[1]||'').length,factors=/^(?:b|bytes?|字节)$/.test(unit)?[1]:/^(?:kb|kib)$/.test(unit)?[1024]:[1024*1024];return factors.some(f=>Number((bytes/f).toFixed(digits))===Number(m[1]));}
function subtree(nodes,index){const root=nodes[index],out=[root];for(let i=index+1;i<nodes.length&&nodes[i].depth>root.depth;i++)out.push(nodes[i]);return out;}
function previews(nodes){return nodes.map((n,i)=>n.labels.some(v=>previewLabel.test(v))?subtree(nodes,i):null).filter(Boolean);}
function fileCards(nodes,plan){
 const rows=[];for(let index=0;index<nodes.length;index++){
  if(!nodes[index].values.includes(plan.artifact.name)||nodes[index].editable)continue;
  let row=[nodes[index]];for(let i=index-1;i>=0;i--){if(nodes[i].depth>=nodes[index].depth)continue;const candidate=subtree(nodes,i);if(candidate.some(n=>n.labels.some(v=>sizeMatches(v,plan.artifact.size))))row=candidate;break;}
  if(row.some(n=>n.labels.some(v=>sizeMatches(v,plan.artifact.size))))rows.push(row);
 }
 return rows.filter((row,index)=>rows.findIndex(other=>other[0]===row[0])===index);
}
function bodyValid(nodes,plan,{empty=false}={}){const editors=nodes.filter(n=>n.editable&&!n.secret&&!n.labels.some(v=>/^搜索|^查找|^Search/i.test(v)));return editors.length===1&&editors[0].values.every(v=>placeholder.test(compact(v))||!empty&&plan.content===v)&&(!plan.content||empty||editors[0].values.includes(plan.content));}
function transferValid(grant,plan){
 const t=grant.attachmentTransfer||grant.phoneAttachment,baseline=t?.emptyDraft||t?.baseline;
 return !!t&&[t.status,t.phase].includes('intent_dispatched')&&typeof t.jobId==='string'&&typeof t.dispatchAttemptId==='string'&&t.artifactId===plan.artifact.id&&t.sha256===plan.artifact.sha256&&t.name===plan.artifact.name&&t.size===plan.artifact.size&&t.mime===plan.artifact.mime&&t.targetPackage===grant.packageName&&t.sourceMessageId===plan.sourceMessageId&&t.contractId===grant.contractId&&t.contractRevision===grant.contractRevision&&Date.parse(t.expiresAt||plan.expiresAt)>Date.now()&&Number.isFinite(Date.parse(t.dispatchedAt))&&baseline?.verified===true&&baseline.recipient===plan.recipient&&typeof baseline.observationId==='string'&&Number.isFinite(baseline.observedAt)&&baseline.observedAt<=Date.parse(t.dispatchedAt)&&Date.parse(t.dispatchedAt)-baseline.observedAt<=60000;
}
export function verifyAttachmentDraft(observation,grant,{allowEmpty=false}={}){
 const plan=binding(grant),state=plan&&fresh(observation,grant);if(!state)return {verified:false,reason:'fresh_bound_attachment_observation_required'};const nodes=parseNodes(state.tree);
 if(nodes.some(n=>n.secret||n.labels.some(v=>forbidden.test(v)))||!header(nodes,plan,state.tree))return {verified:false,reason:'exact_recipient_required'};
 const preview=previews(nodes);
 if(allowEmpty){const verified=preview.length===0&&bodyValid(nodes,plan,{empty:true});return {verified,kind:'empty_attachment_composer',reason:verified?null:'empty_composer_required',recipient:plan.recipient,observationId:observation.id,observedAt:observation.at};}
 if(!transferValid(grant,plan))return {verified:false,reason:'trusted_dispatched_attachment_required'};
 const cards=preview.length===1?fileCards(preview[0],plan):[],allNames=preview.flat().flatMap(n=>n.values).filter(v=>/\.[A-Za-z0-9]{1,10}$/.test(v));
 const verified=preview.length===1&&cards.length===1&&allNames.length===1&&allNames[0]===plan.artifact.name&&bodyValid(nodes,plan)&&!nodes.some(n=>n.labels.some(v=>failed.test(v)));
 const previewsSet=new Set(preview.flat()),outside=nodes.filter(n=>!previewsSet.has(n));
 return {verified,kind:'attachment_draft',reason:verified?null:'unique_matching_attachment_and_body_required',beforeCount:fileCards(outside,plan).length,jobId:(grant.attachmentTransfer||grant.phoneAttachment)?.jobId,recipient:plan.recipient,observationId:observation.id,observedAt:observation.at};
}
export function classifyAttachmentAction(args,state,ocr,grant,nodes,actions=[],observation=null){
 const plan=binding(grant);if(!plan)return null;nodes=parseNodes(state.tree);if(nodes.some(n=>n.secret||n.labels.some(v=>forbidden.test(v))))return null;
 const committed=actions.some(a=>['executing','unknown','completed'].includes(a.status)&&a.phoneEffect?.kind==='effect_attachment_send'&&a.phoneEffect.witness?.jobId===(grant.attachmentTransfer||grant.phoneAttachment)?.jobId);if(committed)return null;
 if(args.action==='type'){
  if(args.inputMode!=='replace'||args.textTargetId)return null;const fields=nodes.filter(n=>n.editable&&n.focused);if(fields.length!==1)return null;
  if(fields[0].labels.some(v=>/^搜索|^查找|^Search/i.test(v))&&args.text===plan.recipient)return {kind:'effect_attachment_recipient_search',witness:{recipient:plan.recipient}};
  if(plan.content&&args.text===plan.content&&header(nodes,plan,state.tree)&&transferValid(grant,plan)&&fields[0].values.every(v=>placeholder.test(compact(v))||v===plan.content))return {kind:'effect_attachment_body',witness:{content:plan.content}};
  return null;
 }
 if(args.action!=='tap')return null;const lines=args.textTargetId?(ocr?.lines||[]).filter(l=>l.id===args.textTargetId):[];if(args.textTargetId&&lines.length!==1)return null;const p=lines[0]?.center||{x:args.x,y:args.y};const hits=nodes.filter(n=>inside(p,n.bounds)&&(n.clickable||n.editable));if(hits.some(n=>n.secret||n.labels.some(v=>forbidden.test(v))))return null;const node=hits.sort((a,b)=>(a.bounds[2]-a.bounds[0])*(a.bounds[3]-a.bounds[1])-(b.bounds[2]-b.bounds[0])*(b.bounds[3]-b.bounds[1]))[0];if(!node)return null;
 const label=lines[0]?compact(lines[0].text):node.labels.length===1?node.labels[0]:null;if(!label||!node.labels.includes(label))return null;
 if(label===compact(plan.recipient)){
  const transferred=transferValid(grant,plan);
  // After ACTION_SEND, selecting a direct-share recipient may itself send.
  // Only a visibly unchecked selection row with a separate preview step is navigation.
  if(transferred&&!(nodes.some(n=>n.labels.some(v=>/^(?:选择联系人|选择聊天|选择收件人)$/.test(v)))&&/\bunchecked\b/.test(node.raw)&&nodes.some(n=>n.clickable&&n.labels.some(v=>/^(?:预览|预览附件|查看发送预览)$/.test(v)))))return null;
  return {kind:'effect_attachment_recipient_open',witness:{recipient:plan.recipient}};
 }
 if(node.editable&&node.labels.some(v=>/^搜索|^查找|^Search/i.test(v)))return {kind:'effect_attachment_search_focus',witness:{}};
 if(node.editable&&plan.content&&header(nodes,plan,state.tree)&&node.values.every(v=>placeholder.test(compact(v))||v===plan.content))return {kind:'effect_attachment_body_focus',witness:{}};
 if(/^(?:发送|Send)$/.test(label)){
  const verified=verifyAttachmentDraft(observation,grant);if(!verified.verified)return null;const transfer=grant.attachmentTransfer||grant.phoneAttachment;
  return {kind:'effect_attachment_send',witness:{jobId:transfer.jobId,dispatchAttemptId:transfer.dispatchAttemptId,artifactId:plan.artifact.id,sha256:plan.artifact.sha256,recipient:plan.recipient,name:plan.artifact.name,size:plan.artifact.size,beforeCount:verified.beforeCount}};
 }
 return null;
}
export function verifyAttachmentResult(nodes,grant,matches,state,observation){
 const plan=binding(grant);if(!plan||!fresh(observation,grant)||!transferValid(grant,plan))return {verified:false,kind:'attachment_sent',reason:'trusted_attachment_transfer_required'};
 nodes=parseNodes(state.tree);const transfer=grant.attachmentTransfer||grant.phoneAttachment,sent=matches.filter(a=>a.status==='completed'&&a.phoneEffect?.kind==='effect_attachment_send'&&a.phoneEffect.witness?.jobId===transfer.jobId&&a.phoneEffect.witness.sha256===plan.artifact.sha256&&a.phoneEffect.witness.dispatchAttemptId===transfer.dispatchAttemptId).at(-1);
 const contentPresent=!plan.content||nodes.some(n=>!n.editable&&n.values.includes(plan.content));
 const verified=!!sent&&header(nodes,plan,state.tree)&&previews(nodes).length===0&&bodyValid(nodes,plan,{empty:true})&&!nodes.some(n=>n.secret||n.labels.some(v=>failed.test(v)))&&contentPresent&&fileCards(nodes,plan).length===sent.phoneEffect.witness.beforeCount+1;
 return {verified,kind:'attachment_sent',reason:verified?null:'requires_new_file_message_exact_recipient_and_cleared_draft',...(verified?{facts:{artifactId:plan.artifact.id,sha256:plan.artifact.sha256,name:plan.artifact.name,size:plan.artifact.size,recipient:plan.recipient,jobId:transfer.jobId},summary:`已通过${plan.app}向${plan.recipient}发送附件“${plan.artifact.name}”。`}:{})};
}
