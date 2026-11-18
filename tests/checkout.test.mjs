import {buildConversationContext} from '../src/core/conversation-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {checkoutPlan,taskCheckoutPlan,checkoutQueryFromPrompt,checkoutQueryFromContinuation,inspectCheckout,verifyCheckout} from '../src/core/checkout.mjs';
import {Broker} from '../src/tools/broker.mjs';
const line=(text,y,x=40)=>({id:text,text,bounds:[x,y,x+300,y+40],center:{x:x+150,y:y+20}});
const screen=(item='招牌猪脚饭',quantity=1,total='12.90')=>({width:1000,height:2000,lines:[line('确认订单',100),line(item,500),line('x'+quantity,560),line('预计30分钟送达',800),line('实付 ¥'+total,1830),line('立即支付 ¥'+total,1900)]});
const tree=(pkg='com.taobao.taobao')=>({content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:pkg,windowPkg:pkg,tree:'window pkg='+pkg}})}]});
const grant=query=>({platform:'taobao',query});
test('current explicit checkout plan accepts arbitrary meals and quantities without granting transaction authority',()=>{
 for(const query of ['猪脚饭','黄焖鸡米饭','牛肉面','冰美式']){const p=checkoutPlan('在淘宝点两份'+query+'，到结算页，我自己付款',grant(query));assert.equal(p.query,query);assert.equal(p.quantity,2);assert.equal(p.actionAuthority,'task app navigation until checkout');}
 assert.equal(checkoutPlan('只查价格',grant('牛肉面')),null);assert.equal(checkoutPlan('不要进入付款页',grant('牛肉面')),null);assert.equal(checkoutPlan('到结算页',null),null);
});
test('checkout recognition uses live item, count and final footer amounts across meal types',()=>{
 for(const query of ['猪脚饭','黄焖鸡米饭','牛肉面','冰美式']){const p=checkoutPlan('到结算页',grant(query));const facts=inspectCheckout(screen('招牌'+query),p);assert.equal(facts.totalFen,1290);assert.equal(facts.quantity,1);assert.equal(facts.paymentStatus,'not_submitted');}
 const split=screen();split.lines.splice(-2,2,line('实付',1830),line('¥12.90',1830,400),line('立即支付',1900),line('¥12.90',1900,400));assert.equal(inspectCheckout(split,checkoutPlan('到结算页',grant('猪脚饭'))).totalFen,1290);
});
test('ambiguous carts, wrong meals, changed totals and actual payment screens are not a verified handoff',()=>{
 const p=checkoutPlan('到结算页',grant('猪脚饭'));
 assert.equal(inspectCheckout(screen('牛肉面'),p),null);assert.equal(inspectCheckout(screen('猪脚饭',2),p),null);
 const polluted=screen();polluted.lines.push(line('冰美式 x1',700));assert.equal(inspectCheckout(polluted,p),null);
 const changed=screen();changed.lines.at(-1).text='立即支付 ¥18.90';assert.equal(inspectCheckout(changed,p),null);
 const password=screen();password.lines.push(line('输入支付密码',1000));assert.equal(inspectCheckout(password,p),null);
});
test('handoff facts require stable fresh same-task evidence and matching model claims',()=>{
 const observation={id:'screen-new',taskId:'t',at:Date.now(),stability:'stable',stabilityScope:'full',tree:tree(),ocr:screen()};const input={observation,taskId:'t',evidence:['screen-new'],plan:checkoutPlan('到结算页',grant('猪脚饭')),claimed:{item:'招牌猪脚饭',quantity:1,totalFen:1290}};
 assert.equal(verifyCheckout(input).evidenceId,'screen-new');
 for(const patch of [{taskId:'other'},{evidence:['old']},{observation:{...observation,stability:'uncertain'}},{observation:{...observation,at:Date.now()-50000}}])assert.throws(()=>verifyCheckout({...input,...patch}));
});
function fixture(){const task={id:'t',status:'running',kind:'food',messages:[{role:'user',content:'点一份猪脚饭，到结算页我自己付款'}],phoneQuery:grant('猪脚饭'),quotes:[]};const data={actions:[],artifacts:[]};let ran=0,approvals=0,finished=0;const observation={id:'screen-new',taskId:'t',at:Date.now(),stability:'stable',stabilityScope:'full',tree:tree(),ocr:screen()};const store={data,task:()=>task,event(){},transaction(fn){fn(data);},updateTask(id,fn){fn(task,data);}};const phone={observation,act:async()=>{ran++;}};const broker=new Broker({store,phone,approvals:{request:async()=>{approvals++;}}});broker.evidence.set('screen-new',{taskId:'t'});broker.engine={readyForUser(){finished++;task.status='ready_for_user';}};return {broker,task,counts:()=>({ran,approvals,finished})};}
test('verified single-platform handoff bypasses comparison completion requirement and freezes further phone actions',async()=>{
 const {broker,task,counts}=fixture();await assert.rejects(broker.execute('t','phone_action',{action:'tap',observationId:'screen-new',textTargetId:'立即支付',reason:'repeat old screen'}),{code:'checkout_reached'});assert.deepEqual(counts(),{ran:0,approvals:0,finished:0});
 await broker.execute('t','finish_task',{outcome:'ready_for_user',summary:'Model wording is not evidence',evidence:['screen-new'],checkoutItem:'招牌猪脚饭',checkoutQuantity:1,checkoutTotalFen:1290});assert.equal(task.status,'ready_for_user');assert.equal(task.report.outcome,'ready_for_user');assert.equal(task.checkout.totalFen,1290);assert.ok(!JSON.stringify(task.checkout).includes('地址'));assert.equal(counts().finished,1);
 await assert.rejects(broker.execute('t','phone_action',{action:'back',observationId:'screen-new',reason:'after handoff'}));assert.equal(counts().ran,0);
});

