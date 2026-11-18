import test from 'node:test';
import assert from 'node:assert/strict';
import {HarnessRun} from '../src/adapters/harness.mjs';

const run=()=>new HarnessRun({task:{id:'t'},role:null,prompt:'p',toolNames:[],token:'x',origin:'http://127.0.0.1:1'});
function rpc(log,{hang=[]}={}){return {dead:false,closing:false,closed:false,request(method,params,timeout){log.push([method,params,timeout]);return hang.includes(method)?new Promise((_,reject)=>setTimeout(()=>reject(Error('timeout')),Math.min(timeout,30))):Promise.resolve({});},close(){this.closed=true;this.closing=true;}};}

test('steering is a session prompt, and only while a turn is being waited on',async()=>{
  const log=[],r=run();r.rpc=rpc(log);r.sessionId=r.sessionId||'s';
  assert.equal(await r.steer('补充'),false);assert.equal(log.length,0);
  r.waiting=true;assert.equal(await r.steer('补充'),true);
  assert.equal(log[0][0],'session/prompt');assert.deepEqual(log[0][1].contentBlocks,[{type:'text',text:'补充'}]);
  r.rpc.dead=true;assert.equal(await r.steer('补充'),false);
});

test('stopping asks the Harness to shut down, and closes the process even when it does not answer',async()=>{
  for(const hang of [[],['shutdown']]){
    const log=[],r=run();r.rpc=rpc(log,{hang});const handle=r.rpc;
    await r.stop();
    assert.equal(log[0][0],'shutdown');assert.equal(log[0][2],2000);assert.equal(handle.closed,true);assert.equal(r.cancelled,true);
  }
});
