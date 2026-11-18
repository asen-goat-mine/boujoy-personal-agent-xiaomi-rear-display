import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { LineRPC } from '../src/adapters/rpc.mjs';

function child(t,script){
  const rpc=new LineRPC(process.execPath,['--input-type=module','--eval',script]);
  t.after(()=>rpc.close());
  return rpc;
}
const silent="setInterval(()=>{},1000);";
const closedInput=`import fs from 'node:fs';
fs.closeSync(0);
process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'ready'})+'\\n');
setInterval(()=>{},1000);`;

test('LineRPC preserves request responses, error responses and notifications',{timeout:5000},async t=>{
  const rpc=child(t,`import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.id===undefined){process.stdout.write(JSON.stringify({method:'seen',params:m.params})+'\\n');return;}
 process.stdout.write(JSON.stringify(m.method==='error'?{id:m.id,error:{message:'fixture error'}}:{id:m.id,result:m.params})+'\\n');
});`);
  assert.deepEqual(await rpc.request('echo',{value:42}),{value:42});
  await assert.rejects(rpc.request('error'),e=>e.code==='rpc_error'&&e.message==='fixture error');
  const seen=once(rpc,'notification');rpc.notify('fixture',{value:'notification'});
  assert.equal((await seen)[0].params.value,'notification');
  assert.equal(rpc.dead,false);assert.equal(rpc.pending.size,0);
});

test('close rejects pending work immediately and dispose cannot write to the dying child',{timeout:5000},async t=>{
  const rpc=child(t,silent);
  let closed=0,kills=0,writes=0;
  rpc.on('closed',()=>closed++);
  const kill=rpc.child.kill.bind(rpc.child);rpc.child.kill=(signal)=>{kills++;return kill(signal);};
  const write=rpc.child.stdin.write.bind(rpc.child.stdin);rpc.child.stdin.write=(...args)=>{writes++;return write(...args);};
  const pending=rpc.request('session/wait',{},60000);
  const rejected=assert.rejects(pending,e=>e.code==='runtime_exited');
  rpc.close();
  assert.equal(rpc.dead,true);assert.equal(rpc.pending.size,0);assert.equal(closed,1);
  const killTimer=rpc.killTimer;rpc.close();assert.equal(rpc.killTimer,killTimer);assert.equal(kills,1);
  await rejected;
  await assert.rejects(rpc.request('shutdown'),e=>e.code==='runtime_exited');
  rpc.notify('shutdown');assert.equal(writes,1);
});

test('a real broken stdin pipe rejects pending requests without an unhandled EPIPE',{timeout:5000},async t=>{
  const rpc=child(t,closedInput);
  await once(rpc,'notification');
  await assert.rejects(rpc.request('echo',{payload:'x'.repeat(1024*1024)},60000),e=>e.code==='EPIPE');
  assert.equal(rpc.dead,true);assert.equal(rpc.pending.size,0);
  await assert.rejects(rpc.request('shutdown'),e=>e.code==='runtime_exited');
});

test('notification writes also handle a real broken stdin pipe',{timeout:5000},async t=>{
  const rpc=child(t,closedInput);
  await once(rpc,'notification');
  const closed=once(rpc,'closed');
  rpc.notify('fixture',{payload:'x'.repeat(1024*1024)});
  await closed;
  assert.equal(rpc.dead,true);assert.equal(rpc.pending.size,0);
});

test('unlimited session wait has no timer and still cancels when runtime closes',async t=>{const rpc=child(t,silent);const pending=rpc.request('session/wait',{},Infinity);assert.equal([...rpc.pending.values()][0].timer,null);const rejected=assert.rejects(pending,{code:'runtime_exited'});rpc.close();await rejected;});
