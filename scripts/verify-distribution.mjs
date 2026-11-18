#!/usr/bin/env node
/** Read-only release verification. Never starts, stops or reconfigures a service. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

const DEFAULT_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const IDENTITY_FIELDS=['edition','version','sourceDigest','androidApplicationId','androidVersion','androidVersionCode'];
class VerificationError extends Error {
  constructor(code,message){super(message);this.code=code;}
}
function fail(code,message){throw new VerificationError(code,message);}
function safeIdentity(value){
  if(!value||!['phoneuse','xiaomi'].includes(value.edition)||!/^\d+\.\d+\.\d+$/.test(value.version)||
    !/^[a-f0-9]{64}$/.test(value.sourceDigest)||value.androidApplicationId!==`dev.boujoy.${value.edition}`||
    !/^\d+\.\d+\.\d+$/.test(value.androidVersion)||!Number.isSafeInteger(value.androidVersionCode)||value.androidVersionCode<1)
    fail('invalid_identity','构建身份缺失或无效。');
  return Object.fromEntries(IDENTITY_FIELDS.map(name=>[name,value[name]]));
}
function matchIdentity(actual,expected){
  actual=safeIdentity(actual);
  for(const name of IDENTITY_FIELDS)if(actual[name]!==expected[name])fail('identity_mismatch',`构建身份不一致：${name}。未复用或停止任何进程。`);
  return actual;
}
// Keep this independent of the runtime import: verify its bytes before loading it.
function actualManifest(root){
  const files={};
  function add(name){
    const file=path.join(root,name),stat=fs.lstatSync(file);
    if(stat.isSymbolicLink())fail('source_mismatch','运行源码包含符号链接。');
    if(stat.isDirectory()){for(const child of fs.readdirSync(file).sort())if(child!=='.DS_Store')add(`${name}/${child}`);}
    else if(stat.isFile())files[name]=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    else fail('source_mismatch','运行源码包含非普通文件。');
  }
  for(const name of ['src','web','config','distribution.json','package.json','package-lock.json'])add(name);
  const ordered=Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b,'en')));
  const sourceDigest=createHash('sha256').update(Object.entries(ordered).map(([name,hash])=>`${name}\0${hash}\n`).join('')).digest('hex');
  return {schemaVersion:1,sourceDigest,files:ordered};
}
function loopbackOrigin(value){
  let url;try{url=new URL(value);}catch{fail('invalid_origin','验证地址必须为 http://127.0.0.1:端口。');}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||url.pathname!=='/')
    fail('invalid_origin','验证只允许本机 http://127.0.0.1:端口，不跟随重定向。');
  return url.origin;
}
async function runningIdentity(origin,expected,fetchImpl,timeoutMs){
  const request=async(url,options={})=>{
    try{return await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});}
    catch{fail('service_unavailable','本机服务未响应或返回重定向；未启动或停止任何服务。');}
  };
  const session=await request(`${origin}/api/session`);
  if(!session.ok)fail('session_failed','无法建立本机验证会话。');
  const cookie=session.headers.get('set-cookie')?.match(/(?:^|,\s*)boujoy_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if(!cookie)fail('session_failed','本机验证会话没有有效认证 Cookie。');
  if(session.body)await session.body.cancel();
  const response=await request(`${origin}/api/health`,{headers:{Cookie:`boujoy_session=${cookie}`}});
  if(!response.ok)fail('health_failed','认证后的健康检查未成功。');
  let health;try{health=await response.json();}catch{fail('health_failed','认证后的健康检查格式无效。');}
  matchIdentity(health?.buildIdentity,expected);
}
export async function verifyDistribution({root=DEFAULT_ROOT,running=false,origin,fetchImpl=globalThis.fetch,timeoutMs=3000}={}){
  root=path.resolve(root);
  const manifestFile=path.join(root,'runtime-manifest.json');
  if(!fs.existsSync(manifestFile))return {ok:false,status:'unsealed',message:'缺少 runtime-manifest.json：源码尚未封版，不能宣称发布校验通过。'};
  const stat=fs.lstatSync(manifestFile);
  if(!stat.isFile()||stat.isSymbolicLink())fail('manifest_invalid','发布清单必须是普通文件。');
  let expected;try{expected=JSON.parse(fs.readFileSync(manifestFile,'utf8'));}catch{fail('manifest_invalid','发布清单无法解析。');}
  const manifest=actualManifest(root);
  if(expected.schemaVersion!==1||expected.sourceDigest!==manifest.sourceDigest||JSON.stringify(expected.files)!==JSON.stringify(manifest.files))
    fail('source_mismatch','运行源码与发布清单不一致：可能存在新增、删除或修改。');
  let module,distribution,identity;
  try{
    module=await import(pathToFileURL(path.join(root,'src/distribution.mjs')).href);
    distribution=module.readDistribution(root);
    identity=safeIdentity(module.readBuildIdentity(root,distribution));
    matchIdentity(module.BUILD_IDENTITY,identity);
  }catch(error){if(error instanceof VerificationError)throw error;fail('distribution_invalid','distribution.json、版本或运行构建身份校验失败。');}
  if(identity.sourceDigest!==manifest.sourceDigest)fail('source_mismatch','运行身份与发布源码摘要不一致。');
  const runtimeFile=path.join(root,'..','runtime.json');
  if(path.basename(root)==='backend'&&fs.existsSync(runtimeFile)){
    let runtime;try{runtime=JSON.parse(fs.readFileSync(runtimeFile,'utf8'));}catch{fail('runtime_invalid','桌面运行配置无法解析。');}
    matchIdentity(runtime.expectedIdentity,identity);
    if(JSON.stringify(runtime.distribution)!==JSON.stringify(distribution))fail('runtime_invalid','桌面运行配置与发行版配置不一致。');
  }
  if(running)await runningIdentity(loopbackOrigin(origin||`http://127.0.0.1:${distribution.port}`),identity,fetchImpl,timeoutMs);
  return {ok:true,status:running?'running_verified':'sealed',buildIdentity:identity,runningVerified:running};
}
export async function runCli(args=process.argv.slice(2),{stdout=process.stdout,stderr=process.stderr}={}){
  const options={};let json=false;
  try{
    for(let i=0;i<args.length;i++){
      const arg=args[i];
      if(arg==='--help'){stdout.write('用法：node scripts/verify-distribution.mjs [--root 源码或backend目录] [--running] [--origin http://127.0.0.1:端口] [--json]\n只读核验；缺少封版清单退出 2，校验失败退出 1，通过退出 0。\n');return 0;}
      if(arg==='--running')options.running=true;
      else if(arg==='--json')json=true;
      else if(arg==='--root'||arg==='--origin'){
        const value=args[++i];if(!value||value.startsWith('--'))fail('arguments','命令参数缺少值。');
        options[arg==='--root'?'root':'origin']=value;
      }else fail('arguments','无法识别的命令参数。');
    }
    if(options.origin&&!options.running)fail('arguments','--origin 必须与 --running 一起使用。');
    const result=await verifyDistribution(options);
    stdout.write(json?JSON.stringify(result)+'\n':result.ok?`${result.runningVerified?'运行进程与封版源码一致':'封版源码验证通过'}：${result.buildIdentity.edition} / ${result.buildIdentity.version}\nsourceDigest=${result.buildIdentity.sourceDigest}\n`:result.message+'\n');
    return result.ok?0:2;
  }catch(error){
    const result={ok:false,status:'failed',code:error instanceof VerificationError?error.code:'verification_failed',message:error instanceof VerificationError?error.message:'验证失败。请检查文件是否完整、可读；未输出内部路径、会话或健康数据。'};
    stderr.write(json?JSON.stringify(result)+'\n':result.message+'\n');return 1;
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runCli();
