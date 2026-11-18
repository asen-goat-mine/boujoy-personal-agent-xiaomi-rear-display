import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {resolveRuntime,initializePortableMemory}=createRequire(import.meta.url)('../desktop/portable-runtime.cjs');
function fixture(edition){
 const phone=edition==='phoneuse',distribution={schemaVersion:1,edition,desktopVersion:'0.4.16',productName:phone?'Boujoy Phone Use':'Boujoy Xiaomi',bundleId:`dev.boujoy.${edition}.desktop`,androidApplicationId:`dev.boujoy.${edition}`,port:phone?18891:18892,dataDirectoryName:phone?'Boujoy Phone Use':'Boujoy Xiaomi',memoryDirectoryName:phone?'Boujoy-PhoneUse-Memory':'Boujoy-Xiaomi-Memory'};
 return {portable:true,distribution,expectedIdentity:{edition,version:'0.4.16',sourceDigest:'a'.repeat(64),androidApplicationId:distribution.androidApplicationId}};
}
test('portable editions resolve only their own moved bundle and recipient data/memory',()=>{
 const values=['phoneuse','xiaomi'].map(edition=>resolveRuntime({...fixture(edition),root:'/old/author',data:'/old/private',memory:'/old/memory'},'/Applications/Selected.app/Contents/Resources/app','/Users/recipient/Library/Application Support','/Users/recipient/Documents'));
 for(const r of values){assert.equal(r.root,'/Applications/Selected.app/Contents/Resources/app/backend');assert.ok(!JSON.stringify(r).includes('/old/'));assert.equal(r.origin,`http://127.0.0.1:${r.distribution.port}`);}
 assert.notEqual(values[0].data,values[1].data);assert.notEqual(values[0].memory,values[1].memory);assert.notEqual(values[0].origin,values[1].origin);
 assert.equal(values[0].data,'/Users/recipient/Library/Application Support/Boujoy Phone Use');assert.equal(values[1].memory,'/Users/recipient/Documents/Boujoy-Xiaomi-Memory');
});
test('developer edition preserves explicit local source/runtime while carrying verified product identity',()=>{
 const c={...fixture('xiaomi'),portable:false,root:'/local',data:'/data',node:'/node'};
 const result=resolveRuntime(c,'/x','/y','/z');assert.equal(result.root,c.root);assert.equal(result.data,c.data);assert.equal(result.node,c.node);assert.equal(result.origin,'http://127.0.0.1:18892');
});
test('missing, mixed edition, private app ID and path escaping configs are rejected',()=>{
 const call=c=>resolveRuntime(c,'/app','/recipient/data','/recipient/docs');
 assert.throws(()=>call({portable:true}));const c=fixture('phoneuse');
 assert.throws(()=>call({...c,expectedIdentity:fixture('xiaomi').expectedIdentity}));
 assert.throws(()=>call({...c,distribution:{...c.distribution,bundleId:'dev.boujoy.personal-agent.desktop'}}));
 assert.throws(()=>call({...c,distribution:{...c.distribution,port:18791}}));assert.throws(()=>call({...c,distribution:{...c.distribution,memoryDirectoryName:'Boujoy-Memory'}}));
 for(const name of ['../other','a/b','a\\b','\0bad'])assert.throws(()=>call({...c,distribution:{...c.distribution,dataDirectoryName:name}}));
});
test('portable startup creates actual Markdown newlines once and preserves existing content',t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'portable-memory-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));const config={portable:true,memory:path.join(base,'Memory')};
 assert.equal(initializePortableMemory(config),true);const file=path.join(config.memory,'00-System/Memory-Protocol.md');assert.match(fs.readFileSync(file,'utf8'),/^---\nprotocol_id: boujoy-personal-memory\n/);
 fs.writeFileSync(file,'recipient content');assert.equal(initializePortableMemory(config),false);assert.equal(fs.readFileSync(file,'utf8'),'recipient content');
 const other={portable:true,memory:path.join(base,'Existing')};fs.mkdirSync(other.memory);assert.equal(initializePortableMemory(other),false);assert.deepEqual(fs.readdirSync(other.memory),[]);
});
