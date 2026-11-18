import test from 'node:test';import assert from 'node:assert/strict';import {ModelWatchdog,validateWatchdogReview} from '../src/core/model-watchdog.mjs';
function fixture(review){const task={id:'one',prompt:'Compare prices',createdAt:new Date(0).toISOString(),status:'running',cloudConsent:true,messages:[],events:[{id:'e1',type:'tool',tool:'web_search'}]};const store={data:{settings:{}},task:()=>task,updateTask:(_,fn)=>fn(task),event:()=>{}};const active={token:'not-a-key',controller:new AbortController()};const engine={active:new Map([['one',active]])};return {task,active,watchdog:new ModelWatchdog({store,engine,review,clock:()=>100000})};}
test('independent review is delivered once and never declares completion',async()=>{const f=fixture(async()=>({verdict:'replan',reason:'Wrong item',guidance:'Match model number first',evidenceIds:['e1']}));await f.watchdog.check('one',{force:true});assert.equal(f.task.status,'running');assert.equal(f.watchdog.guidance('one').authority,false);assert.equal(f.watchdog.guidance('one'),null);});
test('late review after cancellation cannot alter task',async()=>{let resolve;const f=fixture(()=>new Promise(r=>{resolve=r}));const pending=f.watchdog.check('one',{force:true});f.active.controller.abort();resolve({verdict:'blocked',reason:'No progress',guidance:'Wait',evidenceIds:['e1']});assert.equal(await pending,null);assert.equal(f.task.modelWatchdog,undefined);});
test('fabricated review evidence is rejected',()=>{assert.throws(()=>validateWatchdogReview({verdict:'replan',reason:'guess',guidance:'change',evidenceIds:['fake']},{events:[{id:'e1'}]}));});
test('advice that arrives after the task moved several steps on is dropped',async()=>{
 let resolve;const f=fixture(()=>new Promise(r=>{resolve=r}));const pending=f.watchdog.check('one',{force:true});
 for(let i=0;i<7;i++)f.task.events.push({id:'later'+i,type:'tool',tool:'phone_use'});
 resolve({verdict:'replan',reason:'Wrong item',guidance:'Go back',evidenceIds:['e1']});
 assert.equal(await pending,null);assert.equal(f.task.modelWatchdog,undefined);
});
test('advice not yet delivered is withheld once the task has moved on',async()=>{
 const f=fixture(async()=>({verdict:'replan',reason:'Wrong item',guidance:'Match model number first',evidenceIds:['e1']}));
 await f.watchdog.check('one',{force:true});assert.equal(f.task.modelWatchdog.lastEventId,'e1');
 for(let i=0;i<7;i++)f.task.events.push({id:'later'+i,type:'tool',tool:'phone_use'});
 assert.equal(f.watchdog.guidance('one'),null);
});
