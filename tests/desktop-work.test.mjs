// Desktop (Mac) work, 2026-11-01 probes: browser/file requests went to the phone,
// no access to the user's files, 8000-char messages, wasted finish turns.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {Broker,toolsForTask} from '../src/tools/broker.mjs';
import {macFiles,fileRoots} from '../src/tools/mac-files.mjs';

function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-desktop-')),store=new Store(dir);store.transaction(s=>{s.settings.phoneEnabled=true;});
  const engine=new Engine({store,broker:{calls:new Map(),approvals:{cancelTask(){}},phone:{release(){},close(){}},browser:{close(){}},allToolNames:()=>[]},secrets:{get:async()=>'x'},memory:{observe:async()=>{}},runFactory:()=>({async start(){},async stop(){},async dispose(){}})});
  t.after(async()=>{await engine.shutdown();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,store,engine};
}
const names=(f,text)=>{const task=f.engine.newTask({prompt:text,cloudConsent:true});return toolsForTask(task,{store:f.store}).map(x=>x.name);};

test('computer and phone work retain general tools while execution switches remain authoritative',t=>{
  const f=fixture(t);
  for(const text of ['看看我 Mac 上 Documents/Codex 文件夹里有哪些项目','用浏览器打开 https://github.com/trending 告诉我第一名','帮我整理一下桌面上的文件']){
    const list=names(f,text);for(const tool of ['browser_open','mac_files','web_fetch'])assert.ok(list.includes(tool),`${text} → ${tool}`);
  }
  const phone=names(f,'打开淘宝看看购物车');
  for(const tool of ['phone_use','mac_files','browser_open','web_fetch'])assert.ok(phone.includes(tool),tool);
  assert.ok(!phone.includes('shop_flow'),'the model does not receive a scripted shopping path');
  f.store.transaction(s=>{s.settings.filesEnabled=false;s.settings.browserEnabled=false;});
  const disabled=names(f,'打开淘宝看看购物车');
  assert.ok(disabled.includes('phone_use'));
  for(const tool of ['mac_files','artifact_read','browser_open','web_fetch'])assert.ok(!disabled.includes(tool),tool);
});

test('local filenames mentioning phones retain Mac read tools through the broker catalog',t=>{
  const f=fixture(t),broker=new Broker({store:f.store,browser:{},phone:{},memory:{},approvals:{cancelTask(){}}});
  for(const prompt of [
    '看看我下载文件夹里那个『Boujoy 手机端设计稿.html』，用三句话告诉我它讲了什么',
    '读取下载里的“手机端设计稿.html”并总结',
    '看看 Documents 里的「手机使用说明.pdf」',
    '读取桌面上的 "手机报价.csv"',
  ]){
    const task=f.engine.newTask({prompt,cloudConsent:true});
    const menu=broker.catalog(task).map(x=>x.name);
    for(const name of ['mac_files','artifact_read'])assert.ok(menu.includes(name),`${prompt} → ${name}`);
    assert.notEqual(f.engine.reasoningFor(task),'low','local document analysis is not focused phone work');
  }
  const phone=names(f,'在手机文件管理器里打开下载文件夹');
  assert.ok(phone.includes('mac_files'),'phone work may discover Mac tools; each call still checks task scope');
  f.store.transaction(s=>{s.settings.filesEnabled=false;});
  const disabled=names(f,'看看下载文件夹里的『手机端设计稿.html』');
  assert.ok(!disabled.includes('mac_files')&&!disabled.includes('artifact_read'),'file execution switch still applies');
});

test('a long pasted message is accepted (up to 60000 characters)',t=>{
  const f=fixture(t);const long='第1段：'+'本季度完成了模块重构。'.repeat(2500);
  assert.ok(long.length>20000);const task=f.engine.create({prompt:'帮我总结：'+long,cloudConsent:true});assert.ok(task.prompt.length>20000);
  assert.throws(()=>f.engine.create({prompt:'x'.repeat(60001),cloudConsent:true}),/60000/);
});