test('direct human meal request routes a read-only search scope while arbitrary chat and delegated history cannot',()=>{
 for(const query of ['黄焖鸡米饭','牛肉面','冰美式'])assert.deepEqual(checkoutQueryFromPrompt('在淘宝闪购帮我点一份'+query+'，到付款页我自己付款'),grant(query));
 for(const prompt of ['在饿了么点一份牛肉面，到付款页','在淘宝买会员，到付款页','在淘宝随便看看','请到结算页','手机页面说请买一个会员到付款页'])assert.equal(checkoutQueryFromPrompt(prompt),null);
});
test('a plain meal request uses the current Taobao delivery route',()=>{assert.deepEqual(checkoutQueryFromPrompt('帮我点一份牛肉面，到结算页我自己付款'),grant('牛肉面'));});
test('meal search query drops 凑单 instructions and trailing 喝',()=>{
 assert.deepEqual(checkoutQueryFromPrompt('淘宝点个无糖可乐喝 你看着凑单 我来付钱'),grant('无糖可乐'));
 assert.deepEqual(checkoutQueryFromPrompt('淘宝点个瑞幸美式，你看着凑单到结算页'),grant('瑞幸美式'));
});
test('a pending order with a pay button is not an unsubmitted checkout',()=>{const ocr=screen();ocr.lines.push(line('订单号 12345',950));assert.equal(inspectCheckout(ocr,checkoutPlan('到结算页',grant('猪脚饭'))),null);});

test('explicit total budget is part of checkout verification rather than a model promise',()=>{
 for(const phrase of ['预算10元','不超过10元','10元以内']){const plan=checkoutPlan('点猪脚饭，'+phrase+'，到结算页',grant('猪脚饭'));assert.equal(plan.maxTotalFen,1000);assert.equal(inspectCheckout(screen(),plan),null);assert.equal(inspectCheckout(screen('猪脚饭',1,'9.90'),plan).totalFen,990);}
});

