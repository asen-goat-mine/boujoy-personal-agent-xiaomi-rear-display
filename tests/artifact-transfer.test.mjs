import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import {sendArtifact} from '../src/remote/artifact-transfer.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
test('authenticated delivery helper supports ranges, exact hashes, immutable reads and old full-body clients',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-range-')),file=path.join(dir,'output.png'),bytes=randomBytes(5*1024*1024+29),sha256=hash(bytes);fs.writeFileSync(file,bytes);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const server=http.createServer((req,res)=>{sendArtifact(req,res,{file,name:'成品.png',mime:'image/png',sha256}).catch(()=>res.destroy());});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url=`http://127.0.0.1:${server.address().port}/file`,chunks=[];
 for(let start=0;start<bytes.length;start+=1024*1024){const response=await fetch(url,{headers:{Range:`bytes=${start}-${start+1024*1024-1}`,'If-Match':`"${sha256}"`}});assert.equal(response.status,206);const chunk=Buffer.from(await response.arrayBuffer());assert.equal(response.headers.get('x-content-sha256'),hash(chunk));assert.equal(response.headers.get('x-artifact-sha256'),sha256);assert.equal(response.headers.get('content-range'),`bytes ${start}-${start+chunk.length-1}/${bytes.length}`);chunks.push(chunk);}
 assert.deepEqual(Buffer.concat(chunks),bytes);assert.equal((await fetch(url,{headers:{Range:'bytes=0-3','If-Match':'"changed"'}})).status,412);
 for(const range of ['bytes=99999999-','bytes=5-4','bytes=0-1,4-8','bytes=no','bytes=9007199254740994-'])assert.equal((await fetch(url,{headers:{Range:range}})).status,416);
 const full=await fetch(url);assert.equal(full.status,200);assert.equal(full.headers.get('x-content-sha256'),sha256);assert.deepEqual(Buffer.from(await full.arrayBuffer()),bytes);
});