test('a computer task that reaches for a paused phone keeps running',async t=>{
  const f=fixture(t);const task=f.engine.newTask({prompt:'用浏览器打开 github',cloudConsent:true});task.status='running';f.store.transaction(s=>{s.tasks.push(task);});
  const paused=Object.assign(new Error('paused'),{code:'phone_control_paused'});
  const broker=new Broker({store:f.store,browser:{},phone:{lease:null,assertRemoteDataAvailable(){throw paused;},release(){}},memory:{},approvals:{cancelTask(){}}});
  let pausedCalled=false;broker.engine={pauseForPhoneControl(){pausedCalled=true;},takeInterjections:()=>[],takeRouterNotes:()=>[]};
  await assert.rejects(broker.execute(task.id,'phone_use',{action:'read'}),{code:'phone_unavailable'});
  assert.equal(pausedCalled,false);assert.equal(f.store.task(task.id).status,'running');
});

test('mac_files lists, finds, reads and attaches only inside the allowed folders',async t=>{
  const f=fixture(t);const home=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-home-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  for(const d of ['Documents/Codex/Boujoy-Personal-Agent','Documents/.secret','Desktop','Downloads','Library/Keychains','Other'])fs.mkdirSync(path.join(home,d),{recursive:true});
  fs.writeFileSync(path.join(home,'Documents/Codex/Boujoy-Personal-Agent/README.md'),'# Boujoy\n个人助理');
  fs.writeFileSync(path.join(home,'Documents/.secret/key.txt'),'secret');fs.writeFileSync(path.join(home,'Other/x.txt'),'outside');
  fs.writeFileSync(path.join(home,'Desktop/report.docx'),Buffer.from('PK\u0003\u0004fake'));
  fs.symlinkSync(path.join(home,'Other'),path.join(home,'Documents/link'));
  const roots=await fileRoots({},home);assert.deepEqual(roots.map(r=>r.name).sort(),['Desktop','Documents','Downloads']);
  const opts={home};
  const listed=await macFiles({action:'list',path:'Documents/Codex'},opts);assert.deepEqual(listed.entries.map(e=>e.name),['Boujoy-Personal-Agent']);
  const top=await macFiles({action:'list',path:'~/Documents'},opts);assert.ok(!top.entries.some(e=>e.name.startsWith('.')||e.name==='link'),'no hidden entries or symlinks');
  const found=await macFiles({action:'find',query:'readme'},opts);assert.equal(found.matches[0].path,'Documents/Codex/Boujoy-Personal-Agent/README.md');
  const read=await macFiles({action:'read',path:'文稿/Codex/Boujoy-Personal-Agent/README.md'},opts);assert.match(read.content,/个人助理/);
  for(const bad of ['Documents/.secret/key.txt','~/Other/x.txt',path.join(home,'Library/Keychains'),'Documents/link/x.txt','../Other/x.txt'])await assert.rejects(macFiles({action:'read',path:bad},opts),e=>['mac_files_denied','mac_files_not_found'].includes(e.code),bad);
  let attached=null;const result=await macFiles({action:'attach',path:'Desktop/report.docx'},{home,attach:async file=>{attached=file;return {attached:true};}});
  assert.equal(result.attached,true);assert.equal(attached.name,'report.docx');assert.match(attached.mime,/wordprocessingml/);
});

test('an attached Mac file becomes a task input that artifact_read can open',async t=>{
  const f=fixture(t);const {attachToTask}=await import('../src/tools/mac-files.mjs');const {readTaskArtifact}=await import('../src/tools/artifacts.mjs');
  const task=f.engine.newTask({prompt:'读一下桌面上的 notes.txt',cloudConsent:true});f.store.transaction(s=>{s.tasks.push(task);});
  const out=await attachToTask({store:f.store,dataDir:f.dir,taskId:task.id,file:{name:'notes.txt',mime:'text/plain',bytes:Buffer.from('会议记录：周五上线'),from:'Desktop/notes.txt'}});
  const read=await readTaskArtifact({taskId:task.id,id:out.artifactId,artifacts:f.store.data.artifacts,dataDir:f.dir});
  assert.match(JSON.stringify(read),/周五上线|text/);
});

