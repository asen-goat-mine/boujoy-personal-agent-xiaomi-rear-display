import test from 'node:test';
import {NEEDS_VOICE,VOICE_PYTHON} from './helpers/requirements.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const python=VOICE_PYTHON?fs.realpathSync(VOICE_PYTHON):null;
test('voice lifecycle owner reaps a real running child and removes scratch after host pipe closes',{skip:NEEDS_VOICE},async t=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-voice-life-')),root=path.join(parent,'voice-work','test');fs.mkdirSync(root,{recursive:true});t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const script=path.join(root,'fixture.py');fs.writeFileSync(script,'import os,time\nwith open("worker.pid.tmp","w") as f: f.write(str(os.getpid()))\nos.replace("worker.pid.tmp","worker.pid")\nwhile True: time.sleep(1)\n');
 const supervisor=spawn(python,['-I','-S',path.resolve('src/adapters/voice-supervisor.py')],{cwd:root,stdio:['pipe','pipe','pipe','pipe']});let stderr='';supervisor.stderr.on('data',b=>stderr+=b);supervisor.stdin.end(JSON.stringify({executable:python,args:['-I','-S',script],input:'',sandbox:'(version 1)(allow default)(deny network*)',timeout:60000,maxBytes:1024}));
 const pidfile=path.join(root,'worker.pid');for(let n=0;n<100&&!fs.existsSync(pidfile);n++){assert.equal(supervisor.exitCode,null,stderr);await new Promise(r=>setTimeout(r,20));}assert.ok(fs.existsSync(pidfile),stderr);const pid=Number(fs.readFileSync(pidfile));assert.ok(Number.isSafeInteger(pid)&&pid>1,'readiness must identify the actual worker, never process group zero');
 const exit=once(supervisor,'exit');supervisor.stdio[3].end();await exit;assert.equal(supervisor.exitCode,130);assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');assert.equal(fs.existsSync(root),false);
});
