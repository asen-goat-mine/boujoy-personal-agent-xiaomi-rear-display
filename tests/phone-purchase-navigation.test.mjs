import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyPurchaseNavigation} from '../src/adapters/phone-purchase-navigation.mjs';
import {checkoutQueryFromPrompt} from '../src/core/checkout.mjs';

const grant={taskId:'t',platform:'taobao',query:'冰美式',quantity:1,payment:'user',goal:'checkout',authority:'prepare_only'};
const line=(id,text,y,x=500)=>({id,text,bounds:[x-80,y-30,x+80,y+30],center:{x,y}});
function frame(lines,{pkg='com.taobao.taobao',tree=''}={}){
 return {id:'obs',taskId:'t',at:Date.now(),ocr:{width:1000,height:2000,lines},
  tree:{content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:pkg,windowPkg:pkg,tree:`window pkg=${pkg} id=1 bounds=0,0,1000,2000\nFrameLayout bounds=0,0,1000,2000\n${tree}`}})}]}};
}
const tap=target=>({observationId:'obs',action:'tap',textTargetId:target});

test('ordinary store, spec and ad controls inside the platform are navigable',()=>{
 const f=frame([line('store','淘宝便利店(东莞厚街店)',400),line('spec','大杯',800),line('close','关闭',200,900)]);
 for(const id of ['store','spec','close'])assert.equal(classifyPurchaseNavigation('t',tap(id),f,grant).kind,'purchase_tap');
 assert.equal(classifyPurchaseNavigation('t',{observationId:'obs',action:'swipe',x1:500,y1:1500,x2:500,y2:600},f,grant).kind,'purchase_scroll');
 assert.equal(classifyPurchaseNavigation('t',{observationId:'obs',action:'back'},f,grant).kind,'purchase_back');
 assert.equal(classifyPurchaseNavigation('t',{observationId:'obs',action:'type',text:'冰美式'},f,grant).kind,'purchase_search');
 assert.equal(classifyPurchaseNavigation('t',{observationId:'obs',action:'type',text:'别的东西'},f,grant),null);
});
test('opening a product specification panel does not consume a cart item; confirming its quantity does',()=>{
 assert.equal(classifyPurchaseNavigation('t',tap('add'),frame([line('add','加入购物车',1800)]),grant).kind,'purchase_open_spec');
 const specification=frame([line('add','加入购物车',1800),line('quantity','数量',1200),line('storage','储存方式',800)]);
 assert.equal(classifyPurchaseNavigation('t',tap('add'),specification,grant).kind,'purchase_add');
 assert.equal(classifyPurchaseNavigation('t',tap('plus'),frame([line('plus','+',1200)]),grant).kind,'purchase_add');
});
test('payment, submission, account and consent controls are refused, including via the native hit area',()=>{
 for(const text of ['立即支付','去支付 ¥12','确认付款','登录','同意并继续','开通会员','修改地址','联系客服','删除'])assert.equal(classifyPurchaseNavigation('t',tap('x'),frame([line('x',text,900)]),grant),null,text);
 const hidden=frame([line('x','¥12',900)],{tree:'Button "免密支付" clickable bounds=400,860,600,940'});
 assert.equal(classifyPurchaseNavigation('t',tap('x'),hidden,grant),null);
});
test('the order page or a password field is a hand-off point, not a tap target',()=>{
 assert.equal(classifyPurchaseNavigation('t',tap('i'),frame([line('t','确认订单',100),line('i','冰美式',500),line('s','提交订单',1900)]),grant).handoff,true);
 assert.equal(classifyPurchaseNavigation('t',tap('i'),frame([line('i','输入',500)],{tree:'EditText password bounds=0,400,1000,600'}),grant).handoff,true);
});
test('other apps, stale or foreign frames and non-purchase tasks get nothing',()=>{
 assert.equal(classifyPurchaseNavigation('t',tap('a'),frame([line('a','设置',300)],{pkg:'com.android.settings'}),grant),null);
 assert.equal(classifyPurchaseNavigation('t',tap('a'),{...frame([line('a','店',300)]),at:Date.now()-60000},grant),null);
 assert.equal(classifyPurchaseNavigation('other',tap('a'),frame([line('a','店',300)]),grant),null);
 assert.equal(classifyPurchaseNavigation('t',tap('a'),frame([line('a','店',300)]),{...grant,payment:'agent'}),null);
});
test('payer phrasing is not part of the searched item',()=>{
 for(const prompt of ['淘宝点杯冰美式 我来付钱','淘宝点一杯冰美式我付','淘宝点一杯冰美式，我来买单'])assert.equal(checkoutQueryFromPrompt(prompt)?.query,'冰美式',prompt);
});

test('a purchase can search a chosen menu item without changing its source-bound brand or meal goal',()=>{
 const g={...grant,query:'星巴克咖啡'},search=frame([line('search','搜索店内商品',140)],{tree:'EditText "搜索店内商品" editable focused bounds=100,100,750,180'});
 assert.equal(classifyPurchaseNavigation('t',{observationId:'obs',action:'type',text:'美式',inputMode:'replace'},search,g)?.kind,'purchase_search');
 assert.equal(g.query,'星巴克咖啡');
 assert.equal(classifyPurchaseNavigation('t',{observationId:'obs',action:'type',text:'美式'},frame([line('address','收货地址',500)],{tree:'EditText "搜索" editable focused bounds=100,100,750,180'}),g),null);
 assert.equal(classifyPurchaseNavigation('t',{observationId:'obs',action:'type',text:'美式'},frame([],{pkg:'com.tencent.mm',tree:'EditText "搜索" editable focused bounds=100,100,750,180'}),g),null);
});

test('ordinary buy-now opens product checkout preparation while actual submit and payment remain blocked',()=>{
 for(const text of ['立即购买','领券购买'])assert.equal(classifyPurchaseNavigation('t',tap('buy'),frame([line('buy',text,1800)]),grant)?.kind,'purchase_buy_now');
 for(const text of ['提交订单','立即支付','免密支付'])assert.ok(!classifyPurchaseNavigation('t',tap('buy'),frame([line('buy',text,1800)]),grant)||classifyPurchaseNavigation('t',tap('buy'),frame([line('buy',text,1800)]),grant).handoff);
});

test('the actual Samsung USB notice allows only dismissing Back, never settings or another app target',()=>{
 const warning=frame([line('title','支付安全',1500),line('body','关闭 USB 调试来提升支付安全性。',1600),line('ignore','忽略',1800),line('close','关闭',1800,800)],{pkg:'com.tencent.mm'});
 assert.equal(classifyPurchaseNavigation('t',{observationId:'obs',action:'back'},warning,grant)?.kind,'purchase_dismiss_notice');
 for(const id of ['ignore','close'])assert.equal(classifyPurchaseNavigation('t',tap(id),warning,grant),null);
 assert.equal(classifyPurchaseNavigation('t',{observationId:'obs',action:'type',text:'anything'},warning,grant),null);
 const unrelated=structuredClone(warning);unrelated.ocr.lines[1].text='立即支付以继续';assert.equal(classifyPurchaseNavigation('t',{observationId:'obs',action:'back'},unrelated,grant),null);
});