test('a desktop tool result carries a real evidence id that finish_task accepts; invented ids are still refused',async t=>{
  const f=fixture(t);const task=f.engine.newTask({prompt:'帮我读一下 https://example.com 并总结',cloudConsent:true});task.status='running';f.store.transaction(s=>{s.tasks.push(task);s.settings.browserEnabled=true;});
  const broker=new Broker({store:f.store,browser:{},phone:null,memory:{},approvals:{cancelTask(){}}});
  let finished=false;broker.engine={finishReport(){finished=true;},takeInterjections:()=>[],takeRouterNotes:()=>[]};
  broker.web={fetch:async()=>({url:'https://example.com/',title:'Example',content:'示例页面',offset:0,totalChars:4,nextOffset:null,untrustedContent:true})};
  const result=await broker.execute(task.id,'web_fetch',{url:'https://example.com'});
  const refs=result.content.map(c=>{try{return JSON.parse(c.text).finishEvidenceRefs;}catch{return null;}}).find(Boolean);
  assert.equal(refs.length,1);
  await assert.rejects(broker.execute(task.id,'finish_task',{outcome:'completed',summary:'示例页面。',evidence:['made-up']}),/未知证据/);
  await broker.execute(task.id,'finish_task',{outcome:'completed',summary:'示例页面。',evidence:refs});assert.equal(finished,true);
});

test('auto thinking depth does not downgrade user tasks for device words or prompt length',t=>{
  const f=fixture(t);const depth=text=>f.engine.reasoningFor(f.engine.newTask({prompt:text,cloudConsent:true}));
  for(const text of ['你好','打开淘宝看看购物车','放首周杰伦的晴天'])assert.equal(depth(text),'high',text);
  for(const text of ['帮我分析一下这份季度报告的问题','写一个 Python 脚本把 csv 转成 Excel','帮我写一份周报','查一下明天洛杉矶天气','让 codex 看一下项目'])assert.equal(depth(text),'high',text);
  for(const text of ['帮我做一份日本七天的旅行计划','调研一下国内 AI 助手市场','设计一个记账 App 的架构'])assert.equal(depth(text),'max',text);
  for(const level of ['off','low','high','max']){f.store.transaction(s=>{s.settings.modelReasoning=level;});assert.equal(depth('你好'),level,'an explicit setting wins');assert.equal(depth('深入分析并编写代码'),level,'explicit choice also wins for complex tasks');}
});

test('relative writes stay in the work folder; overwrites keep the old version and nothing is deleted',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-home-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  for(const d of ['Documents','Desktop'])fs.mkdirSync(path.join(home,d),{recursive:true});fs.writeFileSync(path.join(home,'Desktop/keep.txt'),'mine');
  const opts={home};
  const first=await macFiles({action:'write',path:'报告/周报.md',content:'# 周报 v1'},opts);
  assert.equal(first.path,'Documents/Boujoy/报告/周报.md');assert.equal(fs.readFileSync(path.join(home,'Documents/Boujoy/报告/周报.md'),'utf8'),'# 周报 v1');
  const second=await macFiles({action:'write',path:'Documents/Boujoy/报告/周报.md',content:'# 周报 v2'},opts);
  assert.ok(second.previousVersion);assert.equal(fs.readFileSync(path.join(home,'Documents/Boujoy',second.previousVersion),'utf8'),'# 周报 v1');
  await macFiles({action:'write',path:'报告/周报.md',content:'\n- 追加一行',append:true},opts);
  assert.match(fs.readFileSync(path.join(home,'Documents/Boujoy/报告/周报.md'),'utf8'),/v2\n- 追加一行$/);
  for(const bad of ['../Desktop/keep.txt','/tmp/x.txt','.versions/x','报告/../../Desktop/keep.txt'])await assert.rejects(macFiles({action:'write',path:bad,content:'x'},opts),e=>e.code==='mac_files_denied',bad);
  assert.equal(fs.readFileSync(path.join(home,'Desktop/keep.txt'),'utf8'),'mine');
  const listed=await macFiles({action:'list',path:'Documents/Boujoy'},opts);assert.ok(!listed.entries.some(e=>e.name.startsWith('.')),'versions stay hidden');
  const saved=await macFiles({action:'save',artifactId:'a1'},{home,artifactBytes:async id=>({name:'周报.docx',bytes:Buffer.from('PK docx')})});
  assert.equal(saved.path,'Documents/Boujoy/周报.docx');
});

