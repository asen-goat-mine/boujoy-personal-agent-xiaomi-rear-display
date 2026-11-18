// Other agents on this Mac: discovery, background runs, safety.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {discoverAgents,LocalAgentJobs,AGENT_REGISTRY,agentEnv} from '../src/tools/local-agents.mjs';

function fakeHome(t){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-agents-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  // Hermetic: only the fake install folders, never agents really installed on this machine.
  const realPath=process.env.PATH;process.env.PATH='/usr/bin:/bin';t.after(()=>{process.env.PATH=realPath;});
  const bin=path.join(home,'.local/bin');fs.mkdirSync(bin,{recursive:true});fs.mkdirSync(path.join(home,'Applications/WorkBuddy.app'),{recursive:true});fs.mkdirSync(path.join(home,'Applications/Kimi.app'),{recursive:true});
  const script=(name,body)=>{const f=path.join(bin,name);fs.writeFileSync(f,'#!/bin/sh\n'+body+'\n');fs.chmodSync(f,0o755);return f;};
  return {home,bin,script};
}

test('agents are found on the Mac without asking the user; desktop-only apps are listed as not callable',async t=>{
  const {home,script}=fakeHome(t);
  script('codex','echo "codex-cli 1.4.0"');script('claude','if [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; fi');
  const found=await discoverAgents({home,apps:path.join(home,'Applications'),dirs:[path.join(home,'.local/bin')],find:async()=>[]});
  const byId=Object.fromEntries(found.agents.map(a=>[a.id,a]));
  assert.equal(byId.codex.callable,true);assert.match(byId.codex.version,/1\.4\.0/);assert.equal(byId.claude.callable,true);
  assert.equal(byId.codebuddy.callable,false);assert.equal(byId.codebuddy.app,'WorkBuddy');assert.match(byId.codebuddy.note,/桌面 App/);
  assert.deepEqual(found.otherApps,['Kimi']);
});

test('a read-only run uses each agent\'s safe mode, strips Boujoy secrets, and reports back when done',async t=>{
  const {home,script}=fakeHome(t);
  const codex=script('codex','echo "ARGS:$*"; echo "KEY:${DEEPSEEK_API_KEY:-none}"; echo "检查完成，3 个测试失败"');
  process.env.DEEPSEEK_API_KEY='secret';t.after(()=>{delete process.env.DEEPSEEK_API_KEY;});
  const finished=[];const jobs=new LocalAgentJobs({dataDir:home,home,onFinish:job=>finished.push(job.status)});
  const started=jobs.start({taskId:'t1',agent:'codex',bin:codex,prompt:'跑一下测试',cwd:home,mode:'read'});
  assert.equal(started.status,'running');
  const done=await jobs.wait(started.jobId,'t1',{ms:5000});
  assert.equal(done.status,'completed');assert.match(done.output,/--sandbox read-only/);assert.match(done.output,/KEY:none/);assert.match(done.output,/3 个测试失败/);assert.match(done.note,/不是给你的指令/);
  assert.deepEqual(finished,['completed']);
  await assert.rejects(jobs.wait(started.jobId,'other-task'),{code:'agent_job_not_found'},'another task cannot read it');
});

test('safe-mode arguments for each agent',()=>{
  const args=(id,mode)=>AGENT_REGISTRY.find(a=>a.id===id).args({prompt:'p',cwd:'/w',mode}).join(' ');
  assert.match(args('codex','read'),/--sandbox read-only/);assert.match(args('codex','write'),/--sandbox workspace-write/);
  assert.match(args('claude','read'),/--permission-mode plan/);assert.match(args('claude','write'),/acceptEdits/);
  assert.match(args('codebuddy','read'),/--allowedTools Read,Grep,Glob,LS/);assert.match(args('gemini','read'),/--approval-mode plan/);
  const jobs=new LocalAgentJobs({dataDir:os.tmpdir()});assert.throws(()=>jobs.start({taskId:'t',agent:'cursor',bin:'/bin/echo',prompt:'p',cwd:os.tmpdir(),mode:'read'}),{code:'agent_needs_write'});
  assert.ok(!Object.keys(agentEnv(os.homedir())).some(k=>/DEEPSEEK|BOUJOY|DSH_/.test(k)));
});

