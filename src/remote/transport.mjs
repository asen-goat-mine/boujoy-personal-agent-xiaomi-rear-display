import {EventEmitter} from 'node:events';
import {Duplex} from 'node:stream';
import net from 'node:net';
import {WebSocket} from 'ws';
import {assert,parseControl,parseBinary,binaryFrame,validStream,MAX_FRAME,MAX_BUFFER,MAX_STREAMS} from './protocol.mjs';

// Keep outbound messages bounded like Android; the 64 KiB receive limit remains
// backward compatible with existing peers. Smaller writes also let control frames
// progress between bulk data messages on constrained routes.
const WRITE_CHUNK=16*1024;
const DRAIN_TIMEOUT_MS=8000,DIAGNOSTIC_LIMIT=12;
const ERROR_CODES=new Set(['ECONNRESET','ECONNREFUSED','ECONNABORTED','ETIMEDOUT','EPIPE','ENOTFOUND','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','ERR_STREAM_DESTROYED','ERR_STREAM_PREMATURE_CLOSE','ERR_SOCKET_CLOSED']);
const safeError=error=>error?(ERROR_CODES.has(error.code)?error.code:'other_error'):null;
const remoteCloseCode=code=>['end','closed','peer_offline'].includes(code)?code:'other';
const wsCloseClass=code=>({1000:'normal',1001:'going_away',1006:'abnormal',1008:'policy',1009:'limit',1011:'server_error'})[code]||'other';

