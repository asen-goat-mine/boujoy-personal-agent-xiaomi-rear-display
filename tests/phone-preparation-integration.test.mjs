import test from 'node:test';
import assert from 'node:assert/strict';
import {Phone} from '../src/adapters/phone.mjs';
import {Broker} from '../src/tools/broker.mjs';
import {Engine} from '../src/core/engine.mjs';
import {preparationGrant} from '../src/adapters/phone-preparation.mjs';
import {taskCheckoutPlan,verifyCheckout} from '../src/core/checkout.mjs';
const PKG='com.taobao.taobao';
const line=(id,text,y,x=40,width=600)=>({id,text,bounds:[x,y,x+width,y+40],center:{x:x+width/2,y:y+20}});
const tree=()=>({content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:PKG+'/Activity',windowPkg:PKG,window:'main',tree:'window pkg='+PKG+' bounds=0,0,1000,2000'}})}]});
const frame=lines=>({tree:tree(),ocr:{width:1000,height:2000,lines}});
const product=()=>frame([line('item','招牌牛肉面',550),line('price','¥18.00',610),line('button','+',550,750,100),line('empty','购物车为空',1500)]);
const cart=()=>frame([line('cart','购物车',130),line('item','招牌牛肉面',500),line('count','x1',560),line('price','¥18.00',620),line('total','合计 ¥18.00',1650),line('button','去结算',1800,650,300)]);
const checkout=()=>frame([line('title','确认订单',100),line('item','招牌牛肉面',500),line('count','x1',560),line('total','实付 ¥18.00',1830),line('button','立即支付 ¥18.00',1900,650,300)]);
function fixture({prompt='帮我点一份牛肉面，到结算页，我自己付款',current=product(),next=[]}={}){
 const task={id:'t',source:'user',status:'running',kind:'general',depth:0,parentId:null,phoneQuery:{platform:'taobao',query:'牛肉面'},prompt,messages:[{id:'human-current',role:'user',content:prompt}],quotes:[],children:[],events:[]};
 const data={tasks:[task],actions:[],artifacts:[],roles:[{id:'concierge',hidden:false}],settings:{phoneEnabled:true,memoryEnabled:false}};
 const events=[],calls=[];let state=current,queue=[...next],approvalCount=0,readyCount=0;
 const store={data,task(id){assert.equal(id,'t');return task;},event(id,type,text,meta){events.push({id,type,text,meta});},transaction(fn){return fn(data);},updateTask(id,fn){assert.equal(id,'t');fn(task,data);return task;}};
 const phone=new Phone(store,{wait:async()=>{},recognize:async image=>JSON.parse(Buffer.from(image.content[0].data,'base64').toString()).ocr});
 phone.call=async(name,args)=>{
  calls.push({name,args});assert.equal(args.display,'main');
  if(name==='ui_tree')return state.tree;
  if(name==='screenshot')return {content:[{type:'image',mimeType:'image/png',data:Buffer.from(JSON.stringify(state)).toString('base64')}]};
  if(name==='wait_idle')return {content:[{type:'text',text:JSON.stringify({ok:true,result:{settled:true,waitedMs:0}})}]};
  if(name==='tap'){if(queue.length)state=queue.shift();return {content:[{type:'text',text:'{"ok":true}'}]};}
  throw Error('Unexpected command '+name);
 };
 const approvals={request:async()=>{approvalCount++;},cancelTask(){}};
 const broker=new Broker({store,phone,approvals});
 broker.engine={readyForUser(){readyCount++;task.status='ready_for_user';},blockToolFailure(){}};
 return {task,data,store,phone,broker,calls,events,approvals,counts:()=>({approvals:approvalCount,ready:readyCount}),setState(s){state=s;},getState:()=>state};
}
const meta=r=>JSON.parse(r.content[0].text);
const action=(id,target='button')=>({observationId:id,action:'tap',textTargetId:target,reason:'Prepare the current requested food only'});
test('ordinary full-observation noodle request crosses real Broker→Phone preparation and checkout without approval or payment',async()=>{
 const f=fixture({next:[cart(),checkout()]});
 const initial=meta(await f.broker.execute('t','phone_observe',{mode:'full'}));
 const added=await f.broker.execute('t','phone_action',action(initial.observationId)),receipt=meta(added);
 assert.equal(receipt.accepted,true);assert.equal(receipt.authorization,'preparation_scope');assert.equal(f.data.actions[0].status,'completed');
 const cartId=JSON.parse(added.content[1].text).observationId;
 const selected=await f.broker.execute('t','phone_action',action(cartId));assert.equal(meta(selected).authorization,'preparation_scope');
 const checkoutId=JSON.parse(selected.content[1].text).observationId;
 await f.broker.execute('t','finish_task',{outcome:'ready_for_user',summary:'Only preparation',evidence:[checkoutId],checkoutItem:'招牌牛肉面',checkoutQuantity:1,checkoutTotalFen:1800});
 assert.equal(f.task.status,'ready_for_user');assert.equal(f.task.checkout.paymentStatus,'not_submitted');assert.equal(f.task.checkout.totalFen,1800);
 assert.deepEqual(f.counts(),{approvals:0,ready:1});assert.equal(f.calls.filter(c=>c.name==='tap').length,2);
 assert.deepEqual(f.data.actions.map(a=>a.authorization),['preparation_scope','preparation_scope']);
 await assert.rejects(f.broker.execute('t','phone_action',action(checkoutId)));assert.equal(f.calls.filter(c=>c.name==='tap').length,2);
});
test('query/fresh evidence may add the requested quantity; quotes still need a full observation',async()=>{
 const f=fixture({next:[cart()]}),query=meta(await f.broker.execute('t','phone_observe',{mode:'query'}));
 assert.equal(query.stability,'fresh');assert.equal(query.stabilityScope,'query');
 const added=meta(await f.broker.execute('t','phone_action',action(query.observationId)));assert.equal(added.authorization,'purchase_navigation');assert.equal(f.calls.filter(c=>c.name==='tap').length,1);
 await assert.rejects(f.broker.execute('t','quote_record',{platform:'taobao',item:'牛肉面',spec:'标准',merchant:'Test',quantity:1,itemsFen:1800,packagingFen:null,deliveryFen:null,serviceFen:null,discountFen:null,paidBenefitFen:null,evidence:query.observationId,final:false}),/完整观察/);
 assert.equal(f.counts().approvals,0);assert.equal(f.data.actions.filter(a=>a.phonePurchase?.kind==='purchase_add').length,1);
 const full=meta(await f.broker.execute('t','phone_observe',{mode:'full'}));assert.equal(full.stabilityScope,'full');
 const receipt=meta(await f.broker.execute('t','phone_action',action(full.observationId)));assert.equal(receipt.authorization,'preparation_scope');assert.equal(f.calls.filter(c=>c.name==='tap').length,2);
});
test('a second add beyond the requested quantity is refused even from a fresh product frame',async()=>{
 const f=fixture({next:[product()]}),first=meta(await f.broker.execute('t','phone_observe',{mode:'query'}));
 const after=meta(await f.broker.execute('t','phone_action',action(first.observationId)));assert.equal(after.authorization,'purchase_navigation');
 const again=meta(await f.broker.execute('t','phone_observe',{mode:'query'}));
 await assert.rejects(f.broker.execute('t','phone_action',action(again.observationId)),e=>e.code==='preparation_result_unverified');assert.equal(f.calls.filter(c=>c.name==='tap').length,1);
});
test('preparation fresh recheck refuses changed item/count even when its original text target stays fixed',async()=>{
 const f=fixture(),full=meta(await f.broker.execute('t','phone_observe',{mode:'full'}));const wrong=product();wrong.ocr.lines[0].text='香辣鸡腿饭';f.setState(wrong);
 await assert.rejects(f.broker.execute('t','phone_action',action(full.observationId)),e=>['preparation_scope_changed','invalid_input'].includes(e.code));
 assert.equal(f.calls.some(c=>c.name==='tap'),false);assert.equal(f.data.actions[0].status,'not_executed');assert.notEqual(f.task.status,'unknown_result');
});
test('deadline during real preparation OCR causes known no-dispatch and paused restoration',async()=>{
 const f=fixture(),full=meta(await f.broker.execute('t','phone_observe',{mode:'full'})),controller=new AbortController();
 const engine=new Engine({store:f.store,broker:f.broker,secrets:{},memory:{}});engine.active.set('t',{controller,run:{stop:async()=>{}}});
 f.phone.recognize=async image=>{await engine.stop('t',{pause:true});return JSON.parse(Buffer.from(image.content[0].data,'base64').toString()).ocr;};
 await assert.rejects(f.broker.execute('t','phone_action',action(full.observationId),controller.signal),e=>e.code==='action_cancelled');
 assert.equal(f.calls.some(c=>c.name==='tap'),false);assert.equal(f.data.actions[0].status,'not_executed');assert.equal(f.task.status,'paused');
});
test('known no-dispatch does not erase another unresolved effect after stop',async()=>{
 const f=fixture(),full=meta(await f.broker.execute('t','phone_observe',{mode:'full'}));
 f.data.actions.push({id:'prior-unresolved',taskId:'t',status:'unknown'});
 await assert.rejects(f.broker.execute('t','phone_action',action(full.observationId)),e=>e.code==='outcome_unknown');
 assert.equal(f.calls.some(c=>c.name==='tap'),false);assert.equal(f.data.actions.length,1);assert.equal(f.data.actions[0].status,'unknown');assert.equal(f.task.status,'unknown_result');
});