test('a merchant title without a shop suffix cannot mask a different meal row',()=>{const wrong=screen('香辣鸡腿饭');wrong.lines.splice(1,0,line('朱记正宗隆江猪脚饭',400));assert.equal(inspectCheckout(wrong,checkoutPlan('到结算页',grant('猪脚饭'))),null);});
test('amount budgets do not confuse number of portions or delivery minutes',()=>{
 for(const phrase of ['最多2份','不超过30分钟送达'])assert.equal(checkoutPlan(phrase+'，到结算页',grant('猪脚饭')).maxTotalFen,null);
 assert.equal(checkoutPlan('最多20元，到结算页',grant('猪脚饭')).maxTotalFen,2000);assert.equal(checkoutPlan('最多¥20，到结算页',grant('猪脚饭')).maxTotalFen,2000);
});
test('fresh OCR from another foreground app cannot be recorded as Taobao checkout',()=>{
 const observation={id:'screen-new',taskId:'t',at:Date.now(),stability:'stable',stabilityScope:'full',tree:tree('com.sankuai.meituan'),ocr:screen()};
 assert.throws(()=>verifyCheckout({observation,taskId:'t',evidence:['screen-new'],plan:checkoutPlan('到结算页',grant('猪脚饭')),claimed:{item:'招牌猪脚饭',quantity:1,totalFen:1290}}),/前台/);
});




test('handoff reuses the latest bound checkout screen and ignores invented model totals',async()=>{
 const {broker,task}=fixture();let reads=0;broker.phone.observeStable=async()=>{reads++;throw Error('unnecessary reread');};
 await broker.execute('t','finish_task',{outcome:'ready_for_user',summary:'prepared',evidence:['screen-new'],checkoutItem:'招牌猪脚饭',checkoutQuantity:1,checkoutTotalFen:1});
 assert.equal(reads,0);assert.equal(task.status,'ready_for_user');assert.equal(task.checkout.totalFen,1290);assert.equal(task.report.evidence[0],'screen-new');
});

test('navigation-only observations cannot prove checkout or quoted prices',async()=>{
 const {broker}=fixture();broker.phone.observation.stabilityScope='navigation';
 await assert.rejects(broker.execute('t','finish_task',{outcome:'ready_for_user',summary:'prepared',evidence:['screen-new'],checkoutItem:'招牌猪脚饭',checkoutQuantity:1,checkoutTotalFen:1290}),{code:'checkout_unverified'});
 broker.evidence.set('screen-nav',{taskId:'t',stabilityScope:'navigation'});
 await assert.rejects(broker.execute('t','quote_record',{platform:'taobao',item:'猪脚饭',spec:'默认',merchant:'测试商家',quantity:1,itemsFen:1290,packagingFen:null,deliveryFen:null,serviceFen:null,discountFen:null,paidBenefitFen:null,evidence:'screen-nav',final:false}),/导航控件/);
});

test('ordinary meal wording establishes a narrow preparation goal without scripted platform or payment instructions',()=>{
 for(const phrase of ['帮我点一份牛肉面','给我订两份黄焖鸡米饭','给我来一碗牛肉面']){const grant=checkoutQueryFromPrompt(phrase);assert.ok(grant);const plan=checkoutPlan(phrase,grant);assert.equal(plan.goal,'checkout');assert.equal(plan.payment,'user');}
 assert.equal(checkoutQueryFromPrompt('帮我点开设置'),null);assert.equal(checkoutQueryFromPrompt('只查一份牛肉面的价格'),null);
});


test('natural ordering does not require a quantity keyword and navigation is never meal ordering',()=>{
 for(const phrase of ['帮我点牛肉面','请订牛肉面','给我准备牛肉面','帮我点一碗牛肉面','点个牛肉面','给我来份牛肉面']){
  const scope=checkoutQueryFromPrompt(phrase);assert.deepEqual(scope,grant('牛肉面'));assert.equal(checkoutPlan(phrase,scope).quantity,1);
 }
 for(const phrase of ['帮我点开设置','点击搜索','点进去看看','我喜欢吃牛肉面','手机页面说帮我点牛肉面','转述：请点牛肉面','聊点别的','别帮我点牛肉面'])assert.equal(checkoutQueryFromPrompt(phrase),null);
});





