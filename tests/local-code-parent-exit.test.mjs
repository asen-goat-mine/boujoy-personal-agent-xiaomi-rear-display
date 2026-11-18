import test from 'node:test';
import {NEEDS_SANDBOX_PYTHON} from './helpers/requirements.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
function processes(){return execFileSync('/bin/ps',['-axo','pid=,ppid=,stat='],{encoding:'utf8'}).trim().split('\n').map(line=>{const [pid,parent,status]=line.trim().split(/\s+/);return {pid:Number(pid),parent:Number(parent),status};});}
function alive(pid){const row=processes().find(row=>row.pid===pid);return !!row&&!row.status.startsWith('Z');}

test('a real sandbox worker exits promptly when its isolated Node owner dies, independently of generated code', {skip:NEEDS_SANDBOX_PYTHON,timeout:15000},async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'boujoy-code-parent-exit-'));await fs.mkdir(path.join(dataDir,'artifacts'));
 const project=fileURLToPath(new URL('..',import.meta.url)),owned=new Set();let owner,ownerClosed,workerPid,stderr='';
 try{
  // This generated program only records its own PID in a declared disposable
  // output, then sleeps. A CPU limit alone cannot stop it at the wall deadline.
  const code='import os,json,time\nwith open(OUTPUTS["pid.json"],"w") as f:\n json.dump({"pid":os.getpid()},f); f.flush()\ntime.sleep(30)';
  const source=`import {runLocalPython} from './src/tools/local-code.mjs';import {createTaskContract,initializeTimeline} from './src/core/task-contract.mjs';const prompt='用 Python 分析附件数据，计算平均数并生成 CSV 文件',task={id:'parent-exit-fixture',source:'user',prompt,messages:[{id:'u1',role:'user',content:prompt}],cloudConsent:true,status:'running'};initializeTimeline(task,{budgetMs:60000});task.taskContract=createTaskContract(task);await runLocalPython({task,store:{data:{artifacts:[]},task:()=>task},dataDir:process.argv[1],args:{code:${JSON.stringify(code)},outputNames:['pid.json']}});`;
  owner=spawn(process.execPath,['--input-type=module','-e',source,dataDir],{cwd:project,stdio:['ignore','ignore','pipe']});owned.add(owner.pid);ownerClosed=new Promise(resolve=>owner.once('close',resolve));owner.stderr.on('data',chunk=>stderr=(stderr+chunk.toString()).slice(-2000));
  const readyBy=Date.now()+6000;
  while(!workerPid&&Date.now()<readyBy){
   try{for(const entry of await fs.readdir(path.join(dataDir,'code-runs'))){const value=JSON.parse(await fs.readFile(path.join(dataDir,'code-runs',entry,'output-0'),'utf8'));if(Number.isInteger(value.pid))workerPid=value.pid;}}catch{}
   if(!workerPid)await sleep(30);
  }
  assert(workerPid,'The isolated worker did not start: '+stderr);
  // Record only this fixture's process tree, so every failure can clean up exact
  // PIDs and never use pkill/killall or touch the running application.
  const rows=processes();let cursor=workerPid;while(cursor!==owner.pid){assert(Number.isInteger(cursor)&&cursor>1,'Worker is not a descendant of the fixture owner');owned.add(cursor);cursor=rows.find(row=>row.pid===cursor)?.parent;}
  assert(alive(workerPid));const killedAt=Date.now();owner.kill('SIGKILL');await ownerClosed;
  while(alive(workerPid)&&Date.now()-killedAt<2500)await sleep(30);
  assert.equal(alive(workerPid),false,'Node died but the sandbox worker kept running without its external timeout and RSS supervisor');
  // The trusted supervisor must also finish; reparented zombies are not running.
  while([...owned].some(alive)&&Date.now()-killedAt<3500)await sleep(30);
  assert([...owned].every(pid=>!alive(pid)),'The isolated supervisor did not clean up after its Node owner exited');
  assert.deepEqual(await fs.readdir(path.join(dataDir,'code-runs')),[],'Host death must not leave decrypted task inputs or incomplete output scratch files');
  assert.deepEqual(await fs.readdir(path.join(dataDir,'artifacts')),[]);
 }finally{
  if(owner?.pid&&alive(owner.pid)){const rows=processes(),currentTree=new Set([owner.pid]);for(let i=0;i<10;i++){let changed=false;for(const row of rows)if(currentTree.has(row.parent)&&!currentTree.has(row.pid)){currentTree.add(row.pid);owned.add(row.pid);changed=true;}if(!changed)break;}}
  for(const pid of [...owned].reverse())if(Number.isInteger(pid)&&pid>1)try{process.kill(pid,'SIGKILL');}catch{}
  if(ownerClosed)await ownerClosed;
  await fs.rm(dataDir,{recursive:true,force:true});
 }
});
