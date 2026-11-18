// Video frames and large photos for the model; raw uploads; viewing files in the chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {findFfmpeg,isVideo} from '../src/tools/media.mjs';
import {readTaskArtifact} from '../src/tools/artifacts.mjs';
import {receiveUpload,validateAttachments,stageAttachments,UPLOAD_LIMITS} from '../src/core/input-files.mjs';

const tools=findFfmpeg();
function dir(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-media-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));fs.mkdirSync(path.join(d,'artifacts/inputs/m'),{recursive:true});return d;}

test('a video becomes evenly spaced frames with its length; the model is told it cannot hear it',{skip:!tools&&'ffmpeg not installed here'},async t=>{
  const d=dir(t),file=path.join(d,'artifacts/inputs/m/v1');
  execFileSync(tools.ffmpeg,['-v','error','-f','lavfi','-i','testsrc=duration=5:size=320x240:rate=10','-pix_fmt','yuv420p','-f','mp4',file]);
  const artifact={id:'v1',taskId:'t',name:'clip.mp4',mime:'video/mp4',path:'inputs/m/v1',size:fs.statSync(file).size,kind:'input'};
  const out=await readTaskArtifact({taskId:'t',id:'v1',artifacts:[artifact],dataDir:d});
  const meta=JSON.parse(out.content[0].text);assert.equal(meta.format,'video');assert.equal(meta.readable,true);assert.ok(Math.abs(meta.durationSeconds-5)<0.3);assert.match(meta.note,/听不到声音/);
  const images=out.content.filter(c=>c.type==='image');assert.equal(images.length,6);assert.ok(images.every(i=>i.mimeType==='image/jpeg'&&Buffer.from(i.data,'base64')[0]===0xff));
  assert.deepEqual(meta.frames,[...meta.frames].sort((a,b)=>a-b),'in time order');
});

test('a photo over 3 MB is shrunk for the model instead of being refused',{skip:!tools&&'ffmpeg not installed here'},async t=>{
  const d=dir(t),file=path.join(d,'artifacts/inputs/m/p1');
  execFileSync(tools.ffmpeg,['-v','error','-f','lavfi','-i','mandelbrot=size=2400x1800','-frames:v','1','-f','image2','-c:v','png',file]);
  const size=fs.statSync(file).size;if(size<=3*1024*1024)fs.appendFileSync(file,Buffer.alloc(3*1024*1024));
  const artifact={id:'p1',taskId:'t',name:'photo.png',mime:'image/png',path:'inputs/m/p1',size:fs.statSync(file).size,kind:'input'};
  const out=await readTaskArtifact({taskId:'t',id:'p1',artifacts:[artifact],dataDir:d});
  const meta=JSON.parse(out.content[0].text);assert.equal(meta.resized,true);assert.equal(out.content[1].mimeType,'image/jpeg');assert.ok(Buffer.from(out.content[1].data,'base64').length<3*1024*1024);
});

test('without ffmpeg nothing is guessed: no tool found means the model hears it cannot see the video',()=>{
  assert.equal(findFfmpeg({env:{PATH:'/nowhere'},home:'/nowhere',exists:()=>false}),null);
  assert.ok(isVideo({name:'a.MOV'})&&isVideo({mime:'video/webm',name:'x'})&&!isVideo({name:'a.png',mime:'image/png'}));
});

test('a large file streams to disk as an upload, then moves into the message; limits and expiry hold',async t=>{
  const d=dir(t),uploads=new Map();
  const big=Buffer.alloc(6*1024*1024,7);
  const up=await receiveUpload(Readable.from([big.subarray(0,3e6),big.subarray(3e6)]),{dataDir:d,name:'../报告.pdf',mime:'application/pdf',uploads});
  assert.equal(up.size,big.length);const entry=uploads.get(up.uploadId);assert.equal(entry.name,'报告.pdf');assert.ok(fs.existsSync(entry.path));
  const rows=validateAttachments([{name:'报告.pdf',mime:'application/pdf',uploadId:up.uploadId}],{uploads});assert.equal(rows[0].size,big.length);
  const staged=stageAttachments([{name:'报告.pdf',mime:'application/pdf',uploadId:up.uploadId}],'11111111-1111-4111-8111-111111111111',d,{uploads});
  assert.equal(staged[0].size,big.length);assert.ok(fs.existsSync(path.join(d,'artifacts',staged[0].path)));assert.equal(uploads.has(up.uploadId),false,'used once');
  assert.throws(()=>validateAttachments([{name:'x',uploadId:'missing'}],{uploads}),/重新添加/);
  await assert.rejects(receiveUpload(Readable.from([Buffer.alloc(UPLOAD_LIMITS.other+1)]),{dataDir:d,name:'a.zip',mime:'application/zip',uploads}),/50 MB/);
  assert.equal(fs.readdirSync(path.join(d,'uploads')).length,0,'a rejected upload leaves nothing behind');
  assert.throws(()=>validateAttachments([{name:'a.png',mime:'image/png',base64:Buffer.alloc(5*1024*1024).toString('base64')}]),/4 MiB/,'the inline path keeps its small limits');
});