test('stop after actual command dispatch retains receipt and does not take further screenshots',async()=>{
 const f=fixture(),full=meta(await f.broker.execute('t','phone_observe',{mode:'full'})),controller=new AbortController();
 const engine=new Engine({store:f.store,broker:f.broker,secrets:{},memory:{}});engine.active.set('t',{controller,run:{stop:async()=>{}}});
 const original=f.phone.call;f.phone.call=async(name,args)=>{const result=await original(name,args);if(name==='tap')await engine.stop('t',{pause:true});return result;};
 const start=f.calls.length,receipt=meta(await f.broker.execute('t','phone_action',action(full.observationId),controller.signal));
 assert.equal(receipt.accepted,true);assert.equal(receipt.requiresVerification,true);assert.equal(f.task.status,'unknown_result');
 assert.deepEqual(f.calls.slice(start).map(c=>c.name),['ui_tree','screenshot','tap']);assert.equal(f.data.actions[0].status,'completed');
});
test('a cancelled final local recheck cannot overwrite paused status with ready_for_user',async()=>{
 const f=fixture({current:checkout()}),full=meta(await f.broker.execute('t','phone_observe',{mode:'full'})),controller=new AbortController();
 controller.abort();f.task.status='paused';
 await assert.rejects(f.broker.execute('t','finish_task',{outcome:'ready_for_user',summary:'Stop test',evidence:[full.observationId],checkoutItem:'招牌牛肉面',checkoutQuantity:1,checkoutTotalFen:1800},controller.signal),e=>e.code==='cancelled');
 assert.equal(f.task.status,'paused');assert.equal(f.counts().ready,0);
});
test('search helper starts with one query observation even when full observation exists',async()=>{
 const f=fixture({current:frame([line('field','全部 牛肉面',128,150,330),line('search','搜索',128,820,80),line('food','美食',380,40,120),line('drink','咖啡奶茶',380,200,220),line('listing','招牌牛肉面 ¥18.00',650),line('delivery','配送费 ¥0 约30分钟送达',800)])});
 const original=f.phone.observeStable.bind(f.phone);let fullReads=0;f.phone.observeStable=async(...args)=>{fullReads++;return original(...args);};
 const output=await f.broker.execute('t','phone_search',{});
 assert.equal(output.search.needsModel,true);assert.equal(output.search.actions,0);assert.equal(fullReads,0);assert.equal(f.calls.filter(c=>c.name==='screenshot').length,1);
});