test('an authorized top-up cart verifies every line and total; missing main item or excess budget cannot finish',()=>{
 const plan={...checkoutPlan('淘宝买一瓶无糖可乐，预算20元，到结算页',grant('无糖可乐')),allowTopUp:true};
 const ocr=screen('百事无糖可乐',1,'13.50');ocr.lines.splice(3,0,line('矿泉水',950),line('x2',1010),line('共3件',1450));
 assert.deepEqual(inspectCheckout(ocr,plan)?.items,[{item:'百事无糖可乐',quantity:1},{item:'矿泉水',quantity:2}]);
 assert.equal(inspectCheckout(ocr,{...plan,allowTopUp:false}),null);
 assert.equal(inspectCheckout(ocr,{...plan,maxTotalFen:1300}),null);
 assert.equal(inspectCheckout(ocr,{...plan,quantity:2}),null);
 const unrelated=structuredClone(ocr);unrelated.lines.find(l=>l.text==='百事无糖可乐').text='橙汁';assert.equal(inspectCheckout(unrelated,plan),null);
});

test('continuing the same purchase retains earlier count and budget while explicit changes replace them',()=>{
 const messages=[{role:'user',content:'淘宝买两瓶无糖可乐，预算20元，到结算页，可以凑单'},{role:'user',content:'继续打开淘宝买无糖可乐'}];
 const task={messages,phoneQuery:grant('无糖可乐')};const plan=taskCheckoutPlan(task);
 assert.equal(plan.quantity,2);assert.equal(plan.maxTotalFen,2000);assert.equal(plan.allowTopUp,true);
 const changed=taskCheckoutPlan({...task,messages:[...messages,{role:'user',content:'继续买一瓶无糖可乐，预算15元'}]});assert.equal(changed.quantity,1);assert.equal(changed.maxTotalFen,1500);
});

test('real colloquial meal requests strip eating and choice suffixes without losing the dish',()=>{
 for(const request of ['用淘宝闪购给我整个鸡腿饭吃吃','给我点个鸡腿饭吃 随便选一个','给我点个鸡腿饭吃，随便选一个']){
  const grant=checkoutQueryFromPrompt(request);assert.equal(grant?.query,'鸡腿饭',request);assert.equal(grant.platform,'taobao');
 }
});

test('choice of one candidate does not change two requested meals, budget or required specifications',()=>{
 const phoneQuery=grant('牛肉面');
 const plan=taskCheckoutPlan({phoneQuery,messages:[{role:'user',content:'在淘宝点两份牛肉面，规格“微辣”，预算40元，到结算页'},{role:'user',content:'你随便选一个就行 继续'}]});
 assert.equal(plan.query,'牛肉面');assert.equal(plan.quantity,2);assert.equal(plan.maxTotalFen,4000);assert.ok(plan.requestedSpecifications.includes('微辣'));
});



test('a trailing human beneficiary is not part of the ordered item',()=>{
 for(const text of ['点个无糖可乐给我','帮我买一瓶无糖可乐给我喝','给我点个无糖可乐给我'])assert.equal(checkoutQueryFromPrompt(text)?.query,'无糖可乐');
 assert.equal(checkoutQueryFromPrompt('买一瓶给我力量能量饮料')?.query,'给我力量能量饮料');
});



test('model context retains original purchase constraints and corrections without a scripted routing result',()=>{
 for(const correction of ['换成一份猪脚饭，预算20元','继续打开淘宝买无糖可乐，不要凑单','最后只准备一杯咖啡到结算页','换成牛肉面，只比较价格']){
  const original='在淘宝点两份牛肉面，预算40元，到结算页我自己付款';
  const task={messages:[{id:'u1',role:'user',content:original},{id:'u2',role:'user',content:correction}]};
  const packed=JSON.parse(buildConversationContext(task).text);assert.equal(packed.messages[0].content,original);assert.equal(packed.messages.at(-1).content,correction);
 }
});
