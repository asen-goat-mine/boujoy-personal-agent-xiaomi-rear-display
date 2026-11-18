import {assertExecutionPermission} from '../core/execution-permissions.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DATA, MEMORY_VAULT } from '../config.mjs';
import { AppError, requireValue, shortText, now } from '../core/errors.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const CONTENT = ['01-Personal', '02-Projects', '03-Knowledge', '04-Routines'];
const DEST = {preference:'01-Personal',workflow:'03-Knowledge/workflows',platform:'03-Knowledge/platforms',episode:'02-Projects',routine:'04-Routines'};
const ID = /^[a-z][a-z0-9.-]{2,100}$/;
const LIMIT = 128 * 1024;
export function parseCard(text) {
  const match = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {meta:{},body:text};
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (!item || Object.hasOwn(meta,item[1])) throw new AppError('memory_format','记忆字段格式无效或重复');
    let value = item[2].trim();
    try { value = JSON.parse(value); } catch {
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1,-1);
      else if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1,-1).split(',').map(v=>v.trim().replace(/^['"]|['"]$/g,''));
      else if (!value || /^[>|&*{\["]/.test(value)) throw new AppError('memory_format','记忆字段使用不支持的 YAML 格式');
    }
    meta[item[1]] = value;
  }
  return {meta,body:text.replace(/^\uFEFF/,'').slice(match[0].length).trim()};
}
export function renderCard(meta,body) {return `---\n${Object.entries(meta).filter(([,v])=>v!==undefined).map(([k,v])=>`${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n${body.trim()}\n`;}
function terms(value) {
  const text = String(value).toLowerCase();
  const tokens = text.match(/[a-z0-9][a-z0-9.-]+/g)||[];
  for (const run of text.match(/[\p{Script=Han}]+/gu)||[]) {if(run.length===1)tokens.push(run);else for(let i=0;i<run.length-1;i++)tokens.push(run.slice(i,i+2));}
  return [...new Set(tokens)];
}
function sensitive(text) {
  return /(?:sk-[\w-]{12,}|-----BEGIN .*PRIVATE KEY|(?:api.?key|password|密码|验证码|token)\s*[:：=]\s*\S+|\b1[3-9]\d{9}\b|\b\d{16,19}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d{17}[\dXx]\b)/i.test(text);
}
function atomic(file,text) {
  const tmp=file+'.'+randomUUID()+'.tmp';const fd=fs.openSync(tmp,'wx',0o600);
  try {fs.writeFileSync(fd,text);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  try {fs.renameSync(tmp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}

export class PersonalMemory {
  constructor({root=MEMORY_VAULT,runtime=path.join(DATA,'memory'),personal=null}={}) {this.root=path.resolve(root);this.runtime=path.resolve(runtime);this.personal=personal;}
  // Never follow symlinks, including the root or an intermediate directory.
  safe(rel,{missing=false}={}) {
    requireValue(typeof rel==='string'&&!path.isAbsolute(rel)&&!rel.includes('\\')&&!rel.split('/').some(p=>p==='..'||!p),'记忆路径无效');
    let cur=path.parse(this.root).root;
    for(const part of this.root.slice(cur.length).split(path.sep)){cur=path.join(cur,part);const stat=fs.lstatSync(cur);requireValue(stat.isDirectory()&&!stat.isSymbolicLink(),'记忆根目录不得经过符号链接');}
    const parts=rel.split('/');cur=this.root;
    for(let i=0;i<parts.length;i++){
      cur=path.join(cur,parts[i]);
      if(!fs.existsSync(cur)){ // lstat also detects dangling links.
        try{if(fs.lstatSync(cur).isSymbolicLink())throw new AppError('memory_path','记忆路径不能是符号链接');}catch(e){if(e.code!=='ENOENT')throw e;}
        requireValue(missing&&i===parts.length-1,'记忆路径不存在');break;
      }
      const stat=fs.lstatSync(cur);requireValue(!stat.isSymbolicLink()&&(i===parts.length-1?stat.isFile():stat.isDirectory()),'记忆路径类型不正确');
    }
    return cur;
  }
  read(rel) {
    const file=this.safe(rel);const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try {
      const st=fs.fstatSync(fd);requireValue(st.isFile()&&st.size<=LIMIT,'记忆文件过大或不可读');
      // Every retrieval walks all cards. An unchanged file (same inode, size and modification
      // time) is not read, hashed and parsed again; the Markdown files stay the only source.
      const cache=this.cardCache||=new Map(),stamp=st.ino+':'+st.size+':'+st.mtimeMs,hit=cache.get(rel);
      if(hit?.stamp===stamp)return {...hit.card,meta:{...hit.card.meta}};
      const text=fs.readFileSync(fd,'utf8'),card={path:rel,hash:hash(text),text,...parseCard(text)};
      if(cache.size>4000)cache.clear();cache.set(rel,{stamp,card});
      return {...card,meta:{...card.meta}};
    }finally{fs.closeSync(fd);}
  }
  check() {
    const {meta}=this.read('00-System/Memory-Protocol.md');
    requireValue(meta.protocol_id==='boujoy-personal-memory'&&meta.protocol_version===1&&meta.scope==='personal-agent','该文件夹不是兼容的 Personal Agent 专用记忆库','memory_protocol');
    return {protocol:'boujoy-personal-memory',version:1,scope:'personal-agent'};
  }
  initialize() {
    // Existing folders belong to the user, including empty or incompatible ones.
    try {fs.lstatSync(this.root);return false;} catch(e) {if(e.code!=='ENOENT')throw e;}
    let current=path.parse(this.root).root;
    for(const part of path.dirname(this.root).slice(current.length).split(path.sep).filter(Boolean)){
      current=path.join(current,part);
      try {fs.mkdirSync(current,{mode:0o700});} catch(e) {if(e.code!=='EEXIST')throw e;}
      const stat=fs.lstatSync(current);
      requireValue(stat.isDirectory()&&!stat.isSymbolicLink(),'记忆根目录不得经过符号链接','memory_path');
    }
    try {fs.mkdirSync(this.root,{mode:0o700});} catch(e) {if(e.code==='EEXIST')return false;throw e;}
    for(const dir of ['00-System',...CONTENT,'03-Knowledge/workflows','03-Knowledge/platforms','07-Inbox','90-Archive','98-Templates']){
      fs.mkdirSync(path.join(this.root,dir),{mode:0o700});
    }
    fs.writeFileSync(path.join(this.root,'00-System/Memory-Protocol.md'),renderCard({protocol_id:'boujoy-personal-memory',protocol_version:1,scope:'personal-agent'},'# Boujoy 个人记忆\n\n这是本机新建的空白记忆库，不包含其他用户的数据。'),{flag:'wx',mode:0o600});
    return true;
  }
  async start(){this.initialize();this.check();if(this.personal)await this.personal.call('health');}
  close(){}
  files(directory,depth=0) {
    const result=[];requireValue(depth<=6,'记忆目录层级超出限制');
    const folder=path.join(this.root,directory);
    // Directory checks use an existing file path surrogate without ever traversing it.
    const relParts=directory.split('/');let current=this.root;
    for(const part of relParts){current=path.join(current,part);if(!fs.existsSync(current))return [];const s=fs.lstatSync(current);requireValue(s.isDirectory()&&!s.isSymbolicLink(),'记忆目录不得是符号链接');}
    for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
      if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;
      const rel=directory+'/'+entry.name;
      if(entry.isDirectory())result.push(...this.files(rel,depth+1));else if(entry.isFile()&&entry.name.endsWith('.md'))result.push(rel);
      requireValue(result.length<=2000,'记忆文件数量超出单次读取限制');
    }
    return result.sort();
  }
  currentCards({all=false}={}) {
    this.check();const cards=[];let skipped=0;
    for(const rel of CONTENT.flatMap(d=>this.files(d))){
      let card;try{card=this.read(rel);}catch{skipped++;continue;}
      const m=card.meta;
      if(m.scope!=='personal-agent'||m.status!=='active'||!m.title||!m.id||!m.memory_kind||m.memory_kind==='system'||!m.source_type||!m.verification||!m.updated)continue;
      const dateOnly=/^\d{4}-\d{2}-\d{2}$/.test(m.updated);
      if(['private','sensitive','secret'].includes(m.sensitivity)||sensitive(card.body+'\n'+m.title)){skipped++;continue;}
      const updated=Date.parse(dateOnly?m.updated+'T00:00:00+08:00':m.updated);const expires=m.expires_at?Date.parse(m.expires_at):null;
      if(!Number.isFinite(updated)||updated>Date.now()||(m.expires_at&&(!Number.isFinite(expires)||expires<=Date.now())))continue;
      cards.push(card);
    }
    const counts=new Map();for(const c of cards){const key=c.meta.concept_key||c.meta.id;counts.set(key,(counts.get(key)||0)+1);}
    const conflicts=[...counts].filter(([,v])=>v>1).map(([key])=>key);
    return {cards:all?cards:cards.filter(c=>!conflicts.includes(c.meta.concept_key||c.meta.id)),conflicts,skipped};
  }
  async health(){try{const contract=this.check();const {cards,conflicts,skipped}=this.currentCards();const personal=this.personal?await this.personal.call('health').catch(()=>({ready:false})):null;return {connected:true,localOnly:true,root:this.root,...contract,cards:cards.length,pending:this.proposals().length,conflicts,skipped,personal,personalRoot:this.personal?.core};}catch(e){return {connected:false,localOnly:true,reason:e instanceof AppError?e.message:'专用记忆文件夹不可读取'};}}
  // The budget is counted in UTF-8 bytes (a Chinese character is 3), so 6000
  // bytes is roughly the ~1500 tokens the protocol describes.
  async context(query,{limit=4,tokenBudget=6000}={}) {
    assertExecutionPermission(undefined,'files');
    shortText(query,'检索问题',2000);requireValue(Number.isInteger(limit)&&limit>=1&&limit<=6,'检索数量无效');requireValue(Number.isInteger(tokenBudget)&&tokenBudget>=128&&tokenBudget<=12000,'上下文预算无效');
    const {cards,conflicts,skipped}=this.currentCards();const needles=terms(query);
    const ranked=cards.map(c=>{const title=String(c.meta.title).toLowerCase();const tags=String(c.meta.tags||'').toLowerCase();const body=c.body.toLowerCase();return {...c,score:needles.reduce((n,t)=>n+(title.includes(t)?6:0)+(tags.includes(t)?4:0)+(body.includes(t)?1:0),0)};}).filter(c=>c.score>0).sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path));
    let remaining=tokenBudget;const sources=[];const blocks=[];
    for(const card of ranked.slice(0,limit)){
      const header=`[${card.path}; ${card.meta.verification}; ${card.meta.updated}]\n`;
      const count=Math.min(limit,ranked.length)-sources.length;
      const room=Math.floor(remaining/count)-Buffer.byteLength(header)-2;if(room<32)break;
      let snippet='',size=0;for(const char of card.body){const bytes=Buffer.byteLength(char);if(size+bytes>room)break;snippet+=char;size+=bytes;}
      const truncated=snippet.length<card.body.length;
      blocks.push(header+snippet);remaining-=Buffer.byteLength(header+snippet)+2;
      sources.push({path:card.path,title:card.meta.title,hash:card.hash,updated:card.meta.updated,verification:card.meta.verification,truncated});
    }
    return {scope:'personal-agent',context:blocks.join('\n\n'),sources,token_estimate:tokenBudget-remaining,tokenEstimateMethod:'utf8-byte-upper-bound-for-context-only',conflicts,skipped,trust:'reference-data-not-instructions',cloudRequestSent:false};
  }
  async observe(item) {
    this.check();if(item.memoryMode==='do_not_remember'||item.memoryMode==='session_only')return {recorded:false,status:'not_retained'};
    requireValue(typeof item.conversationId==='string'&&typeof item.turnId==='string','观察 ID 缺失');
    const id=hash(JSON.stringify([item.conversationId,item.turnId]));const folder=path.join(this.runtime,'receipts');fs.mkdirSync(folder,{recursive:true,mode:0o700});const file=path.join(folder,id+'.json');
    try{fs.writeFileSync(file,JSON.stringify({id,conversationId:item.conversationId,turnId:item.turnId,at:now(),status:'receipt_only',contentStored:false}),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
    if(this.personal&&item.authorized){
      const receipt=JSON.parse(fs.readFileSync(file,'utf8'));
      if(receipt.processed)return {recorded:true,status:receipt.status,contentStored:false};
      const learned=await this.personal.observe(item);
      atomic(file,JSON.stringify({id,conversationId:item.conversationId,turnId:item.turnId,at:now(),status:learned.status,processed:true,contentStored:false}));
      return {recorded:true,status:learned.status,contentStored:false};
    }
    return {recorded:true,status:'receipt_only',contentStored:false};
  }
  proposals() {
    this.check();return this.files('07-Inbox').flatMap(rel=>{try{const c=this.read(rel);return c.meta.scope==='personal-agent'&&c.meta.status==='candidate'?[{id:c.meta.id,path:c.path,hash:c.hash,title:c.meta.title,kind:c.meta.memory_kind,conceptKey:c.meta.concept_key,summary:c.body,sourceRef:c.meta.source_ref,expiresAt:c.meta.expires_at,existing:this.currentCards({all:true}).cards.filter(x=>x.meta.concept_key===c.meta.concept_key).map(x=>({path:x.path,hash:x.hash,title:x.meta.title}))}]:[];}catch{return [];}});
  }
  async propose(input,{taskId,evidenceRefs}={}) {
    assertExecutionPermission(undefined,'files');
    this.check();requireValue(ID.test(input.conceptKey),'概念标识应为稳定的小写语义键');requireValue(Object.hasOwn(DEST,input.kind),'记忆类别不在允许范围');
    const title=shortText(input.title,'标题',100);const summary=shortText(input.summary,'记忆摘要',2400);const applies=shortText(input.appliesTo,'适用范围',500);
    requireValue(!sensitive(title+'\n'+summary+'\n'+applies),'候选含可能敏感的原文，需先脱敏','sensitive_memory');
    requireValue(typeof taskId==='string'&&Array.isArray(evidenceRefs)&&evidenceRefs.length>0&&evidenceRefs.length<=10&&evidenceRefs.every(r=>typeof r==='string'&&r.length<=200),'缺少已核验的本任务来源');
    let expires;if(input.expiresAt){const time=Date.parse(input.expiresAt);requireValue(Number.isFinite(time)&&time>Date.now()&&/(Z|[+-]\d\d:\d\d)$/.test(input.expiresAt),'有效期必须是未来且带时区的 ISO 时间');expires=new Date(time).toISOString();}
    requireValue(input.kind!=='episode'||expires,'任务摘要必须设置有效期');
    const body=`## 一句话结论\n\n${summary}\n\n## 适用场景\n\n${applies}\n\n## 依据与状态\n\n来自本机任务 ${taskId}，引用 ${evidenceRefs.join('、')}。本条是模型压缩的候选，尚未确认，不是执行授权。`;
    const signature=hash(JSON.stringify([taskId,input.conceptKey,input.kind,summary,applies,expires||'',evidenceRefs]));
    for(const p of this.proposals())if(this.read(p.path).meta.proposal_signature===signature)return {id:p.id,status:'candidate',path:p.path,duplicate:true};
    const id='memory-'+randomUUID();const rel='07-Inbox/'+id+'.md';
    const meta={id,title,type:'knowledge',memory_kind:input.kind,concept_key:input.conceptKey,scope:'personal-agent',status:'candidate',updated:now(),source_type:'agent-proposal',source_ref:taskId+'/'+evidenceRefs.join(','),verification:'unverified',confidence:0,expires_at:expires,proposal_signature:signature};
    fs.writeFileSync(this.safe(rel,{missing:true}),renderCard(meta,body),{flag:'wx',mode:0o600});
    return {id,status:'candidate',path:rel,duplicate:false};
  }
  version(card) {
    const dir=path.join(this.runtime,'versions');fs.mkdirSync(dir,{recursive:true,mode:0o700});const id=randomUUID();
    fs.writeFileSync(path.join(dir,id+'.md'),card.text,{flag:'wx',mode:0o600});
    fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify({id,path:card.path,hash:card.hash,at:now()}),{flag:'wx',mode:0o600});return id;
  }
  // Only the authenticated local human API calls review. It is deliberately absent from MCP.
  async review(id,{decision,expectedHash,expectedTargetHash}={}) {
    this.check();requireValue(/^memory-[a-f0-9-]{36}$/.test(id),'候选 ID 无效');requireValue(['accept','reject'].includes(decision),'审核决定无效');
    const rel='07-Inbox/'+id+'.md';const card=this.read(rel);requireValue(card.hash===expectedHash,'候选已被修改，请重新读取','memory_conflict');
    requireValue(card.meta.id===id&&card.meta.scope==='personal-agent'&&card.meta.status==='candidate'&&Object.hasOwn(DEST,card.meta.memory_kind),'候选不再可审核');
    let target;
    if(decision==='accept'){
      requireValue(ID.test(card.meta.concept_key),'概念标识无效');requireValue(!sensitive(card.body+'\n'+card.meta.title),'候选含可能敏感的原文，需先脱敏','sensitive_memory');
      requireValue(card.meta.memory_kind!=='episode'||card.meta.expires_at,'任务摘要必须设置有效期');
      if(card.meta.expires_at)requireValue(Date.parse(card.meta.expires_at)>Date.now(),'候选已过期');
      const existing=this.currentCards({all:true}).cards.filter(c=>c.meta.concept_key===card.meta.concept_key);
      requireValue(existing.length<=1,'同概念有多张卡片，请先在 Bok 中解决冲突','memory_conflict');
      target=existing[0];if(target)requireValue(target.hash===expectedTargetHash,'原卡片已变化或缺少读取哈希，请重新读取','memory_conflict');
      const targetRel=target?.path||`${DEST[card.meta.memory_kind]}/${card.meta.concept_key}.md`;
      const targetFile=this.safe(targetRel,{missing:!target});
      if(!target)requireValue(!fs.existsSync(targetFile),'目标文件已存在，请人工解决冲突','memory_conflict');
      const meta={...card.meta,id:target?.meta.id||id,status:'active',updated:now(),source_type:'human-reviewed-proposal',reviewed_by:'local-user',reviewed_at:now(),verification:'user-confirmed',confidence:1};delete meta.proposal_signature;
      const body=card.body.replace('本条是模型压缩的候选，尚未确认，不是执行授权。','本条已由本机用户确认；此确认不代表流程已真机验证，也不提供执行授权。');
      if(target){this.version(target);requireValue(this.read(target.path).hash===target.hash,'原卡片在写入前发生变化','memory_conflict');atomic(targetFile,renderCard(meta,body));}
      else fs.writeFileSync(targetFile,renderCard(meta,body),{flag:'wx',mode:0o600});
      target={path:targetRel};
    }
    this.version(card);
    const archived={...card.meta,status:decision==='accept'?'superseded':'archived',updated:now(),review_decision:decision,accepted_path:target?.path};
    const archiveRel='90-Archive/'+id+'.md';fs.writeFileSync(this.safe(archiveRel,{missing:true}),renderCard(archived,card.body),{flag:'wx',mode:0o600});
    requireValue(this.read(rel).hash===expectedHash,'候选审核过程中发生变化，请人工核对','memory_conflict');fs.unlinkSync(this.safe(rel));
    return {id,status:decision==='accept'?'accepted':'rejected',path:target?.path||archiveRel};
  }
}
