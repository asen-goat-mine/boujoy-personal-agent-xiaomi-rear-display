import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeQuote,compareQuotes} from '../src/core/compare.mjs';import {Broker} from '../src/tools/broker.mjs';
const partial=()=>({platform:'taobao',item:'美式',spec:'冰/大杯',merchant:'合成测试门店',quantity:1,itemsFen:2400,estimatedFen:1900,packagingFen:null,deliveryFen:null,serviceFen:null,discountFen:null,paidBenefitFen:null,observedAt:new Date().toISOString(),evidence:'test',final:false});
test('unknown fees stay null and do not create a fabricated final total',()=>{
 const q=normalizeQuote(partial());assert.equal(q.itemsFen,2400);assert.equal(q.estimatedFen,1900);assert.equal(q.totalFen,null);assert.equal(q.unknownFees.length,5);
 assert.equal(compareQuotes([q,{...q,platform:'meituan'}],{kind:'food'})[0].comparable,false);
 assert.throws(()=>normalizeQuote({...partial(),final:true}),/未知费用/);
});
test('partial quotes cross the real broker schema while invalid amounts remain rejected',()=>{
 const broker=new Broker({});assert.doesNotThrow(()=>broker.validate('quote_record',partial()));
 for(const change of [{deliveryFen:'unknown'},{estimatedFen:1.5}])assert.throws(()=>broker.validate('quote_record',{...partial(),...change}));
 for(const change of [{itemsFen:null},{estimatedFen:-1},{deliveryFen:-1}])assert.throws(()=>normalizeQuote({...partial(),...change}));
});

test('quote timestamps come from observed evidence and quote ids are valid finish evidence',async()=>{
 const task={id:'t',status:'running',kind:'general',quotes:[]},data={artifacts:[],actions:[]};
 const store={data,task:()=>task,event(){},updateTask(id,fn){fn(task,data);}};
 const broker=new Broker({store});const at=new Date().toISOString();broker.evidence.set('screen-real',{taskId:'t',at});
 const result=await broker.execute('t','quote_record',{platform:'taobao',item:'美式',spec:'冰',merchant:'合成门店',quantity:1,itemsFen:1200,packagingFen:null,deliveryFen:null,serviceFen:null,discountFen:null,paidBenefitFen:null,observedAt:'2020-01-01',evidence:'screen-real',final:false});
 const q=JSON.parse(result.content[0].text);assert.equal(q.observedAt,at);
 await broker.execute('t','finish_task',{outcome:'completed',summary:'Synthetic verified query',evidence:[q.id]});assert.equal(task.report.outcome,'completed');
 await assert.rejects(broker.execute('t','finish_task',{outcome:'completed',summary:'Bad evidence',evidence:['invented']}));
});
