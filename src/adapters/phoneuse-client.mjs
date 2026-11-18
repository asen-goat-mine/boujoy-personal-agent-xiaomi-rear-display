import {ANDROID_PACKAGE,DISTRIBUTION} from '../distribution.mjs';
import {navigationPackageAllowed} from './phone-application-families.mjs';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DATA} from '../config.mjs';
import {AppError,requireValue} from '../core/errors.mjs';
import {LineRPC} from './rpc.mjs';
import {nativeWindowConflict} from './phone-window-identity.mjs';
import {claimInputRecoveryFrame,INPUT_PROOF_FRAME} from './input-recovery-capture.mjs';

export const PHONEUSE_CLIENT_SHA256='e45c8af8d95db1801c851f75b958155eb209c8fa5d4d163de85012f809608540';
const READ=new Set(['get_capabilities','get_status','observe','list_apps','wait_for_change']);
const ACTION=new Set(['tap','long_press','swipe','scroll','input_text','back','home','recents','launch_app']);
const CONTROL=new Set(['cancel','acquire_device','release_device']);
const TERMINAL=new Set(['executed','failed','cancelled']);
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f]/.test(value);
const keyOf=(deviceId,requestId)=>`${deviceId}\0${requestId}`;
const inputProofFramePy=JSON.stringify(INPUT_PROOF_FRAME).replace(/\btrue\b/g,'True').replace(/\bfalse\b/g,'False');

// A second unmodified bridge would still block on Connection.device_lock's
// cross-process file lock. Cancellation/status and fixed readback frames bypass it;
// inherited _send_locked retains TLS pin, identity and credential checks.
export const PHONEUSE_CONTROL_BOOTSTRAP=`import runpy, sys
source = runpy.run_path(sys.argv[1])
source['utf8_stdio']()
class ControlConnection(source['Connection']):
    def send(self, device_id, endpoint, payload):
        params = payload.get('params', {}) if isinstance(payload, dict) else {}
        name = params.get('name') if isinstance(params, dict) else None
        arguments = params.get('arguments', {}) if isinstance(params, dict) else {}
        demo_read = name == 'observe' and arguments == {'mode': 'tree', 'output': 'legacy', 'compact': True, 'include_details': False, 'diagnostics': False, 'stable_wait_ms': 0, 'max_attempts': 1, 'timeout_ms': 1500}
        input_proof = name == 'observe' and arguments == ${inputProofFramePy}
        if endpoint != '/mcp' or payload.get('method') != 'tools/call' or not (name in ('get_status', 'cancel') or demo_read or input_proof):
            raise source['BridgeError']('CONTROL_TOOL_DENIED', 'Control channel permits only fixed readback frames, get_status and cancel', device_id, action_executed=False)
        if not isinstance(device_id, str) or not device_id:
            raise source['BridgeError']('DEVICE_REQUIRED', 'Specify device_id', action_executed=False)
        return self._send_locked(device_id, endpoint, payload)
source['bridge'](ControlConnection(sys.argv[2], name=sys.argv[3]))
`;
export const PHONEUSE_REMOTE_BOOTSTRAP=`import runpy, sys, socket, http.client, types
source = runpy.run_path(sys.argv[1])
source['utf8_stdio']()
port = int(sys.argv[4])
if not 1 <= port <= 65535:
    raise ValueError('Invalid local tunnel port')
OriginalHTTPSConnection = http.client.HTTPSConnection
class TunnelHTTPSConnection(OriginalHTTPSConnection):
    def __init__(self, host, remote_port=None, **kwargs):
        super().__init__('127.0.0.1', 8443, **kwargs)
        self._create_connection = lambda address, timeout, source_address=None: socket.create_connection(('127.0.0.1', port), timeout, source_address)
# Python 3.13's HTTPSConnection.__init__ uses super(HTTPSConnection, self).
# Replacing that module global would recurse into its own constructor. Shadow
# only the official bridge's http binding; leave stdlib class globals intact.
source['http_request'].__globals__['http'] = types.SimpleNamespace(client=types.SimpleNamespace(**{**vars(http.client), 'HTTPSConnection': TunnelHTTPSConnection}))
${readFileSync(new URL('./phoneuse-http-pool.py',import.meta.url),'utf8')}
install_pool(source, TunnelHTTPSConnection)
class ControlConnection(source['Connection']):
    def send(self, device_id, endpoint, payload):
        params = payload.get('params', {}) if isinstance(payload, dict) else {}
        name = params.get('name') if isinstance(params, dict) else None
        arguments = params.get('arguments', {}) if isinstance(params, dict) else {}
        demo_read = name == 'observe' and arguments == {'mode': 'tree', 'output': 'legacy', 'compact': True, 'include_details': False, 'diagnostics': False, 'stable_wait_ms': 0, 'max_attempts': 1, 'timeout_ms': 1500}
        input_proof = name == 'observe' and arguments == ${inputProofFramePy}
        if endpoint != '/mcp' or payload.get('method') != 'tools/call' or not (name in ('get_status', 'cancel') or demo_read or input_proof):
            raise source['BridgeError']('CONTROL_TOOL_DENIED', 'Control channel permits only fixed readback frames, get_status and cancel', device_id, action_executed=False)
        if not isinstance(device_id, str) or not device_id:
            raise source['BridgeError']('DEVICE_REQUIRED', 'Specify device_id', action_executed=False)
        return self._send_locked(device_id, endpoint, payload)
connection = ControlConnection if sys.argv[5] == 'control' else source['Connection']
source['bridge'](connection(sys.argv[2], name=sys.argv[3]))
`;

