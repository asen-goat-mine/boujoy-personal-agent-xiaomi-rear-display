import test from 'node:test';
import assert from 'node:assert/strict';
import {phoneDiagnostic} from '../src/adapters/phone-diagnostics.mjs';
import {watchdogCheck} from '../src/core/watchdog.mjs';
const T=Date.parse('2026-11-04T10:00:00Z');
const at=n=>new Date(T+n*1000).toISOString();
function diagnostic(label,{clock='10:00',id='screen-current',reportedId=id,error,packageName='test.app'}={}){
 const observation={id,native:{packageName},ocr:{width:1000,height:2000,lines:[{text:clock,bounds:[20,0,200,50]},{text:label,bounds:[40,200,900,280]}]}};
 return phoneDiagnostic({name:'phone_use',args:{action:'scroll'},result:{content:[{type:'text',text:JSON.stringify({observationId:reportedId})}]},phone:{observation},started:Date.now(),error});
}
function run(labels,{action='scroll',error=false}={}){
 const events=[];let n=1;
 for(const [i,label] of labels.entries()){
  const a=i?action:'read';events.push({type:'tool',tool:'phone_use',action:a,sig:i?'same-scroll':'read',at:at(n++)});
  const d=diagnostic(label,{clock:'10:'+String(i).padStart(2,'0'),id:'screen-'+i,error:error&&i?{code:'not_sent'}:undefined});
  events.push({...d,action:a,type:'phone_tool_result',at:at(n++)});
 }
 return {id:'t',status:'running',runStartedAt:at(0),events};
}
const check=t=>watchdogCheck(t,{now:T+60000});
test('continued scrolling through new visible rows is progress, even with identical calls',()=>{
 assert.equal(check(run(['a','b','c','d','e','f','g'])).level,'ok');
 assert.equal(check(run(['a','b','c','d','e','f','g'],{action:'swipe'})).level,'ok');
});
test('a scroll at the end still stops; timestamps and fresh capture IDs do not count',()=>{
 assert.equal(check(run(['end','end','end','end','end','end'])).code,'same_call');
 assert.equal(check(run(['end','end','end','end','end','end'])).level,'stop');
});
test('cycling previously seen pages cannot indefinitely reset the watchdog',()=>{
 assert.equal(check(run(['a','b','a','b','a','b','a'])).level,'stop');
});
test('failed scrolling and repeated taps retain the existing bounded stop',()=>{
 assert.equal(check(run(['a','b','c','d','e','f'],{error:true})).level,'stop');
 assert.equal(check(run(['a','b','c','d','e','f'],{action:'tap'})).level,'stop');
});
test('diagnostics bind content hashes to the returned frame and omit screen text',()=>{
 const d=diagnostic('private row');assert.match(d.visibleContentHash,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(d).includes('private row'));
 assert.equal(d.visibleContentHash,diagnostic('private row',{clock:'11:59'}).visibleContentHash);
 assert.equal(diagnostic('private row',{reportedId:'screen-other'}).visibleContentHash,undefined);
 assert.equal(diagnostic('private row',{error:{code:'not_sent'}}).visibleContentHash,undefined);
});
