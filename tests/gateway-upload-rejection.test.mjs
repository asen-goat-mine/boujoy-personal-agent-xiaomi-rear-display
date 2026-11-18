import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import {once} from 'node:events';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {RemoteState} from '../src/remote/state.mjs';
import {createGateway} from '../src/remote/gateway.mjs';
import {createRelay} from '../src/remote/relay.mjs';
import {RelayClient,MacConnector} from '../src/remote/transport.mjs';
import {hash} from '../src/remote/protocol.mjs';
import {identities,eventually} from './helpers/remote-tls.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t,{tunnel=false,...gatewayOptions}={}){
 const identity=identities(),store=new Store(identity.dir,{lock:false}),state=new RemoteState(identity.dir),engine={active:new Map(),creates:0,create(){this.creates++;assert.fail('an unbound upload must never dispatch');}};
 let transcriptions=0;const gateway=createGateway({identity:identity.server,state,store,engine,phone:{},voice:{async transcribeUpload(){transcriptions++;assert.fail('unbound bytes are never transcribed');}},dataDir:identity.dir,...gatewayOptions});
 const port=await gateway.listen();let relay,mac,android;
 t.after(async()=>{android?.close();await mac?.close();await gateway.close();await relay?.close();store.close();identity.cleanup();});
 if(tunnel){
  const deviceId=randomUUID(),tokens={mac:randomBytes(32).toString('hex'),android:randomBytes(32).toString('hex')};
  relay=createRelay({routes:{[deviceId]:{macTokenHash:hash(tokens.mac),androidTokenHash:hash(tokens.android)}}});const address=await relay.listen(),url=`ws://127.0.0.1:${address.port}/v1/tunnel`;
  mac=new MacConnector({config:{relayUrl:url,deviceId,macRouteToken:tokens.mac,allowLoopback:true},gatewayPort:port,controlState:()=>state.data.control});await mac.start();
  android=new RelayClient({url,deviceId,routeToken:tokens.android,role:'android',lane:'data',allowLoopback:true,reconnect:false});android.start();await eventually(()=>android.peerOnline&&mac.clients.data.peerOnline);
 }
 async function connect(){const stream=android?.open('chat',0),socket=tls.connect({...(stream?{socket:stream}:{host:'127.0.0.1',port}),key:identity.other.key,cert:identity.other.cert,rejectUnauthorized:false,minVersion:'TLSv1.3'});socket.on('error',()=>{});await once(socket,'secureConnect');return socket;}
 return {store,state,engine,gateway,connect,transcriptions:()=>transcriptions};
}
async function request(f,{bodyBytes=384*1024,declaredLength=bodyBytes,sendBytes=bodyBytes,chunkMs=1,transferEncoding=false}={}){
 const socket=await f.connect(),response=[],errors=[];socket.on('data',chunk=>response.push(chunk));socket.on('error',error=>errors.push(error));
 const closed=once(socket,'close').catch(()=>{}),write=bytes=>new Promise((resolve,reject)=>socket.write(bytes,error=>error?reject(error):resolve()));
 const framing=transferEncoding?'Transfer-Encoding: chunked':`Content-Length: ${declaredLength}`;
 const headers=`POST /v1/voice/transcribe HTTP/1.1\r\nHost: boujoy.gateway\r\nContent-Type: application/json\r\nConnection: close\r\n${framing}\r\n\r\n`;
 let sent=0;const timer=setTimeout(()=>socket.destroy(Error('response deadline')),12000);
 try{
  await write(Buffer.from(headers));
  // This is a synchronous-upload client like Android: every request byte must
  // be accepted before response processing can complete. The unbound body is
  // intentionally not JSON; rejection must not parse or execute its contents.
  while(sent<sendBytes){const count=Math.min(16384,sendBytes-sent);await write(Buffer.alloc(count,120));sent+=count;if(chunkMs)await delay(chunkMs);}
  await closed;
  if(errors.length)throw errors[0];
  return {raw:Buffer.concat(response).toString(),sent};
 }finally{clearTimeout(timer);socket.destroy();}
}
for(const tunnel of [false,true])test(`unbound large upload gets a complete 403 after bounded discard over ${tunnel?'the real encrypted relay':'direct mTLS'}`,async t=>{
 const f=await fixture(t,{tunnel}),before=JSON.stringify(f.state.data);
 const result=await request(f);assert.equal(result.sent,384*1024);assert.match(result.raw,/HTTP\/1\.1 403/);assert.match(result.raw,/"code":"device_unbound"/);assert.equal(f.transcriptions(),0);assert.equal(f.engine.creates,0);assert.equal(JSON.stringify(f.state.data),before);assert.equal(f.store.data.tasks.length,0);
});

test('undeclared or over-limit rejected bodies receive rejection without waiting for upload',async t=>{
 const f=await fixture(t);
 for(const options of [{declaredLength:12*1024*1024+1},{transferEncoding:true}]){
  const started=Date.now(),result=await request(f,{...options,sendBytes:0});assert.match(result.raw,/HTTP\/1\.1 403/);assert.match(result.raw,/device_unbound/);assert.ok(Date.now()-started<2000,'invalid-size framing is rejected immediately');
 }
 assert.equal(f.transcriptions(),0);assert.equal(f.store.data.tasks.length,0);
});

test('an unbound client that advertises a body but stalls cannot hold rejection open indefinitely',{timeout:15000},async t=>{
 const f=await fixture(t),started=Date.now(),result=await request(f,{declaredLength:100,sendBytes:1,chunkMs:0});
 assert.match(result.raw,/HTTP\/1\.1 403/);assert.match(result.raw,/device_unbound/);assert.ok(Date.now()-started>=9000);assert.ok(Date.now()-started<12000);assert.equal(f.transcriptions(),0);assert.equal(f.engine.creates,0);
});
