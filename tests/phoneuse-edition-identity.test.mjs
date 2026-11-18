import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DISTRIBUTION} from '../src/distribution.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Test both public manifests against the real start path in isolated source roots.
// No global environment overrides, phone, service, or installed profile is changed.
for(const edition of ['phoneuse','xiaomi'])test(`${edition} names local and tunneled Phone Use permissions without changing the wire protocol`,async t=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'boujoy-phoneuse-edition-'));
 t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const phoneuse=edition==='phoneuse',productName=phoneuse?'Boujoy Phone Use':'Boujoy Xiaomi';
 const profile={...DISTRIBUTION,edition,productName,androidApplicationId:`dev.boujoy.${edition}`,androidNamespace:'dev.boujoy.personalagent',
  bundleId:`dev.boujoy.${edition}.desktop`,bindScheme:`boujoy-${edition}`,keychainAccount:`boujoy-${edition}`,
  keychainServicePrefix:`dev.boujoy.${edition}`,launchdLabel:`dev.boujoy.${edition}.service`,supportsBackground:!phoneuse,
  dataDirectoryName:productName,memoryDirectoryName:phoneuse?'Boujoy-PhoneUse-Memory':'Boujoy-Xiaomi-Memory',
  port:phoneuse?18891:18892,gatewayPort:phoneuse?18991:18992};
 for(const name of ['src','web','config','package.json','package-lock.json'])await fs.cp(path.join(root,name),path.join(folder,name),{recursive:true});
 await fs.writeFile(path.join(folder,'distribution.json'),JSON.stringify(profile));
 const {PhoneUseClient}=await import(pathToFileURL(path.join(folder,'src/adapters/phoneuse-client.mjs')));
 const clientPath=path.join(folder,'synthetic-client.py'),bytes='synthetic client: rpc is mocked, no process is executed';
 await fs.writeFile(clientPath,bytes);
 for(const remote of [false,true]){
  const processes=[],initializations=[];
  const client=new PhoneUseClient({dataDir:path.join(folder,remote?'remote-data':'local-data'),clientPath,clientSha256:createHash('sha256').update(bytes).digest('hex'),rpcFactory:(command,args,options)=>{
   const row={command,args,role:options.role};processes.push(row);
   return {dead:false,notify(){},close(){this.dead=true;},async request(method,params){
    assert.equal(method,'initialize','startup cannot pair, discover devices, or send effects');initializations.push({role:row.role,params});
    return {serverInfo:{name:'phone-use',version:'1.3.0'},protocolVersion:'2025-11-25'};
   }};
  }});
  try{
   if(remote)await client.setRemoteTransport({dataPort:32001,controlPort:32002});
   const response=await client.start();assert.deepEqual(response.serverInfo,{name:'phone-use',version:'1.3.0'});
   assert.equal(processes.length,2);assert.equal(initializations.length,2);
   for(const process of processes){
    const name=remote||process.role==='control'?process.args[5]:process.args[process.args.indexOf('--name')+1];
    assert.equal(name,productName+(process.role==='control'?' control':''));
    assert.notEqual(name,'Boujoy Personal Agent');assert.notEqual(name,phoneuse?'Boujoy Xiaomi':'Boujoy Phone Use');
   }
   for(const {params} of initializations){assert.equal(params.protocolVersion,'2025-11-25');assert.deepEqual(params.clientInfo,{name:`boujoy-${edition}`,version:profile.desktopVersion});}
  }finally{await client.close();}
 }
});
