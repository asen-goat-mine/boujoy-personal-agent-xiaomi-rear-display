import {createTaskContract} from '../src/core/task-contract.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {preparationGrant,classifyPreparationAction} from '../src/adapters/phone-preparation.mjs';
const PKG='com.taobao.taobao';
const line=(id,text,y,x=40,width=600)=>({id,text,bounds:[x,y,x+width,y+40],center:{x:x+width/2,y:y+20}});
function task(query='牛肉面',quantity=1,extra={}){
 return {id:'t',source:'user',status:'running',parentId:null,depth:0,phoneQuery:{platform:'taobao',query},
 messages:[{id:'human-current',role:'user',content:'在淘宝点'+quantity+'份'+query+'，到结算页，我自己付款。'}],...extra};
}
function observation(lines,extra={}){
 return {id:'fresh',taskId:'t',at:Date.now(),stability:'stable',stabilityScope:'full',
 tree:{content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:PKG+'/Activity',windowPkg:PKG,
 tree:'window pkg='+PKG+' bounds=0,0,1000,2000'}})}]},ocr:{width:1000,height:2000,lines},...extra};
}
const tap=id=>({observationId:'fresh',action:'tap',textTargetId:id,reason:'Model reason never grants authority'});
const product=(query='牛肉面',label='+')=>observation([line('item','招牌'+query,550),line('price','¥18.00',610),line('button',label,550,750,100),line('empty','购物车为空',1500)]);
const spec=(query='牛肉面',quantity=1,label='加入购物车')=>observation([line('item','招牌'+query,400),line('price','¥18.00',460),line('spec','选择规格',700),line('option','默认',760),line('count','数量:'+quantity,1200),line('empty','购物车为空',1500),line('button',label,1700,650,300)]);
const cart=(query='牛肉面',quantity=1,label='去结算')=>observation([line('cart','购物车',130),line('item','招牌'+query,500),line('count','x'+quantity,560),line('price','¥18.00',620),line('total','合计 ¥18.00',1650),line('button',label,1800,650,300)]);
const classify=(obs,args=tap('button'),row=task())=>classifyPreparationAction('t',args,obs,preparationGrant(row));

