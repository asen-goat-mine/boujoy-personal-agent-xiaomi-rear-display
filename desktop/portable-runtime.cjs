const path=require('node:path');
const fs=require('node:fs');
const {assertBuildIdentity}=require('./service-identity.cjs');
function distributionRuntime(config){
 const d=config.distribution;
 if(!d||d.schemaVersion!==1||!['phoneuse','xiaomi'].includes(d.edition)||d.bundleId!==`dev.boujoy.${d.edition}.desktop`||d.androidApplicationId!==`dev.boujoy.${d.edition}`)throw Error('缺少有效的独立产品配置。');
 for(const key of ['dataDirectoryName','memoryDirectoryName','productName'])if(typeof d[key]!=='string'||!d[key].trim()||/[\/\\\0]/.test(d[key])||['.','..'].includes(d[key]))throw Error('Invalid distribution directory/name');
 const phone=d.edition==='phoneuse',expected={port:phone?18891:18892,dataDirectoryName:phone?'Boujoy Phone Use':'Boujoy Xiaomi',memoryDirectoryName:phone?'Boujoy-PhoneUse-Memory':'Boujoy-Xiaomi-Memory'};
 for(const [key,value] of Object.entries(expected))if(d[key]!==value)throw Error('Distribution runtime identity mismatch: '+key);
 assertBuildIdentity(config.expectedIdentity,config.expectedIdentity);
 if(config.expectedIdentity.edition!==d.edition||config.expectedIdentity.version!==d.desktopVersion||config.expectedIdentity.androidApplicationId!==d.androidApplicationId)throw Error('产品配置与构建身份不一致。');
 return d;
}
function resolveRuntime(config,base,appData,documents){
 const d=distributionRuntime(config),common={...config,distribution:d,productName:d.productName,origin:`http://127.0.0.1:${d.port}`,port:d.port};
 if(!config.portable)return {...common,data:config.data||path.join(appData,d.dataDirectoryName),memory:config.memory||path.join(documents,d.memoryDirectoryName)};
 return {...common,root:path.join(base,'backend'),data:path.join(appData,d.dataDirectoryName),node:path.join(base,'runtime/node'),harness:path.join(base,'harness'),python:path.join(base,'runtime/python/bin/python3'),memory:path.join(documents,d.memoryDirectoryName),portable:true};
}
function initializePortableMemory(config){
 if(!config.portable)return false;
 // Existing folders belong to the recipient; never adopt or overwrite them.
 try{fs.mkdirSync(config.memory,{mode:0o700});}catch(error){if(error.code==='EEXIST')return false;throw error;}
 for(const dir of ['00-System','01-Personal','02-Projects','03-Knowledge','04-Routines'])fs.mkdirSync(path.join(config.memory,dir),{mode:0o700});
 fs.writeFileSync(path.join(config.memory,'00-System/Memory-Protocol.md'),'---\nprotocol_id: boujoy-personal-memory\nprotocol_version: 1\nscope: personal-agent\n---\n\n# Boujoy 个人记忆\n\n这是本机新建的空白记忆库，不包含分享者的数据。\n',{flag:'wx',mode:0o600});
 return true;
}
module.exports={resolveRuntime,initializePortableMemory,distributionRuntime};
