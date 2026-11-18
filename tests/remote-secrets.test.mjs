import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createPrivateKey,createPublicKey} from 'node:crypto';
import {RemoteSecrets,ensureIdentity,validateIdentity,spkiPin} from '../src/remote/state.mjs';
import {identities} from './helpers/remote-tls.mjs';
import {KEYCHAIN_PREFIX,KEYCHAIN_ACCOUNT} from '../src/distribution.mjs';

// Fixed, public test seed: no real Keychain entry or production key is read.
const syntheticKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(Array.from({length:32},(_,i)=>i))]),format:'der',type:'pkcs8'}).export({format:'pem',type:'pkcs8'}).trim();
const hex=value=>Buffer.from(value,'utf8').toString('hex');
function reader(value){
 const calls=[];return {calls,secrets:new RemoteSecrets({exec:async(command,args,options)=>{
  calls.push({command,args,options});assert.equal(command,'/usr/bin/security');assert.equal(args[0],'find-generic-password');return {stdout:value};
 }})};
}

test('macOS hex-encoded multiline private PEM is recovered exactly with no Keychain write',async()=>{
 for(const value of [hex(syntheticKey)+'\n',hex(syntheticKey+'\n')+'\n',hex(syntheticKey).toUpperCase()+'\n',hex(syntheticKey.replaceAll('\n','\r\n'))+'\n']){
  const {secrets,calls}=reader(value),key=await secrets.get('private-key');assert.equal(key,value===hex(syntheticKey.replaceAll('\n','\r\n'))+'\n'?syntheticKey.replaceAll('\n','\r\n'):syntheticKey);
  assert.deepEqual(createPublicKey(createPrivateKey(key)).export({format:'der',type:'spki'}),createPublicKey(createPrivateKey(syntheticKey)).export({format:'der',type:'spki'}));
  assert.equal(await secrets.get('private-key'),key);assert.equal(calls.length,1);assert.equal(calls[0].args[calls[0].args.indexOf('-s')+1],KEYCHAIN_PREFIX+'.remote.private-key');
  assert.equal(calls[0].args[calls[0].args.indexOf('-a')+1],KEYCHAIN_ACCOUNT);
 }
});

test('normal PEM keeps its previous CLI newline normalization and route tokens are never hex-decoded',async()=>{
 const plain=reader(syntheticKey+'\n');assert.equal(await plain.secrets.get('private-key'),syntheticKey);
 const hexLookingToken=hex(syntheticKey);
 for(const name of ['mac-route','android-route']){
  for(const token of [hexLookingToken,'aB12'.repeat(16),'synthetic_route-token-With_MixedCase']){
   const {secrets}=reader(token+'\n');assert.equal(await secrets.get(name),token);
  }
 }
});

test('odd, malformed, nested, non-UTF8, non-private and invalid-key hex stay invalid rather than disappear',async()=>{
 const publicPem=createPublicKey(createPrivateKey(syntheticKey)).export({format:'pem',type:'spki'}).trim();
 const invalidPrivate='-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----';
 for(const value of ['a',hex(syntheticKey)+'0','0x'+hex(syntheticKey),hex('not a private key'),hex(publicPem),hex(invalidPrivate),'fffe'+hex(syntheticKey),hex(hex(syntheticKey)),hex(syntheticKey)+'zz']){
  const {secrets,calls}=reader(value+'\n');const result=await secrets.get('private-key');assert.equal(result,value);assert.throws(()=>createPrivateKey(result));assert.equal(calls.length,1);
 }
});

test('a new RemoteSecrets instance recovers the persisted hex value on cache miss without rewriting identity',async()=>{
 const persisted=new Map(),calls=[];
 const execute=async(command,args)=>{
  assert.equal(command,'/usr/bin/security');const name=args[args.indexOf('-s')+1];calls.push({operation:args[0],name});
  if(args[0]==='add-generic-password'){persisted.set(name,args[args.indexOf('-w')+1]);return {stdout:''};}
  assert.equal(args[0],'find-generic-password');const value=persisted.get(name);return {stdout:(name.endsWith('.private-key')?hex(value):value)+'\n'};
 };
 const first=new RemoteSecrets({exec:execute});await first.set('private-key',syntheticKey);await first.set('mac-route','abcdef0123456789'.repeat(4));
 assert.equal(await first.get('private-key'),syntheticKey);assert.equal(calls.filter(call=>call.operation==='find-generic-password').length,0);
 const restarted=new RemoteSecrets({exec:execute});assert.equal(await restarted.get('private-key'),syntheticKey);assert.equal(await restarted.get('mac-route'),'abcdef0123456789'.repeat(4));
 assert.equal(calls.filter(call=>call.operation==='add-generic-password').length,2);assert.equal(calls.filter(call=>call.operation==='find-generic-password').length,2);
});

test('fresh-process read of hex RSA PEM validates the existing certificate without renewal or identity creation',async t=>{
 const identity=identities();t.after(()=>identity.cleanup());
 fs.mkdirSync(path.join(identity.dir,'remote'),{mode:0o700});const certFile=path.join(identity.dir,'remote/gateway.crt');fs.writeFileSync(certFile,identity.server.cert);
 let writes=0,signing=0,reads=0;
 const execute=async(_command,args)=>{if(args[0]!=='find-generic-password'){writes++;throw Error('Existing identity must not be rewritten');}reads++;return {stdout:hex(identity.server.key)+'\n'};};
 for(let restart=0;restart<2;restart++){
  const secrets=new RemoteSecrets({exec:execute});const result=await ensureIdentity(identity.dir,secrets,{canRenew:()=>false,runOpenSSL:async()=>{signing++;throw Error('Existing identity must not be regenerated');}});
  assert.equal(result.key,identity.server.key.toString('utf8').trim());assert.equal(result.cert,identity.server.cert.toString('utf8'));assert.equal(result.pin,spkiPin(identity.server.cert));assert.equal(validateIdentity(result.key,result.cert).pin,result.pin);
 }
 assert.equal(reads,2);assert.equal(writes,0);assert.equal(signing,0);assert.deepEqual(fs.readFileSync(certFile),identity.server.cert);
});

test('bad persisted private-key output fails closed with both existing and missing certificate, never generating a key',async t=>{
 const identity=identities();t.after(()=>identity.cleanup());
 for(const withCertificate of [true,false]){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-keychain-bad-private-fixture-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'remote'),{mode:0o700});if(withCertificate)fs.writeFileSync(path.join(dir,'remote/gateway.crt'),identity.server.cert);
  const {secrets,calls}=reader(hex('invalid persisted private key')+'\n');let signing=0;
  await assert.rejects(ensureIdentity(dir,secrets,{runOpenSSL:async()=>{signing++;throw Error('Must not generate an identity');}}),error=>error.code===(withCertificate?'gateway_identity_invalid':'gateway_certificate_missing'));
  assert.equal(signing,0);assert.equal(calls.length,1);assert.deepEqual(fs.readdirSync(path.join(dir,'remote')),withCertificate?['gateway.crt']:[]);
 }
});

test('failed Keychain reads remain unavailable and retry instead of caching a fabricated private key',async()=>{
 let attempts=0;const secrets=new RemoteSecrets({exec:async()=>{if(++attempts===1)throw Error('synthetic locked Keychain');return {stdout:hex(syntheticKey)+'\n'};}});
 assert.equal(await secrets.get('private-key'),null);assert.equal(await secrets.get('private-key'),syntheticKey);assert.equal(attempts,2);
});
