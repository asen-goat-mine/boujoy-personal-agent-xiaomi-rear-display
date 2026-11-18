#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {RelayClient} from '../src/remote/transport.mjs';
import {validId} from '../src/remote/protocol.mjs';

// Only dedicated disposable route credentials are accepted. This module never
// loads the application's configuration, Keychain, device bindings or gateway.
class SmokeError extends Error {constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new SmokeError(code);};
const ms=since=>Math.round(performance.now()-since);

function readCredentials(filename){
  if(typeof filename!=='string'||!path.isAbsolute(filename))fail('credentials_path_invalid');
  let fd;
  try{
    fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.size>4096||stat.size<2||(stat.mode&0o077)!==0||
      (process.getuid&&stat.uid!==process.getuid()))fail('credentials_file_unprotected');
    const value=JSON.parse(fs.readFileSync(fd,'utf8'));
    if(!value||Array.isArray(value)||typeof value!=='object'||
      Object.keys(value).sort().join(',')!=='androidToken,deviceId,macToken'||!validId(value.deviceId))fail('credentials_schema_invalid');
    for(const key of ['macToken','androidToken'])if(typeof value[key]!=='string'||
      !/^[a-zA-Z0-9_-]{32,512}$/.test(value[key]))fail('credentials_schema_invalid');
    if(value.macToken===value.androidToken)fail('credentials_schema_invalid');
    return value;
  }catch(error){if(error instanceof SmokeError)throw error;fail('credentials_file_invalid');}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}

function validateOptions({url,timeoutMs,allowLoopbackTest}){
  if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')fail('tls_validation_disabled');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000)fail('timeout_invalid');
  let target;try{target=new URL(url);}catch{fail('relay_url_invalid');}
  const local=allowLoopbackTest===true&&target.protocol==='ws:'&&['127.0.0.1','localhost','[::1]'].includes(target.hostname);
  if((target.protocol!=='wss:'&&!local)||target.pathname!=='/v1/tunnel'||target.username||target.password||target.search||target.hash)fail('relay_url_invalid');
}

