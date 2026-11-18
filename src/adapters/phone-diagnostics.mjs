import {createHash} from 'node:crypto';
// Deliberately exclude screenshot bytes, screen text, typed text and credentials.
const CODE=/^[A-Za-z0-9_:. -]{1,128}$/;
const safe=value=>typeof value==='string'&&CODE.test(value)?value:null;
export function phoneDiagnostic({name,args={},result,error,phone,started}){
 const out={tool:name,action:safe(args.action),durationMs:Math.max(0,Date.now()-started),transport:phone?.phoneUse?.client?.remoteTransport?'cloud_relay':'local',outcome:error?'error':'returned'};
 const values=[];for(const block of result?.content||[]){if(block.type==='text'){try{const value=JSON.parse(block.text);if(value&&typeof value==='object')values.push(value);}catch{}}}
 for(const value of values)for(const key of ['reason','failureCode','stability','stabilityScope','observationId'])if(safe(value[key]))out[key]=value[key];
 const observation=phone?.observation;
 if(observation?.native?.packageName)out.foregroundPackage=observation.native.packageName;
 if(observation?.native?.elements)out.nativeNodeCount=observation.native.elements.length;
 // Compare visible content, not capture IDs or status-bar clocks. Keep only a
 // digest in telemetry; no screen text is persisted here.
 if(!error&&observation?.id===out.observationId&&observation?.ocr?.height>0){
  const {height,width,lines=[]}=observation.ocr;
  const labels=lines.filter(line=>typeof line.text==='string'&&Array.isArray(line.bounds)&&line.bounds.length===4&&line.bounds.every(Number.isFinite)&&line.bounds[1]>=height*0.05&&line.bounds[3]<=height&&line.bounds[0]>=0&&line.bounds[2]<=width).map(line=>line.text.trim().replace(/\s+/g,' ')).filter(Boolean);
  if(labels.length)out.visibleContentHash=createHash('sha256').update(JSON.stringify([out.foregroundPackage||'',...new Set(labels.sort())])).digest('hex');
 }
 if(error){out.code=safe(error.code);if(safe(error.inputDiagnostic))out.inputDiagnostic=error.inputDiagnostic;if(safe(error.phoneuseCode))out.failureCode=error.phoneuseCode;if(safe(error.dispatchState))out.dispatchState=error.dispatchState;if(safe(error.requestId))out.nativeRequestId=error.requestId;}
 return out;
}