test('mac_files finds recently changed files newest first, and listing your own files is not outside material',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-home-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  for(const d of ['Documents/a','Desktop','Downloads'])fs.mkdirSync(path.join(home,d),{recursive:true});
  const old=path.join(home,'Documents/a/old.txt'),fresh=path.join(home,'Desktop/new.md'),fresher=path.join(home,'Downloads/今天.pdf');
  for(const p of [old,fresh,fresher])fs.writeFileSync(p,'x');
  const day=86400000;fs.utimesSync(old,new Date(Date.now()-30*day),new Date(Date.now()-30*day));fs.utimesSync(fresh,new Date(Date.now()-day),new Date(Date.now()-day));
  const found=await macFiles({action:'find',modifiedWithinDays:7},{home});
  assert.deepEqual(found.matches.map(m=>m.path),['Downloads/今天.pdf','Desktop/new.md']);assert.ok(found.matches[0].modified);
  const named=await macFiles({action:'find',query:'new',modifiedWithinDays:7},{home});assert.deepEqual(named.matches.map(m=>m.path),['Desktop/new.md']);
  await assert.rejects(macFiles({action:'find'},{home}),/关键词/);
  const {externalContentSeen}=await import('../src/tools/broker.mjs');
  const at=new Date().toISOString(),task=e=>({runStartedAt:at,events:[{type:'tool',tool:'mac_files',at,...e}],messages:[]});
  assert.equal(externalContentSeen(task({action:'list'})),false);assert.equal(externalContentSeen(task({action:'find'})),false);
  assert.equal(externalContentSeen(task({action:'read'})),true,'file contents are outside material');
  const read=e=>({runStartedAt:at,events:[{type:'tool',tool:'artifact_read',at,...e}],messages:[]});
  assert.equal(externalContentSeen(read({ownArtifact:true})),false,'reading back a file this task made');assert.equal(externalContentSeen(read({})),true,'an uploaded or imported file');
});


test('Mac delivery is a visible output while imported working files remain inputs',async t=>{
 const f=fixture(t),{attachToTask}=await import('../src/tools/mac-files.mjs'),task=f.engine.newTask({prompt:'把电脑做好的报告发给我',cloudConsent:true});f.store.transaction(s=>s.tasks.push(task));
 for(const deliver of [false,true]){const result=await attachToTask({store:f.store,dataDir:f.dir,taskId:task.id,file:{name:'report.txt',mime:'text/plain',bytes:Buffer.from('report'),from:'Documents/Boujoy/report.txt',deliver}});assert.equal(f.store.data.artifacts.find(a=>a.id===result.artifactId).kind,deliver?'output':'input');}
});

test('delivering an imported Mac file by its receipt avoids basename lookup and duplicate attachments',async t=>{
 const f=fixture(t),{attachToTask,deliverTaskArtifact}=await import('../src/tools/mac-files.mjs'),task=f.engine.newTask({prompt:'把文件发回聊天',cloudConsent:true});f.store.transaction(s=>s.tasks.push(task));
 const first=await attachToTask({store:f.store,dataDir:f.dir,taskId:task.id,file:{name:'result.json',mime:'application/json',bytes:Buffer.from('{"sum":140}'),from:'Documents/Boujoy/qa/result.json'}});
 const deliverArtifact=id=>deliverTaskArtifact({store:f.store,dataDir:f.dir,taskId:task.id,id});
 for(const path of [undefined,'result.json']){const result=await macFiles({action:'deliver',artifactId:first.artifactId,path},{deliverArtifact});assert.equal(result.artifactId,first.artifactId);assert.equal(f.store.data.artifacts.length,1);assert.equal(f.store.data.artifacts[0].kind,'output');}
 await assert.rejects(deliverTaskArtifact({store:f.store,dataDir:f.dir,taskId:randomUUID(),id:first.artifactId}),{code:'artifact_not_found'});
 const a=f.store.data.artifacts[0];fs.writeFileSync(path.join(f.dir,'artifacts',a.path),'tampered');await assert.rejects(deliverArtifact(a.id),{code:'artifact_changed'});
});

