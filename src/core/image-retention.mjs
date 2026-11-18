import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {DATA,HARNESS} from '../config.mjs';
import {requireValue} from './errors.mjs';

const VERSION='0.2.1-alpha.2',UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,SHA=/^[a-f0-9]{64}$/;
const SCREENS=new Set(['phone_observe','phone_use','phone_action','phone_open_app','phone_search','phone_prepare_attachment']);
const TERMINAL=new Set(['completed','cancelled','failed','expired']);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const raster=bytes=>bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes[0]===255&&bytes[1]===216&&bytes[2]===255||bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
function refImage(block){const r=block?.type==='image'?block.attachment:null;if(!r||!/^sha256:[a-f0-9]{64}$/.test(r.attachmentId)||!['image/png','image/jpeg','image/webp'].includes(r.mediaType)||![r.width,r.height,r.bytes].every(Number.isSafeInteger)||r.width<1||r.height<1||r.width>8192||r.height>8192||r.bytes<1||r.bytes>20*1024*1024)return null;return {attachmentId:r.attachmentId,sha256:r.attachmentId.slice(7),mime:r.mediaType,width:r.width,height:r.height,bytes:r.bytes};}
// Only an exact known Harness path is addressed, never recursive file deletion.
function safeFile(root,relative){let current=fs.realpathSync(root);for(const segment of relative.split('/')){requireValue(segment&&!['.','..'].includes(segment),'图像路径无效');current=path.join(current,segment);const stat=fs.lstatSync(current);requireValue(!stat.isSymbolicLink(),'图像缓存含符号链接');}return current;}
export class ImageRetention{
 constructor({store,dataDir=DATA,harnessRuntime=HARNESS,engine,clock=Date.now}={}){Object.assign(this,{store,dataDir,harnessRuntime,engine,clock});this.calls=new Map();this.lastSweep=null;this.running=null;this.closed=false;}
 policy(){const value=this.store.data.settings.imageRetention||{};return {hours:Number.isInteger(value.hours)&&value.hours>=1&&value.hours<=168?value.hours:24,diagnosticUntil:typeof value.diagnosticUntil==='string'?value.diagnosticUntil:null};}
 configure(input){requireValue(input&&Object.keys(input).every(k=>['hours','diagnosticUntil'].includes(k)),'截图留存设置无效');const value={...this.policy(),...input};if(!Object.hasOwn(input,'diagnosticUntil')&&Date.parse(value.diagnosticUntil)<=this.clock())value.diagnosticUntil=null;requireValue(Number.isInteger(value.hours)&&value.hours>=1&&value.hours<=168,'截图留存需为1至168小时');requireValue(value.diagnosticUntil===null||Number.isFinite(Date.parse(value.diagnosticUntil))&&Date.parse(value.diagnosticUntil)>this.clock()&&Date.parse(value.diagnosticUntil)<=this.clock()+7*86400000,'故障留存必须明确截止，最长7天');this.store.transaction(s=>s.settings.imageRetention=value);return this.status();}
 status(){const rows=this.store.data.derivedImages||[];return {...this.policy(),trackedScreens:rows.filter(r=>r.source==='screen'&&!r.cleanedAt).length,protectedImages:rows.filter(r=>r.source!=='screen').length,lastSweep:this.lastSweep,scope:'verified_harness_screen_objects_and_default_request_variants',trackingAtCapacity:rows.length>=20000,unknownFormats:'preserved',pendingReceiptProtected:this.hasPendingReceipt(),recoveryPaused:!!this.store.data.recoveryFence?.required};}
 observeHarnessEvent(taskId,event){
  if(this.closed||this.store.data.recoveryFence?.required||!UUID.test(taskId)||!this.store.data.tasks.some(t=>t.id===taskId))return;
  if(event?.type==='tool/call'&&typeof event.data?.callId==='string'&&typeof event.data?.name==='string'){if(this.calls.size>20000)this.calls.clear();this.calls.set(taskId+':'+event.data.callId,event.data.name);return;}
  let content,source='protected';
  if(event?.type==='tool/result'){const m=event.data?.message;if(m?.role!=='tool'||m.source?.kind!=='tool'||m.source.callId!==m.toolCallId||!Array.isArray(m.content))return;content=m.content;const name=this.calls.get(taskId+':'+m.toolCallId);this.calls.delete(taskId+':'+m.toolCallId);if(typeof name==='string'&&name.startsWith('mcp__personal__')&&SCREENS.has(name.slice('mcp__personal__'.length)))source='screen';}
  else if(event?.type==='user/message')content=event.data?.message?.content;
  else return;
  const refs=Array.isArray(content)?content.map(refImage).filter(Boolean):[];if(!refs.length)return;
  let version;try{version=JSON.parse(fs.readFileSync(path.join(this.harnessRuntime,'node_modules/@deepseek-ai/dsh/package.json'))).version;}catch{return;}if(version!==VERSION)return;
  const at=new Date(this.clock()).toISOString();this.store.transaction(s=>{s.derivedImages||=[];for(const ref of refs){let row=s.derivedImages.find(r=>r.taskId===taskId&&r.attachmentId===ref.attachmentId);if(row){if(source!=='screen')row.source='protected';row.lastSeenAt=at;row.cleanedAt=null;}else {if(s.derivedImages.length>=20000){const removable=s.derivedImages.findIndex(r=>r.cleanedAt);if(removable>=0)s.derivedImages.splice(removable,1);}if(s.derivedImages.length<20000)s.derivedImages.push({taskId,...ref,source,harnessVersion:version,firstSeenAt:at,lastSeenAt:at});}}});
 }
 hasPendingReceipt(){
  try{const file=safeFile(this.dataDir,'phone/phoneuse-pending.json'),stat=fs.statSync(file);if(!stat.isFile()||stat.size>262144)return true;const value=JSON.parse(fs.readFileSync(file,'utf8'));return value?.version!==1||!Array.isArray(value.pending)||value.pending.length>0;}
  catch(error){return error.code!=='ENOENT';}
 }
 eligible(row){
  const task=this.store.data.tasks.find(t=>t.id===row.taskId),at=this.clock(),policy=this.policy(),phone=this.engine?.broker?.phone;
  if(this.closed||this.store.data.recoveryFence?.required||!UUID.test(row.taskId)||!SHA.test(row.sha256)||row.attachmentId!=='sha256:'+row.sha256||!refImage({type:'image',attachment:{attachmentId:row.attachmentId,mediaType:row.mime,width:row.width,height:row.height,bytes:row.bytes}})||row.source!=='screen'||row.harnessVersion!==VERSION||!task||!TERMINAL.has(task.status)||this.engine?.active?.has(task.id)||this.hasPendingReceipt()||phone?.client?.pending?.size||phone?.client?.active?.size)return false;
  if(this.store.data.actions.some(a=>a.taskId===task.id&&['unknown','executing','pending'].includes(a.status)&&!a.resolution)||this.store.data.approvals.some(a=>a.taskId===task.id&&a.status==='pending'))return false;
  // Any user/result image in this task conservatively protects shared normalized
  // blobs, including bytes transformed by the Harness before content addressing.
  if(this.store.data.artifacts.some(a=>a.taskId===task.id&&(/^image\//.test(a.mime||'')||/\.(png|jpe?g|webp|gif)$/i.test(a.name||'')||a.sha256===row.sha256)))return false;
  const ended=Math.max(...[task.completedAt,task.runFinishedAt,task.expiredAt,task.updatedAt,row.lastSeenAt].map(v=>Date.parse(v)).filter(Number.isFinite));
  if(!Number.isFinite(ended)||at-ended<policy.hours*3600000)return false;
  if(task.status==='failed'&&Date.parse(policy.diagnosticUntil)>at)return false;return true;
 }
 async variant(row){
  // This pinned provider route has no image-size overrides in personal.patch.yml.
  // Unknown future Harness formats and unrecognised cache files stay untouched.
  const root=path.join(this.harnessRuntime,'node_modules/@deepseek-ai');if(JSON.parse(fs.readFileSync(path.join(root,'dsh/package.json'))).version!==VERSION)throw Error('harness_version_unrecognized');
  const [{requestImageVariantId},{resolveRequestImageTarget}]=await Promise.all([import(pathToFileURL(path.join(root,'dsh-attachment-local/lib/index.js')).href),import(pathToFileURL(path.join(root,'dsh-llm-deepseek/lib/index.js')).href)]);
  const ref={attachmentId:row.attachmentId,mediaType:row.mime,width:row.width,height:row.height,bytes:row.bytes};return String(requestImageVariantId(ref,resolveRequestImageTarget({},ref))).slice(7);
 }
 unlink(row,relative,{sha256,bytes}={}){
  if(!this.eligible(row))return 'retained';let file;
  try{file=safeFile(this.dataDir,relative);}catch(error){if(error.code==='ENOENT')return 'absent';throw error;}
  const before=fs.lstatSync(file);requireValue(before.isFile()&&before.nlink===1&&before.size>0&&before.size<=20*1024*1024,'图像缓存文件类型或大小异常');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let data;try{data=fs.readFileSync(fd);}finally{fs.closeSync(fd);}
  requireValue(raster(data)&&(!sha256||digest(data)===sha256)&&(!bytes||data.length===bytes),'图像缓存校验不一致');
  const after=fs.lstatSync(safeFile(this.dataDir,relative));requireValue(before.ino===after.ino&&before.dev===after.dev&&before.mtimeMs===after.mtimeMs&&before.size===after.size,'图像缓存发生变化');
  if(!this.eligible(row))return 'retained';fs.unlinkSync(file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}return 'removed';
 }
 async sweep(){if(this.running)return this.running;this.running=this.performSweep();try{return await this.running;}finally{this.running=null;}}
 async performSweep(){
  const report={at:new Date(this.clock()).toISOString(),removedFiles:0,retained:0,errors:0,recoveryPaused:!!this.store.data.recoveryFence?.required,unknownFormats:'preserved'};
  for(const row of this.store.data.derivedImages||[]){if(row.cleanedAt)continue;if(!this.eligible(row)){report.retained++;continue;}
   try{const variant=await this.variant(row),base='harness/'+row.taskId;requireValue(SHA.test(variant),'未知截图变体');let complete=true;
    for(const [relative,options] of [[base+'/attachments/v1/objects/'+row.sha256.slice(0,2)+'/'+row.sha256,{sha256:row.sha256,bytes:row.bytes}],[base+'/cache/attachments/request-images/'+variant.slice(0,2)+'/'+variant,{}]]){const result=this.unlink(row,relative,options);if(result==='removed')report.removedFiles++;if(result==='retained')complete=false;}
    if(complete&&this.eligible(row))this.store.transaction(s=>{const current=s.derivedImages.find(r=>r.taskId===row.taskId&&r.attachmentId===row.attachmentId);if(current)current.cleanedAt=report.at;});
   }catch{report.errors++;}
  }
  this.lastSweep=report;return report;
 }
 start(){if(this.timer)return;this.closed=false;void this.sweep().catch(()=>{});this.timer=setInterval(()=>void this.sweep().catch(()=>{}),3600000);this.timer.unref();}
 close(){this.closed=true;clearInterval(this.timer);this.timer=null;this.calls.clear();}
}
