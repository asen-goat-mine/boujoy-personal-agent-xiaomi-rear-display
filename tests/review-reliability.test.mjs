import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {receiveUpload,stageAttachments,LocalMessageUploads} from '../src/core/input-files.mjs';
import {Store} from '../src/core/store.mjs';
import {Engine,validateInputArtifacts} from '../src/core/engine.mjs';
import {LocalAgentJobs} from '../src/tools/local-agents.mjs';
import {macFiles} from '../src/tools/mac-files.mjs';
function folder(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-review-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function fixture(t){const dir=folder(t),store=new Store(dir);t.after(()=>store.close());const engine=new Engine({store,broker:{calls:new Map()},secrets:{get:async()=>null},memory:{}});engine.pump=()=>{};const uploads=new Map(),submitter=new LocalMessageUploads({engine,store,dataDir:dir,uploads});return {dir,store,engine,uploads,submitter};}
async function upload(f){return receiveUpload(Readable.from(['review attachment']),{dataDir:f.dir,name:'review.txt',mime:'text/plain',uploads:f.uploads});}

test('review: an execution failure never restarts the whole prompt on the fallback kernel',async()=>{
 const {HarnessRun,harnessExtrasStatus}=await import('../src/adapters/harness.mjs?review-failure');
 class Fake extends HarnessRun{async startOnce({probe,extras}){this.starts=(this.starts||0)+1;if(!probe)await this.send();return {ok:true};}async send(){this.sends=(this.sends||0)+1;throw Object.assign(new Error('model connection lost after dispatch'),{code:'runtime_exited'});}}
 const run=new Fake({task:{id:'t'},prompt:'do work'});await assert.rejects(run.start(),/connection lost/);assert.equal(run.starts,1);assert.equal(run.sends,1);assert.equal(harnessExtrasStatus().broken,null);
});
test('review: retrying a submitted streamed attachment survives consumed upload IDs and a fresh submitter',async t=>{
 const f=fixture(t),up=await upload(f),request={prompt:'read attachment',clientRequestId:randomUUID(),attachments:[{name:'review.txt',uploadId:up.uploadId}],cloudConsent:false};
 const first=await f.submitter.submit(request);const fresh=new LocalMessageUploads({engine:f.engine,store:f.store,dataDir:f.dir});
 assert.equal((await fresh.submit(request)).id,first.id);assert.equal(f.store.data.tasks.length,1);assert.equal(f.store.data.artifacts.length,1);
 await assert.rejects(fresh.submit({...request,prompt:'different request'}));
 await assert.rejects(fresh.submit({...request,attachments:[{...request.attachments[0],uploadId:randomUUID()}]}));
});
test('review: rejection before creating a task leaves the uploaded bytes available for retry',async t=>{
 const f=fixture(t),up=await upload(f),request={prompt:'read attachment',clientRequestId:randomUUID(),attachments:[{name:'review.txt',uploadId:up.uploadId}],roleId:'missing-role'};
 await assert.rejects(f.submitter.submit(request));assert.ok(f.uploads.has(up.uploadId));assert.ok(fs.existsSync(f.uploads.get(up.uploadId).path));
 const task=await f.submitter.submit({...request,roleId:'concierge'});assert.ok(task.id);
});
test('review: duplicate upload IDs are rejected without consuming the original file',async t=>{
 const f=fixture(t),up=await upload(f),item={name:'review.txt',uploadId:up.uploadId};
 assert.throws(()=>stageAttachments([item,item],randomUUID(),f.dir,{uploads:f.uploads}));assert.ok(f.uploads.has(up.uploadId));assert.ok(fs.existsSync(f.uploads.get(up.uploadId).path));
});
test('review: an empty upload leaves no orphaned file',async t=>{
 const f=fixture(t);await assert.rejects(receiveUpload(Readable.from([]),{dataDir:f.dir,name:'empty.txt',mime:'text/plain',uploads:f.uploads}));assert.deepEqual(fs.readdirSync(path.join(f.dir,'uploads')),[]);
});
test('review: advertised 500 MB videos are accepted by the engine, other inputs stay bounded',()=>{
 const message=randomUUID(),id=randomUUID(),row={id,sourceMessageId:message,path:`inputs/${message}/${id}`,name:'video.mp4',mime:'video/mp4',kind:'input',sha256:'a'.repeat(64),size:120*1024*1024,createdAt:new Date().toISOString()};
 assert.equal(validateInputArtifacts([row])[0].size,row.size);assert.throws(()=>validateInputArtifacts([{...row,size:501*1024*1024}]));assert.throws(()=>validateInputArtifacts([{...row,mime:'text/plain'}]));
});
test('review: a JSON agent error with text is still a failure, even with exit code zero',async t=>{
 const dir=folder(t),bin=path.join(dir,'agent');fs.writeFileSync(bin,'#!/bin/sh\nprintf \'%s\\n\' \'{"is_error":true,"result":"Authentication required. Please login"}\'\n',{mode:0o700});
 const jobs=new LocalAgentJobs({dataDir:dir,home:dir});const job=jobs.start({taskId:'t',agent:'codebuddy',bin,prompt:'p',cwd:dir});const result=await jobs.wait(job.jobId,'t',{ms:4000});assert.equal(result.status,'failed');assert.match(result.error,/Authentication/);
});
test('review: cancelling an agent stops descendants, not only the launcher',async t=>{
 const dir=folder(t),marker=path.join(dir,'late-write'),ready=path.join(dir,'ready'),bin=path.join(dir,'agent');
 const worker=`require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'late'),700);`;
 fs.writeFileSync(bin,`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'ignore'});setInterval(()=>{},1000);\n`,{mode:0o700});
 const jobs=new LocalAgentJobs({dataDir:dir,home:dir});const job=jobs.start({taskId:'t',agent:'codex',bin:process.execPath,launchArgs:[bin],prompt:'p',cwd:dir});t.after(()=>jobs.cancelAll());
 for(let i=0;i<100&&!fs.existsSync(ready);i++)await new Promise(r=>setTimeout(r,20));assert.ok(fs.existsSync(ready),'worker has actually started');
 jobs.cancelTask('t');await new Promise(r=>setTimeout(r,900));assert.equal(fs.existsSync(marker),false);assert.equal(jobs.jobs.get(job.jobId).status,'cancelled');
});
test('review: work-folder and version-directory symlinks cannot redirect writes',async t=>{
 const home=folder(t);fs.mkdirSync(path.join(home,'Documents'),{recursive:true});fs.mkdirSync(path.join(home,'Library/private'),{recursive:true});fs.symlinkSync(path.join(home,'Library/private'),path.join(home,'Documents/Boujoy'));
 await assert.rejects(macFiles({action:'write',path:'blocked.txt',content:'x'},{home}),{code:'mac_files_denied'});assert.equal(fs.existsSync(path.join(home,'Library/private/blocked.txt')),false);
 fs.unlinkSync(path.join(home,'Documents/Boujoy'));fs.mkdirSync(path.join(home,'Documents/Boujoy'));fs.symlinkSync(path.join(home,'Library/private'),path.join(home,'Documents/Boujoy/.versions'));fs.writeFileSync(path.join(home,'Documents/Boujoy/report.txt'),'original');
 await assert.rejects(macFiles({action:'write',path:'report.txt',content:'replacement'},{home}),{code:'mac_files_denied'});assert.equal(fs.readFileSync(path.join(home,'Documents/Boujoy/report.txt'),'utf8'),'original');
});
