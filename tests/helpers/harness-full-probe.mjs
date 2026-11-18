import http from 'node:http';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-full-sdk-'));process.env.BOUJOY_DATA=data;
const {prepareData}=await import('../../src/config.mjs');prepareData();
const {HarnessRun}=await import('../../src/adapters/harness.mjs');let requests=0;
const server=http.createServer(async(req,res)=>{for await(const _ of req){}res.setHeader('Content-Type','application/json');if(req.url.includes('/model/'))requests++;res.end(JSON.stringify(req.url.endsWith('/tools/list')?{tools:[]}:{version:0}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const logs=[];const run=new HarnessRun({task:{id:'full-sdk-probe',source:'user'},profile:'sdk',toolNames:[],origin:`http://127.0.0.1:${server.address().port}`,token:'test-only',onLog:s=>logs.push(s)});
try{const result=await run.start({probe:true});console.log(JSON.stringify({ready:!!result,requests,profile:run.profile,logs}));}catch(e){console.error(JSON.stringify({error:e.message,logs}));process.exitCode=1;}finally{await run.dispose();await new Promise(r=>server.close(r));fs.rmSync(data,{recursive:true,force:true,maxRetries:8,retryDelay:150});}
