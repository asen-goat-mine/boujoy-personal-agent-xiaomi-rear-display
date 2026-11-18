import {createHash,timingSafeEqual} from 'node:crypto';
export const VERSION=1;
export const MAX_FRAME=65536;
export const MAX_BUFFER=4*1024*1024;
export const MAX_STREAMS=32;
export const hash=value=>createHash('sha256').update(value).digest('hex');
export const constantEqual=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb);};
export const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{8,128}$/.test(value);
export function assert(value,message='Invalid protocol frame'){if(!value)throw Error(message);}
export function parseControl(data){assert(Buffer.byteLength(data)<=8192,'Control frame too large');const p=JSON.parse(data.toString());assert(p&&typeof p==='object'&&!Array.isArray(p),'Invalid control');return p;}
export function binaryFrame(id,payload){assert(Number.isInteger(id)&&id>0&&id<=0xffffffff);assert(payload.length>0&&payload.length<=MAX_FRAME);const b=Buffer.allocUnsafe(payload.length+5);b[0]=VERSION;b.writeUInt32BE(id,1);payload.copy(b,5);return b;}
export function parseBinary(data){assert(data.length>5&&data.length<=MAX_FRAME+5&&data[0]===VERSION);const id=data.readUInt32BE(1);assert(id>0);return {id,payload:data.subarray(5)};}
export function validStream(p,role,lane){
 if(!Number.isInteger(p.streamId)||p.streamId<=0||p.streamId>0xffffffff||p.streamId%2!==(role==='android'?1:0)||!Number.isSafeInteger(p.epoch)||p.epoch<0)return false;
 return role==='mac'?(lane==='data'?p.kind==='phone-data':p.kind==='phone-control'):(lane==='data'?p.kind==='chat':p.kind==='chat-control');
}