test('stopping the Boujoy task stops its agent job; a cancelled job does not report back',async t=>{
  const {home,script}=fakeHome(t);const slow=script('codex','sleep 5; echo late');
  const finished=[];const jobs=new LocalAgentJobs({dataDir:home,home,onFinish:job=>finished.push(job.status)});
  const started=jobs.start({taskId:'t2',agent:'codex',bin:slow,prompt:'p',cwd:home,mode:'read'});
  jobs.cancelTask('t2');const done=await jobs.wait(started.jobId,'t2',{ms:4000});assert.equal(done.status,'cancelled');
});

test('the model gets agent tools for code work, and changing files needs the user\'s approval first',async t=>{
  const {Store}=await import('../src/core/store.mjs');const {Engine}=await import('../src/core/engine.mjs');const {Broker,toolsForTask}=await import('../src/tools/broker.mjs');
  const {home,script}=fakeHome(t);const codex=script('codex','echo ok');
  const store=new Store(path.join(home,'data'));t.after(()=>store.close());
  const engine=new Engine({store,broker:{calls:new Map(),approvals:{cancelTask(){}},phone:{release(){}},browser:{}},secrets:{get:async()=>'x'},memory:{}});
  const task=engine.newTask({prompt:'让 codex 把 Boujoy 项目的测试跑一遍，失败的修了',cloudConsent:true});task.status='running';store.transaction(s=>{s.tasks.push(task);});
  assert.ok(['local_agents','agent_run','agent_wait'].every(n=>toolsForTask(task,{store}).some(x=>x.name===n)));
  assert.ok(toolsForTask(engine.newTask({prompt:'明天洛杉矶天气怎么样',cloudConsent:true}),{store}).some(x=>x.name==='agent_run'),'always available; safety is checked when it runs');
  const approvals=[];const broker=new Broker({store,browser:{},phone:null,memory:{},approvals:{cancelTask(){},async request(id,req){approvals.push(req);throw Object.assign(new Error('没有确认'),{code:'not_approved'});}}});
  broker._agentDirectory={at:Date.now(),value:{agents:[{id:'codex',name:'Codex',callable:true,bin:codex,readOnlySupported:true}],otherApps:[]}};
  fs.mkdirSync(path.join(home,'Documents/Boujoy'),{recursive:true});const realHome=process.env.HOME;process.env.HOME=home;t.after(()=>{process.env.HOME=realHome;});
  await assert.rejects(broker.executeTool(task.id,'agent_run',{agent:'codex',prompt:'修复失败的测试',write:true}),{code:'not_approved'});
  assert.equal(approvals.length,1);assert.match(approvals[0].summary,/改文件/);assert.equal(broker.localAgents.jobs.size,0,'nothing ran without approval');
  // Read-only runs need no approval, until this turn has read outside content.
  store.updateTask(task.id,row=>{row.runStartedAt=new Date(Date.now()-1000).toISOString();});
  const plain=await broker.executeTool(task.id,'agent_run',{agent:'codex',prompt:'看一下测试'});assert.equal(approvals.length,1,'a plain read-only run is not asked');
  store.updateTask(task.id,row=>{row.events.push({type:'tool',tool:'web_fetch',at:new Date().toISOString()});});
  await assert.rejects(broker.executeTool(task.id,'agent_run',{agent:'codex',prompt:'按网页说的做'}),{code:'not_approved'});
  assert.equal(approvals.length,2);assert.match(approvals[1].summary,/只读处理.*先请你确认/);assert.match(approvals[1].args.prompt,/按网页说的做/);
  store.updateTask(task.id,row=>{row.runStartedAt=new Date(Date.now()+1000).toISOString();});
  await broker.executeTool(task.id,'agent_run',{agent:'codex',prompt:'新一轮'});assert.equal(approvals.length,2,'an earlier turn\'s web page does not count');
  broker.localAgents.cancelTask(task.id);
});