test('ffmpeg is found in ~/.local/bin even when the service PATH is short',()=>{
  const home='/Users/x',has=new Set(['/Users/x/.local/bin/ffmpeg','/Users/x/.local/bin/ffprobe']);
  assert.deepEqual(findFfmpeg({env:{PATH:'/usr/bin:/bin'},home,exists:f=>has.has(f)}),{ffmpeg:'/Users/x/.local/bin/ffmpeg',ffprobe:'/Users/x/.local/bin/ffprobe'});
});

test('a file attached earlier in the conversation is still listed and readable in a later turn; another conversation\'s file is not',async t=>{
  const {Store}=await import('../src/core/store.mjs');const {Engine}=await import('../src/core/engine.mjs');const {Broker}=await import('../src/tools/broker.mjs');
  const d=dir(t),store=new Store(d);t.after(()=>store.close());
  const engine=new Engine({store,broker:{calls:new Map(),approvals:{cancelTask(){}},phone:{release(){}},browser:{}},secrets:{get:async()=>'x'},memory:{}});
  const first=engine.newTask({prompt:'看看这张图',cloudConsent:true});first.status='completed';
  const later=engine.newTask({prompt:'刚才那张图里有几个圈',cloudConsent:true,conversationId:first.id});later.conversationId=first.id;later.status='running';
  const other=engine.newTask({prompt:'别的对话',cloudConsent:true});other.status='completed';
  fs.writeFileSync(path.join(d,'artifacts/inputs/m/a1'),'circle notes');fs.writeFileSync(path.join(d,'artifacts/inputs/m/b1'),'secret');
  const files=[{id:'a1',taskId:first.id,name:'notes.txt',mime:'text/plain',path:'inputs/m/a1',size:12,kind:'input'},{id:'b1',taskId:other.id,name:'other.txt',mime:'text/plain',path:'inputs/m/b1',size:6,kind:'input'}];
  store.transaction(s=>{s.tasks.push(first,later,other);s.artifacts.push(...files);});
  const broker=new Broker({store,browser:{},phone:null,memory:{},approvals:{cancelTask(){}},dataDir:d});broker.engine=engine;broker.dataDir=d;
  const body=r=>Array.isArray(r)?r:r.content?JSON.parse(r.content[0].text):r;
  const list=body(await broker.executeTool(later.id,'artifact_list',{}));assert.deepEqual(list.map(a=>a.id),['a1']);assert.equal(list[0].fromEarlierTurn,true);
  const read=body(await broker.executeTool(later.id,'artifact_read',{id:'a1'}));assert.equal(read.content,'circle notes');
  await assert.rejects(broker.executeTool(later.id,'artifact_read',{id:'b1'}),/不属于当前任务/);
});

test('a browser recording without a duration header still gets evenly spaced frames',{skip:!tools&&'ffmpeg not installed here'},async t=>{
  const d=dir(t),file=path.join(d,'artifacts/inputs/m/w1');
  // A live-style webm: written as a stream, so the container has no duration.
  execFileSync(tools.ffmpeg,['-v','error','-f','lavfi','-i','testsrc=duration=4:size=320x240:rate=10','-c:v','libvpx','-f','webm','-live','1','-cluster_time_limit','500',file]);
  const {videoDuration}=await import('../src/tools/media.mjs');const duration=await videoDuration(file);assert.ok(duration>3&&duration<5,String(duration));
  const artifact={id:'w1',taskId:'t',name:'rec.webm',mime:'video/webm',path:'inputs/m/w1',size:fs.statSync(file).size,kind:'input'};
  const out=await readTaskArtifact({taskId:'t',id:'w1',artifacts:[artifact],dataDir:d});assert.ok(out.content.filter(c=>c.type==='image').length>=5);
});
