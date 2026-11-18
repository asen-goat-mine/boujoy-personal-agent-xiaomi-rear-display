import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {probeService,assertBuildIdentity} from '../desktop/service-identity.cjs';
const expected={edition:'phoneuse',version:'0.4.16',sourceDigest:'a'.repeat(64),androidApplicationId:'dev.boujoy.phoneuse'};
async function server(t,{identity=expected,cookie=true,healthStatus=200}={}){
 const requests=[];const instance=http.createServer((req,res)=>{requests.push({url:req.url,cookie:req.headers.cookie});
  if(req.url==='/api/session'){if(cookie)res.setHeader('Set-Cookie',`boujoy_session=${'b'.repeat(64)}; HttpOnly; SameSite=Strict; Path=/`);res.setHeader('Content-Type','application/json');res.end('{"csrf":"synthetic"}');return;}
  if(req.url==='/api/health'){res.statusCode=req.headers.cookie===`boujoy_session=${'b'.repeat(64)}`?healthStatus:401;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({buildIdentity:identity}));return;}
  res.statusCode=404;res.end();
 });instance.listen(0,'127.0.0.1');await once(instance,'listening');t.after(()=>new Promise(resolve=>instance.close(resolve)));return {origin:`http://127.0.0.1:${instance.address().port}`,requests};
}
test('desktop probes real loopback session then authenticated health before accepting an exact build',async t=>{
 const s=await server(t);assert.equal(await probeService({...s,expectedIdentity:expected}),true);assert.deepEqual(s.requests.map(r=>r.url),['/api/session','/api/health']);assert.equal(s.requests[1].cookie,`boujoy_session=${'b'.repeat(64)}`);
});
test('a running wrong edition, stale version, stale source digest or Android identity is never reused',async t=>{
 for(const field of ['edition','version','sourceDigest','androidApplicationId']){
  const s=await server(t,{identity:{...expected,[field]:'different'}});await assert.rejects(probeService({...s,expectedIdentity:expected}),e=>e.code==='BOUJOY_BUILD_MISMATCH');
  assert.deepEqual(s.requests.map(r=>r.url),['/api/session','/api/health']);
 }
});
test('legacy health without build identity, absent session cookie and failed health fail closed',async t=>{
 for(const options of [{identity:null},{cookie:false},{healthStatus:401}]){const s=await server(t,options);await assert.rejects(probeService({...s,expectedIdentity:expected}));assert.ok(s.requests.every(r=>['/api/session','/api/health'].includes(r.url)));}
});
test('only a refused connection means no service; timeouts do not permit starting a second service',async()=>{
 const refused=Object.assign(new Error('connect'),{cause:{code:'ECONNREFUSED'}});assert.equal(await probeService({origin:'http://127.0.0.1:18891',expectedIdentity:expected,fetchImpl:async()=>{throw refused;}}),false);
 await assert.rejects(probeService({origin:'http://127.0.0.1:18891',expectedIdentity:expected,fetchImpl:async()=>{throw new DOMException('Timed out','TimeoutError');}}));
});
test('invalid expected release identity and non-loopback URLs are rejected before a request',async()=>{
 let called=0;const fetchImpl=async()=>{called++;throw Error('should not run');};
 for(const origin of ['https://example.com','http://127.0.0.1:18891/path','http://name@127.0.0.1:18891'])await assert.rejects(probeService({origin,expectedIdentity:expected,fetchImpl}));
 assert.throws(()=>assertBuildIdentity(expected,{...expected,sourceDigest:''}));assert.equal(called,0);
});
