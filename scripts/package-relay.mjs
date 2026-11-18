import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
export const relayPackageFiles=['.dockerignore','src/remote/protocol.mjs','src/remote/relay.mjs','scripts/run-relay.mjs','deploy/relay/package.json','deploy/relay/package-lock.json','deploy/relay/Dockerfile','deploy/relay/compose.yaml','deploy/relay/Caddyfile','deploy/relay/Caddyfile.ip','deploy/relay/start.sh','deploy/relay/README.md'];
export function packageRelay({source=path.resolve(import.meta.dirname,'..'),output=path.join(source,'dist/Boujoy-Encrypted-Relay.tar.gz')}={}){
 const root=path.resolve(source),archive=path.resolve(output),stage=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-relay-package-')),temporaryArchive=archive+'.'+randomUUID()+'.tmp';const manifest=[];
 try{
  for(const name of relayPackageFiles){
   const original=path.join(root,name);let current=original;while(current!==root){if(fs.lstatSync(current).isSymbolicLink())throw Error('Relay package refuses symlinks: '+name);current=path.dirname(current);}if(!fs.lstatSync(original).isFile())throw Error('Relay package requires a regular file: '+name);
   const file=path.join(stage,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(original,file);fs.chmodSync(file,name.endsWith('.sh')?0o755:0o644);manifest.push({path:name,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
  }
  fs.writeFileSync(path.join(stage,'manifest.json'),JSON.stringify({version:1,createdAt:new Date().toISOString(),containsCredentials:false,files:manifest},null,2));
  // Never archive an existing dist/relay directory: it may contain a route file
  // or other local material from a previous deployment or inspection.
  // macOS tar otherwise adds AppleDouble ._* files and xattr PAX records that
  // its own listing hides. Explicit USTAR members carry only release bytes.
  fs.mkdirSync(path.dirname(archive),{recursive:true});execFileSync('/usr/bin/tar',['--format=ustar','-czf',temporaryArchive,'-C',stage,...relayPackageFiles,'manifest.json'],{env:{...process.env,COPYFILE_DISABLE:'1'}});fs.renameSync(temporaryArchive,archive);
  return {archive,sha256:createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),files:relayPackageFiles.length,containsCredentials:false};
 }finally{fs.rmSync(stage,{recursive:true,force:true});fs.rmSync(temporaryArchive,{force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(packageRelay()));
