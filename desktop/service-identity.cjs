const REQUIRED_IDENTITY_FIELDS=['edition','version','sourceDigest','androidApplicationId'];
function assertBuildIdentity(actual,expected){
 if(!expected||!['phoneuse','xiaomi'].includes(expected.edition)||typeof expected.version!=='string'||!expected.version||!/^[a-f0-9]{64}$/.test(expected.sourceDigest||'')||expected.androidApplicationId!==`dev.boujoy.${expected.edition}`)throw Error('发行构建身份缺失或无效，请重新生成源码清单和安装包。');
 if(!actual||REQUIRED_IDENTITY_FIELDS.some(key=>actual[key]!==expected[key])){
  const error=Error('此端口运行的 Boujoy 版本、产品版或源码与当前应用不一致。请先核实已有服务；本应用不会复用或停止它。');error.code='BOUJOY_BUILD_MISMATCH';throw error;
 }
 return true;
}
function assertLoopbackOrigin(origin){
 let value;try{value=new URL(origin);}catch{throw Error('Invalid local service origin');}
 if(value.protocol!=='http:'||value.hostname!=='127.0.0.1'||!value.port||value.username||value.password||value.pathname!=='/'||value.search||value.hash)throw Error('Invalid local service origin');
 return value.origin;
}
async function probeService({origin,expectedIdentity,fetchImpl=fetch,timeoutMs=1500}){
 assertBuildIdentity(expectedIdentity,expectedIdentity);origin=assertLoopbackOrigin(origin);
 let session;
 try{session=await fetchImpl(origin+'/api/session',{signal:AbortSignal.timeout(timeoutMs),redirect:'error'});}
 catch(error){if(error?.cause?.code==='ECONNREFUSED'||error?.code==='ECONNREFUSED')return false;throw Error('本机服务检查未完成，未启动额外服务。请检查已有进程和端口。',{cause:error});}
 if(!session.ok)throw Error('该端口已有服务，但无法取得 Boujoy 本机会话；未启动或停止任何服务。');
 const cookie=(session.headers.get('set-cookie')||'').split(';',1)[0];
 if(!/^boujoy_session=[a-f0-9]{64}$/.test(cookie))throw Error('该端口未返回有效的 Boujoy 会话；未复用已有服务。');
 const response=await fetchImpl(origin+'/api/health',{headers:{Cookie:cookie},signal:AbortSignal.timeout(timeoutMs),redirect:'error'});
 if(!response.ok)throw Error('无法验证已有服务的构建身份；未复用已有服务。');
 const health=await response.json();assertBuildIdentity(health?.buildIdentity,expectedIdentity);return true;
}
module.exports={assertBuildIdentity,assertLoopbackOrigin,probeService};
