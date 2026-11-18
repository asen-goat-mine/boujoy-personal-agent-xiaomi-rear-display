import {createHash} from 'node:crypto';
const PKGS={Gmail:['com.google.android.gm'],Outlook:['com.microsoft.office.outlook'],'三星邮件':['com.samsung.android.email.provider'],'小红书':['com.xingin.xhs'],'抖音':['com.ss.android.ugc.aweme'],'哔哩哔哩':['tv.danmaku.bili']};
const clean=v=>String(v??'').normalize('NFKC').replace(/\s+/g,'');
const blocked=/密码|验证码|自动发布|定时发布|自动发送|正在发送|上传中|发送失败|发布失败|审核未通过|草稿保存失败|排队中/;
const rows=(nodes,key)=>nodes.filter(n=>n.values.some(v=>v===key||v.startsWith(key+'：')||v.startsWith(key+':')));
function field(nodes,key){const found=rows(nodes,key);if(found.length!==1)return null;const values=[...new Set(found[0].values.filter(v=>v!==key).map(v=>v.replace(new RegExp('^'+key+'[：:]\\s*'),'')))];return values.length===1?values[0]:null;}
function nodesOf(tree){return String(tree).split('\n').flatMap(line=>{const b=line.match(/bounds=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);if(!b||line.startsWith('window '))return [];const raw=line.replace(/"[^"\n]*"/g,''),values=[...line.matchAll(/"([^"\n]*)"/g)].map(m=>m[1].replace(/\\u([0-9a-f]{4})/gi,(_,h)=>String.fromCharCode(parseInt(h,16))));if(/offscreen|disabled/.test(raw))return [];return [{line,raw,values,bounds:b.slice(1).map(Number),editable:/\beditable\b/.test(raw),focused:/\bfocused\b/.test(raw),clickable:/\bclickable\b/.test(raw),secret:/\bpassword\b/.test(raw)}];});}
const has=(nodes,value)=>nodes.some(n=>n.values.includes(value));
const identity=p=>p.kind==='send_mail'?{发件人:p.account,收件人:p.recipient,主题:p.subject,正文:p.content}:{账号:p.account,正文:p.content,可见范围:p.audience};
const identityHash=p=>createHash('sha256').update(JSON.stringify(identity(p))).digest('hex');
function bound(nodes,p,{empty=false}={}){return Object.entries(identity(p)).every(([k,v])=>field(nodes,k)===v||empty&&k==='正文'&&rows(nodes,k).length===1&&rows(nodes,k)[0].values.every(x=>x===k||x===''));}
function stateOf(observation){for(const item of observation?.tree?.content||[])try{const value=JSON.parse(item.text)?.result;if(value?.tree)return value;}catch{}return null;}
function fresh(observation,grant){const state=stateOf(observation);return observation?.taskId===grant.taskId&&Date.now()-observation.at>=-1000&&Date.now()-observation.at<=15000&&state?.windowPkg===grant.packageName&&state.display==='main'?state:null;}
function children(nodes,root){const i=nodes.indexOf(root),depth=root.line.length-root.line.trimStart().length,out=[root];for(let j=i+1;j<nodes.length&&nodes[j].line.length-nodes[j].line.trimStart().length>depth;j++)out.push(nodes[j]);return out;}
function artifactPreview(nodes,p,{published=false}={}){
 const labels=published?['已发送附件','已发布素材','附件','媒体文件']:p.kind==='send_mail'?['附件预览','待发送附件','文件预览']:['图片预览','视频预览','素材预览','待发布素材'];
 const roots=nodes.filter(n=>n.values.some(v=>labels.includes(v)));if(roots.length!==1)return false;const scope=children(nodes,roots[0]),names=scope.flatMap(n=>n.values).filter(v=>/\.[A-Za-z0-9]{1,10}$/.test(v));
 const size=scope.flatMap(n=>n.values).filter(v=>/^(?:大小[:：]?)?\d+(?:\.\d+)?\s*(?:B|字节|KB|MB)$/i.test(v));
 return names.length===1&&names[0]===p.artifact?.name&&size.length===1&&size.some(v=>{const m=v.match(/(\d+(?:\.\d+)?)\s*(B|字节|KB|MB)$/i);const factor=/MB/i.test(m[2])?1048576:/KB/i.test(m[2])?1024:1;return Number((p.artifact.size/factor).toFixed((m[1].split('.')[1]||'').length))===Number(m[1]);});
}
function transferBound(grant,p){const t=grant.attachmentTransfer,b=t?.emptyDraft;return !!p.artifact&&t?.status==='intent_dispatched'&&t.artifactId===p.artifact.id&&t.sha256===p.artifact.sha256&&t.size===p.artifact.size&&t.mime===p.artifact.mime&&t.name===p.artifact.name&&t.targetPackage===grant.packageName&&t.sourceMessageId===p.sourceMessageId&&t.contractId===grant.contractId&&t.contractRevision===grant.contractRevision&&typeof t.dispatchAttemptId==='string'&&Date.parse(t.expiresAt)>Date.now()&&b?.verified===true&&b.identityHash===identityHash(p)&&Date.parse(t.dispatchedAt)>=b.observedAt&&Date.parse(t.dispatchedAt)-b.observedAt<=60000;}
export function outboundPlan(contract){const p=contract?.objects?.mail||contract?.objects?.media;return p&&contract.effects.includes(p.kind)&&contract.effects.every(e=>['read','navigate',p.kind].includes(e))?p:null;}
export function outboundPackageAllowed(p,pkg){return !['send_mail','publish_media'].includes(p?.kind)||PKGS[p.app]?.includes(pkg);}
export function verifyOutboundDraft(observation,grant,{allowEmpty=false}={}){
 const p=grant.effectPlan,state=fresh(observation,grant);if(!state||!['send_mail','publish_media'].includes(p?.kind))return {verified:false,reason:'fresh_outbound_composer_required'};const nodes=nodesOf(state.tree);
 if(nodes.some(n=>n.secret||n.values.some(v=>blocked.test(v)))||!bound(nodes,p,{empty:allowEmpty}))return {verified:false,reason:'exact_account_recipient_subject_body_or_audience_required'};
 const preview=nodes.some(n=>n.values.some(v=>/^(?:附件预览|待发送附件|文件预览|图片预览|视频预览|素材预览|待发布素材|附件)$/.test(v)));
 const verified=allowEmpty?!preview:(p.artifact?transferBound(grant,p)&&artifactPreview(nodes,p):!preview);
 return {verified,kind:allowEmpty?'empty_outbound_composer':'outbound_draft',reason:verified?null:'exact_dispatched_file_preview_required',identityHash:identityHash(p),recipient:p.recipient||p.account,observationId:observation.id,observedAt:observation.at};
}
export function classifyOutboundAction(args,state,ocr,grant,nodes,actions=[],observation){
 const p=grant.effectPlan;if(!['send_mail','publish_media'].includes(p?.kind))return null;nodes=nodesOf(state.tree);if(nodes.some(n=>n.secret||n.values.some(v=>blocked.test(v))))return null;
 const values=identity(p),accountKey=p.kind==='send_mail'?'发件人':'账号',accountBound=field(nodes,accountKey)===p.account;
 const decision=(kind,witness={})=>({kind,witness});
 if(args.action==='type'){
  const fields=nodes.filter(n=>n.editable&&n.focused);if(!accountBound||fields.length!==1||args.textTargetId||args.inputMode!=='replace')return null;
  for(const [key,want]of Object.entries(values))if(key!==accountKey&&fields[0].values.includes(key)&&args.text===want&&fields[0].values.every(v=>v===key||v===want||v===''))return decision('effect_outbound_input',{field:key});return null;
 }
 if(args.action!=='tap')return null;const lines=args.textTargetId?(ocr?.lines||[]).filter(l=>l.id===args.textTargetId):[];if(args.textTargetId&&lines.length!==1)return null;const pt=lines[0]?.center||{x:args.x,y:args.y},hits=nodes.filter(n=>(n.clickable||n.editable)&&pt.x>=n.bounds[0]&&pt.x<n.bounds[2]&&pt.y>=n.bounds[1]&&pt.y<n.bounds[3]);const node=hits.sort((a,b)=>(a.bounds[2]-a.bounds[0])*(a.bounds[3]-a.bounds[1])-(b.bounds[2]-b.bounds[0])*(b.bounds[3]-b.bounds[1]))[0],label=lines[0]?.text||(node?.values.length===1?node.values[0]:null);if(!node||!label||!node.values.includes(label))return null;
 if(label===p.account&&has(nodes,p.kind==='send_mail'?'选择发件人':'切换账号')&&nodes.filter(n=>n.values.includes(label)).length===1)return decision('effect_outbound_account');
 if(!accountBound)return null;
 if(p.kind==='send_mail'&&['写邮件','撰写','已发送'].includes(label))return decision('effect_outbound_navigation');
 if(p.kind==='publish_media'&&['发布作品','创作'].includes(label))return decision('effect_outbound_navigation');
 if(node.editable&&node.values.some(v=>Object.hasOwn(values,v)&&v!==accountKey))return decision('effect_outbound_focus');
 if(p.kind==='publish_media'&&label==='可见范围')return decision('effect_outbound_audience_open');
 if(p.kind==='publish_media'&&label===p.audience&&has(nodes,'选择可见范围')&&nodes.filter(n=>n.values.includes(label)).length===1)return decision('effect_outbound_audience');
 if(p.kind==='send_mail'&&label===p.subject&&has(nodes,'已发送')&&nodes.filter(n=>n.values.includes(label)).length===1)return decision('effect_outbound_receipt_open');
 if(label===(p.kind==='send_mail'?'发送':'发布')){
  const proof=verifyOutboundDraft(observation,grant);if(!proof.verified)return null;
  return decision(p.kind==='send_mail'?'effect_mail_send':'effect_media_publish',{identityHash:identityHash(p),...(p.artifact?{artifactId:p.artifact.id,sha256:p.artifact.sha256,jobId:grant.attachmentTransfer.jobId,dispatchAttemptId:grant.attachmentTransfer.dispatchAttemptId}:{})});
 }
 return null;
}
export function verifyOutboundResult(nodes,grant,matches,state,observation){
 const p=grant.effectPlan;nodes=nodesOf(state.tree);const commit=matches.filter(a=>a.phoneEffect?.kind===(p.kind==='send_mail'?'effect_mail_send':'effect_media_publish')&&a.phoneEffect.witness.identityHash===identityHash(p)).at(-1),mail=p.kind==='send_mail';
 const id=field(nodes,mail?'邮件ID':'作品ID'),time=Date.parse(field(nodes,mail?'发送时间':'发布时间')),started=Date.parse(commit?.startedAt);
 const verified=!!commit&&fresh(observation,grant)&&bound(nodes,p)&&!nodes.some(n=>n.editable||n.secret||n.values.some(v=>blocked.test(v)))&&has(nodes,mail?'已发送':'发布成功')&&/^[A-Za-z0-9._@<>-]{6,180}$/.test(id||'')&&Number.isFinite(time)&&Number.isFinite(started)&&time>=started-1000&&time<=Date.now()+1000&&(!p.artifact||transferBound(grant,p)&&artifactPreview(nodes,p,{published:true}));
 return {verified:!!verified,kind:mail?'mail_sent':'media_published',facts:verified?{account:p.account,recipient:p.recipient,subject:p.subject,audience:p.audience,reference:id,...(p.artifact?{artifactId:p.artifact.id,sha256:p.artifact.sha256}:{})}:null,summary:verified?(mail?`已从 ${p.account} 向 ${p.recipient} 发送主题为“${p.subject}”的邮件。`:`已使用${p.app}账号“${p.account}”发布${p.artifact.name}，可见范围“${p.audience}”。`):null};
}