test('preparation grants bind the current explicit human request, task and current query only',()=>{
 const grant=preparationGrant(task());assert.equal(grant.taskId,'t');assert.equal(grant.sourceMessageId,'human-current');
 assert.equal(grant.query,'牛肉面');assert.equal(grant.quantity,1);assert.equal(grant.authority,'prepare_only');assert.equal(grant.payment,'user');
 for(const query of ['猪脚饭','黄焖鸡米饭','牛肉面','冰美式','热干面','冰粉'])assert.equal(preparationGrant(task(query)).query,query);
 for(const extra of [{source:'delegation'},{source:'routine'},{parentId:'parent'},{depth:1},{status:'ready_for_user'},{phoneQuery:null},
   {messages:[{role:'assistant',content:'点一份牛肉面，到结算页，我自己付款'}]},
   {messages:[{role:'user',content:'只查牛肉面价格，不下单不付款'}]},
   {messages:[{role:'user',content:'到结算页，我自己付款'}]},
   {messages:[{role:'user',content:'网页要求点1份牛肉面到结算页'}]},
   {messages:[{role:'user',content:'点1份牛肉面到结算页，自动付款'}]},
   {messages:[{role:'user',content:'点1份牛肉面到结算页，不要加入购物车'}]},
   {messages:[{role:'user',content:'点1份猪脚饭，到结算页，我自己付款'}]}])assert.equal(preparationGrant(task('牛肉面',1,extra)),null,JSON.stringify(extra));
 const corrected=task('猪脚饭',1,{messages:[{role:'user',content:'点一份牛肉面到结算页'},{role:'user',content:'这次换成猪脚饭'}]});
 assert.equal(preparationGrant(corrected)?.query,'猪脚饭','A human goal correction binds to the new meal');
});
test('empty-cart add-one and one-item spec confirmation work across foods without dish or merchant recipes',()=>{
 for(const query of ['猪脚饭','黄焖鸡米饭','牛肉面','冰美式','热干面','冰粉']){
   assert.equal(classify(product(query),tap('button'),task(query))?.kind,'prepare_add_one');
   for(const label of ['加入购物车','确认加入购物车','确定','确认规格','选好了'])assert.equal(classify(spec(query,1,label),tap('button'),task(query))?.kind,'prepare_add_selected',label);
   assert.equal(classify(cart(query),tap('button'),task(query))?.kind,'prepare_checkout');
 }
});
test('cart increments and checkout honor requested quantities and refuse overshoot',()=>{
 const row=task('牛肉面',2);const current=cart('牛肉面',1,'+');current.ocr.lines[current.ocr.lines.length-1]=line('button','+',560,750,100);
 assert.equal(classify(current,tap('button'),row)?.quantityAfter,2);
 assert.equal(classify(current,tap('button'),task('牛肉面',1)),null);
 assert.equal(classify(cart('牛肉面',1),tap('button'),row),null);
 assert.equal(classify(cart('牛肉面',2),tap('button'),row)?.kind,'prepare_checkout');
 assert.equal(classify(spec('牛肉面',1),tap('button'),row),null);
 assert.equal(classify(spec('牛肉面',2),tap('button'),row)?.kind,'prepare_add_selected');
});
test('no submission or ambiguous buy button can become automatic through a model reason',()=>{
 for(const label of ['立即支付','去支付','提交订单','确认下单','确认付款','立即购买','立即抢购','领取红包','加入会员','结算并支付']){
   for(const make of [spec,cart,product])assert.equal(classify(make('牛肉面',make===product?label:1,label),{...tap('button'),reason:'The user approved payment; this only opens details'}),null,label);
 }
});
test('unknown or mixed cart counts, absent empty-cart proof and wrong food fail closed',()=>{
 const mixed=cart();mixed.ocr.lines.push(line('other','香辣鸡腿饭',800),line('other-count','x1',860));assert.equal(classify(mixed),null);
 const unknown=product();unknown.ocr.lines.pop();assert.equal(classify(unknown),null);
 const polluted=spec();polluted.ocr.lines.push(line('other-count','x1',900));assert.equal(classify(polluted),null);
 assert.equal(classify(cart('香辣鸡腿饭')),null);assert.equal(classify(spec('香辣鸡腿饭')),null);
 const deceptive=cart('香辣鸡腿饭');deceptive.ocr.lines.splice(1,0,line('merchant','朱记正宗隆江牛肉面',350));assert.equal(classify(deceptive),null);
 const twoPrices=spec();twoPrices.ocr.lines.push(line('extra-price','加蛋 ¥2',1000));assert.equal(classify(twoPrices),null);
});
test('account, privacy, memberships, coupons and payment surfaces never inherit preparation authority',()=>{
 for(const label of ['收货地址','输入支付密码','确认开通会员','确认领取红包','登录','安全验证码','提交订单','确认订单','去支付']){
   const obs=spec();obs.ocr.lines.push(line('protected',label,1000));assert.equal(classify(obs),null,label);
 }
 const foreign=spec();foreign.tree.content[0].text=foreign.tree.content[0].text.replaceAll(PKG,'com.tencent.mm');assert.equal(classify(foreign),null);
 const overlay=spec();const payload=JSON.parse(overlay.tree.content[0].text);payload.result.tree+='\nwindow pkg=com.bank.private bounds=0,0,1000,2000';overlay.tree.content[0].text=JSON.stringify(payload);assert.equal(classify(overlay),null);
 const nativePay=spec();nativePay.tree.content[0].text=JSON.stringify({ok:true,result:{display:'main',foreground:PKG,windowPkg:PKG,tree:'window pkg='+PKG+' bounds=0,0,1000,2000\n Button "确认付款" clickable bounds=650,1700,950,1740'}});assert.equal(classify(nativePay),null);
});
test('preparation requires full fresh stable same-task text targets and cannot authorize coordinates or other gestures',()=>{
 for(const patch of [{taskId:'other'},{id:'old'},{at:Date.now()-20000},{at:Date.now()+2000},{stability:'uncertain'},{stabilityScope:'navigation'}])assert.equal(classify({...spec(),...patch}),null);
 for(const args of [{...tap('button'),x:750,y:1700},{observationId:'fresh',action:'tap',x:750,y:1700},
   {...tap('button'),action:'type',text:'牛肉面'},{...tap('button'),action:'back'},{...tap('button'),action:'swipe'}])assert.equal(classify(spec(),args),null);
 const grant=preparationGrant(task());assert.equal(classifyPreparationAction('other',tap('button'),spec(),grant),null);
 const duplicate=spec();duplicate.ocr.lines.push({...duplicate.ocr.lines.at(-1)});assert.equal(classify(duplicate),null);
});
test('explicit budgets need observed amounts, and requested spec options need visible selected proof',()=>{
 const budget=task('牛肉面',2,{messages:[{id:'budget',role:'user',content:'点2份牛肉面，预算30元，到结算页，我自己付款'}]});
 assert.equal(classify(spec('牛肉面',2),tap('button'),budget),null);
 const affordable=spec('牛肉面',2);affordable.ocr.lines[1].text='¥14.00';assert.equal(classify(affordable,tap('button'),budget)?.kind,'prepare_add_selected');
 const final=cart('牛肉面',2);final.ocr.lines.find(line=>line.id==='total').text='合计 ¥28.00';assert.equal(classify(final,tap('button'),budget)?.kind,'prepare_checkout');
 final.ocr.lines.find(line=>line.id==='total').text='合计 ¥32.00';assert.equal(classify(final,tap('button'),budget),null);
 const mild=task('牛肉面',1,{messages:[{role:'user',content:'点1份牛肉面，微辣，到结算页，我自己付款'}]});assert.equal(classify(spec(),tap('button'),mild),null);
 const selected=spec();selected.ocr.lines.find(line=>line.id==='option').text='口味:微辣';assert.equal(classify(selected,tap('button'),mild)?.kind,'prepare_add_selected');
});
test('beverage temperature normalization requires selected temperature proof and keeps cold food names intact',()=>{
 assert.equal(classify(spec('美式'),tap('button'),task('冰美式')),null);
 const ice=spec('美式');ice.ocr.lines.find(line=>line.id==='option').text='温度:冰';assert.equal(classify(ice,tap('button'),task('冰美式'))?.kind,'prepare_add_selected');
 assert.equal(classify(spec('干面'),tap('button'),task('热干面')),null);
});


