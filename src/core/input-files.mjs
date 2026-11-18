import fs from 'node:fs';
import path from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash,randomUUID} from 'node:crypto';
import {requireValue} from './errors.mjs';
export const inputHash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Two ways a file arrives: small ones inline as base64 (the phone gateway), or as an
// uploadId for a file already streamed to disk by POST /api/uploads (the web chat:
// photos, videos and documents up to the limits below).
export const UPLOAD_LIMITS={count:10,video:500*1024*1024,other:50*1024*1024,total:600*1024*1024};
const isVideo=mime=>/^video\/[\w.+-]+$/.test(String(mime||''));
export function validateAttachments(items,{uploads=null}={}){
 requireValue(Array.isArray(items)&&items.length<=UPLOAD_LIMITS.count,`每条消息最多 ${UPLOAD_LIMITS.count} 个附件`);let total=0,inline=0;const uploadIds=new Set();
 return items.map(item=>{
  requireValue(item&&typeof item.name==='string'&&item.name.length>0&&item.name.length<=200,'附件格式无效');
  const name=path.basename(item.name).replace(/[\x00-\x1f\\]/g,'');requireValue(name&&name!=='.'&&name!=='..','附件名称无效');
  const mime=typeof item.mime==='string'&&/^[\w.+-]+\/[\w.+-]+$/.test(item.mime)?item.mime:'application/octet-stream';
  if(typeof item.uploadId==='string'){
   requireValue(!uploadIds.has(item.uploadId),'同一个上传附件不能重复添加');uploadIds.add(item.uploadId);
   const entry=uploads?.get(item.uploadId);requireValue(entry&&fs.existsSync(entry.path),'附件上传已失效，请重新添加','upload_missing');
   total+=entry.size;requireValue(entry.size>0&&entry.size<=(isVideo(entry.mime)?UPLOAD_LIMITS.video:UPLOAD_LIMITS.other)&&total<=UPLOAD_LIMITS.total,'附件太大：视频最多 500 MB，其他文件最多 50 MB，一条合计最多 600 MB');
   return {name,mime:entry.mime||mime,size:entry.size,sha256:entry.sha256,file:entry.path,uploadId:item.uploadId};
  }
  requireValue(typeof item.base64==='string'&&item.base64.length<=12*1024*1024&&/^[A-Za-z0-9+/]*={0,2}$/.test(item.base64)&&item.base64.length%4===0,'附件格式无效');
  const bytes=Buffer.from(item.base64,'base64'),audio=/^audio\/[\w.+-]+$/.test(mime);inline+=bytes.length;total+=bytes.length;
  requireValue(bytes.toString('base64')===item.base64&&bytes.length>0&&bytes.length<=(audio?8:4)*1024*1024&&inline<=8*1024*1024,'普通附件最多 4 MiB，音频及本条合计最多 8 MiB');
  return {name,mime,bytes,size:bytes.length,sha256:inputHash(bytes)};
 });
}
export function stageAttachments(items,messageId,dataDir,{uploads=null}={}){
 requireValue(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(messageId),'消息编号无效');const rows=validateAttachments(items,{uploads}),saved=[],created=[],moved=[];
 const root=fs.realpathSync(dataDir);let dir=root;for(const part of ['artifacts','inputs',messageId]){dir=path.join(dir,part);if(fs.existsSync(dir))requireValue(fs.lstatSync(dir).isDirectory()&&!fs.lstatSync(dir).isSymbolicLink(),'附件目录不能使用链接');else fs.mkdirSync(dir,{mode:0o700});}
 try{for(const row of rows){const id=randomUUID(),relative='inputs/'+messageId+'/'+id,file=path.join(dir,id);
   if(row.file){fs.renameSync(row.file,file);moved.push({from:row.file,to:file});}
   else{const fd=fs.openSync(file,'wx',0o600);created.push(file);try{fs.writeFileSync(fd,row.bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
   saved.push({id,name:row.name,mime:row.mime,size:row.size,sha256:row.sha256,path:relative,kind:'input',...(row.uploadId?{sourceUploadId:row.uploadId}:{}),sourceMessageId:messageId,createdAt:new Date().toISOString()});}
  for(const row of rows)if(row.uploadId)uploads?.delete(row.uploadId);
  return saved;}
 catch(error){for(const file of created)fs.rmSync(file,{force:true});for(const m of moved)try{fs.renameSync(m.to,m.from);}catch{}throw error;}
}
// Raw upload streamed to disk (no base64, no JSON): the id is then sent with the message.
export async function receiveUpload(req,{dataDir,name,mime,uploads}){
 const safeMime=/^[\w.+-]+\/[\w.+-]+$/.test(String(mime||''))?mime:'application/octet-stream',limit=isVideo(safeMime)?UPLOAD_LIMITS.video:UPLOAD_LIMITS.other;
 const dir=path.join(fs.realpathSync(dataDir),'uploads');fs.mkdirSync(dir,{recursive:true,mode:0o700});requireValue(fs.lstatSync(dir).isDirectory()&&!fs.lstatSync(dir).isSymbolicLink(),'上传目录不能使用链接');
 const now=Date.now();for(const [id,entry] of uploads)if(now-entry.at>2*3600000){fs.rmSync(entry.path,{force:true});uploads.delete(id);}
 const id=randomUUID(),file=path.join(dir,id),hash=createHash('sha256');let size=0;
 const out=fs.createWriteStream(file,{flags:'wx',mode:0o600});
 const measure=new Transform({transform(chunk,encoding,callback){
  try{size+=chunk.length;requireValue(size<=limit,isVideo(safeMime)?'视频最多 500 MB':'文件最多 50 MB','too_large');hash.update(chunk);callback(null,chunk);}catch(error){callback(error);}
 }});
 try{await pipeline(req,measure,out);requireValue(size>0,'文件是空的');}
 catch(error){fs.rmSync(file,{force:true});throw error;}
 const entry={id,path:file,name:path.basename(String(name||'file')).slice(0,200),mime:safeMime,size,sha256:hash.digest('hex'),at:now};uploads.set(id,entry);
 return {uploadId:id,size,sha256:entry.sha256};
}
export class LocalMessageUploads{
 constructor({engine,store,dataDir,uploads=new Map()}){Object.assign(this,{engine,store,dataDir,uploads});this.locks=new Set();}
 async submit(data){
  requireValue(data&&typeof data==='object'&&!Array.isArray(data),'消息格式无效');requireValue(typeof data.prompt==='string'&&data.prompt.trim(),'请说明希望怎样处理附件');const prompt=data.prompt.trim(),messageId=data.clientRequestId;
  requireValue(typeof messageId==='string'&&/^[a-f0-9-]{36}$/i.test(messageId),'提交编号无效');requireValue(!this.locks.has(messageId),'同一消息正在接收，请稍候','message_busy');this.locks.add(messageId);
  try{
   const old=this.store.data.tasks.find(t=>t.clientRequestId===messageId||t.messages.some(m=>m.clientRequestId===messageId));
   const available=new Map(this.uploads);
   if(old)for(const a of this.store.data.artifacts.filter(a=>a.taskId===old.id&&a.uploadMessageId===messageId&&a.sourceUploadId))available.set(a.sourceUploadId,{path:path.join(this.dataDir,'artifacts',a.path),mime:a.mime,size:a.size,sha256:a.sha256});
   const rows=validateAttachments(data.attachments||[],{uploads:available}),trusted={prompt,clientRequestId:messageId,source:'user'};for(const field of ['kind','roleId','cloudConsent','memoryConsent','memoryMode'])if(Object.hasOwn(data,field))trusted[field]=data[field];
   trusted.inputDigest=inputHash(JSON.stringify({conversationId:data.conversationId||null,...trusted,attachments:rows.map(row=>({name:row.name,mime:row.mime,size:row.size,sha256:row.sha256}))}));
   if(old){const message=old.messages.find(m=>m.clientRequestId===messageId);requireValue(message?.inputDigest===trusted.inputDigest&&(!data.conversationId||old.id===data.conversationId||old.conversationId===data.conversationId),'提交内容、附件或会话已变化');return old;}
   const pending=new Map(rows.filter(row=>row.uploadId).map(row=>[row.uploadId,this.uploads.get(row.uploadId)]));
   const staged=stageAttachments(data.attachments||[],messageId,this.dataDir,{uploads:this.uploads});trusted.inputArtifacts=staged;
   try{if(data.conversationId){this.store.task(data.conversationId);return await this.engine.message(data.conversationId,{...trusted,message:prompt});}return this.engine.create(trusted);}
   catch(error){for(const row of staged)if(!this.store.data.artifacts.some(a=>a.id===row.id)){const file=path.join(this.dataDir,'artifacts',row.path),entry=pending.get(row.sourceUploadId);if(entry){fs.renameSync(file,entry.path);this.uploads.set(row.sourceUploadId,entry);}else fs.rmSync(file,{force:true});}throw error;}
  }finally{this.locks.delete(messageId);}
 }
}
