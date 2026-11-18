/** Local, read-only timing: real stable observation + Apple Vision; frame transport is synthetic. */
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {Phone as Candidate} from '../src/adapters/phone.mjs';
const base=process.argv[2],file=process.argv[3];if(!base||!file)throw Error('Pass a 52 baseline source directory and a synthetic readable PNG.');
const {Phone:Before}=await import(pathToFileURL(resolve(base,'src/adapters/phone.mjs')));
const bytes=await readFile(file),png=bytes.toString('base64'),width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
const page={display:'main',foreground:'example.fixture',windowPkg:'example.fixture',window:'fixture',tree:'window pkg=example.fixture bounds=0,0,'+width+','+height};
async function sample(Phone){
 const s={phoneEnabled:true,phoneBackend:'phoneuse',phoneUseDeviceId:'local-fixture',phoneExecutionMode:'background'};
 const phone=new Phone({data:{settings:s}});let captures=0;
 phone.displayUse.capture=async()=>{captures++;return {tree:{content:[{type:'text',text:JSON.stringify({ok:true,result:page})}]},image:{content:[{type:'image',mimeType:'image/png',data:png}]},mapping:{scaleX:1,scaleY:1,offsetX:0,offsetY:0,physicalWidth:width,physicalHeight:height}}};
 const started=performance.now();const result=await phone.observeStable('fixture-task');const ms=performance.now()-started;
 assert.equal(result.meta.stability,'stable');assert.equal(captures,2);assert.ok(phone.observation.ocr.lines.length>0,'Actual Vision output required');
 return {ms:Math.round(ms),captures,ocr:phone.observation.ocr};
}
await sample(Before);await sample(Candidate);
const before=[],after=[];for(let i=0;i<5;i++){
 const [b,a]=i%2===0?[await sample(Before),await sample(Candidate)]:await (async()=>{const a=await sample(Candidate);return [await sample(Before),a]})();
 assert.deepEqual(b.ocr,a.ocr);before.push(b.ms);after.push(a.ms);
}
const median=a=>[...a].sort((x,y)=>x-y)[2];
console.log(JSON.stringify({test:'stable observation, identical synthetic PNG, real Vision, synthetic transport',repetitions:5,framesPerRead:2,beforeMs:before,afterMs:after,beforeMedianMs:median(before),afterMedianMs:median(after),equivalentOcr:true},null,2));
