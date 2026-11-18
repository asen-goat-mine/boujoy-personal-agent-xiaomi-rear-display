import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
import {once} from 'node:events';
import {randomBytes,randomUUID} from 'node:crypto';
import {RelayClient} from '../src/remote/transport.mjs';
import {hash} from '../src/remote/protocol.mjs';
import {eventually} from './helpers/remote-tls.mjs';
import {createHash} from 'node:crypto';
import {packageRelay,relayPackageFiles} from '../scripts/package-relay.mjs';

function fixture(t){const source=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-relay-package-test-'));t.after(()=>fs.rmSync(source,{recursive:true,force:true}));for(const name of relayPackageFiles){const file=path.join(source,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture '+name);}return source;}
function portableArchive(archive){return JSON.parse(execFileSync('python3',['-c',`
import tarfile, json, hashlib, sys
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    members = archive.getmembers()
    rows = [{'name': item.name, 'regular': item.isfile(), 'paxKeys': list(item.pax_headers),
             'sha256': hashlib.sha256(archive.extractfile(item).read()).hexdigest() if item.isfile() else None}
            for item in members]
    manifest = json.load(archive.extractfile('manifest.json'))
    print(json.dumps({'members': rows, 'manifest': manifest}))
`,archive],{encoding:'utf8'}));}
function assertPortableAllowlist(archive){
 const contents=portableArchive(archive);assert.deepEqual(contents.members.map(m=>m.name).sort(),[...relayPackageFiles,'manifest.json'].sort());
 assert(contents.members.every(m=>m.regular&&m.paxKeys.length===0));assert.equal(contents.manifest.files.length,relayPackageFiles.length);
 for(const entry of contents.manifest.files)assert.equal(contents.members.find(m=>m.name===entry.path)?.sha256,entry.sha256);
 return contents;
}
test('relay package only includes fresh allowlisted files even when an old dist directory contains credentials',t=>{
 const source=fixture(t),stale=path.join(source,'dist/relay');fs.mkdirSync(stale,{recursive:true});fs.writeFileSync(path.join(stale,'private-token'),'synthetic-secret');fs.symlinkSync('/etc/hosts',path.join(stale,'outside'));
 const result=packageRelay({source});assert.equal(result.containsCredentials,false);assertPortableAllowlist(result.archive);
 const extracted=path.join(source,'inspect');fs.mkdirSync(extracted);execFileSync('/usr/bin/tar',['-xzf',result.archive,'-C',extracted]);const manifest=JSON.parse(fs.readFileSync(path.join(extracted,'manifest.json')));for(const entry of manifest.files)assert.equal(createHash('sha256').update(fs.readFileSync(path.join(extracted,entry.path))).digest('hex'),entry.sha256);assert.equal(fs.readFileSync(path.join(stale,'private-token'),'utf8'),'synthetic-secret');assert.equal(fs.statSync(path.join(extracted,'deploy/relay/start.sh')).mode&0o777,0o755);
});
test('portable reader sees no AppleDouble or xattr metadata and packaging does not modify source attributes',t=>{
 const source=fixture(t),file=path.join(source,'src/remote/relay.mjs');
 // This synthetic private attribute is never a release member. Exercise the
 // native filesystem metadata path, not the AppleDouble-hiding tar listing.
 const attribute=process.platform==='darwin'?'com.boujoy.package-fixture':'user.boujoy-package-fixture';
 if(process.platform==='darwin')execFileSync('/usr/bin/xattr',['-w',attribute,'synthetic-local-only-attribute',file]);
 else execFileSync('python3',['-c','import os,sys; os.setxattr(sys.argv[1], sys.argv[2], b"synthetic-local-only-attribute")',file,attribute]);
 const result=packageRelay({source});assertPortableAllowlist(result.archive);
 const actual=process.platform==='darwin'?execFileSync('/usr/bin/xattr',['-p',attribute,file],{encoding:'utf8'}).trim():execFileSync('python3',['-c','import os,sys; sys.stdout.buffer.write(os.getxattr(sys.argv[1], sys.argv[2]))',file,attribute],{encoding:'utf8'});
 assert.equal(actual,'synthetic-local-only-attribute');
});
test('relay package rejects linked source files and leaves an earlier archive intact on failure',t=>{
 const source=fixture(t),result=packageRelay({source}),before=fs.readFileSync(result.archive),file=path.join(source,relayPackageFiles[0]);fs.unlinkSync(file);fs.symlinkSync('/etc/hosts',file);assert.throws(()=>packageRelay({source}),/symlinks/);assert.deepEqual(fs.readFileSync(result.archive),before);assert.deepEqual(fs.readdirSync(path.dirname(result.archive)),['Boujoy-Encrypted-Relay.tar.gz']);
});

