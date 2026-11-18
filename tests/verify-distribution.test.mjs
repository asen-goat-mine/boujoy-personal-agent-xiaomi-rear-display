import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {verifyDistribution} from '../scripts/verify-distribution.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function fixture(t,{seal=true,portable=false}={}){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-release-verify-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=portable?path.join(base,'backend'):base;
  for(const name of ['src','web','config'])fs.mkdirSync(path.join(root,name),{recursive:true});
  fs.copyFileSync(path.join(ROOT,'src/distribution.mjs'),path.join(root,'src/distribution.mjs'));
  const distribution=JSON.parse(fs.readFileSync(path.join(ROOT,'distribution.json'),'utf8'));
  fs.writeFileSync(path.join(root,'distribution.json'),JSON.stringify(distribution));
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:distribution.desktopVersion,type:'module'}));
  fs.writeFileSync(path.join(root,'package-lock.json'),'{}');
  fs.writeFileSync(path.join(root,'web/index.html'),'<p>Fixture</p>');
  fs.writeFileSync(path.join(root,'config/default.json'),'{}');
  const module=await import(pathToFileURL(path.join(root,'src/distribution.mjs')).href);
  if(seal)fs.writeFileSync(path.join(root,'runtime-manifest.json'),JSON.stringify(module.runtimeSourceManifest(root)));
  if(portable)fs.writeFileSync(path.join(base,'runtime.json'),JSON.stringify({portable:true,distribution,expectedIdentity:module.BUILD_IDENTITY}));
  return {root,distribution,identity:module.BUILD_IDENTITY};
}
async function server(t,identity,{cookie=true,status=200,redirect=false}={}){
  const seen=[];
  const srv=http.createServer((req,res)=>{
    seen.push({url:req.url,cookie:req.headers.cookie});
    if(redirect){res.writeHead(302,{Location:'https://example.invalid/should-not-be-requested'});return res.end();}
    if(req.url==='/api/session'){
      if(cookie)res.setHeader('Set-Cookie','boujoy_session='+ 'a'.repeat(64)+'; HttpOnly; SameSite=Strict; Path=/');
      return res.end(JSON.stringify({csrf:'never-log-this-csrf'}));
    }
    if(req.url==='/api/health'){
      if(req.headers.cookie!=='boujoy_session='+ 'a'.repeat(64))res.statusCode=401;
      else res.statusCode=status;
      return res.end(JSON.stringify({buildIdentity:identity,memory:{directory:'/private/recipient-private-vault'},credentials:{secret:'never-log-this-secret'}}));
    }
    res.statusCode=404;res.end();
  });
  await new Promise((resolve,reject)=>{srv.once('error',reject);srv.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>{srv.closeAllConnections();srv.close(resolve);}));
  return {origin:`http://127.0.0.1:${srv.address().port}`,seen};
}
test('missing release manifest is explicitly unsealed, CLI exits 2',async t=>{
  const {root}=await fixture(t,{seal:false});
  const result=await verifyDistribution({root});assert.equal(result.ok,false);assert.equal(result.status,'unsealed');
  const cli=spawnSync(process.execPath,[path.join(ROOT,'scripts/verify-distribution.mjs'),'--root',root,'--json'],{encoding:'utf8'});
  assert.equal(cli.status,2);assert.equal(JSON.parse(cli.stdout).status,'unsealed');
});
test('sealed runtime matches the canonical runtimeSourceManifest and portable identity',async t=>{
  const {root,identity}=await fixture(t,{portable:true});
  const result=await verifyDistribution({root});assert.equal(result.status,'sealed');assert.deepEqual(result.buildIdentity,identity);assert.equal(result.runningVerified,false);
});
test('modified, added, deleted and symlinked source cannot pass the release manifest',async t=>{
  for(const kind of ['modified','added','deleted','symlinked'])await t.test(kind,async t=>{
    const {root}=await fixture(t),file=path.join(root,'web/index.html');
    if(kind==='modified')fs.writeFileSync(file,'modified');
    if(kind==='added')fs.writeFileSync(path.join(root,'web/new.txt'),'new');
    if(kind==='deleted')fs.unlinkSync(file);
    if(kind==='symlinked'){fs.unlinkSync(file);fs.symlinkSync('../package.json',file);}
    await assert.rejects(verifyDistribution({root}),e=>e.code==='source_mismatch');
  });
});
test('portable runtime expected identity cannot select another edition',async t=>{
  const {root}=await fixture(t,{portable:true});const file=path.join(root,'..','runtime.json');
  const runtime=JSON.parse(fs.readFileSync(file,'utf8'));runtime.expectedIdentity.sourceDigest='0'.repeat(64);fs.writeFileSync(file,JSON.stringify(runtime));
  await assert.rejects(verifyDistribution({root}),e=>e.code==='identity_mismatch');
});
test('running verification authenticates health and only returns public build identity',async t=>{
  const {root,identity}=await fixture(t),srv=await server(t,identity);
  const result=await verifyDistribution({root,running:true,origin:srv.origin});
  assert.equal(result.status,'running_verified');assert.deepEqual(result.buildIdentity,identity);
  assert.deepEqual(srv.seen.map(x=>x.url),['/api/session','/api/health']);
  assert.equal(srv.seen[0].cookie,undefined);assert.equal(srv.seen[1].cookie,'boujoy_session='+ 'a'.repeat(64));
  assert.doesNotMatch(JSON.stringify(result),/recipient-private|never-log|csrf|cookie|credentials/);
});
test('old or wrong edition process is rejected without mutating endpoints',async t=>{
  for(const field of ['edition','version','sourceDigest','androidApplicationId','androidVersion','androidVersionCode'])await t.test(field,async t=>{
    const {root,identity}=await fixture(t),wrong={...identity};
    if(field==='edition'){wrong.edition=identity.edition==='phoneuse'?'xiaomi':'phoneuse';wrong.androidApplicationId=`dev.boujoy.${wrong.edition}`;}
    else wrong[field]=field==='sourceDigest'?'0'.repeat(64):field==='androidApplicationId'?'dev.boujoy.other':field==='androidVersionCode'?identity.androidVersionCode+1:'99.0.0';
    const srv=await server(t,wrong);await assert.rejects(verifyDistribution({root,running:true,origin:srv.origin}),e=>['identity_mismatch','invalid_identity'].includes(e.code));
    assert.deepEqual(srv.seen.map(x=>x.url),['/api/session','/api/health']);
  });
});
test('missing auth cookie and rejected authenticated health do not pass',async t=>{
  const {root,identity}=await fixture(t);
  const noCookie=await server(t,identity,{cookie:false});
  await assert.rejects(verifyDistribution({root,running:true,origin:noCookie.origin}),e=>e.code==='session_failed');
  assert.equal(noCookie.seen.length,1);
  const rejected=await server(t,identity,{status:401});
  await assert.rejects(verifyDistribution({root,running:true,origin:rejected.origin}),e=>e.code==='health_failed');
});
test('verification refuses non-loopback origins and redirects',async t=>{
  const {root,identity}=await fixture(t);let fetched=false;
  await assert.rejects(verifyDistribution({root,running:true,origin:'https://example.invalid',fetchImpl:()=>{fetched=true;}}),e=>e.code==='invalid_origin');
  assert.equal(fetched,false);
  const srv=await server(t,identity,{redirect:true});
  await assert.rejects(verifyDistribution({root,running:true,origin:srv.origin}),e=>e.code==='service_unavailable');assert.equal(srv.seen.length,1);
});
test('CLI errors do not reveal malformed manifest content or local paths',async t=>{
  const {root}=await fixture(t);fs.writeFileSync(path.join(root,'runtime-manifest.json'),'recipient-secret-invalid-json');
  const cli=spawnSync(process.execPath,[path.join(ROOT,'scripts/verify-distribution.mjs'),'--root',root,'--json'],{encoding:'utf8'});
  assert.equal(cli.status,1);const output=cli.stdout+cli.stderr;assert.doesNotMatch(output,/recipient-secret|boujoy-release-verify-/);assert.equal(JSON.parse(cli.stderr).code,'manifest_invalid');
});
