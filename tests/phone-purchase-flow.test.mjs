import test from 'node:test';
import assert from 'node:assert/strict';
import {purchaseFlow} from '../src/adapters/phone-purchase-flow.mjs';
const ocr=(labels)=>({height:2000,lines:labels.map(([text,y],i)=>({id:'t'+i,text,bounds:[50,y,950,y+50]}))});
test('ordinary product, SKU, cart and checkout have different next steps and current target refs',()=>{
 const product=purchaseFlow(ocr([['无糖可乐',500],['加入购物车',1750],['领券购买',1800]]));assert.equal(product.stage,'product');assert.equal(product.next,'buy_now');assert.equal(product.visibleBuyTargets[0].targetId,'t2');
 const spec=purchaseFlow(ocr([['规格',600],['购买数量',1400],['立即购买',1800]]));assert.equal(spec.stage,'specification');
 assert.equal(purchaseFlow(ocr([['购物车',100],['结算(1)',1800]])).stage,'cart');
 const ready=purchaseFlow(ocr([['确认订单',100],['提交订单',1800]]));assert.equal(ready.stage,'checkout');assert.equal(ready.next,'read_full_then_handoff');
 assert.equal(purchaseFlow(ocr([['领券购买',300],['搜索',100]])).stage,'browsing');assert.equal(purchaseFlow(null),null);
});
