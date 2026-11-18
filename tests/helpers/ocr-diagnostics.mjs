// Test-only capture of the exact subprocess response used by production OCR.
// No retry, substitution or recognition/authorization policy change is made.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';

const original=childProcess.execFile,records=new Map();
function capturedExecFile(file,args,options,callback){
 const selected=file==='/usr/bin/osascript'&&Array.isArray(args)&&args[0]==='-l'&&args[1]==='JavaScript'&&/[/\\]scripts[/\\]phone-ocr\.js$/.test(args[2]||'')&&typeof callback==='function';
 if(!selected)return original.apply(this,arguments);
 const startedAt=new Date().toISOString();
 return original.call(this,file,args,options,(error,stdout,stderr)=>{
  try{
   const bytes=fs.readFileSync(args[3]),sha256=createHash('sha256').update(bytes).digest('hex');
   const rows=records.get(sha256)||[];rows.push({startedAt,finishedAt:new Date().toISOString(),sha256,stdout:String(stdout),stderr:String(stderr),error:error?{name:error.name,message:error.message,code:error.code,signal:error.signal,killed:error.killed}:null});records.set(sha256,rows);
  }catch{}
  callback(error,stdout,stderr);
 });
}
capturedExecFile[promisify.custom]=(...args)=>{
 let child;const promise=new Promise((resolve,reject)=>{child=capturedExecFile(...args,(error,stdout,stderr)=>{if(error){error.stdout=stdout;error.stderr=stderr;reject(error);}else resolve({stdout,stderr});});});promise.child=child;return promise;
};
childProcess.execFile=capturedExecFile;syncBuiltinESMExports();
export function capturedPhoneOCR(sha256){return structuredClone(records.get(sha256)||[]);}
