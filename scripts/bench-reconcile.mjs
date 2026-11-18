// Isolated predicate benchmark (Node 24+); no server, device or user data.
// Usage: node scripts/bench-reconcile.mjs /path/to/unmodified/1.0.52/repo
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';

if(!process.argv[2])throw Error('Pass the root of the unmodified 1.0.52 repo');
const urls=[pathToFileURL(resolve(process.argv[2],'src/remote/gateway.mjs')).href,new URL('../src/remote/gateway.mjs',import.meta.url).href];
if(urls[0]===urls[1])throw Error('Pass a separate baseline checkout');
// Expose the actual private predicate only inside this benchmark process.
const hooks=registerHooks({load(url,context,next){const result=next(url,context);return urls.includes(url)?{...result,source:Buffer.from(result.source).toString()+'\nexport {canReconcile as benchReconcile};'}:result;}});
const fns=await Promise.all(urls.map(async url=>(await import(url)).benchReconcile));hooks.deregister();
for(const [taskCount,actionCount] of [[5,100],[150,3000],[250,10000]]){
 const tasks=Array.from({length:taskCount},(_,i)=>({id:'t'+i,status:i%31===0?'unknown_result':'completed'}));
 const actions=Array.from({length:actionCount},(_,i)=>({taskId:tasks[i%taskCount].id,status:i%31===0?'unknown':'completed',tool:'phone_open_app',nativeRequestId:'r'+i,nativeDeviceId:'synthetic'}));
 const store={data:{actions}},run=fn=>tasks.map(task=>fn(task,store));
 assert.deepEqual(run(fns[0]),run(fns[1]));
 const times=[[],[]];
 for(let n=0;n<130;n++)for(const which of n%2?[1,0]:[0,1]){const start=performance.now();run(fns[which]);if(n>=30)times[which].push(performance.now()-start);}
 const [baseline,candidate]=times.map(values=>{values.sort((a,b)=>a-b);return {p50_ms:+values[49].toFixed(4),p95_ms:+values[94].toFixed(4)};});
 console.log(JSON.stringify({tasks:taskCount,actions:actionCount,unknownTasks:tasks.filter(t=>t.status==='unknown_result').length,samples:100,baseline,candidate}));
}