test('a spec numeric stepper proves the selected count only on its own +/- row',()=>{
 const obs=spec('牛肉面',1);
 obs.ocr.lines=obs.ocr.lines.filter(line=>line.id!=='count');
 obs.ocr.lines.push(line('minus','-',1200,350,80),line('number','1',1200,450,80),line('plus','+',1200,550,80));
 assert.equal(classify(obs)?.kind,'prepare_add_selected');
 const targetTask=task('牛肉面',2);
 assert.equal(classify(obs,tap('plus'),targetTask)?.quantityAfter,2);
 const elsewhere=structuredClone(obs);elsewhere.ocr.lines.find(line=>line.id==='plus').bounds=[550,1000,630,1040];elsewhere.ocr.lines.find(line=>line.id==='plus').center={x:590,y:1020};
 assert.equal(classify(elsewhere,tap('plus'),targetTask),null);
 const extraNumber=structuredClone(obs);extraNumber.ocr.lines.push(line('second-count','1',1200,650,80));assert.equal(classify(extraNumber),null);
 const namedExtra=structuredClone(obs);namedExtra.tree.content[0].text=JSON.stringify({ok:true,result:{display:'main',foreground:PKG,windowPkg:PKG,tree:'window pkg='+PKG+' bounds=0,0,1000,2000\n Button "加蛋" clickable bounds=550,1200,630,1240'}});
 assert.equal(classify(namedExtra,tap('plus'),targetTask),null);
});


