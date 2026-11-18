import test from 'node:test';
import assert from 'node:assert/strict';
import {modelToolResult} from '../src/adapters/model-tool-result.mjs';

const session={sessionId:'b9c4d725-9417-4f13-9519-c6bb1f417f5a',generation:6,displayId:19};
const block=value=>({type:'text',text:JSON.stringify(value)});
const result=value=>({content:[block(value)]});
const parse=value=>JSON.parse(value.content[0].text);
const tree=(extra={})=>({ok:true,result:{display:'main',backend:'display',displayId:19,displaySession:{...session},foreground:'com.example.reader',windowPkg:'com.example.reader',window:28,tree:'window pkg=com.example.reader id=28\n  TextView "正在显示" bounds=0,0,20,20',...extra}});

// Native/local callers keep their original shape; this is exclusively the model boundary.
test('checked background tree is relabeled even when there are no offscreen nodes',()=>{
  const raw=result(tree()),before=structuredClone(raw);
  const model=parse(modelToolResult('phone_observe',raw));
  assert.equal(model.result.display,'background');assert.equal(model.result.backend,'display');
  assert.equal(model.result.displayId,19);assert.deepEqual(model.result.displaySession,session);
  assert.equal(model.result.tree,parse(raw).result.tree);assert.deepEqual(raw,before);
  assert.equal(parse(raw).result.display,'main');
});
test('background tree removes only offscreen node flags and preserves quoted labels and local proof',()=>{
  const raw=result(tree({tree:'TextView "offscreen 是页面原文" bounds=0,0,20,20\nButton "不可见" offscreen bounds=0,2000,20,2040'})),before=structuredClone(raw);
  const model=parse(modelToolResult('phone_use',raw)).result;
  assert.equal(model.display,'background');assert.equal(model.omittedOffscreenNodes,1);
  assert.match(model.tree,/offscreen 是页面原文/);assert.doesNotMatch(model.tree,/不可见/);assert.deepEqual(raw,before);
});
test('missing invalid or mismatched display identity never gets silently relabeled',()=>{
  for(const extra of [
    {backend:'phoneuse'}, {displayId:0}, {displayId:20}, {displaySession:null},
    {displaySession:{...session,sessionId:'unverified'}}, {displaySession:{...session,generation:-1}},
    {displaySession:{...session,displayId:0}}, {displaySession:{...session,displayId:20}},
  ]){
    const raw=result(tree(extra));assert.equal(parse(modelToolResult('phone_observe',raw)).result.display,'main');
  }
});
test('background observation metadata stays bound to its own session while rear is progress only',()=>{
  const oldSession={...session,displayId:8,generation:5};
  const observation={observationId:'screen-live',display:'main',backend:'display',displayId:19,displaySession:session,
    connectorTelemetry:{displayBackend:{session:oldSession,rear:{available:true,displayId:1,showing:true}}}};
  const raw={content:[block(observation),block(tree()),{type:'image',mimeType:'image/jpeg',data:'unchanged'}]},before=structuredClone(raw);
  const output=modelToolResult('phone_use',raw),header=JSON.parse(output.content[1].text);
  assert.deepEqual(JSON.parse(output.content[0].text).finishEvidenceRefs,['screen-live']);
  assert.equal(header.display,'background');assert.equal(header.displayId,19);assert.deepEqual(header.displaySession,session);
  assert.deepEqual(header.connectorTelemetry.displayBackend.session,oldSession);
  assert.equal(header.connectorTelemetry.displayBackend.rear.role,'boujoy_progress_only');
  assert.equal(header.connectorTelemetry.displayBackend.rear.showing,true);
  assert.equal(JSON.parse(output.content[2].text).result.display,'background');assert.equal(output.content[3],raw.content[2]);assert.deepEqual(raw,before);
});
test('a background read without a frame does not borrow an old telemetry session or rear display',()=>{
  const raw=result({display:'background',backend:'display',displayId:null,displaySession:null,stability:'uncertain',connectorTelemetry:{displayBackend:{session,rear:{available:true,displayId:1,showing:true}}}});
  const model=parse(modelToolResult('phone_observe',raw));
  assert.equal(model.display,'background');assert.equal(model.displayId,null);assert.equal(model.displaySession,null);
  assert.equal(model.connectorTelemetry.displayBackend.rear.role,'boujoy_progress_only');
});
test('background phone status retains safe backend and session rather than inventing main',()=>{
  const raw=result({enabled:true,backend:'display',result:result({connected:true,listening:true,link:'ready',backend:'display',session:{...session,width:1080,height:2348,token:'private-session-token'},rear:{available:true,displayId:1,showing:true,secret:'private-rear-secret'},shizuku:'running',executorService:true,userService:true,reason:null,token:'private-token',log:['private-log'],futureSecret:'private-unknown'})});
  const before=structuredClone(raw),model=parse(modelToolResult('phone_status',raw));
  assert.equal(model.enabled,true);assert.equal(model.connected,true);assert.equal(model.display,'background');assert.equal(model.backend,'display');assert.equal(model.displayId,19);
  assert.deepEqual(model.session,{...session,width:1080,height:2348});assert.equal(model.rear.role,'boujoy_progress_only');assert.equal(model.rear.displayId,1);
  assert.equal(model.reason,null);assert.equal(model.shizuku,'running');assert.equal(JSON.stringify(model).includes('private-'),false);assert.deepEqual(raw,before);
});
test('unavailable background status and invalid session preserve mode without inventing a live display',()=>{
  for(const held of [null,{...session,displayId:0},{...session,generation:NaN},{sessionId:'private-invalid',displayId:1,generation:1}]){
    const model=parse(modelToolResult('phone_status',result({enabled:true,backend:'display',result:result({connected:false,listening:false,link:'not_ready',reason:'shizuku_not_running',session:held,rear:{available:true,displayId:1,showing:true}})})));
    assert.equal(model.display,'background');assert.equal(model.link,'not_ready');assert.equal(model.reason,'shizuku_not_running');assert.equal(model.session,null);assert.equal(model.displayId,null);
    assert.equal(JSON.stringify(model).includes('private-invalid'),false);
  }
  const flat=parse(modelToolResult('phone_status',result({enabled:true,backend:'display',connected:false,reason:'private arbitrary text'})));
  assert.equal(flat.backend,'display');assert.equal(flat.displayId,null);assert.equal(flat.session,null);assert.equal('reason' in flat,false);
});
test('main display status and observation preserve their existing shapes',()=>{
  const main=result({ok:true,result:{display:'main',tree:'TextView "当前页面" bounds=0,0,20,20'}});
  assert.equal(modelToolResult('phone_observe',main),main);
  const model=parse(modelToolResult('phone_status',result({enabled:true,result:result({connected:true,link:'ready',listening:true,remainingMs:5000})})));
  assert.deepEqual(model,{enabled:true,connected:true,link:'ready',listening:true,display:'main',remainingMs:5000});
});
