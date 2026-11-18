import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {startSuccessor,successorCommand,supervised,SERVICE_LABEL} from '../src/core/respawn.mjs';

test('under launchd the service leaves restarting to launchd; otherwise it starts its own successor',()=>{
  const calls=[];const spawnImpl=(...args)=>{calls.push(args);return {unref(){}};};
  assert.equal(supervised({XPC_SERVICE_NAME:SERVICE_LABEL}),true);assert.equal(supervised({XPC_SERVICE_NAME:'0'}),false);assert.equal(supervised({XPC_SERVICE_NAME:'dev.boujoy.personal-agent'}),false);
  assert.equal(startSuccessor('/x/server.mjs',{env:{XPC_SERVICE_NAME:SERVICE_LABEL},spawnImpl}),false);assert.equal(calls.length,0);
  assert.equal(startSuccessor('/x/server.mjs',{env:{},cwd:'/tmp',spawnImpl}),true);
  assert.equal(calls[0][0],process.execPath);assert.equal(calls[0][2].detached,true);assert.equal(calls[0][2].stdio,'ignore');assert.match(calls[0][1][1],/file:\/\/\/x\/server\.mjs/);
});
test('the successor command really loads the given file, paths with spaces and quotes included',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"boujoy res'pawn "));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'server.mjs'),mark=path.join(dir,'started');fs.writeFileSync(file,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(mark)},'ok');`);
  const result=spawnSync(process.execPath,successorCommand(file,{delayMs:10}),{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(fs.readFileSync(mark,'utf8'),'ok');
});