export function unwrapPhoneUseMcp(result){
 requireValue(result&&Array.isArray(result.content),'Phone Use 返回了无效的工具结果','phoneuse_invalid_result');
 const values=[];
 for(const block of result.content){
  if(block?.type!=='text')continue;
  try{const value=JSON.parse(block.text);if(value&&typeof value==='object'&&!Array.isArray(value))values.push(value);}catch{}
 }
 requireValue(values.length===1,'Phone Use 工具结果缺少唯一的状态对象','phoneuse_invalid_result');
 return values[0];
}
function safePublic(value){
 if(Array.isArray(value))return value.map(safePublic);
 if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).filter(([key])=>!['token','pairing_secret','client_nonce','server_nonce','tls_pin'].includes(key)).map(([key,item])=>[key,safePublic(item)]));
}
function readResult(native){
 const result=unwrapPhoneUseMcp(native);
 if(native.isError||result.error){
  const reasons=[];let complete=true;
  const add=value=>{if(typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/.test(value))reasons.push(value);else complete=false;};
  if(result.error)add(result.error.code);
  for(const channel of [result.tree,result.screenshot])if(channel?.available===false)add(channel.reason);
  if(result.condition&&(result.condition.status!=='satisfied'||result.condition.timed_out===true))complete=false;
  const code=result.error?.code??reasons[0];
  const message=result.error?.message||`Phone Use 未能返回完整可靠的读取结果${reasons.length?'（'+[...new Set(reasons)].join('、')+'）':''}`;
  const error=new AppError('phoneuse_error',String(message).slice(0,1500),503);
  error.phoneuseCode=code;error.phoneuseReasons=[...new Set(reasons)];error.phoneuseReasonsComplete=complete&&reasons.length>0;
  error.phoneuseObservationStatus=result.observation_status;throw error;
 }
 return result;
}
// The native server deliberately marks an unknown action status as isError.
// It is a valid reconciliation receipt, never proof of execution or permission
// to replay. Only the exact device/request and stable service envelope qualifies.
// Real Phone Use 1.3.0 status envelopes omit `paused` unless the service is
// paused. Treat a missing field as not paused; an explicit true still blocks.
const notPaused=value=>value.paused===undefined||value.paused===false;
function readStatusResult(native,deviceId,requestId){
 const state=unwrapPhoneUseMcp(native),request=state.request;
 const unknown=validId(requestId)&&native.isError===true&&!state.error&&
  state.device_id===deviceId&&validId(state.service_instance_id)&&
  typeof state.stopped==='boolean'&&(state.paused===undefined||typeof state.paused==='boolean')&&state.paused!==true&&state.executing_request_id===null&&
  request?.request_id===requestId&&request.device_id===deviceId&&request.service_instance_id===state.service_instance_id&&
  request.state==='unknown'&&request.action_executed===null&&request.error?.code==='RESULT_UNKNOWN';
 return unknown?state:readResult(native);
}
function failure(code,message,record){
 const error=new AppError(code,message,409);
 if(record){error.requestId=record.requestId;error.deviceId=record.deviceId;error.tool=record.tool;}
 return error;
}
function proof(native,record,{status=false}={}){
 let root;try{root=unwrapPhoneUseMcp(native);}catch{return {outcome:'unknown'};}
 if(root.device_id&&root.device_id!==record.deviceId)return {outcome:'unknown',result:root};
 const result=status?root.request:root;
 if(!result||typeof result!=='object'||result.device_id&&result.device_id!==record.deviceId)return {outcome:'unknown',result:root};
 if(result.request_id!==undefined&&result.request_id!==record.requestId)return {outcome:'unknown',result:root};
 if(['accepted','executing'].includes(result.state))return {outcome:'pending',result:root};
 if(result.state==='executed'&&result.action_executed===true&&result.request_id===record.requestId&&root.device_id===record.deviceId&&validId(root.service_instance_id)&&(!record.serviceInstanceId||root.service_instance_id===record.serviceInstanceId))return {outcome:'executed',result:root};
 if(['failed','cancelled'].includes(result.state)&&result.action_executed===false&&(!status||result.request_id===record.requestId))return {outcome:result.state,result:root};
 return {outcome:'unknown',result:root};
}
// Connection-level failures before any phone-side result: the relay or TLS
// link dropped. Reads may be retried once; effects never are.
function transientTransport(error){
 if(error?.code==='phoneuse_error')return ['DEVICE_OFFLINE','BRIDGE_BUSY','SCREENSHOT_TIMEOUT'].includes(error.phoneuseCode)||!error.phoneuseCode&&/SSL|EOF|ECONNRESET|Connection reset|timed out|Broken pipe|Remote end closed/i.test(error.message||'');
 return error?.code==='runtime_exited';
}
function bounded(promise,{signal,timeout,code='rpc_timeout'}={}){
 if(signal?.aborted){Promise.resolve(promise).catch(()=>{});return Promise.reject(failure('cancelled','任务已停止'));}
 return new Promise((resolve,reject)=>{
  let done=false;
  const finish=(fn,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);fn(value);};
  const onAbort=()=>finish(reject,failure('cancelled','任务已停止'));
  const timer=setTimeout(()=>finish(reject,failure(code,'Phone Use 请求等待超时')),timeout);
  signal?.addEventListener('abort',onAbort,{once:true});
  Promise.resolve(promise).then(value=>finish(resolve,value),error=>finish(reject,error));
 });
}

