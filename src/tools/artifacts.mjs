import {isVideo,videoFrames,shrinkImage} from './media.mjs';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DATA} from '../config.mjs';
import {requireValue} from '../core/errors.mjs';
import {inflateRawSync} from 'node:zlib';

const TEXT_LIMIT=200*1024,IMAGE_LIMIT=10*1024*1024,FILE_LIMIT=100*1024*1024;
const textFile=artifact=>/^text\//i.test(artifact.mime||'')||/^application\/(?:json|ld\+json|xml|javascript)$/i.test(artifact.mime||'')||(!artifact.mime||artifact.mime==='application/octet-stream')&&/\.(?:md|txt|csv|tsv|json|xml|html|css|js|mjs|py|yaml|yml)$/i.test(artifact.name||'');
async function boundedOffice(bytes,format){
 const [{default:JSZip},{readDocumentBuffer}]=await Promise.all([import('jszip'),import('./documents.mjs')]);
 requireValue(bytes.length<=8*1024*1024,'Office 附件最多 8 MiB');const zip=await JSZip.loadAsync(bytes),entries=Object.values(zip.files);requireValue(entries.length<=1000,'Office 附件部件过多');let total=0,cells=0;
 for(const entry of entries){if(entry.dir)continue;const data=entry._data;requireValue(data&&Number.isSafeInteger(data.uncompressedSize)&&data.uncompressedSize<=4*1024*1024,'Office 部件过大');total+=data.uncompressedSize;requireValue(total<=16*1024*1024,'Office 解压内容过大');
  const magic=data.compression?.magic;requireValue(magic==='\x00\x00'||magic==='\x08\x00','不支持的 Office 压缩方式');
  const expanded=magic==='\x08\x00'?inflateRawSync(data.compressedContent,{maxOutputLength:Math.max(1,data.uncompressedSize)}):Buffer.from(data.compressedContent);requireValue(expanded.length===data.uncompressedSize,'Office 部件大小不一致');
  if(/\.xml$|\.rels$/i.test(entry.name)){const xml=expanded.toString('utf8');requireValue(!/<!DOCTYPE|<!ENTITY/i.test(xml),'不读取含 XML 实体声明的附件');
   if(format==='xlsx'&&/^xl\/worksheets\//.test(entry.name)){cells+=(xml.match(/<c\b/g)||[]).length;requireValue(cells<=20000,'工作簿单元格过多');for(const cell of xml.matchAll(/\br=["']([A-Z]+)(\d+)["']/g)){const column=[...cell[1]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);requireValue(column<=100&&Number(cell[2])<=5000,'工作簿范围超出读取限制');}for(const row of xml.matchAll(/<row\b[^>]*\br=["'](\d+)["']/g))requireValue(Number(row[1])<=5000,'工作簿行号过大');}
  }
 }
 // Parse local OOXML text only. Hyperlink/image targets are never fetched or executed.
 return readDocumentBuffer({format,buffer:bytes,allowExternalRelationships:true});
}
function rasterMime(bytes){
 if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 if(/^GIF8[79]a/.test(bytes.subarray(0,6).toString('ascii')))return 'image/gif';
 if(bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP')return 'image/webp';
 return null;
}

// Attachments are untrusted source material, never a new instruction or grant.
// Caller supplies only a recorded artifact ID; a model cannot select a path.
export async function readTaskArtifact({taskId,id,artifacts,dataDir=DATA,textLimit=TEXT_LIMIT}){
 // Only internal consumers may request a larger text payload; model previews stay
 // at 200 KiB. Keep ownership/hash/UTF-8 checks on the same read path.
 requireValue(Number.isSafeInteger(textLimit)&&textLimit>0&&textLimit<=1024*1024,'文本读取上限无效');
 const artifact=artifacts.find(item=>item.id===id&&item.taskId===taskId);
 requireValue(artifact,'此文件不属于当前任务','artifact_not_found');
 requireValue(typeof artifact.path==='string'&&!path.isAbsolute(artifact.path),'文件路径无效','artifact_path_invalid');
 const root=path.join(await fs.realpath(dataDir),'artifacts');requireValue(await fs.realpath(root)===root,'产物根目录不能指向其他目录','artifact_path_invalid');
 const candidate=path.resolve(root,artifact.path);
 requireValue(candidate.startsWith(root+path.sep),'文件路径超出任务产物目录','artifact_path_invalid');
 const file=await fs.realpath(candidate);requireValue(file.startsWith(root+path.sep),'文件路径超出任务产物目录','artifact_path_invalid');
 // Video: a few evenly spaced frames plus its length; the model cannot watch or hear it.
 if(isVideo(artifact)){
  const st=await fs.stat(file);requireValue(st.isFile()&&(!Number.isSafeInteger(artifact.size)||st.size===artifact.size),'文件大小与记录不一致','artifact_changed');
  const base={id:artifact.id,taskId,name:artifact.name,mime:artifact.mime||'video/mp4',size:st.size,source:artifact.kind==='input'?'user_attachment':'task_artifact',sourceMessageId:artifact.sourceMessageId||null,untrustedContent:true,authorizationSource:false,format:'video'};
  const {available,duration,frames}=await videoFrames(file);
  if(!available||!frames.length)return {content:[{type:'text',text:JSON.stringify({...base,readable:false,reason:available?'frames_failed':'ffmpeg_not_found',note:'这台 Mac 上暂时无法解析这个视频；请如实告诉用户你看不到视频内容。'})}]};
  return {content:[{type:'text',text:JSON.stringify({...base,readable:true,durationSeconds:duration?Number(duration.toFixed(1)):null,frames:frames.map(f=>f.at),note:`以下是视频里均匀截取的 ${frames.length} 张画面（按时间顺序，单位秒）；你看不到其余画面，也听不到声音，回答时说明这一点。`})},...frames.map(f=>({type:'image',mimeType:'image/jpeg',data:f.jpeg.toString('base64')}))]};
 }
 const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 let bytes,stat;
 try{
  stat=await handle.stat();requireValue(stat.isFile()&&stat.size<=FILE_LIMIT,'文件不存在或超出本机读取大小限制','artifact_size_invalid');
  if(Number.isSafeInteger(artifact.size))requireValue(stat.size===artifact.size,'文件大小与记录不一致','artifact_changed');
  bytes=await handle.readFile();requireValue(bytes.length===stat.size,'文件在读取中发生变化','artifact_changed');
 }finally{await handle.close();}
 const digest=createHash('sha256').update(bytes).digest('hex');
 if(artifact.sha256)requireValue(typeof artifact.sha256==='string'&&digest===artifact.sha256,'文件内容与记录的校验值不一致','artifact_changed');
 const meta={id:artifact.id,taskId,name:artifact.name,mime:artifact.mime||'application/octet-stream',size:bytes.length,sha256:digest,source:artifact.kind==='input'?'user_attachment':'task_artifact',sourceMessageId:artifact.sourceMessageId||null,untrustedContent:true,authorizationSource:false};
 const imageMime=rasterMime(bytes);
 if(bytes.subarray(0,5).toString()==='%PDF-'||artifact.mime==='application/pdf'||/\.pdf$/i.test(artifact.name||'')){const {readPdfBuffer}=await import('./pdf-reader.mjs');return {content:[{type:'text',text:JSON.stringify({...meta,format:'pdf',...await readPdfBuffer(bytes)})}]};}
 if(imageMime){
  // Large phone photos are shrunk for the model instead of refused.
  if(bytes.length>3*1024*1024){const small=await shrinkImage(bytes);if(small)return {content:[{type:'text',text:JSON.stringify({...meta,mime:'image/jpeg',format:'image',readable:true,resized:true})},{type:'image',mimeType:'image/jpeg',data:small.toString('base64')}]};}
  if(bytes.length>IMAGE_LIMIT)return {content:[{type:'text',text:JSON.stringify({...meta,format:'binary',readable:false,reason:'image_exceeds_10_mib'})}]};
  return {content:[{type:'text',text:JSON.stringify({...meta,mime:imageMime,format:'image',readable:true})},{type:'image',mimeType:imageMime,data:bytes.toString('base64')}]};
 }
 if(textFile(artifact)){
  let content;try{const decoder=new TextDecoder('utf-8',{fatal:true});content=decoder.decode(bytes.subarray(0,textLimit),{stream:bytes.length>textLimit});}catch{return {content:[{type:'text',text:JSON.stringify({...meta,format:'binary',readable:false,reason:'not_valid_utf8'})}]};}
  // NULs in common binary formats should not become fake document text.
  if(content.includes('\0'))return {content:[{type:'text',text:JSON.stringify({...meta,format:'binary',readable:false,reason:'binary_content'})}]};
  return {content:[{type:'text',text:JSON.stringify({...meta,format:'text',readable:true,truncated:bytes.length>textLimit,content})}]};
 }
 const office=artifact.name?.match(/\.(docx|xlsx|pptx)$/i)?.[1]?.toLowerCase();
 if(office){try{const parsed=await boundedOffice(bytes,office),serialized=Buffer.from(JSON.stringify(parsed)),truncated=serialized.length>TEXT_LIMIT,content=new TextDecoder().decode(serialized.subarray(0,TEXT_LIMIT),{stream:truncated});return {content:[{type:'text',text:JSON.stringify({...meta,format:office,readable:true,method:'ooxml_parse',rendered:false,truncated,content})}]};}catch{return {content:[{type:'text',text:JSON.stringify({...meta,format:office,readable:false,reason:'unsupported_or_oversized_office_document'})}]};}}
 return {content:[{type:'text',text:JSON.stringify({...meta,format:'binary',readable:false,reason:'reader_not_available'})}]};
}
