import {DISTRIBUTION,ANDROID_PACKAGE} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {RemoteState,spkiPin} from '../src/remote/state.mjs';
import {createGateway} from '../src/remote/gateway.mjs';
import {createRelay} from '../src/remote/relay.mjs';
import {RelayClient,MacConnector} from '../src/remote/transport.mjs';
import {hash} from '../src/remote/protocol.mjs';
import {identities,eventually,request} from './helpers/remote-tls.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t,{sendDelayMs=0}={}){
 const identity=identities(),store=new Store(identity.dir,{lock:false}),state=new RemoteState(identity.dir),engine={active:new Map()};
 const gateway=createGateway({identity:identity.server,state,store,engine,phone:{},dataDir:identity.dir}),port=await gateway.listen();
 const deviceId=randomUUID(),tokens={mac:randomBytes(32).toString('hex'),android:randomBytes(32).toString('hex')};
 const relay=createRelay({routes:{[deviceId]:{macTokenHash:hash(tokens.mac),androidTokenHash:hash(tokens.android)}}}),address=await relay.listen(),url=`ws://127.0.0.1:${address.port}/v1/tunnel`;
 const mac=new MacConnector({config:{relayUrl:url,deviceId,macRouteToken:tokens.mac,allowLoopback:true},gatewayPort:port,controlState:()=>state.data.control});await mac.start();
 const android=new RelayClient({url,deviceId,routeToken:tokens.android,role:'android',lane:'data',allowLoopback:true,reconnect:false});android.start();await eventually(()=>android.peerOnline&&mac.clients.data.peerOnline);
 t.after(async()=>{android.close();await mac.close();await gateway.close();await relay.close();store.close();identity.cleanup();});
 const call=(pathname='/v1/state',body)=>request({stream:android.open('chat',0),identity:identity.client,pin:spkiPin(identity.server.cert),pathname,method:body?'POST':'GET',body});
 const challenge=state.issuePairing({deviceId});assert.equal((await call('/v1/pair',{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,pairToken:challenge.pairToken})).status,200);
 if(sendDelayMs){const send=mac.clients.data.sendBinary.bind(mac.clients.data);mac.clients.data.sendBinary=async(...args)=>{await send(...args);await delay(sendDelayMs);};}
 return {store,state,engine,gateway,mac,android,call};
}
for(const {sendDelayMs,compact} of [{sendDelayMs:0},{sendDelayMs:8},{sendDelayMs:8,compact:true}])test(`the full ${compact?'sub-256KiB':'large'} state body survives TLS socket EOF with ${sendDelayMs} ms relay write backpressure`,async t=>{
 const f=await fixture(t,{sendDelayMs}),tail='LAST-STATE-ROW-TAIL',result=compact?'PUBLIC_STATE_FIXTURE '.repeat(24):'这是合成任务的状态摘要。'.repeat(160);
 f.store.transaction(s=>{for(let n=0;n<150;n++)s.tasks.push({id:randomUUID(),roleId:'concierge',title:'历史任务'+n,prompt:'合成状态',status:'completed',result:result+(n===149?tail:''),messages:[],events:[],updatedAt:new Date().toISOString()});});
 const before=JSON.stringify(f.state.data.control),response=await f.call();assert.equal(response.status,200);assert.equal(response.body.tasks.length,150);const payloadBytes=Buffer.byteLength(JSON.stringify(response.body));t.diagnostic('response bytes: '+payloadBytes);assert.ok(payloadBytes>150000);if(compact)assert.ok(payloadBytes<262144,'exercise an entire reply inside the writable high water mark');assert.ok(response.body.tasks.at(-1).result.endsWith(tail));assert.equal(JSON.stringify(f.state.data.control),before);
 // The same encrypted relay remains healthy for the next request.
 const follow=await f.call('/v1/voice/status');assert.equal(follow.status,200);assert.equal(f.android.peerOnline,true);assert.equal(f.mac.clients.data.peerOnline,true);await eventually(()=>f.mac.clients.data.streams.size===0&&f.android.streams.size===0);
});