const NAVIGATION_IDLE_MS=2*60000;
export const UNCONFIRMED_EFFECT_EXPIRY_MS=15000;
const NAVIGATION_TOOLS=new Set(['launch_app','back','home','recents','swipe','scroll']);
// A navigation proof has three independent read-only hops: original status,
// current foreground and final status. Bound each hop and the whole proof.
export const NAVIGATION_PROOF_BUDGET_MS=24_000;
const NAVIGATION_READ_BUDGET_MS=8_000;
export class PhoneUseClient {
 constructor({dataDir=DATA,clientPath=path.join(dataDir,'tools/phoneuse/1.3.0/phoneuse_client.py'),python='python3',rpcFactory=(...args)=>new LineRPC(...args),files=fs,clock=Date.now,uuid=randomUUID,clientSha256=PHONEUSE_CLIENT_SHA256,controlTimeout=4000,navigationRecoveryTimeout=NAVIGATION_PROOF_BUDGET_MS,initTimeout=5000,env}={}){
  Object.assign(this,{dataDir,clientPath,python,rpcFactory,files,clock,uuid,clientSha256,controlTimeout,navigationRecoveryTimeout,initTimeout,env});
  this.configPath=path.join(dataDir,'phone/phoneuse.json');this.pendingPath=path.join(dataDir,'phone/phoneuse-pending.json');
  this.controllerBootAt=clock();this.controllerNavigation=null;this.pending=new Map();this.active=new Map();this.completed=new Map();this.loaded=false;this.initialized=false;this.starting=null;this.writing=Promise.resolve();this.closed=false;this.closing=null;this.rpc=null;this.controlRpc=null;
 }
 async loadPending(){
  if(this.loaded)return;
  let value;
  try{const raw=await this.files.readFile(this.pendingPath,'utf8');requireValue(Buffer.byteLength(raw)<=262144,'Phone Use 动作记录过大','pending_store_invalid');value=JSON.parse(raw);}
  catch(error){if(error.code==='ENOENT'){this.loaded=true;return;}throw new AppError('pending_store_invalid','Phone Use 动作记录无法核实，已暂停新动作。',503);}
  requireValue(value?.version===1&&Array.isArray(value.pending)&&value.pending.length<=256,'Phone Use 动作记录格式无效','pending_store_invalid');
  for(const row of value.pending){
   requireValue(validId(row?.deviceId)&&validId(row.requestId)&&row.requestId.length<=128&&ACTION.has(row.tool)&&Number.isFinite(row.createdAt)&&['sending','pending','unknown'].includes(row.state),'Phone Use 动作记录内容无效','pending_store_invalid');
   const key=keyOf(row.deviceId,row.requestId);requireValue(!this.pending.has(key),'Phone Use 动作记录重复','pending_store_invalid');
   const navigationTarget=row.tool==='launch_app'&&/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(row.navigationTarget||'')?row.navigationTarget:null;
   const resolution=row.resolution;
   if(resolution){
    const observed=navigationTarget&&resolution.kind==='navigation_observed'&&resolution.packageName===navigationTarget&&(!resolution.observedPackageName||navigationPackageAllowed(navigationTarget,resolution.observedPackageName))&&validId(resolution.observationId);
    const superseded=row.tool==='launch_app'&&!navigationTarget&&resolution.kind==='legacy_navigation_superseded'&&resolution.nativeOutcome==='not_retained'&&validId(resolution.newRequestId)&&resolution.newRequestId!==row.requestId&&/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(resolution.newPackageName||'')||
     resolution.kind==='superseded_after_idle'&&['not_retained','unknown'].includes(resolution.nativeOutcome)&&validId(resolution.newRequestId)&&resolution.newRequestId!==row.requestId&&ACTION.has(resolution.newTool);
    requireValue((observed||superseded)&&resolution.deviceId===row.deviceId&&validId(resolution.serviceInstanceId)&&Number.isFinite(resolution.at),'导航核实记录无效','pending_store_invalid');
   }
   this.pending.set(key,{deviceId:row.deviceId,requestId:row.requestId,tool:row.tool,createdAt:row.createdAt,state:row.state==='sending'?'unknown':row.state,...(validId(row.serviceInstanceId)?{serviceInstanceId:row.serviceInstanceId}:{}),...(navigationTarget?{navigationTarget}:{}),...(resolution?{resolution}: {})});
  }
  this.loaded=true;
 }
 async commit(change){
  const operation=this.writing.then(async()=>{
   const before=new Map(this.pending);change();const temporary=this.pendingPath+'.'+this.uuid()+'.tmp';let stream;
   try{
    await this.files.mkdir(path.dirname(this.pendingPath),{recursive:true,mode:0o700});
    stream=await this.files.open(temporary,'wx',0o600);await stream.writeFile(JSON.stringify({version:1,pending:[...this.pending.values()]}),'utf8');await stream.sync();await stream.close();stream=null;
    await this.files.rename(temporary,this.pendingPath);
   }catch{this.pending=before;try{await stream?.close();await this.files.rm(temporary,{force:true});}catch{}throw new AppError('pending_store_unavailable','Phone Use 动作记录无法安全保存，已暂停新动作。',503);}
  });
  this.writing=operation.catch(()=>{});return operation;
 }
 async start(){
  if(this.closed)throw failure('phoneuse_closed','Phone Use 客户端已关闭');
  if(this.starting&&(!this.initialized||this.rpc&&!this.rpc.dead&&this.controlRpc&&!this.controlRpc.dead))return this.starting;
  if(this.initialized){this.rpc?.close();this.controlRpc?.close();this.rpc=null;this.controlRpc=null;this.starting=null;this.initialized=false;}
  this.starting=(async()=>{
   await this.loadPending();
   const hash=createHash('sha256').update(await this.files.readFile(this.clientPath)).digest('hex');
   requireValue(hash===this.clientSha256,'Phone Use 客户端校验失败，请重新安装已验证版本','phoneuse_client_integrity');
   await this.files.mkdir(path.dirname(this.configPath),{recursive:true,mode:0o700});
   const options={...(this.env?{env:this.env}:{})};
   const remoteArgs=(port,role)=>['-u','-c',PHONEUSE_REMOTE_BOOTSTRAP,this.clientPath,this.configPath,DISTRIBUTION.productName+(role==='control'?' control':''),String(port),role];
   this.rpc=await this.rpcFactory(this.python,this.remoteTransport?remoteArgs(this.remoteTransport.dataPort,'main'):['-u',this.clientPath,'--config',this.configPath,'mcp-stdio','--name',DISTRIBUTION.productName],{...options,role:'main'});
   this.controlRpc=await this.rpcFactory(this.python,this.remoteTransport?remoteArgs(this.remoteTransport.controlPort,'control'):['-u','-c',PHONEUSE_CONTROL_BOOTSTRAP,this.clientPath,this.configPath,DISTRIBUTION.productName+' control'],{...options,role:'control'});
   const params={protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:`boujoy-${DISTRIBUTION.edition}`,version:DISTRIBUTION.desktopVersion}};
   const results=await Promise.all([this.rpc.request('initialize',params,this.initTimeout),this.controlRpc.request('initialize',params,this.initTimeout)]);
   requireValue(results.every(result=>result?.serverInfo?.name==='phone-use'&&result.serverInfo.version==='1.3.0'),'Phone Use 客户端版本不兼容','phoneuse_client_version');
   this.rpc.notify('notifications/initialized');this.controlRpc.notify('notifications/initialized');
   if(this.closed)throw failure('phoneuse_closed','Phone Use 客户端已关闭');
   requireValue(!this.rpc.dead&&!this.controlRpc.dead,'Phone Use 客户端初始化后已退出','phoneuse_closed');this.initialized=true;
   return results[0];
  })();
  try{return await this.starting;}catch(error){this.rpc?.close();this.controlRpc?.close();this.rpc=null;this.controlRpc=null;this.starting=null;this.initialized=false;throw error;}
 }
 async setRemoteTransport(transport){
  requireValue(transport===null||transport&&Object.keys(transport).every(key=>['dataPort','controlPort'].includes(key))&&['dataPort','controlPort'].every(key=>Number.isInteger(transport[key])&&transport[key]>0&&transport[key]<=65535)&&transport.dataPort!==transport.controlPort,'远程手机通道必须是两个不同的本机TCP端口');
  requireValue(!this.closed,'Phone Use 客户端已关闭','phoneuse_closed');
  if(JSON.stringify(this.remoteTransport||null)===JSON.stringify(transport))return {remote:!!transport,changed:false};
  requireValue(!this.active.size&&!this.rpc?.pending?.size&&!this.controlRpc?.pending?.size&&(!this.starting||this.initialized),'手机请求仍在进行，暂不切换传输','phone_transport_busy');
  this.rpc?.close();this.controlRpc?.close();this.rpc=null;this.controlRpc=null;this.starting=null;this.initialized=false;
  this.remoteTransport=transport?{dataPort:transport.dataPort,controlPort:transport.controlPort}:null;
  return {remote:!!transport,changed:true};
 }
 async invoke(rpc,tool,args,timeout){
  const result=await rpc.request('tools/call',{name:tool,arguments:args},timeout),row=result?._boujoyTransport;
  if(this.remoteTransport&&row&&['httpRequests','tlsHandshakes','receivedBytes','durationMs'].every(key=>Number.isFinite(row[key])&&row[key]>=0))
   this.onTransportMetrics?.({tool,transport:'cloud_relay',...(Number.isSafeInteger(row.tlsResumed)?{tlsResumed:row.tlsResumed}:{}),...(typeof row.peerKeepAlive==='boolean'?{peerKeepAlive:row.peerKeepAlive}:{}),...Object.fromEntries(['httpRequests','tlsHandshakes','receivedBytes','durationMs'].map(key=>[key,row[key]]))});
  return result;
 }
 async listDevices({refresh=false}={}){
  requireValue(typeof refresh==='boolean','refresh 必须为布尔值');await this.start();
  return safePublic(readResult(await this.invoke(this.rpc,'phoneuse_list_devices',{refresh},8000)));
 }
 async connect({address,deviceId,confirmPairing=false}={}){
  requireValue(typeof confirmPairing==='boolean','配对确认必须由显式布尔值提供');
  if(deviceId!==undefined)requireValue(validId(deviceId),'设备标识无效');
  if(address!==undefined){let url;try{url=new URL(address);}catch{}requireValue(url&&url.protocol==='https:'&&!url.username&&!url.password&&['','/'].includes(url.pathname)&&!url.search&&!url.hash,'手机地址必须为 HTTPS 地址');}
  await this.start();
  const args={...(address?{address}:{}),...(deviceId?{device_id:deviceId}:{}),confirm_pairing:confirmPairing};
  const connect=async()=>safePublic(readResult(await this.invoke(this.rpc,'phoneuse_connect',args,30000)));
  try{return await connect();}catch(error){
   // The official bridge clears expired pending state before returning this
   // error. One unconfirmed retry can issue a fresh code; consent never carries
   // over to it, and identity, denial, revocation or transport failures stop here.
   if(confirmPairing||error?.code!=='phoneuse_error'||error.phoneuseCode!=='PAIRING_EXPIRED')throw error;
  }
  return connect();
 }
 async status(deviceId,{requestId,signal,timeout=8000}={}){
  if(deviceId===undefined){await this.loadPending();return {closed:this.closed,ready:Boolean(this.rpc&&!this.rpc.dead),pending:[...this.pending.values()].map(row=>({...row}))};}
  requireValue(validId(deviceId),'设备标识无效');if(requestId!==undefined)requireValue(validId(requestId)&&requestId.length<=128,'动作标识无效');await this.start();
  const native=await bounded(this.invoke(this.controlRpc,'get_status',{device_id:deviceId,...(requestId?{request_id:requestId}:{})},timeout),{signal,timeout});
  return safePublic(readStatusResult(native,deviceId,requestId));
 }
 async observeForDemo(deviceId,{lease,signal}={}){
  const valid=()=>requireValue(validId(deviceId)&&this.demoLeaseGuard?.(lease,deviceId)===true&&!signal?.aborted,'示范采集已停止或未由用户启动','demo_lease_expired');valid();await this.start();valid();
  const fields={device_id:deviceId,mode:'tree',output:'legacy',compact:true,include_details:false,diagnostics:false,stable_wait_ms:0,max_attempts:1,timeout_ms:1500};
  const raw=await bounded(this.invoke(this.controlRpc,'observe',fields,2500),{signal,timeout:2500});valid();
  requireValue(!raw.content.some(block=>block.type==='image'),'示范观察不能包含截图','demo_invalid_observation');const result=readResult(raw);requireValue(result.device_id===deviceId,'示范观察设备不匹配','demo_invalid_observation');return result;
 }
 async observeForInputVerification(deviceId,options={}){
  requireValue(Object.keys(options).every(key=>key==='lease'||key==='signal'),'输入核验不接受任何可执行参数','input_verification_scope');
  const {lease,signal}=options,live=claimInputRecoveryFrame(lease,this,deviceId);
  const check=()=>requireValue(validId(deviceId)&&live?.()&&!signal?.aborted,'原输入核实授权已失效','input_verification_scope');
  check();await this.start();check();
  const raw=await bounded(this.invoke(this.controlRpc,'observe',{device_id:deviceId,...INPUT_PROOF_FRAME},6000),{signal,timeout:6000});check();
  return raw;
 }
 async pendingSummary(){
  await this.loadPending();const unresolved=[...this.pending.values()].filter(row=>!row.resolution);return {count:unresolved.length,requests:unresolved.map(row=>({requestId:row.requestId,deviceId:row.deviceId,tool:row.tool,status:row.state}))};
 }
 // Only navigation can be reconciled from a fresh foreground observation. The
 // original unknown receipt is retained; this is a separate business proof.
 // capture is supplied by the trusted driver, never by a model/tool argument.
 async reconcileNavigation(requestId,{deviceId,signal,timeout=this.navigationRecoveryTimeout,capture}={}){
  requireValue(validId(requestId)&&validId(deviceId)&&typeof capture==='function'&&Number.isFinite(timeout)&&timeout>0,'导航核实参数无效');
  const deadline=performance.now()+Math.min(timeout,NAVIGATION_PROOF_BUDGET_MS);
  const options=()=>{if(signal?.aborted)throw failure('cancelled','导航核实已停止');const remaining=Math.floor(deadline-performance.now());if(remaining<=0)throw failure('rpc_timeout','导航核实超时');return {signal,timeout:Math.min(NAVIGATION_READ_BUDGET_MS,remaining)};};
  await bounded(this.start(),options());options();
  const record=this.pending.get(keyOf(deviceId,requestId));
  if(!record)return {resolved:false,outcome:'not_pending',requestId};
  if(record.resolution)return {resolved:true,outcome:{legacy_navigation_superseded:'navigation_superseded',superseded_after_idle:'superseded_after_idle'}[record.resolution.kind]||'navigation_observed',requestId,resolution:record.resolution,nativeOutcome:record.state};
  if(record.tool!=='launch_app'||!record.navigationTarget)return {resolved:false,outcome:'requires_business_reconciliation',requestId};
  const check=await this.status(deviceId,{requestId,...options()});
  if(check.device_id!==deviceId||!validId(check.service_instance_id)||check.request?.request_id!==requestId||check.request?.state!=='unknown'||check.executing_request_id!==null)return {resolved:false,outcome:'not_quiescent',requestId};
  const frame=await bounded(capture(options()),options());const native=frame?.native;
  const state=frame?.tree?.content?.flatMap(block=>{try{return block.type==='text'?[JSON.parse(block.text).result]:[];}catch{return [];}}).find(value=>value?.windowPkg);
  options();
  const observed=native?.deviceId===deviceId&&native.serviceInstanceId===check.service_instance_id&&validId(native.observationId)&&Number.isFinite(native.at)&&this.clock()-native.at>=-1000&&this.clock()-native.at<=5000&&state?.display==='main'&&navigationPackageAllowed(record.navigationTarget,state.windowPkg)&&(state.foreground===state.windowPkg||state.foreground?.startsWith(state.windowPkg+'/'));
  if(!observed)return {resolved:false,outcome:'navigation_not_observed',requestId};
  const after=await this.status(deviceId,{requestId,...options()});
  if(after.service_instance_id!==check.service_instance_id||after.device_id!==deviceId||after.executing_request_id!==null||after.request?.request_id!==requestId||after.request?.state!=='unknown')return {resolved:false,outcome:'state_changed',requestId};
  options();
  const resolution={kind:'navigation_observed',at:this.clock(),deviceId,serviceInstanceId:native.serviceInstanceId,observationId:native.observationId,packageName:record.navigationTarget,...(state.windowPkg!==record.navigationTarget?{observedPackageName:state.windowPkg}:{})};
  await this.commit(()=>{options();this.pending.set(keyOf(deviceId,requestId),{...record,resolution});});
  return {resolved:true,outcome:'navigation_observed',requestId,resolution,nativeOutcome:record.state};
 }
 async reconcile(requestId,{deviceId,signal,timeout=8000}={}){
  requireValue(validId(requestId)&&requestId.length<=128,'动作标识无效');await this.start();
  const records=[...this.pending.values()].filter(row=>row.requestId===requestId&&(!deviceId||row.deviceId===deviceId));
  requireValue(records.length<=1,'同一动作标识属于多个设备，请指定 deviceId');
  if(!records.length)return {resolved:true,outcome:'not_pending',requestId};
  const record=records[0];let native;
  try{native=await bounded(this.invoke(this.controlRpc,'get_status',{device_id:record.deviceId,request_id:record.requestId},timeout),{signal,timeout});}
  catch(error){if(error.code==='cancelled')throw error;return {resolved:false,outcome:'unknown',deviceId:record.deviceId,requestId};}
  const check=proof(native,record,{status:true}),resolved=TERMINAL.has(check.outcome);
  if(resolved)await this.commit(()=>this.pending.delete(keyOf(record.deviceId,record.requestId)));
  return {resolved,outcome:check.outcome,deviceId:record.deviceId,requestId,result:safePublic(check.result)};
 }
 // A fresh screen or idle service does not prove that a prior effect failed.
 // Only a terminal native receipt can release it here; bound navigation proof
 // is handled by reconcileNavigation, without dispatching any replacement.
 async settleUnknown(record,parameters,{signal}={}){
  this.idleInstance=null; // A failed/busy status must invalidate an earlier idle observation.
  const navigation=record.tool==='launch_app';
  const hopBudget=navigation?Math.min(this.controlTimeout*2,NAVIGATION_READ_BUDGET_MS):this.controlTimeout;
  const deadline=performance.now()+(navigation?Math.min(this.navigationRecoveryTimeout,2*hopBudget):hopBudget);
  const read=async args=>{
   const remaining=Math.min(hopBudget,Math.floor(deadline-performance.now()));
   if(remaining<=0||signal?.aborted)throw failure(signal?.aborted?'cancelled':'rpc_timeout','原动作状态核验已停止');
   return bounded(this.invoke(this.controlRpc,'get_status',args,remaining),{signal,timeout:remaining});
  };
  let forgotten=false;
  try{
   const native=await read({device_id:record.deviceId,request_id:record.requestId});
   try{forgotten=unwrapPhoneUseMcp(native)?.error?.code==='REQUEST_NOT_FOUND';}catch{}
   // Remember that the phone just reported itself idle (nothing executing) and which
   // service instance it is: the proof an old open-app can be superseded.
   try{const st=unwrapPhoneUseMcp(native);if(st?.device_id===record.deviceId&&validId(st.service_instance_id)&&st.executing_request_id===null&&st.paused!==true&&st.stopped!==true)this.idleInstance={deviceId:record.deviceId,id:st.service_instance_id,at:this.clock()};}catch{}
   const check=proof(native,record,{status:true});
   if(TERMINAL.has(check.outcome)&&!signal?.aborted)await this.commit(()=>this.pending.delete(keyOf(record.deviceId,record.requestId)));
  }catch(error){if(error.code==='cancelled')throw error;}
  // After the phone app restarts (an update, a reboot) it no longer retains the old
  // request and answers REQUEST_NOT_FOUND; ask for its plain status as well, so an
  // idle phone can still be seen as idle.
  if(forgotten&&!this.idleInstance&&!signal?.aborted){
   try{
    const plain=await read({device_id:record.deviceId});
    const st=unwrapPhoneUseMcp(plain);
    if(st?.device_id===record.deviceId&&validId(st.service_instance_id)&&st.executing_request_id===null&&st.paused!==true&&st.stopped!==true)this.idleInstance={deviceId:record.deviceId,id:st.service_instance_id,at:this.clock()};
   }catch(error){if(error.code==='cancelled')throw error;}
  }
 }
 async cancelAndConfirm(record){
  // cancel_requested is an acknowledgement, never proof of non-execution.
  const deadline=this.clock()+this.controlTimeout;
  try{
   await bounded(this.invoke(this.controlRpc,'cancel',{device_id:record.deviceId,request_id:record.requestId},this.controlTimeout),{timeout:this.controlTimeout});
   const remaining=Math.max(1,deadline-this.clock());
   const native=await bounded(this.invoke(this.controlRpc,'get_status',{device_id:record.deviceId,request_id:record.requestId},remaining),{timeout:remaining});
   return {native,...proof(native,record,{status:true})};
  }catch{return {outcome:'unknown'};}
 }
 // Called on lease release, target switch, or observation of a different app/service.
 limitControllerNavigation(taskId,packageName,instance){
  const grant=this.controllerNavigation;
  if(grant&&(grant.taskId!==taskId||grant.packageName!==packageName||instance!==undefined&&instance!==grant.instance))this.controllerNavigation=null;
 }
 // The old record stays on disk and unresolved. This temporary permit belongs
 // only to an authenticated new task, its exact target and this transport pair.
 async controllerPermit(old,record,parameters,options){
  const {controller:ctx,signal}=options;
  if(!ctx||old.tool!=='back'||old.state!=='unknown'||!validId(old.serviceInstanceId)||!this.remoteTransport||this.active.has(old.deviceId)||ctx.createdAt<this.controllerBootAt)return null;
  const rpc=this.rpc,controlRpc=this.controlRpc;
  const unique=(ownId)=>{
   const other=[...this.pending.values()].filter(row=>row.deviceId===old.deviceId&&!row.resolution&&row.requestId!==ownId);
   const active=this.active.get(old.deviceId);
   return !this.closed&&!signal?.aborted&&rpc===this.rpc&&controlRpc===this.controlRpc&&!rpc.dead&&!controlRpc.dead&&(!active||active.record.requestId===ownId)&&other.length===1&&other[0]===old&&ctx.valid(old);
  };
  if(!unique())return null;
  const grant=this.controllerNavigation;
  if(ctx.operation!=='launch'){
   const frame=options.controllerFrame;
   const fresh=()=>grant&&this.controllerNavigation===grant&&grant.key===ctx.key&&grant.oldRequestId===old.requestId&&grant.signal===signal&&grant.rpc===rpc&&grant.controlRpc===controlRpc&&this.clock()<grant.expiresAt&&performance.now()<grant.endMono&&frame?.deviceId===old.deviceId&&frame.serviceInstanceId===grant.instance&&frame.packageName===ctx.packageName&&validId(frame.observationId)&&frame.observationId===parameters.observation_id&&frame.windowId===parameters.expected_window_id&&frame.at>=grant.executedAt&&this.clock()-frame.at>=-1000&&this.clock()-frame.at<=5000;
   if(nativeWindowConflict(frame)||!(ctx.operation==='general_tap'&&record.tool==='tap'||ctx.operation==='general_scroll'&&record.tool==='swipe')||!fresh())return null;
   return {check:()=>unique(record.requestId)&&fresh()&&!nativeWindowConflict(frame)};
  }
  if(record.tool!=='launch_app'||record.navigationTarget!==ctx.packageName||typeof options.captureController!=='function'||ctx.used()||grant?.key===ctx.key)return null;
  const deadline=performance.now()+Math.min(this.navigationRecoveryTimeout,NAVIGATION_PROOF_BUDGET_MS);
  const readOptions=()=>{
   const timeout=Math.min(NAVIGATION_READ_BUDGET_MS,Math.floor(deadline-performance.now()));
   if(timeout<=0||!unique())throw failure('outcome_pending','导航核验期间控制状态已变化',old);
   return {signal,timeout};
  };
  const idle=state=>state.device_id===old.deviceId&&state.service_instance_id===old.serviceInstanceId&&state.stopped===false&&notPaused(state)&&state.executing_request_id===null;
  const forgotten=async()=>{
   const o=readOptions(),raw=await bounded(this.invoke(controlRpc,'get_status',{device_id:old.deviceId,request_id:old.requestId},o.timeout),o),state=unwrapPhoneUseMcp(raw);
   return state.error?.code==='REQUEST_NOT_FOUND'&&(!state.device_id||state.device_id===old.deviceId)&&(!state.service_instance_id||state.service_instance_id===old.serviceInstanceId)&&(!state.request_id||state.request_id===old.requestId)&&(!state.request?.request_id||state.request.request_id===old.requestId)&&(!state.error?.request_id||state.error.request_id===old.requestId);
  };
  try{
   const first=await this.status(old.deviceId,readOptions());if(!idle(first)||!await forgotten())return null;
   const o=readOptions(),frame=await bounded(options.captureController(o),o),native=frame?.native;
   const page=frame?.tree?.content?.flatMap(block=>{try{const envelope=block.type==='text'&&JSON.parse(block.text);return envelope?.ok===true?[envelope.result]:[];}catch{return [];}}).find(value=>value?.windowPkg);
   const home=ANDROID_PACKAGE;
   if(nativeWindowConflict(native)||native?.deviceId!==old.deviceId||native.serviceInstanceId!==old.serviceInstanceId||native.packageName!==home||!validId(native.observationId)||!Number.isFinite(native.at)||page?.display!=='main'||page.windowPkg!==home||!(page.foreground===home||page.foreground?.startsWith(home+'/')))return null;
   if(!await forgotten()||!idle(await this.status(old.deviceId,readOptions())))return null;
   const fresh=()=>this.clock()-native.at>=-1000&&this.clock()-native.at<=5000&&performance.now()<deadline;
   if(!unique()||!fresh()||ctx.used())return null;
   return {launch:true,check:()=>unique(record.requestId)&&fresh()&&!ctx.used(),live:()=>unique(record.requestId)&&fresh(),record:()=>ctx.record({requestId:old.requestId,newRequestId:record.requestId,observationId:native.observationId}),
    executed:native=>{if(unwrapPhoneUseMcp(native).service_instance_id!==old.serviceInstanceId)return;this.controllerNavigation={key:ctx.key,taskId:ctx.taskId,packageName:ctx.packageName,oldRequestId:old.requestId,instance:old.serviceInstanceId,rpc,controlRpc,signal,executedAt:this.clock(),expiresAt:this.clock()+120000,endMono:performance.now()+120000};}};
  }catch{return null;}
 }
 async call(deviceId,tool,args={},options={}){
  const {signal,timeout=8000}=options,effect=ACTION.has(tool);
  requireValue(validId(deviceId),'设备标识无效');requireValue(READ.has(tool)||effect||CONTROL.has(tool),'不允许调用此 Phone Use 工具','phoneuse_tool_denied');
  requireValue(args&&typeof args==='object'&&!Array.isArray(args),'工具参数必须为对象');requireValue(Number.isFinite(timeout)&&timeout>0&&timeout<=90000,'请求超时必须在 1–90000 毫秒内');
  requireValue(args.device_id===undefined||args.device_id===deviceId,'参数中的设备标识与当前设备不一致','phoneuse_device_mismatch');
  if(signal?.aborted)throw failure(effect?'action_cancelled':'cancelled','任务已停止，动作未发送到手机');
  let parameters;try{parameters=JSON.parse(JSON.stringify(args));}catch{throw failure('invalid_input','工具参数不可序列化');}parameters.device_id=deviceId;
  await this.start();if(signal?.aborted||this.closed)throw failure(effect?'action_cancelled':'cancelled','任务已停止，动作未发送到手机');
  if(!effect){
   const started=performance.now();
   for(let attempt=0;;attempt++){
    try{const remaining=Math.max(1,Math.floor(timeout-(performance.now()-started)));const result=await bounded(this.invoke(['get_status','cancel'].includes(tool)?this.controlRpc:this.rpc,tool,parameters,remaining),{signal,timeout:remaining});readResult(result);return result;}
    catch(error){
     if(READ.has(tool))error.dispatchState='not_sent';
     if(attempt||!READ.has(tool)||!transientTransport(error)||signal?.aborted||this.closed||timeout-(performance.now()-started)<1500)throw error;
     await new Promise(resolve=>setTimeout(resolve,400));await this.start();
    }
   }
  }
  parameters.request_id??=this.uuid();requireValue(validId(parameters.request_id)&&parameters.request_id.length<=128,'动作标识无效');
  const record={deviceId,requestId:parameters.request_id,tool,createdAt:this.clock(),state:'sending',...(validId(parameters.service_instance_id)?{serviceInstanceId:parameters.service_instance_id}:{}),...(tool==='launch_app'&&/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(parameters.package_name||'')?{navigationTarget:parameters.package_name}:{})},key=keyOf(deviceId,record.requestId);
  let old=[...this.pending.values()].find(row=>row.deviceId===deviceId&&!row.resolution);
  // Recovery has its own bounded control budget: cloud identity verification plus
  // the original terminal receipt must be confirmed before any new effect is sent.
  const controllerCandidate=old?.tool==='back'&&options.controller;
  const permit=controllerCandidate?await this.controllerPermit(old,record,parameters,options):null;
  if(old&&!permit&&!this.active.has(deviceId)){await this.settleUnknown(old,parameters,{signal});old=[...this.pending.values()].find(row=>row.deviceId===deviceId&&!row.resolution);}
  // An unconfirmed "open app" has no lasting effect (it only changes what is in the
  // foreground, and every new step re-reads the screen). Once it is two minutes old
  // and the phone has just reported itself idle, the next action supersedes it
  // instead of the phone staying blocked for good; any other unconfirmed action
  // (typing, tapping, sending) still blocks.
  const idle=this.idleInstance?.deviceId===deviceId&&this.clock()-this.idleInstance.at<15000?this.idleInstance.id:null;
  // Navigation (open an app, back, home, recents, scroll/swipe) commits nothing: at
  // worst the screen is somewhere else, and every next step re-reads the screen.
  // An unconfirmed navigation step therefore never blocks the phone: it is
  // superseded as soon as the phone itself reports that it is idle (nothing
  // executing, not paused). A busy, paused or unreachable phone, or a request it
  // still holds, keeps it in place. Unconfirmed taps and typing still block.
  const navigationOld=old&&NAVIGATION_TOOLS.has(old.tool)&&!this.active.has(deviceId);
  if(navigationOld&&idle){
   const resolution={kind:'superseded_after_idle',nativeOutcome:old.state==='unknown'?'unknown':'not_retained',at:this.clock(),deviceId,serviceInstanceId:idle,newRequestId:record.requestId,newTool:tool};
   await this.commit(()=>{this.pending.set(keyOf(old.deviceId,old.requestId),{...old,state:'unknown',resolution});});
   old=[...this.pending.values()].find(row=>row.deviceId===deviceId&&!row.resolution);
  }
  // A tap, long press or typing whose result never came back is not replayed and its own
  // task has been told the result is unknown. It used to block the phone for good, until
  // the service was restarted. Once it is fifteen seconds old and the phone itself reports
  // that nothing is executing, the next action (decided on a fresh reading of the screen)
  // supersedes it. A phone that is busy, paused or unreachable keeps it in place.
  const effectOld=old&&!NAVIGATION_TOOLS.has(old.tool)&&!this.active.has(deviceId)&&this.clock()-old.createdAt>=UNCONFIRMED_EFFECT_EXPIRY_MS;
  if(effectOld&&idle){
   const resolution={kind:'expired_after_idle',nativeOutcome:'unknown',at:this.clock(),deviceId,serviceInstanceId:idle,newRequestId:record.requestId,newTool:tool};
   await this.commit(()=>{this.pending.set(keyOf(old.deviceId,old.requestId),{...old,state:'unknown',resolution});});
   old=[...this.pending.values()].find(row=>row.deviceId===deviceId&&!row.resolution);
  }
  if(old&&!permit){const error=failure(old.state==='unknown'?'outcome_unknown':'outcome_pending','上一动作尚未核实，请查询原 request_id，不能重放或继续新动作。',old);error.dispatchState='not_sent';throw error;}
  if(this.active.has(deviceId))throw failure('outcome_pending','同一设备已有在途动作，请等待原动作结果。',this.active.get(deviceId).record);
  if(this.completed.has(key)||this.pending.has(key))throw failure('request_id_reused','动作标识已使用，请观察后为新动作生成新标识。',record);
  const abort=new AbortController(),onAbort=()=>abort.abort();signal?.addEventListener('abort',onAbort,{once:true});
  const active={record,abort};this.active.set(deviceId,active);
  let sent=false,native,check;
  try{
   await this.commit(()=>{this.pending.set(key,record);});
   if(signal?.aborted||abort.signal.aborted||this.closed){await this.commit(()=>this.pending.delete(key));throw failure('action_cancelled','任务已停止，动作未发送到手机',record);}
   if(permit){
    if(!permit.check()){await this.commit(()=>this.pending.delete(key));throw Object.assign(failure('outcome_pending','导航授权已失效，动作未发送',old),{dispatchState:'not_sent'});}
    try{permit.record?.();if(permit.live&&!permit.live())throw Object.assign(failure('outcome_pending','导航授权已变化',old),{dispatchState:'not_sent'});}catch(error){await this.commit(()=>this.pending.delete(key));throw error;}
   }
   sent=true;
   try{native=await bounded(this.invoke(this.rpc,tool,parameters,timeout),{signal:abort.signal,timeout});check=proof(native,record);}
   catch{const cancelled=await this.cancelAndConfirm(record);native=cancelled.native;check=cancelled;}
   if(TERMINAL.has(check.outcome)){
    await this.commit(()=>this.pending.delete(key));this.completed.set(key,this.clock());
    for(const [used,at] of this.completed)if(this.clock()-at>600000)this.completed.delete(used);
    if(check.outcome==='cancelled')throw failure('action_cancelled','已核实取消，动作没有执行',record);
    if(permit?.launch&&check.outcome==='executed'&&!signal?.aborted)permit.executed(native);
    return native;
   }
   // The pre-dispatch sending record remains sufficient if this update fails.
   try{await this.commit(()=>this.pending.set(key,{...record,state:check.outcome==='pending'?'pending':'unknown'}));}catch{}
   throw failure(check.outcome==='pending'?'outcome_pending':'outcome_unknown','动作结果尚未核实，已暂停后续动作；请查询原 request_id，不要重放。',record);
  }catch(error){
   if(sent&&!['action_cancelled','outcome_pending','outcome_unknown'].includes(error.code)){
    const unknown=failure('outcome_unknown','动作已发送，但状态记录未完成核实；请查询原 request_id，不要重放。',record);throw unknown;
   }
   throw error;
  }finally{signal?.removeEventListener('abort',onAbort);if(this.active.get(deviceId)===active)this.active.delete(deviceId);}
 }
 async close(){
  if(this.closing)return this.closing;this.closed=true;this.controllerNavigation=null;
  this.closing=(async()=>{
   for(const active of this.active.values())active.abort.abort();
   // Keep the independent control process alive until interrupted actions have
   // had one bounded chance to obtain proof. Durable journals survive failure.
   const deadline=Date.now()+this.controlTimeout+1000;
   while(this.active.size&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
   if(this.starting)await this.starting.catch(()=>{});
   this.rpc?.close();this.controlRpc?.close();await this.writing;
  })();return this.closing;
 }
}
