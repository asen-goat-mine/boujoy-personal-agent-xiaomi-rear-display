import fs from 'node:fs';
import {createHash} from 'node:crypto';

// Byte ranges let mobile clients resume an interrupted read without replaying any task.
export async function sendArtifact(req,res,{file,name,mime,sha256}){
 if(!sha256){const digest=createHash('sha256');for await(const chunk of fs.createReadStream(file))digest.update(chunk);sha256=digest.digest('hex');}
 const size=fs.statSync(file).size,etag=sha256?`"${sha256}"`:null;
 const headers={'Content-Type':mime||'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':'no-store','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(name)}`,...(etag?{ETag:etag,'X-Artifact-SHA256':sha256}:{})};
 if(req.headers['if-match']&&req.headers['if-match']!==etag){res.writeHead(412,{'Content-Length':0,...headers});res.end();return;}
 let start=0,end=size-1,status=200;
 if(req.headers.range){
  const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
  if(!match||!Number.isSafeInteger(Number(match[1]))||match[2]&&!Number.isSafeInteger(Number(match[2]))||Number(match[1])>=size||match[2]&&Number(match[2])<Number(match[1])){res.writeHead(416,{...headers,'Content-Range':`bytes */${size}`,'Content-Length':0});res.end();return;}
  start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),size-1):size-1;status=206;
  headers['Content-Range']=`bytes ${start}-${end}/${size}`;
 }
 if(status===206){const digest=createHash('sha256');for await(const chunk of fs.createReadStream(file,{start,end}))digest.update(chunk);headers['X-Content-SHA256']=digest.digest('hex');}
 else if(sha256)headers['X-Content-SHA256']=sha256;
 if(res.destroyed)return;
 res.writeHead(status,{...headers,'Content-Length':Math.max(0,end-start+1)});
 if(!size){res.end();return;}
 const stream=fs.createReadStream(file,{start,end});res.once('close',()=>stream.destroy());stream.on('error',()=>res.destroy()).pipe(res);
}