test('packaged production entrypoint relays all four v1 stream kinds using its isolated locked dependency',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-relay-artifact-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=fileURLToPath(new URL('..',import.meta.url)),archive=packageRelay({source,output:path.join(root,'relay.tar.gz')}),unpacked=path.join(root,'unpacked');assertPortableAllowlist(archive.archive);fs.mkdirSync(unpacked);execFileSync('/usr/bin/tar',['-xzf',archive.archive,'-C',unpacked]);
 // Copy the already-installed exact lockfile version into this isolated package.
 // No symlink, package install, production route, or runtime credential is used.
 const require=createRequire(import.meta.url),wsRoot=path.dirname(require.resolve('ws/package.json')),lock=JSON.parse(fs.readFileSync(path.join(unpacked,'deploy/relay/package-lock.json'))),version=JSON.parse(fs.readFileSync(path.join(wsRoot,'package.json'))).version;
 assert.equal(version,lock.packages['node_modules/ws'].version);fs.cpSync(wsRoot,path.join(unpacked,'node_modules/ws'),{recursive:true});
 const manifest=JSON.parse(fs.readFileSync(path.join(unpacked,'manifest.json')));for(const item of manifest.files)assert.equal(item.sha256,createHash('sha256').update(fs.readFileSync(path.join(source,item.path))).digest('hex'));
 const deviceId=randomUUID(),macToken=randomBytes(32).toString('hex'),androidToken=randomBytes(32).toString('hex'),routes=path.join(root,'routes.json');fs.writeFileSync(routes,JSON.stringify({[deviceId]:{macTokenHash:hash(macToken),androidTokenHash:hash(androidToken)}}),{mode:0o600});
 const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const child=spawn(process.execPath,[path.join(unpacked,'scripts/run-relay.mjs')],{cwd:unpacked,env:{PATH:'',BOUJOY_RELAY_ROUTES:routes,BOUJOY_RELAY_HOST:'127.0.0.1',PORT:String(port)},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);await once(child,'exit');clearTimeout(timer);}});
 await eventually(()=>log.includes('encrypted relay listening'));assert.equal((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).ok,true);
 const clients=[],payload='opaque-tls-payload-fixture',received=[];
 for(const lane of ['data','control'])for(const role of ['mac','android']){const client=new RelayClient({url:`ws://127.0.0.1:${port}/v1/tunnel`,deviceId,routeToken:role==='mac'?macToken:androidToken,role,lane,allowLoopback:true,reconnect:false,onStream:stream=>{stream.on('data',bytes=>received.push({lane,role,kind:stream.kind,text:bytes.toString()}));return true;}});clients.push(client);client.start();}
 t.after(()=>clients.forEach(client=>client.close()));await eventually(()=>clients.every(c=>c.peerOnline));
 for(const [role,lane,kind] of [['android','data','chat'],['android','control','chat-control'],['mac','data','phone-data'],['mac','control','phone-control']]){const stream=clients.find(c=>c.role===role&&c.lane===lane).open(kind,7);await stream.ready;stream.write(Buffer.from(payload+' '+kind));}
 await eventually(()=>received.length===4);assert.deepEqual(received.map(x=>x.kind).sort(),['chat','chat-control','phone-control','phone-data']);assert(received.every(x=>x.text===payload+' '+x.kind));assert.equal(log.includes(payload),false);assert.equal(log.includes(macToken),false);assert.equal(log.includes(androidToken),false);
 const dead=clients.find(c=>c.role==='mac'&&c.lane==='data');dead.close();await eventually(()=>!clients.find(c=>c.role==='android'&&c.lane==='data').peerOnline);assert.equal(clients.find(c=>c.role==='android'&&c.lane==='control').peerOnline,true);
});