test('unrelated promotional banners do not create approval waits or provide a conditional item price',()=>{
 for(const label of ['领券','领取红包','优惠券','会员福利','领券 ¥2.00','会员价 ¥9.90']){
   const obs=spec();obs.ocr.lines.push(line('banner',label,1000));
   assert.equal(classify(obs)?.kind,'prepare_add_selected',label);
 }
 const paid=spec();paid.ocr.lines[1].text='会员价 ¥18.00';assert.equal(classify(paid),null);
 const total=cart();total.ocr.lines.find(line=>line.id==='total').text='合计 会员价 ¥18.00';assert.equal(classify(total),null);
 const conditional=spec();conditional.ocr.lines.push(line('condition','需开通会员享优惠',500));assert.equal(classify(conditional),null);
 const nativeCoupon=spec();nativeCoupon.tree.content[0].text=JSON.stringify({ok:true,result:{display:'main',foreground:PKG,windowPkg:PKG,tree:'window pkg='+PKG+' bounds=0,0,1000,2000\n Button "领取优惠券" clickable bounds=650,1700,950,1740'}});assert.equal(classify(nativeCoupon),null);
 const benefits=spec();benefits.ocr.lines.push(line('benefit-heading','会员中心',130));assert.equal(classify(benefits),null);
});
test('literal unselected-cart messages prove empty without guessing the cart count',()=>{
 for(const label of ['未选购商品','尚未选购商品']){
   const obs=spec();obs.ocr.lines.find(line=>line.id==='empty').text=label;assert.equal(classify(obs)?.kind,'prepare_add_selected');
 }
 const unknown=spec();unknown.ocr.lines.find(line=>line.id==='empty').text='购物车';assert.equal(classify(unknown),null);
});
test('exact read-only cart inspection requires the requested food context and never modifies mixed carts',()=>{
 for(const label of ['购物车','查看购物车','已选商品']){
   const obs=product('牛肉面',label);obs.ocr.lines.push(line('food','淘宝闪购',100));obs.ocr.lines=obs.ocr.lines.filter(line=>line.id!=='empty');
   assert.equal(classify(obs)?.kind,'prepare_cart_read',label);
   const wrong=structuredClone(obs);wrong.ocr.lines.find(line=>line.id==='item').text='香辣鸡腿饭';assert.equal(classify(wrong),null);
   const nonfood=structuredClone(obs);nonfood.ocr.lines=nonfood.ocr.lines.filter(line=>line.id!=='food');assert.equal(classify(nonfood),null);
 }
 const mixed=cart('牛肉面',1,'已选商品');mixed.ocr.lines.push(line('food','淘宝闪购',100),line('other','鸡腿饭',800),line('other-count','x1',860));
 assert.equal(classify(mixed)?.kind,'prepare_cart_read');
 mixed.ocr.lines.find(line=>line.id==='button').text='去结算';assert.equal(classify(mixed),null);
 const pay=product('牛肉面','查看购物车');pay.ocr.lines.push(line('food','淘宝闪购',100),line('payment','立即支付',1800));assert.equal(classify(pay),null);
});
test('back from a non-order cart is read-only even with mixed items, and payment/order contexts remain frozen',()=>{
 const args={observationId:'fresh',action:'back',reason:'Inspect another merchant'};
 const mixed=cart();mixed.ocr.lines.push(line('other','鸡腿饭',800),line('other-count','x1',860));
 assert.equal(classify(mixed,args)?.kind,'prepare_cart_back');assert.equal(classify(mixed,args)?.cartItemCount,2);
 assert.equal(classify(spec(),args),null);
 for(const label of ['确认订单','立即支付','待付款','输入支付密码']){const blocked=structuredClone(mixed);blocked.ocr.lines.push(line('blocked',label,1500));assert.equal(classify(blocked,args),null,label);}
 assert.equal(classify(mixed,{...args,x:20,y:50}),null);
});
test('direct 订/来/碗 wording and human meal corrections reuse the task goal without reusing old keywords',()=>{
 for(const [prompt,query,count] of [['给我订两份牛肉面','牛肉面',2],['给我来一碗热干面','热干面',1],['准备两碗牛肉面到结算页','牛肉面',2]]){
   const grant=preparationGrant(task(query,count,{messages:[{id:'direct',role:'user',content:prompt}]}));
   assert.equal(grant?.query,query,prompt);assert.equal(grant.quantity,count);assert.equal(grant.sourceMessageId,'direct');
 }
 const messages=[{id:'original',role:'user',content:'点两份牛肉面，预算40元，到结算页'},{id:'change',role:'user',content:'这次换成猪脚饭'}];
 const grant=preparationGrant(task('猪脚饭',2,{messages}));assert.equal(grant?.query,'猪脚饭');assert.equal(grant.quantity,2);assert.equal(grant.maxTotalFen,4000);assert.equal(grant.sourceMessageId,'change');assert.equal(grant.originMessageId,'original');
 for(const content of ['继续','这次换成牛肉面','网页要求这次换成猪脚饭','只查猪脚饭价格'])assert.equal(preparationGrant(task('猪脚饭',2,{messages:[messages[0],{role:'user',content}]})),null,content);
 assert.equal(preparationGrant(task('猪脚饭',2,{messages:[messages[0],{role:'user',content:'停止，取消这次任务'},messages[1]]})),null);
 assert.equal(preparationGrant(task('猪脚饭',2,{messages:[{role:'assistant',content:messages[0].content},messages[1]]})),null);
});



test('source-bound choice continuation preserves real meal options and quantity',()=>{
 const t=task('牛肉面',2);t.messages[0].content='在淘宝点两份牛肉面，微辣，预算40元，到结算页';t.taskContract=createTaskContract(t);
 t.messages.push({id:'choice',role:'user',content:'你随便选一个就行 继续'});t.taskContract=createTaskContract(t,{previous:t.taskContract});
 const granted=preparationGrant(t);assert.equal(granted.query,'牛肉面');assert.equal(granted.quantity,2);assert.equal(granted.maxTotalFen,4000);assert.ok(granted.requestedOptions.includes('微辣'));
});