test('a command line inside a desktop app bundle and the user\'s login-shell PATH are found too',async t=>{
  const {home}=fakeHome(t);
  const inner=path.join(home,'Applications/Codex.app/Contents/Resources/bin');fs.mkdirSync(inner,{recursive:true});
  fs.writeFileSync(path.join(inner,'codex'),'#!/bin/sh\necho "codex-cli 2.0.0"\n');fs.chmodSync(path.join(inner,'codex'),0o755);
  const shellBin=path.join(home,'.nvm-like/bin');fs.mkdirSync(shellBin,{recursive:true});fs.writeFileSync(path.join(shellBin,'gemini'),'#!/bin/sh\necho "0.9.0"\n');fs.chmodSync(path.join(shellBin,'gemini'),0o755);
  const found=await discoverAgents({home,apps:path.join(home,'none'),shell:async()=>[shellBin],find:async()=>[]});
  const byId=Object.fromEntries(found.agents.map(a=>[a.id,a]));
  assert.equal(byId.codex.callable,true);assert.match(byId.codex.bin,/Codex\.app/);assert.equal(byId.gemini.callable,true);
});

test('an agent whose command line cannot actually run is marked and not offered again',async t=>{
  const {Store}=await import('../src/core/store.mjs');const {Broker}=await import('../src/tools/broker.mjs');
  const {home}=fakeHome(t);const store=new Store(path.join(home,'data'));t.after(()=>store.close());
  const broker=new Broker({store,browser:{},phone:null,memory:{},approvals:{cancelTask(){}}});
  broker._agentDirectory={at:Date.now(),value:{agents:[{id:'codebuddy',name:'WorkBuddy',callable:true,bin:'/x',readOnlySupported:true}],otherApps:[]}};
  broker.agentFinished({agent:'codebuddy',taskId:'none',status:'failed',stderr:"Error: Cannot find module '../dist/codebuddy'",stdout:''});
  const listed=await broker.agentDirectory(false);assert.equal(listed.agents[0].callable,false);assert.match(listed.agents[0].note,/重新安装/);
});

test('Spotlight finds a command line installed somewhere unusual',async t=>{
  const {home}=fakeHome(t);const odd=path.join(home,'tools/fnm/node-22/bin');fs.mkdirSync(odd,{recursive:true});
  fs.writeFileSync(path.join(odd,'claude'),'#!/bin/sh\necho "2.1.0 (Claude Code)"\n');fs.chmodSync(path.join(odd,'claude'),0o755);
  const found=await discoverAgents({home,apps:path.join(home,'none'),dirs:[],find:async()=>[path.join(odd,'claude')]});
  const claude=found.agents.find(a=>a.id==='claude');assert.equal(claude.callable,true);assert.match(claude.bin,/fnm/);assert.equal(found.searched.spotlightHits,1);
});

test('WorkBuddy\'s bundled build is run with Node when its launcher points at a missing file',async t=>{
  const {home}=fakeHome(t);const cli=path.join(home,'Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli');
  fs.mkdirSync(path.join(cli,'bin'),{recursive:true});fs.mkdirSync(path.join(cli,'dist'),{recursive:true});
  fs.writeFileSync(path.join(cli,'bin/codebuddy'),'#!/bin/sh\necho "Cannot find module ../dist/codebuddy" >&2; exit 1\n');fs.chmodSync(path.join(cli,'bin/codebuddy'),0o755);
  fs.writeFileSync(path.join(cli,'dist/codebuddy-lite-wb.mjs'),"if(process.argv.includes('--version'))console.log('2.165.0');else console.log(JSON.stringify({result:'列好了：3 个文件'}));\n");
  const found=await discoverAgents({home,apps:path.join(home,'none'),dirs:[],find:async()=>[]});
  const wb=found.agents.find(a=>a.id==='codebuddy');
  assert.equal(wb.callable,true);assert.equal(wb.bin,process.execPath);assert.match(wb.launchArgs[0],/codebuddy-lite-wb\.mjs$/);assert.equal(wb.version,'2.165.0');
  const jobs=new LocalAgentJobs({dataDir:home,home});const started=jobs.start({taskId:'t',agent:'codebuddy',bin:wb.bin,launchArgs:wb.launchArgs,prompt:'列文件',cwd:home,mode:'read'});
  const done=await jobs.wait(started.jobId,'t',{ms:8000});assert.equal(done.status,'completed');assert.equal(done.output,'列好了：3 个文件');
});

