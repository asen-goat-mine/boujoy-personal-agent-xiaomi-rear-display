import http from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';
import {assert,parseControl,parseBinary,constantEqual,hash,validId,validStream,MAX_FRAME,MAX_BUFFER,MAX_STREAMS} from './protocol.mjs';

// This service sees only routing and TLS ciphertext, never application requests.
export function createRelay({routes,host='127.0.0.1',port=0,trustedProxyAddresses=[],helloTimeout=5000,heartbeatMs=15000,closedStreamTtlMs=30000,maxClosedStreams=1024}={}){
 assert(routes&&typeof routes==='object','Routes required');
 assert(Number.isInteger(closedStreamTtlMs)&&closedStreamTtlMs>0&&closedStreamTtlMs<=30000&&Number.isInteger(maxClosedStreams)&&maxClosedStreams>0&&maxClosedStreams<=1024,'Invalid closed stream limits');
 const lanes=new Map(),unauthenticated=new Set();
 const server=http.createServer((req,res)=>{if(req.url==='/healthz'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"ok":true}');}else{res.writeHead(404);res.end();}});
 const wss=new WebSocketServer({noServer:true,maxPayload:MAX_FRAME+5,perMessageDeflate:false,maxFragments:64,maxBufferedChunks:128});
 server.on('upgrade',(req,socket,head)=>{
  const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(socket.remoteAddress);
  // Production entry is a TLS reverse proxy on the same host; do not trust public forwarded headers.
  if(req.url!=='/v1/tunnel'||req.headers.origin||(!socket.encrypted&&!local&&!trustedProxyAddresses.includes(socket.remoteAddress))||unauthenticated.size>=32){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
 });
 const send=(ws,value,binary=false)=>{if(!ws||ws.readyState!==WebSocket.OPEN)return false;if(ws.bufferedAmount>MAX_BUFFER){ws.close(1009,'buffer limit');return false;}ws.send(binary?value:JSON.stringify(value),{binary});return true;};
 const pruneClosed=lane=>{const before=performance.now()-closedStreamTtlMs;for(const [id,entry] of lane.closedStreams){if(entry.closedAt>before)break;lane.closedStreams.delete(id);}};
 const closedStream=(lane,id)=>{pruneClosed(lane);return lane.closedStreams.get(id);};
 const retireStream=(lane,id)=>{const stream=lane.streams.get(id);if(!stream)return false;lane.streams.delete(id);pruneClosed(lane);lane.closedStreams.set(id,{...stream,closedAt:performance.now()});while(lane.closedStreams.size>maxClosedStreams)lane.closedStreams.delete(lane.closedStreams.keys().next().value);return true;};
 const resetStreams=lane=>{lane.streams.clear();lane.closedStreams.clear();for(const s of Object.values(lane.peers))send(s,{type:'peer',online:false});};
 wss.on('connection',ws=>{
  ws.alive=true;ws.on('pong',()=>{ws.alive=true;});unauthenticated.add(ws);const timer=setTimeout(()=>ws.close(1008,'authentication timeout'),helloTimeout);timer.unref();let state;
  ws.on('message',(data,binary)=>{
   try{
    if(!state){
     assert(!binary);const p=parseControl(data);assert(p.type==='hello'&&p.version===1&&['android','mac'].includes(p.role)&&['data','control'].includes(p.lane)&&validId(p.deviceId));
     assert(typeof p.routeToken==='string'&&p.routeToken.length>=32&&p.routeToken.length<=512);
     const route=routes[p.deviceId];assert(route?.enabled!==false&&constantEqual(hash(p.routeToken),route?.[p.role+'TokenHash']),'Authentication rejected');
     clearTimeout(timer);unauthenticated.delete(ws);
     const key=p.deviceId+':'+p.lane;let lane=lanes.get(key);if(!lane){lane={peers:{},streams:new Map(),closedStreams:new Map()};lanes.set(key,lane);}
     if(lane.peers[p.role]){const old=lane.peers[p.role];lane.peers[p.role]=null;resetStreams(lane);old.close(1008,'connection replaced');}
     state={key,lane,role:p.role,laneName:p.lane};lane.peers[p.role]=ws;
     send(ws,{type:'hello',version:1,accepted:true});const peer=lane.peers[p.role==='mac'?'android':'mac'];send(ws,{type:'peer',online:peer?.readyState===WebSocket.OPEN});if(peer)send(peer,{type:'peer',online:true});return;
    }
    const {lane,role,laneName}=state,peer=lane.peers[role==='mac'?'android':'mac'];assert(lane.peers[role]===ws,'Replaced connection');
    if(binary){const {id}=parseBinary(data),stream=lane.streams.get(id);if(!stream&&closedStream(lane,id)?.opened)return;assert(stream?.opened,'Unknown stream');assert(send(peer,data,true),'Peer offline');return;}
    const p=parseControl(data);
    if(p.type==='open'){
     assert(validStream(p,role,laneName)&&!lane.streams.has(p.streamId)&&!closedStream(lane,p.streamId)&&lane.streams.size<MAX_STREAMS,'Invalid stream');
     if(!peer){send(ws,{type:'close',streamId:p.streamId,code:'peer_offline'});return;}
     lane.streams.set(p.streamId,{owner:role,opened:false});send(peer,{type:'open',streamId:p.streamId,kind:p.kind,epoch:p.epoch});return;
    }
    if(p.type==='opened'){const stream=lane.streams.get(p.streamId);if(!stream){const retired=closedStream(lane,p.streamId);assert(retired&&retired.owner!==role&&!retired.opened);retired.opened=true;return;}assert(stream.owner!==role&&!stream.opened);stream.opened=true;send(peer,{type:'opened',streamId:p.streamId});return;}
    // Both directions can already have bytes in flight when either endpoint
    // closes. Remember only an actual stream; unsolicited close never admits data.
    if(p.type==='close'){assert(Number.isInteger(p.streamId));if(retireStream(lane,p.streamId))send(peer,{type:'close',streamId:p.streamId,code:'closed'});return;}
    throw Error('Unknown frame');
   }catch{ws.close(1008,'protocol rejected');}
  });
  ws.on('close',()=>{clearTimeout(timer);unauthenticated.delete(ws);if(state&&state.lane.peers[state.role]===ws){delete state.lane.peers[state.role];resetStreams(state.lane);if(!Object.keys(state.lane.peers).length)lanes.delete(state.key);}});
  ws.on('error',()=>{});
 });
 const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.alive){ws.terminate();continue;}ws.alive=false;ws.ping();}},heartbeatMs);heartbeat.unref();
 return {server,wss,lanes,async listen(){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});return server.address();},async close(){clearInterval(heartbeat);for(const s of wss.clients)s.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}};
}
