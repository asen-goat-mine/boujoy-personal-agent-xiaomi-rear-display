import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {RemoteState,RemoteSecrets,ensureIdentity,certificateStatus,atomicJSON} from './state.mjs';
import {DISTRIBUTION,ANDROID_PACKAGE,BACKGROUND_SUPPORTED} from '../distribution.mjs';
import {createGateway} from './gateway.mjs';
import {MacConnector} from './transport.mjs';
import {hash,assert} from './protocol.mjs';
import {AppError} from '../core/errors.mjs';

export class RemoteService{
 constructor({dataDir,store,engine,phone,voice,removeRole,secrets=new RemoteSecrets(),log=()=>{},clock=Date.now,identityOptions={},maintenanceIntervalMs=86400000,gatewayFactory=createGateway,connectorFactory=options=>new MacConnector(options)}){
  Object.assign(this,{dataDir,store,engine,phone,voice,removeRole,secrets,log,clock,identityOptions,maintenanceIntervalMs,gatewayFactory,connectorFactory});this.state=new RemoteState(dataDir);this.engine.remoteControlState=()=>this.state.data.control;this.configPath=path.join(dataDir,'remote/config.json');this.connector=null;this.gateway=null;this.identity=null;this.starting=null;this.maintaining=null;this.maintenanceTimer=null;this.closed=false;this.error=null;this.identityMaintenance={maintenanceState:'identity_unavailable',lastCheckedAt:null,lastRenewedAt:null,error:null};this.latestDeviceTelemetry=null;this.transportGeneration=null;this.phone.remoteDeviceTelemetry=()=>this.deviceTelemetry();this.phone.remoteControlState=()=>this.state.data.control;this.phone.ime={request:({text,mode,packageName})=>{const typing=this.gateway?.typing,active=Object.values(this.state.data.devices).filter(device=>device.active);if(!typing||this.closed||this.state.data.control?.paused||active.length!==1){const error=new AppError('phone_input_unavailable','手机输入法通道还没连上，或手机控制已暂停',409);error.dispatchState='not_sent';throw error;}return typing.request({deviceId:active[0].id,text,mode,packageName});}};this.phone.ime.verify=input=>this.verifyInput(input);this.phone.displayBackend={telemetry:()=>this.deviceTelemetry()?.displayBackend||null,deviceId:()=>this.deviceTelemetry()?.deviceId||null,request:(op,args,options)=>this.displayRequest(op,args,options)};this.phone.remoteAttachments={prepareShare:input=>{assert(this.gateway&&!this.closed&&!this.phone.remoteMaintenance,'Remote attachment transport unavailable');return this.gateway.attachments.prepareShare(input);},shareStatus:id=>{assert(this.gateway&&!this.closed&&!this.phone.remoteMaintenance,'Remote attachment transport unavailable');return this.gateway.attachments.shareStatus(id);}};
 }
 async verifyInput({text,packageName,referenceId,controlEpoch}={}){
  const telemetry=this.deviceTelemetry(),typing=this.gateway?.typing;
  const eligible=()=>!this.closed&&!this.phone.remoteMaintenance&&this.gateway?.typing===typing&&this.state.data.control?.paused===false&&this.state.data.control.controlEpoch===controlEpoch&&this.deviceTelemetry()?.deviceId===telemetry?.deviceId&&this.deviceTelemetry()?.certificateFingerprint===telemetry?.certificateFingerprint&&this.deviceTelemetry()?.typingProtocol===2;
  if(!typing||!telemetry||telemetry.typingProtocol!==2||!eligible())throw new AppError('typing_verification_unavailable','当前手机尚不支持安全的只读输入核验，原动作保持未知',409);
  const result=await typing.request({deviceId:telemetry.deviceId,text,mode:'replace',packageName,operation:'verify_replace',referenceId,controlEpoch});
  if(!eligible())throw new AppError('typing_verification_changed','输入核验期间控制或设备身份已变化',409);
  return result;
 }
 // Background-display commands go only to the authenticated, currently bound phone
 // and only while its control generation is admitted.
 async displayRequest(op,args,{session=null,taskId=null,timeoutMs=20000,signal}={}){
  if(!BACKGROUND_SUPPORTED){const error=new AppError('background_not_supported','此发行版不支持后台显示执行',409);error.dispatchState='not_sent';throw error;}
  const telemetry=this.deviceTelemetry(),display=this.gateway?.display,control=this.state.data.control;
  const unavailable=message=>Object.assign(new AppError('display_backend_unavailable',message,409),{dispatchState:'not_sent'});
  if(!display||!telemetry||this.closed||this.phone.remoteMaintenance)throw unavailable('手机 Boujoy 当前没有通过加密连接在线');
  if(control?.paused!==false)throw Object.assign(new AppError('phone_control_paused','手机控制已暂停，这次没有动手机。',409),{dispatchState:'not_sent'});
  if(signal?.aborted)throw Object.assign(new AppError('action_cancelled','任务已停止，动作未发送到手机',409),{dispatchState:'not_sent'});
  return display.request({deviceId:telemetry.deviceId,op,args,session,controlEpoch:control.controlEpoch,taskId,timeoutMs,signal});
 }
 config(){return fs.existsSync(this.configPath)?JSON.parse(fs.readFileSync(this.configPath,'utf8')):null;}
 identityStatus(){let status={validFrom:null,expiresAt:null,daysRemaining:null,needsMaintenance:false};try{const cert=this.identity?.cert||fs.readFileSync(path.join(this.dataDir,'remote/gateway.crt'),'utf8');status=certificateStatus(cert,this.clock());}catch{status.needsMaintenance=!!this.config()?.enabled;}
  return {...status,...this.identityMaintenance,needsMaintenance:status.needsMaintenance||['failed','identity_unavailable'].includes(this.identityMaintenance.maintenanceState)&&!!this.config()?.enabled};
 }
 deviceTelemetry(){const value=this.latestDeviceTelemetry,connection=this.connector?.status(),ageMs=value?this.clock()-Date.parse(value.receivedAt):Infinity;if(!value?.timezone||this.closed||this.phone.remoteMaintenance||!connection?.dataConnected||!connection?.controlConnected||!Number.isFinite(ageMs)||ageMs<0||ageMs>30000||this.state.device(value.certificateFingerprint)?.id!==value.deviceId||this.config()?.deviceId!==value.deviceId)return null;return {...value,ageMs,fresh:true};}
 status(){const config=this.config();return {configured:!!config?.enabled,relayUrl:config?.relayUrl||null,deviceBound:Object.values(this.state.data.devices).some(d=>d.active),control:this.state.data.control,connection:this.connector?.status()||null,gateway:this.gateway?.diagnostics?.()||null,identity:this.identityStatus(),notificationDelivery:this.store.data.remoteNotificationDelivery?.[config?.deviceId]||null,deviceTelemetry:this.deviceTelemetry(),error:this.error};}
 busy(){const client=this.phone.phoneUse?.client;return !!(this.engine.active.size||this.phone.lease||this.store.data.tasks.some(t=>['queued','running','waiting_approval','waiting_children'].includes(t.status))||client?.active?.size||client?.rpc?.pending?.size||client?.controlRpc?.pending?.size||client?.starting&&!client.initialized);}
 scheduleMaintenance(){if(!this.maintenanceTimer&&!this.closed){this.maintenanceTimer=setInterval(()=>{void this.maintainIdentity().catch(()=>{});},this.maintenanceIntervalMs);this.maintenanceTimer.unref();}}
 pauseForMaintenance(){
  this.phone.remoteMaintenance=true;
  this.state.update(s=>{
   const previous=s.control,eligible=!previous.paused?previous.controlEpoch:previous.reason==='maintenance'&&Number.isSafeInteger(previous.maintenanceResumeEpoch)&&previous.maintenanceResumeEpoch>=0&&previous.maintenanceResumeEpoch<previous.controlEpoch?previous.maintenanceResumeEpoch:null;
   // A restart must never disguise a user's stop, a lock-screen pause, or an
   // unknown legacy pause as maintenance. Repeated maintenance retains the
   // last explicitly admitted generation, rather than inventing a new grant.
   s.control={...previous,paused:true,controlEpoch:previous.controlEpoch+1};
   if(eligible!==null)s.control={controlEpoch:previous.controlEpoch+1,paused:true,reason:'maintenance',maintenanceResumeEpoch:eligible,pausedAt:new Date(this.clock()).toISOString()};
   else delete s.control.maintenanceResumeEpoch;
  });
  this.connector?.pause();
 }
 async closeTransport(){const connector=this.connector,gateway=this.gateway;this.connector=null;this.gateway=null;this.transportGeneration=null;this.latestDeviceTelemetry=null;const results=await Promise.allSettled([connector?.close(),gateway?.close()]);const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'Remote transport failed to close');}
 async openTransport(identity){
  assert(!this.closed,'Remote service is closed');const config=this.config(),token=await this.secrets.get('mac-route');assert(token,'Remote route credential missing');assert(!this.closed,'Remote service is closed');
  const generation=Symbol('remote-transport');this.transportGeneration=generation;this.latestDeviceTelemetry=null;
  let ownedGateway,ownedConnector;try{
  this.gateway=this.gatewayFactory({identity,state:this.state,store:this.store,engine:this.engine,phone:this.phone,voice:this.voice,removeRole:this.removeRole,dataDir:this.dataDir,onTlsError:code=>this.log('remote-tls',code),onRequestError:code=>this.log('remote-request',code),onControl:async control=>{if(control.paused)this.connector?.pause();},onDeviceStatus:value=>{if(!this.closed&&this.transportGeneration===generation)this.latestDeviceTelemetry=value;}});ownedGateway=this.gateway;const gatewayPort=await ownedGateway.listen();assert(!this.closed,'Remote service is closed');
  this.connector=this.connectorFactory({config:{...config,macRouteToken:token},gatewayPort,onStatus:status=>{if(this.transportGeneration===generation&&(!status.dataConnected||!status.controlConnected)){this.latestDeviceTelemetry=null;ownedGateway?.disconnectWorkspace?.();}},controlState:()=>{const control=this.state.data.control,owner=this.store.data.tasks.find(t=>t.id===this.phone.lease);return owner?.remoteDeviceId&&owner.remoteControlEpoch!==control.controlEpoch?{...control,paused:true}:control;}});ownedConnector=this.connector;await ownedConnector.start();assert(!this.closed,'Remote service is closed');
  const ports=this.connector.status();await this.phone.setRemoteTransport?.({dataPort:ports.phoneDataPort,controlPort:ports.phoneControlPort});assert(!this.closed,'Remote service is closed');this.phone.remoteMaintenance=false;
  }catch(error){const cleanup=await Promise.allSettled([ownedConnector?.close(),ownedGateway?.close()]);if(this.connector===ownedConnector)this.connector=null;if(this.gateway===ownedGateway)this.gateway=null;const errors=cleanup.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError([error,...errors],'Remote start was cancelled and cleanup failed');throw error;}
 }
 recordIdentity(identity){this.identity=identity;this.identityMaintenance={...this.identityMaintenance,maintenanceState:identity.renewalDeferred?'deferred_active':identity.renewed?'renewed':identity.certificate.needsMaintenance?'renewal_due':'ready',lastCheckedAt:new Date(this.clock()).toISOString(),...(identity.renewed?{lastRenewedAt:new Date(this.clock()).toISOString()}:{}),error:null};}
 async configure({relayUrl}){
  assert(!this.engine.active.size,'Finish active tasks before changing the connection');const url=new URL(relayUrl);assert(url.protocol==='wss:'&&url.pathname==='/v1/tunnel'&&!url.username&&!url.password&&!url.search&&!url.hash,'Relay URL must be WSS /v1/tunnel');
  const old=this.config();if(old?.enabled&&old.relayUrl!==relayUrl)throw Error('Changing a relay requires explicit disconnect first');
  const deviceId=old?.deviceId||randomUUID();let mac=await this.secrets.get('mac-route'),android=await this.secrets.get('android-route');
  if(!mac){mac=randomBytes(32).toString('base64url');await this.secrets.set('mac-route',mac);}if(!android){android=randomBytes(32).toString('base64url');await this.secrets.set('android-route',android);}
  atomicJSON(this.configPath,{version:1,enabled:true,deviceId,relayUrl});
  // Only hashes leave this host for the relay's route table.
  const routesFile=path.join(this.dataDir,'remote/relay-routes.json');atomicJSON(routesFile,{[deviceId]:{macTokenHash:hash(mac),androidTokenHash:hash(android),enabled:true}});
  await this.start();return {...this.status(),routesFile};
 }
 async start(){
  if(this.store.data.recoveryFence?.required){this.error='recovery_confirmation_required';return this.status();}
  if(this.starting)return this.starting;if(this.maintaining){await this.maintaining;return this.status();}if(this.connector)return this.status();const config=this.config();if(!config?.enabled)return this.status();this.closed=false;
  this.starting=(async()=>{try{
   const identity=await ensureIdentity(this.dataDir,this.secrets,{...this.identityOptions,now:this.clock,canRenew:()=>!this.closed&&!this.busy()});this.recordIdentity(identity);assert(!identity.certificate.expired&&!identity.certificate.notYetValid,'Gateway certificate is not currently valid');assert(!this.closed,'Remote service is closed');
   this.pauseForMaintenance();await this.openTransport(identity);this.error=null;return this.status();
  }catch(error){this.error=error.code||'remote_start_failed';this.identityMaintenance={...this.identityMaintenance,maintenanceState:'failed',lastCheckedAt:new Date(this.clock()).toISOString(),error:this.error};this.log('remote',this.error);await this.closeTransport();throw error;}finally{this.starting=null;this.scheduleMaintenance();}})();return this.starting;
 }
 async maintainIdentity(){
  if(this.maintaining)return this.maintaining;if(this.closed||this.starting||!this.config()?.enabled||this.store.data.recoveryFence?.required)return this.status();
  this.identityMaintenance.lastCheckedAt=new Date(this.clock()).toISOString();
  if(this.busy()){if(this.identityStatus().needsMaintenance)this.identityMaintenance.maintenanceState='deferred_active';return this.status();}
  this.maintaining=(async()=>{let closing=null;try{
   const identity=await ensureIdentity(this.dataDir,this.secrets,{...this.identityOptions,now:this.clock,canRenew:()=>!this.closed&&!this.busy(),beforeRenewalCommit:()=>{
    if(this.closed||this.busy()||this.store.data.recoveryFence?.required)return false;
    this.identityMaintenance.maintenanceState='renewing';this.pauseForMaintenance();closing=this.closeTransport();closing.catch(()=>{});return true;
   }});
   if(this.closed){await closing;return this.status();}this.recordIdentity(identity);
   if(identity.renewalDeferred)return this.status();
   if(closing||!this.connector){await closing;if(!closing)this.pauseForMaintenance();await this.openTransport(identity);}
   this.error=null;return this.status();
  }catch(error){await closing?.catch(()=>{});if(closing)await this.closeTransport();this.error=error.code||'gateway_renewal_failed';this.identityMaintenance={...this.identityMaintenance,maintenanceState:'failed',error:this.error};this.log('remote',this.error);throw error;}finally{this.maintaining=null;}})();return this.maintaining;
 }
 async pairing(){const config=this.config();assert(config?.enabled,'Configure remote connection first');assert(!Object.values(this.state.data.devices).some(d=>d.active),'Device already bound');if(!this.identity)await this.start();assert(this.identity,'Gateway identity unavailable');const issued=this.state.issuePairing({deviceId:config.deviceId});return {version:1,edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,relayUrl:config.relayUrl,deviceId:config.deviceId,routeToken:await this.secrets.get('android-route'),gatewayPin:this.identity.pin,pairToken:issued.pairToken,expiresAt:issued.expiresAt};}
 async pause(){if(this.gateway)await this.gateway.pause();else{this.state.update(s=>{s.control={paused:true,controlEpoch:s.control.controlEpoch+1,reason:'user_takeover',pausedAt:new Date(this.clock()).toISOString()};});const owner=this.phone.lease;if(owner)await this.engine.stop(owner,{pause:true});}return this.status();}
 async revoke(){const config=this.config();if(config){this.state.revoke(config.deviceId);this.gateway?.disconnectWorkspace?.();this.connector?.pause();const owner=this.phone.lease;if(owner)await this.engine.stop(owner,{pause:true});}return this.status();}
 async close(){this.closed=true;clearInterval(this.maintenanceTimer);this.maintenanceTimer=null;await this.closeTransport();await this.starting?.catch(()=>{});await this.maintaining?.catch(()=>{});await this.closeTransport();}
}
