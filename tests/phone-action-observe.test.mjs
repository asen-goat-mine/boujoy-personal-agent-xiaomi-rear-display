import test from 'node:test';import assert from 'node:assert/strict';
import {Broker} from '../src/tools/broker.mjs';
function fixture(fails=false){
 const task={id:'t',status:'running'},data={actions:[],artifacts:[]};const store={data,task:()=>task,event(){},transaction(fn){fn(data);},updateTask(id,fn){fn(task,data);}};
 const phone={act:async()=>({ok:true}),observe:async()=>{if(fails)throw Error('Synthetic read failure');return {content:[{type:'text',text:JSON.stringify({observationId:'new',untrustedContent:true})},{type:'text',text:'new page'}]};}};
 const broker=new Broker({store,phone,approvals:{request:async()=>{}}});broker.evidence.set('old',{taskId:'t'});return {broker,task,data,phone};
}
test('phone action returns and registers the next observation without another model call',async()=>{
 const {broker,data}=fixture();const result=await broker.execute('t','phone_action',{action:'tap',x:10,y:20,reason:'Synthetic navigation',observationId:'old'});
 assert.equal(JSON.parse(result.content[0].text).accepted,true);assert.equal(JSON.parse(result.content[1].text).observationId,'new');assert.equal(broker.evidence.get('new').taskId,'t');assert.equal(data.actions[0].status,'completed');
});
test('a failed follow-up screenshot preserves the successful action receipt',async()=>{
 const {broker,task,data}=fixture(true);const result=await broker.execute('t','phone_action',{action:'tap',x:10,y:20,reason:'Synthetic navigation',observationId:'old'});
 const receipt=JSON.parse(result.content[0].text);assert.equal(receipt.accepted,true);assert.equal(receipt.requiresVerification,true);assert.ok(receipt.verificationError);assert.equal(data.actions[0].status,'completed');assert.equal(task.status,'running');
});


test('phone action uses bounded stable acquisition and keeps its observation metadata',async()=>{
 const {broker,data,phone}=fixture();let calls=0;phone.observe=async()=>{throw Error('Legacy read must not run');};phone.observeAfterAction=async(id,options)=>{calls++;assert.equal(id,'t');assert.ok(options.signal);return {meta:{stability:'stable'},content:[{type:'text',text:JSON.stringify({observationId:'stable',stability:'stable',attempts:2})}]};};
 const signal=new AbortController().signal;const result=await broker.execute('t','phone_action',{action:'tap',x:10,y:20,reason:'Synthetic navigation',observationId:'old'},{signal});
 assert.equal(calls,1);assert.equal(JSON.parse(result.content[0].text).accepted,true);assert.equal(JSON.parse(result.content[1].text).stability,'stable');assert.equal(broker.evidence.get('stable').taskId,'t');assert.equal(data.actions[0].status,'completed');
});

test('uncertain post-action screen preserves receipt without registering actionable evidence',async()=>{
 const {broker,task,data,phone}=fixture();phone.observeAfterAction=async()=>({meta:{stability:'uncertain'},content:[{type:'text',text:JSON.stringify({stability:'uncertain',reason:'action_screen_unchanged',requiresFreshObservation:true})}]});
 const result=await broker.execute('t','phone_action',{action:'tap',x:10,y:20,reason:'Synthetic navigation',observationId:'old'});
 assert.equal(JSON.parse(result.content[0].text).accepted,true);assert.equal(JSON.parse(result.content[1].text).observationId,undefined);assert.equal(broker.evidence.size,1);assert.equal(data.actions[0].status,'completed');assert.equal(task.status,'running');
});

test('a standalone unstable read creates no evidence reference',async()=>{
 const {broker,phone}=fixture();phone.observeStable=async()=>({meta:{stability:'uncertain'},content:[{type:'text',text:JSON.stringify({stability:'uncertain',requiresFreshObservation:true})}]});
 const result=await broker.execute('t','phone_observe',{});assert.equal(JSON.parse(result.content[0].text).stability,'uncertain');assert.equal(broker.evidence.size,1);
});