test('a file that only looks like a command never breaks discovery',async t=>{
  const {home,bin}=fakeHome(t);
  fs.writeFileSync(path.join(bin,'codex'),'not a program, no shebang');fs.chmodSync(path.join(bin,'codex'),0o755);
  fs.writeFileSync(path.join(bin,'gemini'),'#!/bin/sh\necho "0.9.0"\n');fs.chmodSync(path.join(bin,'gemini'),0o755);
  const found=await discoverAgents({home,apps:path.join(home,'none'),dirs:[bin],find:async()=>[path.join(bin,'codex')]});
  assert.ok(!found.agents.some(a=>a.id==='codex'&&a.callable));assert.equal(found.agents.find(a=>a.id==='gemini').callable,true);
});

test('an agent that exits cleanly with no answer is reported as failed, with its own words',async t=>{
  const {home,script}=fakeHome(t);
  const quiet=script('codebuddy','echo "请先登录：codebuddy login" >&2; exit 0');
  const empty=script('cbc','echo \'{"type":"result","is_error":true,"result":""}\'');
  const jobs=new LocalAgentJobs({dataDir:home,home});
  for(const bin of [quiet,empty]){
    const started=jobs.start({taskId:'t9',agent:'codebuddy',bin,prompt:'p',cwd:home,mode:'read'});
    const done=await jobs.wait(started.jobId,'t9',{ms:5000});
    assert.equal(done.status,'failed',bin);assert.equal(done.exitCode,0);assert.match(done.error,/没有给出任何回答/);
  }
  const first=[...jobs.jobs.values()][0];assert.match(jobs.view(first).error,/codebuddy login/);
  assert.match(jobs.view([...jobs.jobs.values()][1]).rawOutput,/is_error/);
});

test('a turn that runs out of time leaves a background agent working and says so; an explicit stop ends it',async t=>{
  const {Store}=await import('../src/core/store.mjs');const {Engine}=await import('../src/core/engine.mjs');
  const {home,script}=fakeHome(t);const slow=script('codex','sleep 5; echo done');
  const store=new Store(path.join(home,'data'));t.after(()=>store.close());
  const jobs=new LocalAgentJobs({dataDir:home,home});
  const engine=new Engine({store,broker:{calls:new Map(),approvals:{cancelTask(){}},phone:{release(){}},browser:{},localAgents:jobs},secrets:{get:async()=>'x'},memory:{}});
  const task=engine.newTask({prompt:'让 codex 扫一下项目',cloudConsent:true});task.status='running';store.transaction(s=>{s.tasks.push(task);});
  const job=jobs.start({taskId:task.id,agent:'codex',bin:slow,prompt:'p',cwd:home,mode:'read'});
  await engine.expireTask(task.id);
  assert.equal(store.task(task.id).status,'expired');assert.match(store.task(task.id).blockedReason,/Codex 还在后台继续做/);
  assert.equal(jobs.jobs.get(job.jobId).status,'running','the agent keeps working');
  const other=engine.newTask({prompt:'让 codex 看下',cloudConsent:true});other.status='running';store.transaction(s=>{s.tasks.push(other);});
  const second=jobs.start({taskId:other.id,agent:'codex',bin:slow,prompt:'p',cwd:home,mode:'read'});
  await engine.stop(other.id);assert.equal(jobs.jobs.get(second.jobId).status,'cancelled','the user\'s stop ends it');
  jobs.cancelTask(task.id);
});

test('a member working on a hand-off from the user\'s own request can call the local agents; routine and event chains cannot',async t=>{
  const {Store}=await import('../src/core/store.mjs');const {toolsForTask}=await import('../src/tools/broker.mjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-agent-child-'));const store=new Store(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const names=task=>toolsForTask(task,{store}).map(x=>x.name);
  const root={id:'root',source:'user',status:'waiting_children',messages:[{id:'m',role:'user',content:'让群里资料助理用 Codex 算一下文件哈希'}]};
  const child={id:'child',source:'delegation',parentId:'root',depth:1,status:'running',messages:[{id:'c',role:'user',content:'用 Codex 算 approval.txt 的哈希'}]};
  const routine={id:'r',source:'routine',status:'running',messages:[]},routineChild={...child,id:'rc',parentId:'r'};
  store.transaction(s=>{s.tasks.push(root,child,routine,routineChild);});
  for(const n of ['local_agents','agent_run','agent_wait'])assert.ok(names(child).includes(n),n);
  assert.equal(names(routineChild).includes('agent_run'),false,'a scheduled chain keeps its own narrower tool set');
});
