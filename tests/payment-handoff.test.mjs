import test from 'node:test';
import assert from 'node:assert/strict';
import {paymentSubmissionTarget,inspectPaymentHandoff} from '../src/core/payment-handoff.mjs';
import {createTaskContract} from '../src/core/task-contract.mjs';
import {Broker} from '../src/tools/broker.mjs';
import {Phone} from '../src/adapters/phone.mjs';
import {checkoutPlan} from '../src/core/checkout.mjs';
const facts={item:'招牌牛肉面',quantity:1,totalFen:1200,paymentStatus:'not_submitted'};
const node=(text,extra={})=>({element_id:text,text,visible:true,enabled:true,password:false,actions:[],bounds:[100,1700,800,1800],...extra});
const native=(elements,packageName='com.taobao.taobao')=>({deviceId:'phone',serviceInstanceId:'service',observationId:'service:observed',packageName,elements});
test('payment submission only selects one verified order button, never a payment or password-free action',()=>{
 const good=native([node('提交订单 ¥12.00',{actions:['tap']})]),input={native:good,ocr:{height:2000,lines:[]},facts};
 assert.equal(paymentSubmissionTarget(input).elementId,'提交订单 ¥12.00');
 for(const elements of [[node('立即支付',{actions:['tap']})],[node('提交订单',{actions:['tap']}),node('去支付',{actions:['tap']})],[node('提交订单',{actions:['tap']}),node('免密支付')]])assert.throws(()=>paymentSubmissionTarget({...input,native:native(elements)}),error=>error.code==='payment_requires_user');
});
test('pending payment proof binds actual item total and order reference; no raw order id or private text escapes',()=>{
 const page=native([node('待付款'),node('招牌牛肉面'),node('应付 ¥12.00'),node('订单号 1234567890')]),result=inspectPaymentHandoff(page,facts);
 assert.equal(result.verified,true);assert.equal(result.orderCreated,true);assert.equal(result.paymentStatus,'pending_payment');assert.equal(JSON.stringify(result).includes('1234567890'),false);
 for(const elements of [[node('待付款'),node('招牌牛肉面'),node('应付 ¥13.00'),node('订单号 1234567890')],[node('待付款'),node('招牌牛肉面'),node('应付 ¥12.00')],[node('待付款'),node('黄焖鸡'),node('应付 ¥12.00'),node('订单号 1234567890')]])assert.equal(inspectPaymentHandoff(native(elements),facts).verified,false);
});
test('credential boundary returns only sanitized handoff status, no text or screenshot and no invented order creation',()=>{
 const result=inspectPaymentHandoff(native([node('private-sensitive-fixture',{editable:true,password:true}),node('请输入支付密码')],'com.eg.android.AlipayGphone'),facts);
 assert.equal(result.verified,true);assert.equal(result.paymentStatus,'credential_entry');assert.equal(result.orderCreated,'unverified');assert.equal(result.credentialBoundary,true);assert.equal(JSON.stringify(result).includes('private-sensitive-fixture'),false);assert.equal(result.content,undefined);
 assert.equal(inspectPaymentHandoff(native([node('private',{password:true})],'com.foreign.app'),facts).verified,false);
});
function fixture({prompt='在淘宝点一份牛肉面，到付款页我自己付款',run}={}){
 const task={id:'t',source:'user',status:'running',kind:'food',phoneQuery:{platform:'taobao',query:'牛肉面'},messages:[{id:'u',role:'user',content:prompt}],quotes:[]};task.taskContract=createTaskContract(task);
 const data={actions:[],artifacts:[],settings:{}},store={data,task:()=>task,event(){},transaction:fn=>fn(data),updateTask:(id,fn)=>{fn(task,data);return task;}},calls=[];
 const phone={preparePayment:async(id,args)=>{calls.push(args);await args.onDispatch({deviceId:'phone',serviceInstanceId:'service',nativeObservationId:'service:before',facts});if(run)return run(args);return {...facts,observationId:'pay-screen',taskId:id,observedAt:Date.now(),verified:true,paymentStatus:'credential_entry',credentialBoundary:true,orderCreated:'unverified'};}};
 const broker=new Broker({store,phone});broker.engine={readyForUser(){task.status='ready_for_user';}};return {task,data,broker,calls};
}
const args={checkoutItem:facts.item,checkoutQuantity:1,checkoutTotalFen:1200};
test('submission requests hand off without dispatching, including explicit payment-page wording',async()=>{
 for(const prompt of ['在淘宝点一份牛肉面，到付款页我自己付款','在淘宝点一份牛肉面，到结算页','提交订单并付款']){
  const f=fixture({prompt});const result=await f.broker.execute('t','phone_prepare_payment',args);
  assert.equal(f.task.status,'ready_for_user');assert.equal(f.calls.length,0);assert.equal(f.data.actions.length,0);assert.match(JSON.stringify(result),/由你在手机上完成/);
 }
});
test('an existing unknown submission cannot be bypassed by the handoff compatibility tool',async()=>{
 const f=fixture();f.data.actions.push({id:'original',taskId:'t',tool:'phone_prepare_payment',status:'unknown'});
 await assert.rejects(f.broker.execute('t','phone_prepare_payment',args),{code:'outcome_unknown'});assert.equal(f.calls.length,0);assert.equal(f.data.actions[0].status,'unknown');
});
const line=(text,y)=>({id:text,text,bounds:[100,y,700,y+40],center:{x:400,y:y+20}});
const checkout=(total='12.00')=>({width:1000,height:2000,lines:[line('确认订单',100),line('招牌牛肉面',500),line('x1',550),line('实付 ¥'+total,1700),line('提交订单 ¥'+total,1850)]});
function phoneFixture({freshOcr=checkout(),post,failAfter=false}={}){
 const tree={content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:'com.taobao.taobao',windowPkg:'com.taobao.taobao',window:1,tree:'window pkg=com.taobao.taobao id=1 bounds=0,0,1000,2000\nButton "提交订单" clickable bounds=100,1850,700,1890'}})}]};
 const before={at:Date.now(),tree,image:{content:[{type:'image',mimeType:'image/png',data:'fixture-before'}]},mapping:{},native:native([node('提交订单',{bounds:[100,1850,700,1890],actions:['tap']})])};
 const after={at:Date.now(),native:post||native([node('请输入支付密码'),node('private-secret-fixture',{password:true,editable:true})],'com.eg.android.AlipayGphone')},calls=[];let captures=0;
 const driver={capture:async(id,args)=>{calls.push({name:'capture',args});if(++captures===1)return before;if(failAfter)throw Object.assign(Error('fixture read timeout'),{code:'rpc_timeout'});return after;},recognize:async()=>freshOcr,call:async(id,name,args,timeout,options)=>{calls.push({name,args,options});return {};}};
 const phone=new Phone({data:{settings:{phoneEnabled:true,phoneBackend:'phoneuse',phoneUseDeviceId:'phone'}}},{phoneUse:driver});phone.observation={id:'checkout-before',taskId:'t',at:Date.now(),tree,ocr:checkout(),aligned:true,stability:'stable',stabilityScope:'full'};
 const input={plan:checkoutPlan('点一份牛肉面，到付款页我自己付款',{platform:'taobao',query:'牛肉面'}),claimed:{item:'招牌牛肉面',quantity:1,totalFen:1200},requestId:'one-order-intent'};
 return {phone,calls,input};
}
test('real Phone payment path freshly rechecks checkout then only observes native tree beyond the submission',async()=>{
 const f=phoneFixture(),proof=await f.phone.preparePayment('t',f.input);assert.equal(proof.paymentStatus,'credential_entry');assert.equal(proof.credentialBoundary,true);assert.equal(f.phone.observation,null);
 assert.deepEqual(f.calls.filter(row=>row.name==='capture').map(row=>row.args.mode),['both','tree']);assert.equal(f.calls.find(row=>row.name==='tap').options.requestId,'one-order-intent');assert.equal(JSON.stringify(proof).includes('private-secret-fixture'),false);assert.equal(proof.content,undefined);
});
test('real Phone payment path sends nothing when total, cart quantity or app content changed before dispatch',async()=>{
 const polluted=checkout();polluted.lines.push(line('冰美式 x1',700));
 for(const freshOcr of [checkout('18.00'),polluted]){const f=phoneFixture({freshOcr});await assert.rejects(f.phone.preparePayment('t',f.input));assert.equal(f.calls.some(row=>row.name==='tap'),false);}
});
test('native submission execution plus later read timeout is not called unexecuted and old screen remains invalid',async()=>{
 const f=phoneFixture({failAfter:true});await assert.rejects(f.phone.preparePayment('t',f.input),error=>error.paymentDispatched===true&&error.paymentExecution==='executed');assert.equal(f.calls.filter(row=>row.name==='tap').length,1);assert.equal(f.phone.observation,null);
});
