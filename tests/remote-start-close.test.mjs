import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {RemoteService} from '../src/remote/service.mjs';
import {MacConnector} from '../src/remote/transport.mjs';
import {createGateway} from '../src/remote/gateway.mjs';
import {createRelay} from '../src/remote/relay.mjs';
import {atomicJSON} from '../src/remote/state.mjs';
import {hash} from '../src/remote/protocol.mjs';
import {Store} from '../src/core/store.mjs';
import {identities} from './helpers/remote-tls.mjs';

const barrier=()=>{let enter,release;return {entered:new Promise(r=>enter=r),wait:new Promise(r=>release=r),enter:()=>enter(),release:()=>release()};};
async function fixture(t){
 const identity=identities(),store=new Store(identity.dir,{lock:false}),deviceId=randomUUID(),token='isolated-start-close-test-route-token';
 const relay=createRelay({routes:{[deviceId]:{macTokenHash:hash(token),androidTokenHash:hash(token+'android')}}}),address=await relay.listen();
 const config={enabled:true,deviceId,allowLoopback:true,relayUrl:`ws://127.0.0.1:${address.port}/v1/tunnel`};fs.mkdirSync(path.join(identity.dir,'remote'),{recursive:true});fs.writeFileSync(path.join(identity.dir,'remote/gateway.crt'),identity.server.cert);atomicJSON(path.join(identity.dir,'remote/config.json'),config);
 // Defer one-day test certificate renewal; no real secrets or model are used.
 store.data.tasks.push({id:'defer-fixture-renewal',status:'queued'});
 const engine={active:new Map()},phone={lease:null,configured:0,async setRemoteTransport(){this.configured++;}},secrets={async get(name){return name==='private-key'?identity.server.key:token;}};
 t.after(async()=>{await relay.close();store.close();identity.cleanup();});return {identity,store,config,engine,phone,secrets,token};
}
test('real MacConnector close cancels pending loopback bind, rejects late start and is idempotent',async t=>{
 const f=await fixture(t),connector=new MacConnector({config:{...f.config,macRouteToken:f.token},gatewayPort:1,controlState:()=>({paused:true,controlEpoch:0})});t.after(()=>connector.close());
 const pending=connector.start(),rejected=assert.rejects(pending,/closed/),closing=connector.close();assert.equal(connector.close(),closing);await Promise.all([rejected,closing]);
 await new Promise(r=>setImmediate(r));assert(Object.values(connector.servers).every(server=>!server.listening));assert(Object.values(connector.clients).every(client=>client.closed));assert.equal(connector.pendingListens.size,0);await assert.rejects(connector.start(),/closed/);
});
test('RemoteService shutdown closes a detached connector even if its actual start enters late',async t=>{
 const f=await fixture(t),gate=barrier();let connector,gateway;
 const service=new RemoteService({dataDir:f.identity.dir,store:f.store,engine:f.engine,phone:f.phone,secrets:f.secrets,gatewayFactory:options=>(gateway=createGateway(options)),connectorFactory:options=>{connector=new MacConnector(options);const start=connector.start.bind(connector);connector.start=async()=>{gate.enter();await gate.wait;return start();};return connector;}});
 t.after(async()=>{gate.release();await service.close();await connector?.close();await gateway?.close();});
 const starting=service.start(),rejected=assert.rejects(starting,/closed/);await gate.entered;const closing=service.close();gate.release();await Promise.all([rejected,closing]);
 assert.equal(service.connector,null);assert.equal(service.gateway,null);assert.equal(gateway.server.listening,false);assert(Object.values(connector.servers).every(server=>!server.listening));assert.equal(f.phone.configured,0);await service.close();
});
test('RemoteService shutdown also prevents a detached gateway from binding after shutdown',async t=>{
 const f=await fixture(t),gate=barrier();let gateway;
 const service=new RemoteService({dataDir:f.identity.dir,store:f.store,engine:f.engine,phone:f.phone,secrets:f.secrets,gatewayFactory:options=>{gateway=createGateway(options);const listen=gateway.listen.bind(gateway);gateway.listen=async()=>{gate.enter();await gate.wait;return listen();};return gateway;}});
 t.after(async()=>{gate.release();await service.close();await gateway?.close();});
 const starting=service.start(),rejected=assert.rejects(starting,/连接正在更新|closed/);await gate.entered;const closing=service.close();gate.release();await Promise.all([rejected,closing]);
 assert.equal(gateway.server.listening,false);assert.equal(service.gateway,null);assert.equal(service.connector,null);assert.equal(f.phone.configured,0);
});
test('closing a real gateway during its asynchronous listen rejects startup instead of hanging',async t=>{
 const f=await fixture(t),service=new RemoteService({dataDir:f.identity.dir,store:f.store,engine:f.engine,phone:f.phone,secrets:f.secrets});
 const gateway=createGateway({identity:f.identity.server,state:service.state,store:f.store,engine:f.engine,phone:f.phone,dataDir:f.identity.dir});t.after(()=>gateway.close());
 const listening=gateway.listen(),rejected=assert.rejects(listening,e=>e.code==='gateway_closed');const closing=gateway.close();assert.equal(gateway.close(),closing);await Promise.all([rejected,closing]);assert.equal(gateway.server.listening,false);await assert.rejects(gateway.listen(),e=>e.code==='gateway_closed');
});
