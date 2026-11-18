import fs from 'node:fs';
import path from 'node:path';
import {receiveUpload,UPLOAD_LIMITS} from '../core/input-files.mjs';
import {requireValue} from '../core/errors.mjs';

// Temporary input files are scoped to the authenticated phone. Persist receipts so a
// service reconnect between attachment selection and message delivery loses no file.
export class ChatUploads {
 constructor(dataDir){this.root=path.join(dataDir,'remote-chat-uploads');this.devices=new Map();this.busy=new Set();}
 forDevice(id){
  requireValue(/^[A-Za-z0-9_-]{1,128}$/.test(id),'设备编号无效');
  if(this.devices.has(id))return this.devices.get(id);
  const dir=path.join(this.root,id);fs.mkdirSync(dir,{recursive:true,mode:0o700});
  for(const folder of [this.root,dir])requireValue(!fs.lstatSync(folder).isSymbolicLink(),'上传目录无效');
  const entries=new Map(),files=path.join(dir,'uploads');fs.mkdirSync(files,{recursive:true,mode:0o700});requireValue(!fs.lstatSync(files).isSymbolicLink(),'上传目录无效');
  for(const name of fs.readdirSync(files)){
   if(!/^[a-f0-9-]{36}\.json$/.test(name))continue;
   const meta=path.join(files,name);try{const row=JSON.parse(fs.readFileSync(meta,'utf8')),file=path.join(files,name.slice(0,-5));
    if(row.id!==name.slice(0,-5)||!Number.isFinite(row.at)||Date.now()-row.at>2*3600000||!fs.existsSync(file)||!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size!==row.size){fs.rmSync(meta,{force:true});fs.rmSync(file,{force:true});continue;}
    entries.set(row.id,{...row,path:file});
   }catch{fs.rmSync(meta,{force:true});}
  }
  const value={dir,entries};this.devices.set(id,value);return value;
 }
 async receive(req,device,check){
  const {dir,entries}=this.forDevice(device.id);requireValue(!this.busy.has(device.id),'附件正在上传，请稍候');
  const length=Number(req.headers['content-length']),mime=String(req.headers['content-type']||'application/octet-stream');
  requireValue(Number.isSafeInteger(length)&&length>0&&length<=(mime.startsWith('video/')?UPLOAD_LIMITS.video:UPLOAD_LIMITS.other),'附件大小无效');
  for(const [id,row] of entries)if(Date.now()-row.at>2*3600000){fs.rmSync(row.path,{force:true});fs.rmSync(row.path+'.json',{force:true});entries.delete(id);}
  requireValue([...entries.values()].reduce((n,row)=>n+row.size,0)+length<=UPLOAD_LIMITS.total,'待发送附件合计最多 600 MB');
  let name;try{name=decodeURIComponent(String(req.headers['x-file-name']||'file'));}catch{requireValue(false,'附件名称无效');}
  requireValue(name.length>0&&name.length<=200,'附件名称无效');this.busy.add(device.id);let saved;
  try{saved=await receiveUpload(req,{dataDir:dir,name,mime,uploads:entries});check();const row=entries.get(saved.uploadId);requireValue(row.size===length,'附件上传不完整');
   fs.writeFileSync(row.path+'.json',JSON.stringify({...row,path:undefined}),{flag:'wx',mode:0o600});return {...saved,name:row.name,mime:row.mime};
  }catch(error){if(saved){const row=entries.get(saved.uploadId);if(row){fs.rmSync(row.path,{force:true});fs.rmSync(row.path+'.json',{force:true});entries.delete(saved.uploadId);}}throw error;}
  finally{this.busy.delete(device.id);}
 }
}