test('checkout verification accepts general full-screen evidence and refuses restricted navigation evidence',()=>{
 const f=fixture({current:checkout()}),plan=taskCheckoutPlan(f.task);
 const observation={id:'screen',taskId:'t',at:Date.now(),stability:'fresh',stabilityScope:'general',tree:tree(),ocr:checkout().ocr};
 assert.equal(verifyCheckout({observation,taskId:'t',evidence:['screen'],plan}).page,'checkout');
 assert.throws(()=>verifyCheckout({observation:{...observation,stabilityScope:'navigation'},taskId:'t',evidence:['screen'],plan}),{code:'checkout_unverified'});
});

test('cancel while effect transport reconnects never writes the command after start resumes',async()=>{
 const f=fixture(),full=meta(await f.broker.execute('t','phone_observe',{mode:'full'})),controller=new AbortController();
 const engine=new Engine({store:f.store,broker:f.broker,secrets:{},memory:{}});engine.active.set('t',{controller,run:{stop:async()=>{}}});
 const original=f.phone.call;let starts=0,beginEffect,releaseEffect;
 const began=new Promise(resolve=>{beginEffect=resolve;}),release=new Promise(resolve=>{releaseEffect=resolve;});
 const rpc={request:async(method,params)=>{assert.equal(method,'tools/call');return original(params.name,params.arguments);}};
 f.phone.start=async()=>{starts++;if(starts===3){beginEffect();await release;}return rpc;};
 f.phone.call=Phone.prototype.call.bind(f.phone);
 const pending=f.broker.execute('t','phone_action',action(full.observationId),controller.signal);
 const outcome=assert.rejects(pending,e=>e.code==='action_cancelled');
 await began;await engine.stop('t',{pause:true});releaseEffect();await outcome;
 assert.equal(f.calls.some(c=>c.name==='tap'),false);assert.equal(f.data.actions[0].status,'not_executed');assert.equal(f.task.status,'paused');
});

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
test('fresh action screenshot and native read start independently before native validation resolves',async()=>{
 const f=fixture({next:[cart()]}),full=meta(await f.broker.execute('t','phone_observe',{mode:'full'}));
 const original=f.phone.call,began=deferred(),release=deferred();let first=true;
 f.phone.call=async(name,...args)=>{if(name==='ui_tree'&&first){first=false;began.resolve();await release.promise;}return original(name,...args);};
 const start=f.calls.length,pending=f.broker.execute('t','phone_action',action(full.observationId));
 await began.promise;await Promise.resolve();
 const screenshotStartedBeforeNative=f.calls.slice(start).some(c=>c.name==='screenshot');release.resolve();await pending;
 assert.equal(screenshotStartedBeforeNative,true,'Independent screenshot must not wait on ui_tree');
});
test('cancellation while parallel fresh native read is pending never dispatches preparation',async()=>{
 const f=fixture({next:[cart()]}),full=meta(await f.broker.execute('t','phone_observe',{mode:'full'})),controller=new AbortController();
 const engine=new Engine({store:f.store,broker:f.broker,secrets:{},memory:{}});engine.active.set('t',{controller,run:{stop:async()=>{}}});
 const original=f.phone.call,began=deferred(),release=deferred();let first=true;
 f.phone.call=async(name,...args)=>{if(name==='ui_tree'&&first){first=false;began.resolve();await release.promise;}return original(name,...args);};
 const pending=f.broker.execute('t','phone_action',action(full.observationId),controller.signal),outcome=assert.rejects(pending,e=>e.code==='action_cancelled');
 await began.promise;await engine.stop('t',{pause:true});release.resolve();await outcome;
 assert.equal(f.calls.some(c=>c.name==='tap'),false);assert.equal(f.data.actions[0].status,'not_executed');assert.equal(f.task.status,'paused');
});
test('recent full stable cache supplies only a previous sample and still requires one fresh matching capture',async()=>{
 const f=fixture(),old=meta(await f.broker.execute('t','phone_observe',{mode:'full'})),start=f.calls.length;
 const next=meta(await f.broker.execute('t','phone_observe',{mode:'full'}));
 assert.equal(next.stability,'stable');assert.equal(next.stabilityScope,'full');assert.notEqual(next.observationId,old.observationId);
 assert.equal(f.calls.slice(start).filter(c=>c.name==='screenshot').length,1);assert.equal(f.calls.slice(start).filter(c=>c.name==='ui_tree').length,1);
});
test('query scope and expired full cache cannot provide full verification as a previous sample',async()=>{
 for(const kind of ['query','expired']){
  const f=fixture(),first=meta(await f.broker.execute('t','phone_observe',{mode:kind==='query'?'query':'full'}));
  if(kind==='expired')f.phone.observation.at=Date.now()-16000;else assert.equal(first.stabilityScope,'query');
  const start=f.calls.length,next=meta(await f.broker.execute('t','phone_observe',{mode:'full'}));
  assert.equal(next.stabilityScope,'full');assert.equal(f.calls.slice(start).filter(c=>c.name==='screenshot').length,2,kind);
 }
});
test('a changed price cannot reuse prior full cache and requires two new matching frames',async()=>{
 const f=fixture();await f.broker.execute('t','phone_observe',{mode:'full'});
 const changed=product();changed.ocr.lines.find(row=>row.id==='price').text='¥20.00';f.setState(changed);
 const start=f.calls.length,next=meta(await f.broker.execute('t','phone_observe',{mode:'full'}));
 assert.equal(next.stabilityScope,'full');assert.equal(f.calls.slice(start).filter(c=>c.name==='screenshot').length,2);
 assert.equal(f.phone.observation.ocr.lines.find(row=>row.id==='price').text,'¥20.00');
});
test('an action follow-up never replaces new full stabilization with an old cached sample',async()=>{
 const f=fixture();await f.broker.execute('t','phone_observe',{mode:'full'});
 const start=f.calls.length,next=meta(await f.phone.observeAfterAction('t'));
 assert.equal(next.stability,'stable');assert.equal(next.stabilityScope,'full');
 assert.equal(f.calls.slice(start).filter(c=>c.name==='screenshot').length,2);assert.equal(f.calls.slice(start).filter(c=>c.name==='wait_idle').length,1);
});
test('final handoff reuses a current bound image without another screenshot',async()=>{
 const f=fixture({current:checkout()}),old=meta(await f.broker.execute('t','phone_observe',{mode:'full'})),start=f.calls.length;
 await f.broker.execute('t','finish_task',{outcome:'ready_for_user',summary:'Handoff',evidence:[old.observationId],checkoutItem:'招牌牛肉面',checkoutQuantity:1,checkoutTotalFen:1800});
 assert.equal(f.counts().ready,1);assert.equal(f.calls.slice(start).filter(c=>c.name==='screenshot').length,0);
});
