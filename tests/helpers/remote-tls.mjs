import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import https from 'node:https';
import tls from 'node:tls';
import {spkiPin} from '../../src/remote/state.mjs';
export function identities(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-remote-test-'));const make=name=>{const keyFile=path.join(dir,name+'.key'),certFile=path.join(dir,name+'.crt');execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-keyout',keyFile,'-out',certFile,'-days','1','-subj','/CN='+name],{stdio:'ignore'});return {key:fs.readFileSync(keyFile),cert:fs.readFileSync(certFile)};};return {dir,server:make('gateway'),client:make('android'),other:make('unbound'),cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};}
export async function eventually(fn,timeout=4000){const end=Date.now()+timeout;while(!fn()){if(Date.now()>=end)throw Error('condition timed out');await new Promise(r=>setTimeout(r,10));}}
export function request({port,stream,identity,pin,method='GET',pathname='/v1/state',body,host='boujoy.gateway',headers={},rawResponse=false}){
 return new Promise((resolve,reject)=>{const agent=new https.Agent({keepAlive:false});agent.createConnection=(options,callback)=>{const socket=tls.connect({...(stream?{socket:stream}:{host:'127.0.0.1',port}),key:identity.key,cert:identity.cert,rejectUnauthorized:false,minVersion:'TLSv1.3',maxVersion:'TLSv1.3'});socket.once('error',reject);socket.once('secureConnect',()=>{if(pin&&spkiPin(socket.getPeerCertificate().raw)!==pin){socket.destroy();callback(Error('server identity changed'));return;}callback(null,socket);});};
 const req=https.request({host:'boujoy.gateway',path:pathname,method,agent,headers:{Host:host,'Content-Type':'application/json',...headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>{agent.destroy();const raw=Buffer.concat(chunks);resolve({status:res.statusCode,headers:res.headers,body:rawResponse?raw:JSON.parse(raw.toString())});});});req.setTimeout(5000,()=>req.destroy(Error('request timeout')));req.on('error',e=>{agent.destroy();reject(e);});req.end(body?JSON.stringify(body):undefined);
 });
}