class TunnelStream extends Duplex{
 constructor(owner,id,kind,epoch){
  super({readableHighWaterMark:262144,writableHighWaterMark:262144,allowHalfOpen:false});Object.assign(this,{owner,id,kind,epoch,opened:false,remoteClosed:false,connectionGeneration:owner.connectionGeneration});
  this.diagnostic={streamId:id,kind,connectionGeneration:this.connectionGeneration,opened:false,incomingBytes:0,outgoingBytes:0,startedAt:new Date().toISOString(),firstClose:null};
  this.on('error',()=>{});this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});this.ready.catch(()=>{});
  this.timer=setTimeout(()=>{this.noteClose('stream_open_timeout');this.destroy(Error('stream open timeout'));},8000);this.timer.unref();
 }
 noteClose(source,code=null){if(!this.diagnostic.firstClose)this.diagnostic.firstClose={source,code,at:new Date().toISOString()};}
 markOpened(){if(this.destroyed)return;this.opened=true;this.diagnostic.opened=true;clearTimeout(this.timer);this.resolveReady(this);}
 _read(){}
 async _write(chunk,encoding,callback){try{await this.ready;assert(!this.destroyed);for(let off=0;off<chunk.length;off+=WRITE_CHUNK){assert(!this.destroyed&&!this.owner.closed&&this.connectionGeneration===this.owner.connectionGeneration,'stream no longer active');const part=chunk.subarray(off,off+WRITE_CHUNK);await this.owner.sendBinary(this.id,part);this.diagnostic.outgoingBytes+=part.length;}callback();}catch(e){this.noteClose('relay_write_error',safeError(e));callback(e);}}
 _final(callback){this.noteClose('local_stream_end');if(!this.remoteClosed)this.owner.send({type:'close',streamId:this.id,code:'end'});callback();}
 _destroy(error,callback){
  clearTimeout(this.timer);this.rejectReady(error||Error('stream closed'));this.owner.retireStream(this);if(!this.remoteClosed)this.owner.send({type:'close',streamId:this.id,code:'closed'});
  this.noteClose(error?'stream_error':'local_stream_close',safeError(error));Object.assign(this.diagnostic,{finishedAt:new Date().toISOString(),errorCode:safeError(error),remoteClosed:this.remoteClosed,readableEnded:this.readableEnded,writableFinished:this.writableFinished,pendingWriteBytes:this.writableLength});this.owner.recordStream(this.diagnostic);callback(error);
 }
 receive(payload){this.diagnostic.incomingBytes+=payload.length;if(this.readableLength+payload.length>MAX_BUFFER){this.noteClose('receive_limit');this.destroy(Error('stream receive limit'));return;}this.push(payload);}
 endRemote(code='closed'){this.noteClose('remote_close',remoteCloseCode(code));this.remoteClosed=true;clearTimeout(this.timer);this.owner.retireStream(this);if(!this.opened){this.destroy(Error('stream rejected'));return;}this.push(null);}
}
export class RelayClient extends EventEmitter{
 constructor({url,deviceId,routeToken,role='mac',lane='data',onStream,allowLoopback=false,reconnect=true,heartbeatMs=15000,pongTimeoutMs=10000,helloTimeoutMs=8000,closedStreamTtlMs=30000,maxClosedStreams=1024}={}){
  super();const u=new URL(url);assert(u.protocol==='wss:'||(allowLoopback&&u.protocol==='ws:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)),'Relay must use WSS');assert(u.pathname==='/v1/tunnel'&&!u.username&&!u.password&&!u.search&&!u.hash,'Invalid relay URL');
  assert(Number.isInteger(closedStreamTtlMs)&&closedStreamTtlMs>0&&closedStreamTtlMs<=30000&&Number.isInteger(maxClosedStreams)&&maxClosedStreams>0&&maxClosedStreams<=1024,'Invalid closed stream limits');
  assert([heartbeatMs,pongTimeoutMs,helloTimeoutMs].every(n=>Number.isInteger(n)&&n>=10&&n<=60000),'Invalid relay liveness limits');
  Object.assign(this,{url,deviceId,routeToken,role,lane,onStream,reconnect,heartbeatMs,pongTimeoutMs,helloTimeoutMs,closedStreamTtlMs,maxClosedStreams});this.lastError=null;this.connectionGeneration=0;this.lastWsClose=null;this.recentStreams=[];this.linkedSockets=new Map();this.traffic={opened:0,receivedBytes:0,sentBytes:0,lastReceivedAt:null};this.streams=new Map();this.closedStreams=new Map();this.nextId=role==='android'?1:2;this.closed=false;this.connected=false;this.peerOnline=false;this.retryMs=300;this.ws=null;
 }
 start(){if(this.closed||this.ws?.readyState===WebSocket.CONNECTING||this.ws?.readyState===WebSocket.OPEN)return;const ws=new WebSocket(this.url,{perMessageDeflate:false,maxPayload:MAX_FRAME+5,handshakeTimeout:8000,followRedirects:false});this.ws=ws;
  let heartbeat,pongDeadline,helloDeadline;
  const clearLiveness=()=>{clearInterval(heartbeat);clearTimeout(pongDeadline);clearTimeout(helloDeadline);};
  const expired=code=>{if(this.ws!==ws||this.closed)return;this.lastError=code;ws.closeSource=code;this.emit('transport-error',{code});ws.terminate();};
  ws.on('open',()=>{
   if(this.closed||this.ws!==ws){ws.terminate();return;}
   helloDeadline=setTimeout(()=>expired('relay_auth_timeout'),this.helloTimeoutMs);helloDeadline.unref();
   this.send({type:'hello',version:1,role:this.role,deviceId:this.deviceId,routeToken:this.routeToken,lane:this.lane});
   // TCP may stay OPEN after sleep, a VPN switch, or a silently lost route.
   // Require a fresh pong; old sockets must be retired before new streams open.
   heartbeat=setInterval(()=>{if(this.closed||this.ws!==ws||ws.readyState!==WebSocket.OPEN||pongDeadline)return;ws.ping();pongDeadline=setTimeout(()=>expired('relay_heartbeat_timeout'),this.pongTimeoutMs);pongDeadline.unref();},this.heartbeatMs);heartbeat.unref();
  });
  ws.on('pong',()=>{clearTimeout(pongDeadline);pongDeadline=null;});
  ws.on('message',(raw,binary)=>{try{if(binary){const {id,payload}=parseBinary(raw),s=this.streams.get(id);if(!s&&this.closedStream(id)?.opened)return;assert(s?.opened);this.traffic.receivedBytes+=payload.length;this.traffic.lastReceivedAt=new Date().toISOString();s.receive(payload);return;}const p=parseControl(raw);
   if(p.type==='hello'){assert(p.accepted===true&&p.version===1);clearTimeout(helloDeadline);this.lastError=null;this.connected=true;this.retryMs=300;this.emit('connected');return;}
   if(p.type==='peer'){this.peerOnline=p.online===true;if(!this.peerOnline)this.dropStreams('peer_offline');this.emit('peer',this.peerOnline);return;}
   if(p.type==='open'){assert(this.connected&&validStream(p,this.role==='mac'?'android':'mac',this.lane)&&!this.streams.has(p.streamId)&&!this.closedStream(p.streamId)&&this.streams.size<MAX_STREAMS);const stream=new TunnelStream(this,p.streamId,p.kind,p.epoch);this.streams.set(p.streamId,stream);this.traffic.opened++;Promise.resolve(this.onStream?.(stream,p)).then(accepted=>{if(accepted===false)throw Error('stream denied');if(!stream.destroyed){this.send({type:'opened',streamId:p.streamId});stream.markOpened();}},()=>stream.destroy(Error('stream rejected'))).catch(()=>stream.destroy(Error('stream rejected')));return;}
   if(p.type==='opened'){const stream=this.streams.get(p.streamId);if(!stream){const retired=this.closedStream(p.streamId);assert(retired?.initiated&&!retired.opened);retired.opened=true;return;}assert(!stream.opened&&p.streamId%2===(this.role==='android'?1:0));stream.markOpened();return;}
   if(p.type==='close'){this.streams.get(p.streamId)?.endRemote(p.code);return;}
   throw Error('unexpected control');
  }catch{ws.closeSource='protocol_rejected';this.lastError='relay_protocol_rejected';ws.close(1008,'protocol rejected');}});
  ws.on('error',error=>{if(this.ws===ws){ws.transportErrorCode=safeError(error);ws.closeSource ||= 'transport_error';this.lastError='relay_unavailable';this.emit('transport-error',{code:this.lastError});}});
  ws.on('close',code=>{clearLiveness();if(this.ws!==ws)return;this.lastWsClose={at:new Date().toISOString(),code,classification:wsCloseClass(code),source:ws.closeSource||'remote_ws_close',errorCode:ws.transportErrorCode||null};this.connected=false;this.peerOnline=false;this.dropStreams('websocket_close');this.emit('disconnected');if(!this.closed&&this.reconnect){const delay=this.retryMs;this.retryMs=Math.min(this.retryMs*2,10000);this.retry=setTimeout(()=>this.start(),delay);this.retry.unref();}});
 }
 recordStream(record){this.recentStreams.push(record);if(this.recentStreams.length>DIAGNOSTIC_LIMIT)this.recentStreams.shift();}
 diagnostics(){return structuredClone({lastWsClose:this.lastWsClose,recentStreams:this.recentStreams,linkedSockets:this.linkedSockets.size});}
 pruneClosed(){const before=performance.now()-this.closedStreamTtlMs;for(const [id,entry] of this.closedStreams){if(entry.closedAt>before)break;this.closedStreams.delete(id);}}
 closedStream(id){this.pruneClosed();return this.closedStreams.get(id);}
 retireStream(stream){if(this.streams.get(stream.id)!==stream)return;this.streams.delete(stream.id);this.pruneClosed();this.closedStreams.set(stream.id,{opened:stream.opened,initiated:stream.id%2===(this.role==='android'?1:0),closedAt:performance.now()});while(this.closedStreams.size>this.maxClosedStreams)this.closedStreams.delete(this.closedStreams.keys().next().value);}
 send(value){if(this.ws?.readyState!==WebSocket.OPEN)return false;if(this.ws.bufferedAmount>MAX_BUFFER){this.ws.closeSource='send_buffer_limit';this.lastError='relay_buffer_limit';this.ws.close(1009,'buffer limit');return false;}this.ws.send(JSON.stringify(value));return true;}
 sendBinary(id,payload){return new Promise((resolve,reject)=>{if(this.ws?.readyState!==WebSocket.OPEN||this.ws.bufferedAmount>MAX_BUFFER){reject(Error('relay unavailable'));return;}this.ws.send(binaryFrame(id,payload),{binary:true},error=>{if(error)reject(error);else{this.traffic.sentBytes+=payload.length;resolve();}});});}
 open(kind,epoch){assert(this.connected&&this.peerOnline,'Phone relay offline');const id=this.nextId;this.nextId+=2;if(this.nextId>0xfffffffd)this.nextId=this.role==='android'?1:2;assert(validStream({streamId:id,kind,epoch},this.role,this.lane)&&!this.streams.has(id)&&!this.closedStream(id)&&this.streams.size<MAX_STREAMS);const stream=new TunnelStream(this,id,kind,epoch);this.streams.set(id,stream);if(!this.send({type:'open',streamId:id,kind,epoch}))stream.destroy(Error('relay unavailable'));return stream;}
 dropStreams(source='relay_disconnect'){
  this.connectionGeneration++;
  for(const s of [...this.streams.values()]){s.noteClose(source);s.remoteClosed=true;s.destroy(Error('relay disconnected'));}
  // Remote EOF retires the stream before TCP drain completes. Keep ownership of
  // that socket until close so stop/disconnect can still abort pending writes.
  for(const [socket,stream] of this.linkedSockets){stream.diagnostic.socketAbort=source;stream.noteClose(source);stream.remoteClosed=true;stream.destroy(Error('relay disconnected'));socket.destroy();}this.linkedSockets.clear();this.closedStreams.clear();
 }
 pauseData(){for(const s of [...this.streams.values()])if(s.kind==='phone-data'){s.noteClose('local_pause');s.destroy(Error('phone paused'));}for(const [socket,stream] of this.linkedSockets)if(stream.kind==='phone-data'){stream.diagnostic.socketAbort='local_pause';stream.noteClose('local_pause');stream.destroy(Error('phone paused'));socket.destroy();}}
 close(){this.closed=true;clearTimeout(this.retry);this.dropStreams('local_stop');if(this.ws){this.ws.closeSource='local_stop';this.ws.close(1000,'closed');}}

}
function closeLinkedStream(stream,socket,hadError){
 if(stream.destroyed)return;
 // A normal TCP FIN can precede completion of async WebSocket writes queued by
 // socket.pipe(stream). Dropping that queue truncates large TLS/HTTP replies.
 // Only orderly EOF drains: errors, local aborts, takeover and disconnect still
 // destroy immediately, and nothing is retained for a later connection.
 if(hadError||!socket.readableEnded||stream.writableFinished){stream.destroy();return;}
 stream.once('finish',()=>stream.destroy());
 if(!stream.writableEnded)stream.end();
}
function closeLinkedSocket(stream,socket){
 if(socket.destroyed)return;
 // Ordered remote EOF may auto-destroy the Duplex while its final data is still
 // queued in the TCP writable. Flush only this orderly path; local errors and
 // aborts retain immediate destruction, including after the stream is retired.
 if(!stream.remoteClosed||!stream.readableEnded||stream.errored){socket.destroy();return;}
 if(socket.writableFinished){socket.destroy();return;}
 stream.diagnostic.socketDrain='pending';
 const timeout=setTimeout(()=>{stream.diagnostic.socketDrain='timeout';socket.destroy();},DRAIN_TIMEOUT_MS);timeout.unref();
 socket.once('close',()=>clearTimeout(timeout));socket.once('finish',()=>{clearTimeout(timeout);stream.diagnostic.socketDrain='finished';socket.destroy();});
 if(!socket.writableEnded)socket.end();
}
function linkSocket(stream,socket){
 stream.owner.linkedSockets.set(socket,stream);
 socket.on('end',()=>stream.noteClose('local_tcp_eof'));
 socket.on('error',error=>{stream.noteClose('local_tcp_error',safeError(error));stream.diagnostic.tcpErrorCode=safeError(error);stream.destroy(error);});
 stream.on('error',()=>socket.destroy());stream.on('close',()=>{closeLinkedSocket(stream,socket);if(socket.destroyed)stream.owner.linkedSockets.delete(socket);});
 socket.on('close',hadError=>{
  // A closed TCP side can still have an async WSS write pending. Retain the
  // pair until both sides finish so a concurrent pause/disconnect can abort it.
  if(stream.destroyed)stream.owner.linkedSockets.delete(socket);stream.noteClose('local_tcp_close');
  stream.diagnostic.tcp={closedAt:new Date().toISOString(),hadError,errorCode:stream.diagnostic.tcpErrorCode||null,readableEnded:socket.readableEnded,writableFinished:socket.writableFinished,bytesRead:socket.bytesRead,bytesWritten:socket.bytesWritten,pendingWriteBytes:socket.writableLength};
  closeLinkedStream(stream,socket,hadError);
 });
}
export function pipeSocket(stream,{host='127.0.0.1',port}={}){
 return new Promise((resolve,reject)=>{
  if(stream.destroyed){reject(Error('stream already closed'));return;}
  const socket=net.connect({host,port});let linked=false;linkSocket(stream,socket);
  socket.on('error',e=>{if(!linked)reject(e);});socket.once('close',()=>{if(!linked)reject(Error('stream closed before TCP connect'));});
  socket.once('connect',()=>{if(stream.destroyed){socket.destroy();return;}linked=true;stream.pipe(socket);socket.pipe(stream);resolve(true);});
 });
}
export class MacConnector{
 constructor({config,gatewayPort,controlState,onStatus}={}){Object.assign(this,{config,gatewayPort,controlState,onStatus});this.clients={};this.servers={};this.sockets=new Set();this.closed=false;this.starting=null;this.closing=null;this.pendingListens=new Map();}
 start(){
  if(this.closed)return Promise.reject(Error('Remote connector is closed'));if(this.starting)return this.starting;
  this.starting=(async()=>{try{
  for(const lane of ['data','control']){
   assert(!this.closed,'Remote connector is closed');
   const client=new RelayClient({url:this.config.relayUrl,deviceId:this.config.deviceId,routeToken:this.config.macRouteToken,lane,allowLoopback:this.config.allowLoopback===true,onStream:async(stream,p)=>{if(p.kind!==(lane==='data'?'chat':'chat-control'))return false;return pipeSocket(stream,{port:this.gatewayPort});}});
   this.clients[lane]=client;for(const event of ['connected','peer','disconnected'])client.on(event,()=>this.onStatus?.(this.status()));client.start();
   const server=net.createServer(socket=>{this.sockets.add(socket);socket.on('close',()=>this.sockets.delete(socket));socket.on('error',()=>{});try{const state=this.controlState();if(lane==='data'&&state.paused)throw Error('phone controlled by user');const stream=client.open(lane==='data'?'phone-data':'phone-control',state.controlEpoch);linkSocket(stream,socket);socket.pipe(stream);stream.pipe(socket);}catch{socket.destroy();}});
   // Own the server before the asynchronous bind. close() must also cancel a
   // listen whose callback has not run, rather than lose the detached listener.
   this.servers[lane]=server;
   await new Promise((resolve,reject)=>{let done=false;const finish=error=>{if(done)return;done=true;this.pendingListens.delete(server);server.removeListener('error',failed);error?reject(error):resolve();};const failed=error=>finish(error);this.pendingListens.set(server,failed);server.once('error',failed);server.listen(0,'127.0.0.1',()=>finish());});
   assert(!this.closed,'Remote connector is closed');
  }
  return this.status();
  }catch(error){try{await this.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Remote connector failed to start and close');}throw error;}})();return this.starting;
 }
 status(){return {enabled:true,transportDiagnostics:Object.fromEntries(Object.entries(this.clients).map(([lane,client])=>[lane,client.diagnostics()])),traffic:Object.fromEntries(Object.entries(this.clients).map(([lane,client])=>[lane,{...client.traffic,openStreams:client.streams.size}])),macDataAuthenticated:!!this.clients.data?.connected,macControlAuthenticated:!!this.clients.control?.connected,transportErrors:{data:this.clients.data?.lastError||null,control:this.clients.control?.lastError||null},dataConnected:!!this.clients.data?.peerOnline,controlConnected:!!this.clients.control?.peerOnline,phoneDataPort:this.servers.data?.address()?.port||null,phoneControlPort:this.servers.control?.address()?.port||null};}
 pause(){this.clients.data?.pauseData();}
 close(){if(this.closing)return this.closing;this.closed=true;this.closing=(async()=>{for(const reject of [...this.pendingListens.values()])reject(Error('Remote connector closed during listen'));for(const c of Object.values(this.clients))c.close();for(const s of this.sockets)s.destroy();const results=await Promise.allSettled(Object.values(this.servers).map(s=>new Promise((resolve,reject)=>s.close(error=>error&&error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve()))));const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'Remote connector listeners failed to close');})();return this.closing;}
}
