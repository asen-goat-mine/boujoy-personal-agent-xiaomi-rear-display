import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAfterSalesRequest} from '../src/core/after-sales-contract.mjs';
import {phoneUseGrant,classifyPhoneUseAction,effectGoalStatus} from '../src/adapters/phone-use.mjs';
import {nativeNode as n,nativeButton as b,nativePage as page,nativeTask as task,nativeTap as tap,nativeBrokerFixture as fixture} from './helpers/phone-native-fixture.mjs';
const APP={packageName:'com.xunmeng.pinduoduo',appName:'拼多多',label:'拼多多'};
const prompt='在拼多多为订单“1234567890”的商品“保温杯”申请仅退款，数量1件，退款金额18元，退款原因“商品破损”，退款方式“原路退回”，货物状态“已收到货”，费用上限0元';
const grant=content=>phoneUseGrant(task(content),APP);
function form({returnGoods=false,changes={},extra=[]}={}){
 const pairs={'订单号':'1234567890','商品':'保温杯','数量':'1','售后类型':returnGoods?'退货退款':'仅退款','货物状态':'已收到货','退款原因':'商品破损','退款金额':'¥18.00','退款方式':'原路退回','费用':'¥0.00',...(returnGoods?{'退货方式':'自行寄回'}:{}),...changes};
 return [...Object.entries(pairs).map(([description,text],i)=>n(text,120+i*100,{description})),...extra];
}
const complete=(options={})=>page(APP,[...form(options),n('申请已提交',1500),n('等待商家处理',1600),n('AS123456789',1700,{description:'售后单号'})]);
test('after-sales requires explicit exact application fields and rejects missing costs or a new financial commitment',()=>{
 const parsed=parseAfterSalesRequest(prompt);assert.equal(parsed.amountFen,1800);assert.equal(parsed.quantity,1);assert.equal(grant(prompt).effectPlan.kind,'after_sales');
 for(const raw of [prompt.replace('，费用上限0元',''),prompt.replace('上限0元','上限8元'),prompt.replace('原路退回','指定账户'),prompt.replace('数量1件','数量2件和3件'),prompt.replace('，退款原因“商品破损”',''),prompt.replace('申请仅退款','不要申请仅退款'),prompt.replace('申请仅退款','申请退货退款')])assert.equal(grant(raw),null,raw);
 const ret=prompt.replace('申请仅退款','申请退货退款')+'，退货方式“自行寄回”';assert.equal(grant(ret).effectPlan.operation,'return_refund');assert.equal(grant(ret.replace('自行寄回','上门取件')),null);
});
test('native submit binds order/item/quantity/refund terms and never accepts fees, agreement or wrong fields',()=>{
 const g=grant(prompt),valid=page(APP,[...form(),b('提交申请',2100)]),decision=classifyPhoneUseAction('t',tap(valid,'提交申请'),valid,g);assert.equal(decision?.kind,'effect_after_sales_submit');
 for(const changes of [{'订单号':'9999999999'},{'商品':'水壶'},{'数量':'2'},{'退款金额':'¥18.01'},{'退款原因':'不想要了'},{'退款方式':'平台余额'},{'费用':'¥5.00'}]){const p=page(APP,[...form({changes}),b('提交申请',2100)]);assert.equal(classifyPhoneUseAction('t',tap(p,'提交申请'),p,g),null,JSON.stringify(changes));}
 for(const extra of [[n('同意新的服务协议',1900)],[n('费用：¥0.00',1900)],[n('secret',1900,{editable:true,password:true})]]){const p=page(APP,[...form({extra}),b('提交申请',2100)]);assert.equal(classifyPhoneUseAction('t',tap(p,'提交申请'),p,g),null);}
 const receipt={status:'completed',phoneEffect:decision};assert.equal(effectGoalStatus(complete(),g,[receipt]).verified,true);assert.equal(effectGoalStatus(complete(),g,[]).verified,false);
 assert.equal(effectGoalStatus(complete({changes:{'退款金额':'¥17.00'}}),g,[receipt]).verified,false);assert.equal(effectGoalStatus(complete({extra:[n('提交失败',1800)]}),g,[receipt]).verified,false);
});