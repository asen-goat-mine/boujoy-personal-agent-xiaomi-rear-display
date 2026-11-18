import {Worker} from 'node:worker_threads';
export function readPdfBuffer(bytes){
 if(bytes.length>8*1024*1024)return Promise.resolve({readable:false,reason:'pdf_exceeds_8_mib'});
 return new Promise(resolve=>{
  const worker=new Worker(new URL('./pdf-worker.mjs',import.meta.url),{workerData:{bytes:new Uint8Array(bytes)},resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:4},env:{},stdout:true,stderr:true});
  let settled=false;const done=value=>{if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();resolve(value);};
  const timer=setTimeout(()=>done({readable:false,reason:'pdf_processing_timeout'}),10000);timer.unref();
  worker.stdout.resume();worker.stderr.resume();worker.once('message',done);worker.once('error',()=>done({readable:false,reason:'pdf_processing_limit'}));worker.once('exit',()=>done({readable:false,reason:'pdf_processing_failed'}));
 });
}
