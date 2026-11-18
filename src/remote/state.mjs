import {KEYCHAIN_ACCOUNT,KEYCHAIN_PREFIX} from '../distribution.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,randomBytes,X509Certificate,createHash,createPrivateKey,createPublicKey} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {assert,hash,constantEqual} from './protocol.mjs';
const exec=promisify(execFile);
export function atomicJSON(file,data){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(data));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
export class RemoteState{
 constructor(dir){this.file=path.join(dir,'remote/state.json');this.data=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{version:1,pairing:null,devices:{},messages:{},control:{controlEpoch:0,paused:true}};assert(this.data.version===1&&this.data.devices&&this.data.messages&&this.data.control,'Invalid remote state');}
 update(fn){const next=structuredClone(this.data),result=fn(next);atomicJSON(this.file,next);this.data=next;return result;}
 issuePairing({deviceId,ttlMs=600000}={}){const token=randomBytes(32).toString('base64url');const expiresAt=Date.now()+ttlMs;this.update(s=>{s.pairing={deviceId,tokenHash:hash(token),expiresAt};});return {pairToken:token,expiresAt};}
 bind(certFingerprint,{pairToken,clientName}={}){let device;this.update(s=>{const p=s.pairing;assert(p&&p.expiresAt>Date.now()&&constantEqual(hash(String(pairToken||'')),p.tokenHash),'Pairing expired or invalid');assert(!Object.values(s.devices).some(d=>d.active&&d.id===p.deviceId),'Device already bound; revoke explicitly before replacement');device={id:p.deviceId,certFingerprint,name:String(clientName||'Boujoy Android').slice(0,80),active:true,pairedAt:new Date().toISOString()};s.devices[certFingerprint]=device;s.pairing=null;});return device;}
 device(fingerprint){const d=this.data.devices[fingerprint];return d?.active?d:null;}
 revoke(id){this.update(s=>{for(const d of Object.values(s.devices))if(d.id===id){d.active=false;d.revokedAt=new Date().toISOString();}s.pairing=null;s.control={paused:true,controlEpoch:s.control.controlEpoch+1,reason:'device_revoked',pausedAt:new Date().toISOString()};});}
}
export function spkiPin(cert){const x=new X509Certificate(cert);return 'sha256/'+createHash('sha256').update(x.publicKey.export({type:'spki',format:'der'})).digest('base64');}
function keychainPrivateKey(value){
 // security(1) can print a multiline generic-password value as hexadecimal.
 // Decode only a complete, parseable private-key PEM, never a route token or
 // arbitrary bytes. Retain malformed values so missing-cert recovery fails
 // closed instead of treating an existing broken identity as a fresh install.
 if(!/^(?:[a-f0-9]{2})+$/i.test(value))return value;
 try{
  const decoded=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(value,'hex')).trim();
  if(!/^-----BEGIN ((?:RSA |EC |DSA )?PRIVATE KEY)-----\r?\n[A-Za-z0-9+/=\r\n]+-----END \1-----$/.test(decoded))return value;
  createPrivateKey(decoded);return decoded;
 }catch{return value;}
}
export class RemoteSecrets{
 constructor({exec:run=exec}={}){this.exec=run;this.cache=new Map();}
 async get(name){assert(['private-key','mac-route','android-route'].includes(name));if(this.cache.has(name))return this.cache.get(name);try{const {stdout}=await this.exec('/usr/bin/security',['find-generic-password','-a',KEYCHAIN_ACCOUNT,'-s',KEYCHAIN_PREFIX+'.remote.'+name,'-w'],{timeout:5000,maxBuffer:32768});const raw=stdout.trim(),value=name==='private-key'?keychainPrivateKey(raw):raw;this.cache.set(name,value);return value;}catch{return null;}}
 async set(name,value){assert(['private-key','mac-route','android-route'].includes(name)&&typeof value==='string'&&value.length<=16384);await this.exec('/usr/bin/security',['add-generic-password','-U','-a',KEYCHAIN_ACCOUNT,'-s',KEYCHAIN_PREFIX+'.remote.'+name,'-w',value],{timeout:15000});this.cache.set(name,value);}
}
const DAY=86400000,identityOperations=new Map();
const identityError=(code,message)=>Object.assign(Error(message),{code});
export function certificateStatus(cert,at=Date.now()){
 const value=new X509Certificate(cert),from=Date.parse(value.validFrom),until=Date.parse(value.validTo);
 if(!Number.isFinite(from)||!Number.isFinite(until))throw identityError('gateway_certificate_invalid','Gateway certificate dates are invalid');
 return {validFrom:new Date(from).toISOString(),expiresAt:new Date(until).toISOString(),daysRemaining:Math.floor((until-at)/DAY),needsMaintenance:until-at<=30*DAY||from>at,expired:until<=at,notYetValid:from>at};
}
export function validateIdentity(key,cert){
 let parsed,privateKey;try{parsed=new X509Certificate(cert);privateKey=createPrivateKey(key);}catch{throw identityError('gateway_identity_invalid','Gateway identity cannot be parsed');}
 const expected=parsed.publicKey.export({type:'spki',format:'der'}),actual=createPublicKey(privateKey).export({type:'spki',format:'der'});
 if(!expected.equals(actual)||!parsed.verify(parsed.publicKey))throw identityError('gateway_identity_mismatch','Gateway certificate and private key do not match the established identity');
 return {key,cert,pin:spkiPin(cert)};
}
async function maintainIdentity(dir,secrets,{now=Date.now,runOpenSSL=exec,canRenew=()=>true,beforeRenewalCommit=()=>true}={}){
 const root=path.join(dir,'remote'),certFile=path.join(root,'gateway.crt');fs.mkdirSync(root,{recursive:true,mode:0o700});
 let existing;try{existing=fs.lstatSync(certFile);}catch(error){if(error.code!=='ENOENT')throw error;}if(existing?.isSymbolicLink())throw identityError('gateway_identity_path','Gateway certificate must not be a symlink');
 let key=await secrets.get('private-key'),old=null;
 if(fs.existsSync(certFile)){
  if(!key)throw identityError('gateway_private_key_unavailable','Gateway private key unavailable');
  old=validateIdentity(key,fs.readFileSync(certFile,'utf8'));const status=certificateStatus(old.cert,now());
  if(!status.needsMaintenance)return {...old,renewed:false,certificate:status};
  if(canRenew()===false)return {...old,renewed:false,renewalDeferred:true,certificate:status};
 }else if(key)throw identityError('gateway_certificate_missing','Gateway certificate missing; restore identity instead of silently replacing it');
 const temporary=fs.mkdtempSync(path.join(root,'.identity-')),privateFile=path.join(temporary,'private.key'),temporaryCert=path.join(temporary,'gateway.crt');fs.chmodSync(temporary,0o700);
 try{
  fs.writeFileSync(privateFile,key||'',{flag:'wx',mode:0o600});fs.writeFileSync(temporaryCert,'',{flag:'wx',mode:0o600});
  const args=old?['req','-new','-x509','-key',privateFile]:['req','-x509','-newkey','rsa:2048','-nodes','-keyout',privateFile];
  await runOpenSSL('/usr/bin/openssl',[...args,'-sha256','-out',temporaryCert,'-days','365','-subj','/CN=Boujoy Personal Gateway'],{timeout:30000,maxBuffer:32768});
  const candidate=validateIdentity(old?key:fs.readFileSync(privateFile,'utf8'),fs.readFileSync(temporaryCert,'utf8')),status=certificateStatus(candidate.cert,now());
  if(status.needsMaintenance||status.expired||status.notYetValid||old&&candidate.pin!==old.pin)throw identityError('gateway_renewal_invalid','Replacement certificate failed identity or validity checks');
  const fd=fs.openSync(temporaryCert,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  if(old){if(canRenew()===false)return {...old,renewed:false,renewalDeferred:true,certificate:certificateStatus(old.cert,now())};const allowed=beforeRenewalCommit(candidate);if(allowed&&typeof allowed.then==='function')throw identityError('gateway_maintenance_guard','Renewal admission must be synchronous');if(allowed===false)return {...old,renewed:false,renewalDeferred:true,certificate:certificateStatus(old.cert,now())};}
  else await secrets.set('private-key',candidate.key);
  fs.chmodSync(temporaryCert,0o600);fs.renameSync(temporaryCert,certFile);
  const syncDirectory=()=>{const directory=fs.openSync(root,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}};
  try{syncDirectory();}catch(error){
   if(old){
    // If durability acknowledgement fails after rename, restore the established
    // certificate before reporting a failed renewal. Never generate another key.
    try{fs.writeFileSync(temporaryCert,old.cert,{flag:'wx',mode:0o600});const rollback=fs.openSync(temporaryCert,'r');try{fs.fsyncSync(rollback);}finally{fs.closeSync(rollback);}fs.renameSync(temporaryCert,certFile);syncDirectory();}
    catch{throw identityError('gateway_certificate_commit_unknown','Certificate durability could not be confirmed; verify the original identity before reconnecting');}
   }
   throw identityError('gateway_certificate_commit_failed','Certificate durability check failed; renewal was not accepted');
  }
  return {...candidate,renewed:!!old,created:!old,certificate:status};
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
export function ensureIdentity(dir,secrets,options={}){
 const id=path.resolve(dir),previous=identityOperations.get(id)||Promise.resolve();const operation=previous.catch(()=>{}).then(()=>maintainIdentity(id,secrets,options));identityOperations.set(id,operation);
 operation.finally(()=>{if(identityOperations.get(id)===operation)identityOperations.delete(id);}).catch(()=>{});return operation;
}
