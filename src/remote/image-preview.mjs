import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {requireValue} from '../core/errors.mjs';

const exec=promisify(execFile),flights=new Map();
// Call only after artifact ownership, canonical path and digest verification.
// Preview bytes are disposable and never replace the original task artifact.
export async function imagePreview(file,key){
 if(flights.has(key))return flights.get(key);
 const job=(async()=>{
  requireValue(process.platform==='darwin','此电脑暂不支持图片预览，请保存原图');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'boujoy-image-preview-'));
  try{
   const output=path.join(dir,'preview.jpg');
   await exec('/usr/bin/sips',['-Z','1280','-s','format','jpeg','-s','formatOptions','75',file,'--out',output],{timeout:15000,maxBuffer:65536});
   const info=await fs.stat(output);requireValue(info.size>0&&info.size<=2*1024*1024,'图片预览过大，请保存原图');
   return await fs.readFile(output);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
 })();flights.set(key,job);try{return await job;}finally{flights.delete(key);}
}