function abortable(promise,signal){
  if(signal.aborted)return Promise.reject(signal.reason);
  return new Promise((resolve,reject)=>{
    const abort=()=>{cleanup();reject(signal.reason);};
    const cleanup=()=>signal.removeEventListener('abort',abort);
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}
async function until(predicate,signal){
  while(!predicate())await delay(20,undefined,{signal});
  if(signal.aborted)throw signal.reason;
}

/** Exercise only the public relay framing with fresh opaque synthetic bytes.
 * This does not establish the inner device mTLS or execute a phone/business task.
 * Returns a redacted report; errors, URLs, identities and tokens are never output.
 */
export async function verifyDeployedRelay({url,credentialsPath,timeoutMs=30000,allowLoopbackTest=false,signal:externalSignal}={}){
  const started=performance.now(),checks=[],clients=[],controller=new AbortController();
  const {signal}=controller;let stage='configuration',timer;
  const interrupt=()=>controller.abort(new SmokeError('interrupted'));
  const check=async(name,run)=>{
    stage=name;const began=performance.now();
    try{await run();if(signal.aborted)throw signal.reason;checks.push({name,ok:true,durationMs:ms(began)});}
    catch(error){checks.push({name,ok:false,durationMs:ms(began)});throw error;}
  };
  const dispose=client=>{client.close();client.ws?.terminate();};
  try{
    validateOptions({url,timeoutMs,allowLoopbackTest});
    const credentials=readCredentials(credentialsPath);
    timer=setTimeout(()=>controller.abort(new SmokeError('deadline_exceeded')),timeoutMs);
    if(externalSignal?.aborted)interrupt();else externalSignal?.addEventListener('abort',interrupt,{once:true});
    if(signal.aborted)throw signal.reason;
    const make=(role,lane,routeToken=credentials[role+'Token'])=>{
      const client=new RelayClient({url,deviceId:credentials.deviceId,routeToken,role,lane,reconnect:false,allowLoopback:allowLoopbackTest,
        onStream:stream=>{
          const expected=role==='mac'?(lane==='data'?'chat':'chat-control'):(lane==='data'?'phone-data':'phone-control');
          if(stream.kind!==expected)return false;
          let received=0;
          stream.on('data',bytes=>{received+=bytes.length;if(received>262144)stream.destroy();else stream.write(bytes);});
          return true;
        }});
      clients.push(client);return client;
    };
    const peers={};
    for(const lane of ['data','control'])for(const role of ['mac','android']){const client=make(role,lane);peers[role+':'+lane]=client;client.start();}
    await check('authenticated_lanes',()=>until(()=>Object.values(peers).every(c=>c.connected&&c.peerOnline),signal));

    const roundTrip=async(role,lane,kind)=>{
      const stream=peers[role+':'+lane].open(kind,1),payload=randomBytes(131089),chunks=[];let length=0;
      // A multi-frame binary challenge verifies byte integrity in both directions.
      const reply=new Promise((resolve,reject)=>{
        stream.on('data',bytes=>{length+=bytes.length;if(length>payload.length){reject(new SmokeError('payload_mismatch'));return;}chunks.push(bytes);if(length===payload.length){const bytes=Buffer.concat(chunks);timingSafeEqual(bytes,payload)?resolve():reject(new SmokeError('payload_mismatch'));}});
        stream.once('error',()=>reject(new SmokeError('stream_failed')));
        stream.once('end',()=>{if(length!==payload.length)reject(new SmokeError('stream_incomplete'));});
      });
      // Register rejection handling before waiting for the open acknowledgement.
      reply.catch(()=>{});
      try{await abortable(stream.ready,signal);stream.write(payload);await abortable(reply,signal);}
      finally{stream.destroy();}
    };
    for(const [role,lane,kind] of [['android','data','chat'],['android','control','chat-control'],['mac','data','phone-data'],['mac','control','phone-control']]){
      await check(kind+'_round_trip',()=>roundTrip(role,lane,kind));
    }

    for(const role of ['mac','android'])await check('wrong_'+role+'_credential_rejected',async()=>{
      let token;do{token=randomBytes(32).toString('hex');}while(token===credentials[role+'Token']);
      const client=make(role,'data',token);let accepted=false;client.once('connected',()=>{accepted=true;});
      client.start();
      try{
        const code=await abortable(new Promise(resolve=>client.ws.once('close',resolve)),signal);
        if(accepted||code!==1008)fail('wrong_credentials_not_rejected');
        if(!Object.values(peers).every(c=>c.connected&&c.peerOnline))fail('valid_peers_disrupted');
      }finally{dispose(client);}
    });

    await check('data_cut_drops_active_stream',async()=>{
      const active=peers['mac:data'].open('phone-data',1);await abortable(active.ready,signal);
      // Terminate the underlying connection, without automatic reconnect/replay.
      peers['mac:data'].ws.terminate();
      await until(()=>!peers['mac:data'].connected&&!peers['android:data'].peerOnline&&active.destroyed&&peers['android:data'].streams.size===0,signal);
      if(!peers['mac:control'].peerOnline||!peers['android:control'].peerOnline)fail('control_lane_disrupted');
    });
    await check('chat_control_after_data_cut',()=>roundTrip('android','control','chat-control'));
    await check('phone_control_after_data_cut',()=>roundTrip('mac','control','phone-control'));
    return {ok:true,checks,durationMs:ms(started)};
  }catch(error){
    const reason=signal.aborted?signal.reason:error;
    return {ok:false,checks,durationMs:ms(started),error:{stage,code:reason instanceof SmokeError?reason.code:'verification_failed'}};
  }finally{
    clearTimeout(timer);externalSignal?.removeEventListener('abort',interrupt);
    for(const client of clients)dispose(client);
  }
}

function parseArgs(args){
  const options={},seen=new Set();
  for(let i=0;i<args.length;i++){
    const flag=args[i];if(seen.has(flag))fail('arguments_invalid');seen.add(flag);
    if(flag==='--allow-loopback-test'){options.allowLoopbackTest=true;continue;}
    if(!['--url','--credentials','--timeout-ms'].includes(flag)||!args[i+1]||args[i+1].startsWith('--'))fail('arguments_invalid');
    const value=args[++i];options[flag==='--url'?'url':flag==='--credentials'?'credentialsPath':'timeoutMs']=flag==='--timeout-ms'?Number(value):value;
  }
  return options;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const controller=new AbortController(),stop=()=>controller.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  let report;
  try{report=await verifyDeployedRelay({...parseArgs(process.argv.slice(2)),signal:controller.signal});}
  catch{report={ok:false,checks:[],durationMs:0,error:{stage:'configuration',code:'arguments_invalid'}};}
  finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
  process.stdout.write(JSON.stringify(report)+'\n');process.exitCode=report.ok?0:1;
}
