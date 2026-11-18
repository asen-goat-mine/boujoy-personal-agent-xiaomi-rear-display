import test from 'node:test';
import assert from 'node:assert/strict';
import {checkoutQueryFromPrompt,checkoutPlan,inspectCheckout,verifyCheckout} from '../src/core/checkout.mjs';
import {preparationGrant,classifyPreparationAction} from '../src/adapters/phone-preparation.mjs';
import {queryGrantFromPrompt,classifyQueryAction} from '../src/adapters/phone-query.mjs';
import {paymentSubmissionTarget,inspectPaymentHandoff} from '../src/core/payment-handoff.mjs';
import {verifyPhoneQuote} from '../src/adapters/phone-commerce-quotes.mjs';
import {normalizePhoneUseObservation} from '../src/adapters/phoneuse-state.mjs';
import {createTaskContract} from '../src/core/task-contract.mjs';
import {Broker} from '../src/tools/broker.mjs';
import {Phone} from '../src/adapters/phone.mjs';
const platforms={meituan:['美团','com.sankuai.meituan','牛肉面'],jd:['京东','com.jingdong.app.mall','保温杯'],pinduoduo:['拼多多','com.xunmeng.pinduoduo','保温杯']};
const line=(text,y,x=100,w=600)=>({id:text,text,bounds:[x,y,x+w,y+40],center:{x:x+w/2,y:y+20}});
function observation(platform,lines,controls=[],{packageName=platforms[platform][1],field=null}={}){
 const at=Date.now(),states={enabled:true,visible:true,editable:false,password:false,focused:false,checkable:false,checked:false,selected:false,content_invalid:false};
 const elements=[{element_id:'0',parent_id:null,class:'android.widget.FrameLayout',text:null,description:null,hint:null,bounds:[0,0,1000,2000],actions:[],...states},...lines.map((row,index)=>({element_id:'0.'+index,parent_id:'0',class:field===row.text?'android.widget.EditText':'android.widget.TextView',text:row.text,description:field===row.text?'搜索商品':null,hint:null,bounds:row.bounds,actions:controls.includes(row.text)?['tap']:field===row.text?['tap','set_text']:[],...states,...(field===row.text?{editable:true,focused:true}:{})}))];
 const raw={device_id:'fixture',service_instance_id:'service',observation_id:'service:1',window_id:2,package_name:packageName,ui_version:1,captured_at_ms:at,display:{id:0,width:1000,height:2000,rotation:0,coordinates:'physical_pixels',origin:'top_left',includes_system_bars_and_ime:true},tree:{output:'legacy',available:true,compact:false,scope_clipped:false,collected_nodes:elements.length,output_nodes:elements.length,merged_nodes:0,elements,collection_complete:true,collection_truncated:false,truncated:false,reason:null,started_at_ms:at-2,finished_at_ms:at-1},screenshot:null,windows:[{window_id:2,display_id:0,type:1,layer:0,active:true,focused:true,bounds:[0,0,1000,2000]}],observation_status:'complete',collection_attempts:1,inconsistency_detected:false};
 const normalized=normalizePhoneUseObservation(raw,{requireScreenshot:false,now:at});
 return {id:'o',taskId:'t',at,tree:normalized.tree,native:normalized.native,ocr:{width:1000,height:2000,lines},stability:'stable',stabilityScope:'full'};
}
function task(platform,payment=false){const [name,,query]=platforms[platform],prompt=`在${name}${platform==='meituan'?'点一份':'买一件'}${query}，预算30元，到${payment?'付款':'结算'}页`;const task={id:'t',source:'user',status:'running',kind:platform==='meituan'?'food':'shopping',phoneQuery:checkoutQueryFromPrompt(prompt),messages:[{id:'u',role:'user',content:prompt}],quotes:[],children:[]};task.taskContract=createTaskContract(task);return task;}
const checkout=(platform,total='18.00')=>observation(platform,[line('确认订单',100),line(platforms[platform][2],500),line('x1',560),line('实付 ¥'+total,1700),line('提交订单',1850)],['提交订单']);
const cart=platform=>observation(platform,[line('购物车',120),line(platforms[platform][2],500),line('x1',560),line('¥18.00',620),line('合计 ¥18.00',1700),line('去结算',1850)],['去结算']);
const product=platform=>observation(platform,[line(platforms[platform][2],500),line('¥18.00',560),line('+',500,800,100),line('购物车为空',1600)],['+']);
const tap=text=>({observationId:'o',action:'tap',textTargetId:text,reason:'fixture'});
test('explicit commerce platform routing covers Meituan, JD and PDD without cross-platform fallback',()=>{
 for(const [platform,[name,,query]] of Object.entries(platforms)){
  assert.deepEqual(task(platform).phoneQuery,{platform,query});assert.ok(preparationGrant(task(platform)));
  assert.deepEqual(queryGrantFromPrompt(`在${name}搜索${query}，不下单不付款`),{platform,query});
 }
 assert.equal(checkoutQueryFromPrompt('在美团和淘宝点一份牛肉面，到结算页'),null);
 for(const prompt of ['我喜欢买保温杯','我不想点牛肉面','不需要帮我买保温杯'])assert.equal(checkoutQueryFromPrompt(prompt),null,prompt);
 assert.equal(preparationGrant({...task('meituan'),phoneQuery:{platform:'taobao',query:'牛肉面'}}),null);
});
test('real native protocol fixtures authorize a current matching single-item cart and reject polluted or foreign carts',()=>{
 for(const platform of Object.keys(platforms)){
  const grant=preparationGrant(task(platform));assert.equal(classifyPreparationAction('t',tap('去结算'),cart(platform),grant)?.kind,'prepare_checkout');
  const mixed=cart(platform);mixed.ocr.lines.push(line('多余商品',800),line('x1',860));assert.equal(classifyPreparationAction('t',tap('去结算'),mixed,grant),null);
  assert.equal(classifyPreparationAction('t',tap('去结算'),cart(platform),{...grant,quantity:2}),null);
  assert.equal(classifyPreparationAction('t',tap('去结算'),cart(platform),{...grant,platform:platform==='jd'?'meituan':'jd'}),null);
 }
 const grant=preparationGrant(task('meituan'));assert.equal(classifyPreparationAction('t',tap('+'),product('meituan'),grant)?.kind,'prepare_add_one');
 const standalone=observation('meituan',cart('meituan').ocr.lines,['去结算'],{packageName:'com.sankuai.meituan.takeoutnew'});assert.equal(classifyPreparationAction('t',tap('去结算'),standalone,grant)?.kind,'prepare_checkout');
});
test('shopping specifications remain source-bound at preparation and checkout; opaque buy buttons are not promoted to navigation',()=>{
 const t=task('jd');t.messages[0].content='在京东买一件保温杯，规格“500ml,黑色”，到结算页';t.taskContract=createTaskContract(t);const grant=preparationGrant(t);
 assert.deepEqual(grant.requestedOptions,['500ml','黑色']);
 const page=observation('jd',[line('保温杯',400),line('¥18.00',460),line('规格',700),line('500ml',800),line('黑色',900),line('数量:1',1200),line('购物车为空',1600),line('加入购物车',1800)],['500ml','黑色','加入购物车']);
 assert.equal(classifyPreparationAction('t',tap('黑色'),page,grant)?.kind,'prepare_spec_selection');
 assert.equal(classifyPreparationAction('t',tap('加入购物车'),page,grant),null);
 const ready=structuredClone(page);ready.ocr.lines.find(row=>row.text==='500ml').text='规格:500ml';ready.ocr.lines.find(row=>row.text==='黑色').text='颜色:黑色';assert.equal(classifyPreparationAction('t',tap('加入购物车'),ready,grant)?.kind,'prepare_add_selected');
 const plan=checkoutPlan(t.messages[0].content,t.phoneQuery);assert.equal(inspectCheckout(checkout('jd').ocr,plan),null);
 const selected=checkout('jd');selected.ocr.lines.push(line('规格:500ml',1000),line('黑色',1100));assert.equal(inspectCheckout(selected.ocr,plan)?.quantity,1);
 for(const platform of ['jd','pinduoduo']){const buying=observation(platform,[line('保温杯',500),line('¥18.00',560),line('单独购买',1850)],['单独购买']);assert.equal(classifyPreparationAction('t',tap('单独购买'),buying,preparationGrant(task(platform))),null);assert.equal(classifyQueryAction('t',tap('单独购买'),buying,task(platform).phoneQuery),null);}
});
test('checkout and one-shot payment recognize the requested platform, item and amount, never another platform cashier',()=>{
 for(const platform of Object.keys(platforms)){
  const t=task(platform,true),page=checkout(platform),plan=checkoutPlan(t.messages[0].content,t.phoneQuery),claimed={item:platforms[platform][2],quantity:1,totalFen:1800};
  const facts=verifyCheckout({observation:page,taskId:'t',evidence:['o'],plan,claimed});assert.equal(facts.platform,platform);
  assert.ok(paymentSubmissionTarget({native:page.native,ocr:page.ocr,facts}).elementId);
  const pending=observation(platform,[line('待付款',100),line(claimed.item,500),line('应付 ¥18.00',1000),line('订单号 1234567890',1300)]);assert.equal(inspectPaymentHandoff(pending.native,facts).paymentStatus,'pending_payment');
  assert.equal(inspectPaymentHandoff(pending.native,{...facts,platform:platform==='jd'?'meituan':'jd'}).verified,false);
 }
});
function brokerFixture(platform,{start=product(platform),next=[cart(platform),checkout(platform)]}={}){
 const t=task(platform),data={tasks:[t],settings:{phoneEnabled:true,memoryEnabled:false},actions:[],artifacts:[]},calls=[];let state=start;
 const store={data,task:()=>t,event(){},transaction:fn=>fn(data),updateTask:(id,fn)=>fn(t,data)};
 const phone=new Phone(store,{wait:async()=>{},recognize:async()=>state.ocr});
 phone.call=async(name,args)=>{calls.push({name,args});if(name==='ui_tree')return state.tree;if(name==='screenshot')return {content:[{type:'image',data:Buffer.from('fixture').toString('base64'),mimeType:'image/png'}]};if(name==='wait_idle')return {content:[{type:'text',text:JSON.stringify({ok:true,result:{settled:true}})}]};if(['tap','key','type'].includes(name)){if(next.length)state=next.shift();return {content:[{type:'text',text:'{"ok":true}'}]};}throw Error('Unexpected '+name);};
 const broker=new Broker({store,phone,approvals:{request(){throw Error('Unexpected approval');}}});broker.engine={readyForUser(){t.status='ready_for_user';}};
 return {t,data,phone,broker,calls};
}
const meta=result=>result.content.map(block=>{try{return JSON.parse(block.text);}catch{return null;}}).find(value=>value?.observationId);
test('Broker → Phone Meituan preparation reaches verified checkout with automatic scope and no order submission',async()=>{
 const f=brokerFixture('meituan');await f.broker.execute('t','phone_use',{action:'read',mode:'full'});
 await f.broker.execute('t','phone_use',{action:'tap',target:'+'});
 await f.broker.execute('t','phone_use',{action:'tap',target:'去结算'});
 const page=f.phone.observation;await f.broker.execute('t','finish_task',{outcome:'ready_for_user',summary:'prepared',evidence:[page.id],checkoutItem:'牛肉面',checkoutQuantity:1,checkoutTotalFen:1800});
 assert.equal(f.t.status,'ready_for_user');assert.equal(f.t.checkout.platform,'meituan');assert.equal(f.calls.filter(call=>call.name==='tap').length,2);assert.ok(f.data.actions.every(action=>action.authorization==='purchase_navigation'));
});
test('Broker → Phone JD single-item cart reaches verified checkout; stale price or incorrect SKU cannot finish',async()=>{
 const f=brokerFixture('jd',{start:cart('jd'),next:[checkout('jd')]});await f.broker.execute('t','phone_use',{action:'read',mode:'full'});await f.broker.execute('t','phone_use',{action:'tap',target:'去结算'});
 await f.broker.execute('t','finish_task',{outcome:'ready_for_user',summary:'wrong',evidence:[f.phone.observation.id],checkoutItem:'保温杯',checkoutQuantity:1,checkoutTotalFen:1});assert.equal(f.t.checkout.totalFen,1800,'observed total overrides a fabricated model amount');
 assert.equal(f.t.status,'ready_for_user');assert.equal(f.t.checkout.platform,'jd');
});
test('observed shopping prices require exact item/spec/merchant/count and explicit fee rows; unknown is never zero',()=>{
 const page=observation('pinduoduo',[line('保温杯',500),line('¥18.00',550),line('500ml黑色',800),line('测试旗舰店',1000),line('x1',1100)]);
 const quote={platform:'pinduoduo',item:'保温杯',spec:'500ml黑色',merchant:'测试旗舰店',quantity:1,itemsFen:1800,packagingFen:null,deliveryFen:null,serviceFen:null,discountFen:null,paidBenefitFen:null,evidence:'o',final:false};assert.equal(verifyPhoneQuote(page,quote).verified,true);
 for(const patch of [{item:'水壶'},{spec:'1000ml'},{merchant:'其他店'},{quantity:2},{itemsFen:1},{deliveryFen:0},{final:true},{platform:'jd'}])assert.throws(()=>verifyPhoneQuote(page,{...quote,...patch}),error=>error.code==='quote_unverified');
 const conditional=structuredClone(page);conditional.ocr.lines[1].text='拼单价 ¥18.00';assert.throws(()=>verifyPhoneQuote(conditional,quote));
});
test('native commerce search observes once and only model-selected actions submit the real query',async()=>{
 for(const platform of Object.keys(platforms)){
  const query=platforms[platform][2];
  const input=observation(platform,[line('搜索商品',130,100,650),line('搜索',130,820,100)],['搜索'],{field:'搜索商品'});
  const typed=observation(platform,[line(query,130,100,650),line('搜索',130,820,100)],['搜索'],{field:query});
  const results=observation(platform,[line(query,130),line('综合',400),line('招牌'+query,700),line('¥18.00',760)]);
  const f=brokerFixture(platform,{start:input,next:[typed,results]});const result=await f.broker.execute('t','phone_use',{action:'search'});
  const metadata=result.content.map(block=>{try{return JSON.parse(block.text);}catch{return null;}}).filter(Boolean);
  assert.equal(metadata.find(value=>value.search)?.search.needsModel,true,platform);
  assert.equal(metadata.find(value=>value.search)?.search.actions,0,platform);
  assert.deepEqual(f.calls.filter(call=>['type','tap'].includes(call.name)),[],platform);
  assert.equal(f.phone.observation.ocr.lines.some(row=>row.text==='招牌'+query),false,'an input view is not a submitted result');
  await f.broker.execute('t','phone_use',{action:'type',text:query});
  assert.deepEqual(f.calls.filter(call=>['type','tap'].includes(call.name)).map(call=>call.name),['type']);
  await f.broker.execute('t','phone_use',{action:'tap',target:'搜索'});
  assert.deepEqual(f.calls.filter(call=>['type','tap'].includes(call.name)).map(call=>call.name),['type','tap']);
  assert.equal(f.phone.observation.ocr.lines.some(row=>row.text==='招牌'+query),true,'the final observation contains actual result content');
  assert.equal(f.data.actions.length,2);
  assert.ok(f.data.actions.every(action=>action.status==='completed'&&action.executionStatus==='executed'&&['query_scope','purchase_navigation'].includes(action.authorization)),'only the two requested search actions were executed');
 }
});
test('an unchanged cart is observed without automatically adding another item',async()=>{
 const f=brokerFixture('meituan',{next:[product('meituan')]});await f.broker.execute('t','phone_use',{action:'read',mode:'full'});await f.broker.execute('t','phone_use',{action:'tap',target:'+'});
 await f.broker.execute('t','phone_use',{action:'read',mode:'full'});
 assert.equal(f.phone.observation.ocr.lines.some(line=>line.text==='购物车为空'),true);assert.equal(f.calls.filter(call=>call.name==='tap').length,1);
});
test('Broker opens the installed Meituan variant from the real directory whitelist, including standalone delivery',async()=>{
 const main={packageName:'com.sankuai.meituan',label:'美团'},delivery={packageName:'com.sankuai.meituan.takeoutnew',label:'美团外卖'};
 for(const [app,installed,expected] of [['美团',[delivery],delivery.packageName],['美团',[main,delivery],main.packageName],['美团外卖',[main,delivery],delivery.packageName]]){
  const f=brokerFixture('meituan');if(app==='美团外卖'){f.t.messages[0].content=f.t.messages[0].content.replace('美团','美团外卖');f.t.taskContract=createTaskContract(f.t);}
  f.phone.resolveApp=async pkg=>{const found=installed.find(a=>a.packageName===pkg);assert.ok(found,'must resolve an installed variant');return found;};
  let query;f.phone.listApps=async value=>{query=value;return {source:'phoneuse',cached:false,stale:false,apps:installed};};
  f.phone.call=async(name,args)=>{f.calls.push({name,args});return {content:[{type:'text',text:'{"ok":true}'}]};};
  await f.broker.execute('t','phone_use',{action:'open_app',app});assert.equal(query,'美团');assert.equal(f.calls.find(call=>call.name==='open_app')?.args.packageName,expected);
 }
 for(const directory of [{source:'phoneuse',apps:[{packageName:'com.fake.meituan',label:'美团'}]},{source:'phoneuse',stale:true,apps:[delivery]}]){
  const f=brokerFixture('meituan');f.phone.listApps=async()=>directory;await assert.rejects(f.phone.resolvePlatformApp('meituan',{request:f.t.prompt}));const result=await f.broker.execute('t','phone_use',{action:'open_app',app:'美团'});assert.match(result.content[0].text,/blocked|recovered/);assert.equal(f.calls.length,0);
 }
});