test('delivering the same task file by path reuses a verified attachment but preserves changed versions',async t=>{
 const f=fixture(t),{attachToTask}=await import('../src/tools/mac-files.mjs'),task=f.engine.newTask({prompt:'交付修订文件',cloudConsent:true});f.store.transaction(s=>s.tasks.push(task));
 const file={name:'checklist.md',mime:'text/markdown',bytes:Buffer.from('first revision'),from:'Documents/Boujoy/checklist.md',deliver:true};
 const first=await attachToTask({store:f.store,dataDir:f.dir,taskId:task.id,file});const second=await attachToTask({store:f.store,dataDir:f.dir,taskId:task.id,file});assert.equal(first.artifactId,second.artifactId);assert.equal(f.store.data.artifacts.length,1);
 const changed=await attachToTask({store:f.store,dataDir:f.dir,taskId:task.id,file:{...file,bytes:Buffer.from('second revision')}});assert.notEqual(changed.artifactId,first.artifactId);assert.equal(f.store.data.artifacts.length,2);
 assert.match(second.next,/取决于客户端支持/);
});


test('Mac delivery preserves video and audio types so clients can offer media playback',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-media-home-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));fs.mkdirSync(path.join(home,'Documents'),{recursive:true});
 for(const [name,mime] of [['clip.webm','video/webm'],['clip.MP4','video/mp4'],['clip.mov','video/quicktime'],['sound.mp3','audio/mpeg'],['notes.bin','application/octet-stream']]){
  const bytes=Buffer.from('known test fixture');fs.writeFileSync(path.join(home,'Documents',name),bytes);
  const file=await macFiles({action:'deliver',path:'Documents/'+name},{home,attach:async file=>file});assert.equal(file.mime,mime);assert.equal(file.deliver,true);assert.deepEqual(file.bytes,bytes);
 }
});

test('device vocabulary does not reduce reasoning for open-ended analysis in either language',t=>{
 const f=fixture(t);
 for(const prompt of ['分析手机与电脑跨端同步的架构和失败恢复方案，不操作任何设备','研究带蓝牙的音频设备协议差异，只作分析','分析电脑跨端同步的失败恢复','Compare Bluetooth protocols and recovery strategies'])assert.notEqual(f.engine.reasoningFor(f.engine.newTask({prompt,cloudConsent:true})),'low');
});
test('large desktop media streams to chat, reuses verified delivery and preserves ownership checks',async t=>{
 const f=fixture(t),{attachToTask,deliverTaskArtifact}=await import('../src/tools/mac-files.mjs'),home=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-large-output-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));fs.mkdirSync(path.join(home,'Documents'));
 const file=path.join(home,'Documents','clip.webm'),size=21*1024*1024,fd=fs.openSync(file,'w');fs.ftruncateSync(fd,size);fs.writeSync(fd,Buffer.from('QA stream'),0,9,0);fs.closeSync(fd);
 const task=f.engine.newTask({prompt:'交付视频',cloudConsent:true});f.store.transaction(s=>s.tasks.push(task));
 const options={home,attach:file=>{assert.ok(file.handle,'large files use a stream');assert.equal(file.bytes,undefined);return attachToTask({store:f.store,dataDir:f.dir,taskId:task.id,file});}};
 const first=await macFiles({action:'deliver',path:'Documents/clip.webm'},options);assert.equal(first.size,size);assert.equal(f.store.data.artifacts.at(-1).kind,'output');
 const again=await macFiles({action:'deliver',path:'Documents/clip.webm'},options);assert.equal(again.artifactId,first.artifactId);assert.equal(f.store.data.artifacts.length,1);
 const saved=path.join(f.dir,'artifacts',f.store.data.artifacts[0].path);assert.equal(fs.statSync(saved).size,size);
 await assert.rejects(deliverTaskArtifact({store:f.store,dataDir:f.dir,taskId:randomUUID(),id:first.artifactId}),{code:'artifact_not_found'});
 fs.writeFileSync(saved,'changed');await assert.rejects(deliverTaskArtifact({store:f.store,dataDir:f.dir,taskId:task.id,id:first.artifactId}),{code:'artifact_changed'});
 const large=path.join(home,'Documents','oversize.bin'),out=fs.openSync(large,'w');fs.ftruncateSync(out,51*1024*1024);fs.closeSync(out);await assert.rejects(macFiles({action:'deliver',path:'Documents/oversize.bin'},options),/50 MB/);
});
