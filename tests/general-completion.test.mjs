import test from 'node:test';
import assert from 'node:assert/strict';
import {Broker} from '../src/tools/broker.mjs';
function fixture(){
 const task={id:'t',prompt:'放首周杰伦的歌',messages:[{id:'u',role:'user',content:'放首周杰伦的歌'}],status:'running',phoneUseScope:{mode:'general'},events:[]};
 const data={tasks:[task],actions:[],settings:{}},store={data,task:()=>task,updateTask:(id,fn)=>fn(task,data),event(){}};
 const phone={observation:{id:'screen-current',taskId:'t',at:Date.now(),ocr:{lines:[{text:'晴天'},{text:'00:18 / 04:29'}]},native:{elements:[]}}};
 const broker=new Broker({store,phone,approvals:{}});let finished=0,blocked=0;
 broker.engine={finishReport(){finished++;},blockToolFailure(){blocked++;}};
 return {broker,task,phone,data,counts:()=>({finished,blocked})};
}
const args={outcome:'completed',summary:'正在播放晴天，最新画面显示进度 00:18 和暂停图标。',evidence:['screen-current']};
test('general completion accepts model interpretation of current visual evidence without playback keywords',async()=>{
 const f=fixture();const result=await f.broker.finishGeneral('t',args);
 assert.equal(JSON.parse(result.content[0].text).recorded,true);assert.equal(f.task.report.outcome,'completed');assert.deepEqual(f.task.report.evidence,['screen-current']);assert.equal(f.counts().finished,1);
});
test('missing or stale screenshot references request evidence without repeated-failure blocking',async()=>{
 const f=fixture();for(const evidence of [[],['screen-old'],[]]){
  const result=JSON.parse((await f.broker.finishGeneral('t',{...args,evidence})).content[0].text);
  assert.equal(result.recorded,false);assert.equal(result.requiresEvidence,true);assert.deepEqual(result.finishEvidenceRefs,['screen-current']);
 }
 assert.equal(f.task.report,undefined);assert.equal(f.task.phoneRecovery,undefined);assert.deepEqual(f.counts(),{finished:0,blocked:0});
});
test('a foreign frame or a frame older than the last action must be refreshed before completion',async()=>{
 for(const foreign of [true,false]){
  const f=fixture();if(foreign)f.phone.observation.taskId='other';else f.data.actions.push({taskId:'t',tool:'phone_action',status:'completed',finishedAt:new Date(Date.now()+1000).toISOString()});
  let reads=0;f.broker.readGeneral=async()=>{reads++;};await f.broker.finishGeneral('t',args);
  assert.equal(reads,1);assert.equal(f.task.report,undefined);assert.equal(f.counts().finished,0);
 }
});

test('a report preserves earlier phone frames from this task only',async()=>{
 const f=fixture();
 f.broker.evidence.set('screen-first',{source:'phone',taskId:'t'});
 f.broker.evidence.set('screen-foreign',{source:'phone',taskId:'other'});
 await f.broker.finishGeneral('t',{...args,evidence:['screen-first','screen-foreign','screen-current','screen-first']});
 assert.deepEqual(f.task.report.evidence,['screen-first','screen-current']);
});
test('missing focus is reported as a focus problem, never a permission diagnosis, and never ends the task by count',()=>{
 const f=fixture();let reason;
 f.broker.engine.blockToolFailure=(_,message)=>{reason=message;};
 const failure={code:'phone_input_unavailable',inputDiagnostic:'focus_missing'};
 const first=JSON.parse(f.broker.phoneFailure('t',failure).content[0].text);
 assert.match(first.reason,/焦点/);assert.doesNotMatch(first.reason,/开启|弹窗/);
 const second=JSON.parse(f.broker.phoneFailure('t',failure).content[0].text);
 assert.equal(second.attempts,2);assert.equal(second.recoverable,true);assert.equal(reason,undefined);
});
