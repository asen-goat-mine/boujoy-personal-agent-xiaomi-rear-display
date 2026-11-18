import test from 'node:test';
import assert from 'node:assert/strict';
import {Phone} from '../src/adapters/phone.mjs';
import {recognizeWithinObservation} from '../src/adapters/phone-ocr.mjs';
import {mapPhoneUseOcr} from '../src/adapters/phoneuse-state.mjs';

const image=(data,mimeType='image/png')=>({content:[{type:'image',mimeType,data}]});
const settings={phoneEnabled:true,phoneBackend:'phoneuse',phoneUseDeviceId:'test'};
const raw={width:100,height:100,lines:[{id:'text-1',text:'A',bounds:[10,10,20,20],center:{x:15,y:15}}]};
const tree=(dialog=false)=>({content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:'app.test',windowPkg:'app.test',window:'main',tree:dialog?'Dialog bounds=0,0,100,100':''}})}]});

test('a sequence reuses only consecutive exact bytes and mime; invalid and failed reads do not survive',async()=>{
  let calls=0,fail=false;
  const recognize=recognizeWithinObservation(async()=>{calls++;return fail?null:raw;});
  for(const data of ['QQ==','QQ==','Qg==','Qg==','QQ=='])await recognize(image(data));
  assert.equal(calls,3);
  await recognize(image('QQ==','image/jpeg'));assert.equal(calls,4);
  for(const item of [image(''),image(''),image('QQ==',''),image('QQ==','')])await recognize(item);
  assert.equal(calls,8);
  fail=true;assert.equal(await recognize(image('QQ==')),null);assert.equal(await recognize(image('QQ==')),null);
  fail=false;assert.equal(await recognize(image('QQ==')),raw);assert.equal(calls,11);
});

test('native frames and coordinate mappings stay fresh even when raw OCR is identical',async()=>{
  let captures=0,ocrCalls=0;
  const driver={
    capture:async()=>{const i=++captures;return {tree:tree(i===2),native:{windowId:i},image:image('QQ=='),mapping:{physicalWidth:300,physicalHeight:100,scaleX:i,scaleY:1,offsetX:0,offsetY:0}};},
    recognize:async(image,mapping,recognize)=>mapPhoneUseOcr(await recognize(image),mapping)
  };
  const phone=new Phone({data:{settings}},{phoneUse:driver});
  const options={deadline:Date.now()+5000,sampleOcr:recognizeWithinObservation(async()=>{ocrCalls++;return raw;})};
  const a=await phone.captureStableFrame('t',options),b=await phone.captureStableFrame('t',options);
  assert.equal(captures,2);assert.equal(ocrCalls,1);assert.notEqual(a.native.windowId,b.native.windowId);
  assert.notDeepEqual(a.tree,b.tree);assert.deepEqual(a.ocr.lines[0].bounds,[10,10,20,20]);assert.deepEqual(b.ocr.lines[0].bounds,[20,10,40,20]);
});

test('stable observation checks every native sample, discards OCR wrapper between operations and respects custom recognizers',async()=>{
  const callbacks=[];let captures=0;
  const driver={capture:async()=>({tree:tree(++captures%2===0),image:image('QQ==')}),recognize:async(_image,_mapping,recognize)=>{callbacks.push(recognize);return raw;}};
  const phone=new Phone({data:{settings}},{phoneUse:driver,wait:async()=>{}});
  const first=await phone.observeStable('t');assert.equal(first.meta.stability,'uncertain');assert.equal(first.meta.attempts,5);assert.equal(first.meta.observationId,undefined);
  assert.equal(captures,5);assert.equal(new Set(callbacks).size,1);const old=callbacks[0];callbacks.length=0;
  await phone.observeStable('t');assert.notEqual(callbacks[0],old);
  const custom=async()=>raw;phone.recognize=custom;callbacks.length=0;await phone.observeStable('t');assert.deepEqual(callbacks,Array(5).fill(custom));
});
