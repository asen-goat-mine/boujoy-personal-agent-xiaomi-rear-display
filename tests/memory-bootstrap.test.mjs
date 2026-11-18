import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {PersonalMemory} from '../src/adapters/memory.mjs';
import {DISTRIBUTION} from '../src/distribution.mjs';

function fixture(t){
  const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-memory-bootstrap-')));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=path.join(base,'new-documents','memory');
  return {base,root,memory:new PersonalMemory({root,runtime:path.join(base,'runtime')})};
}

test('source startup creates a private empty vault and supports the complete Markdown proposal lifecycle',async t=>{
  const {root,memory}=fixture(t);
  assert.equal((await memory.health()).connected,false);
  await memory.start();
  const health=await memory.health();
  assert.equal(health.connected,true);assert.equal(health.cards,0);assert.equal(health.pending,0);
  assert.equal(fs.statSync(root).mode&0o777,0o700);
  assert.equal(fs.statSync(path.join(root,'00-System/Memory-Protocol.md')).mode&0o777,0o600);
  for(const kind of ['preference','workflow','platform','episode','routine']){
    const proposal=await memory.propose({conceptKey:'synthetic.'+kind,kind,title:'合成测试',summary:'仅用于空白记忆库测试。',appliesTo:'本机隔离夹具',...(kind==='episode'?{expiresAt:new Date(Date.now()+86400000).toISOString()}:{})},{taskId:'synthetic',evidenceRefs:['message']});
    const pending=memory.proposals().find(p=>p.id===proposal.id);
    const result=await memory.review(proposal.id,{decision:'accept',expectedHash:pending.hash});
    assert.ok(fs.existsSync(path.join(root,result.path)));
  }
  assert.equal((await memory.health()).cards,5);assert.equal(memory.proposals().length,0);
  const protocol=fs.readFileSync(path.join(root,'00-System/Memory-Protocol.md'),'utf8');
  await memory.start();
  assert.equal(fs.readFileSync(path.join(root,'00-System/Memory-Protocol.md'),'utf8'),protocol);
  assert.equal((await memory.health()).cards,5);
});

test('source startup preserves and rejects pre-existing empty or unrelated directories',async t=>{
  const {root,memory}=fixture(t);fs.mkdirSync(root,{recursive:true});
  await assert.rejects(memory.start());assert.deepEqual(fs.readdirSync(root),[]);
  fs.writeFileSync(path.join(root,'user-notes.md'),'recipient content');
  await assert.rejects(memory.start());
  assert.deepEqual(fs.readdirSync(root),['user-notes.md']);
  assert.equal(fs.readFileSync(path.join(root,'user-notes.md'),'utf8'),'recipient content');
});

test('source startup does not overwrite an incompatible protocol',async t=>{
  const {root,memory}=fixture(t);fs.mkdirSync(path.join(root,'00-System'),{recursive:true});
  const file=path.join(root,'00-System/Memory-Protocol.md');fs.writeFileSync(file,'# User protocol\n');
  await assert.rejects(memory.start(),{code:'memory_protocol'});
  assert.equal(fs.readFileSync(file,'utf8'),'# User protocol\n');
  assert.deepEqual(fs.readdirSync(root),['00-System']);
});

test('source startup refuses linked ancestors and dangling roots without writing through them',async t=>{
  const {base}=fixture(t),outside=path.join(base,'outside');fs.mkdirSync(outside);
  const linked=path.join(base,'linked');fs.symlinkSync(outside,linked);
  const memory=new PersonalMemory({root:path.join(linked,'new-memory'),runtime:path.join(base,'runtime')});
  await assert.rejects(memory.start());assert.deepEqual(fs.readdirSync(outside),[]);
  const dangling=path.join(base,'dangling');fs.symlinkSync(path.join(base,'missing-target'),dangling);
  await assert.rejects(new PersonalMemory({root:dangling,runtime:path.join(base,'runtime')}).start());
  assert.equal(fs.existsSync(path.join(base,'missing-target')),false);
});

test('source HTTP startup reports the newly initialized vault without connecting to the running service',async t=>{
  const {base,root}=fixture(t);
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));
  const port=socket.address().port;await new Promise(r=>socket.close(r));
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,BOUJOY_PORT:String(port),BOUJOY_DATA:path.join(base,'app-state'),BOUJOY_MEMORY_VAULT:root},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  t.after(async()=>{if(child.exitCode!==null)return;child.kill('SIGTERM');await new Promise(r=>{child.once('exit',r);setTimeout(()=>{child.kill('SIGKILL');r();},2000).unref();});});
  const origin=`http://127.0.0.1:${port}`;
  let health,cookie,lastStatus;
  for(let n=0;n<150;n++){
    try {
      if(!cookie){const session=await fetch(origin+'/api/session');if(session.ok)cookie=session.headers.get('set-cookie')?.split(';')[0];}
      if(cookie){const response=await fetch(origin+'/api/health',{headers:{Cookie:cookie}});lastStatus=response.status;if(response.ok){health=await response.json();if(health.memory?.connected)break;}}
    } catch {}
    if(child.exitCode!==null)break;
    await new Promise(r=>setTimeout(r,50));
  }
  assert.ok(cookie,'The isolated service did not issue a session cookie. '+output);
  assert.equal(lastStatus,200,output);
  assert.equal(health?.version,DISTRIBUTION.desktopVersion,output);
  assert.equal(health.buildIdentity.edition,DISTRIBUTION.edition);
  assert.equal(health.buildIdentity.androidApplicationId,DISTRIBUTION.androidApplicationId);
  assert.equal(health.memory.connected,true,JSON.stringify(health));
  assert.equal(health.memory.root,root);assert.equal(health.memory.cards,0);assert.equal(health.memory.pending,0);
});
