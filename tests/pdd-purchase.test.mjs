import test from 'node:test';
import assert from 'node:assert/strict';
import {checkoutQueryFromPrompt} from '../src/core/checkout.mjs';
import {preparationGrant,classifyPreparationAction} from '../src/adapters/phone-preparation.mjs';
import {nativeNode as n,nativeButton as b,nativePage as page,nativeTask as task,nativeTap as tap,nativeBrokerFixture as fixture} from './helpers/phone-native-fixture.mjs';
const APP={packageName:'com.xunmeng.pinduoduo',appName:'拼多多',label:'拼多多'},prompt='在拼多多买一件保温杯，规格“500ml,黑色”，预算30元，到结算页';
const extra={kind:'shopping',phoneQuery:checkoutQueryFromPrompt(prompt)};
const product=()=>page(APP,[n('商品详情',120),n('保温杯',400),n('单独购买价：¥18.00',500),b('单独购买',2100,{description:'选择规格'})]);
const spec=(selected=['500ml','黑色'])=>page(APP,[n('确认规格',120),n('规格',220),n('保温杯',400),n('单独购买价：¥18.00',500),n('购买方式：单独购买',600),b('500ml',800,{selected:selected.includes('500ml')}),b('黑色',900,{selected:selected.includes('黑色')}),n('数量：1',1000),n('下一步：确认订单',1800),b('确定',2100)]);
const checkout=()=>page(APP,[n('确认订单',120),n('保温杯',500),n('x1',560),n('500ml',700),n('黑色',800),n('实付 ¥18.00',2100),b('提交订单',2250)]);
function stable(p){return {...p,stability:'stable',stabilityScope:'full'};}
test('PDD purchase step requires native next-step semantics, single-buy price, exact SKU and quantity',()=>{
 const g=preparationGrant(task(prompt,extra)),p=stable(product());assert.equal(classifyPreparationAction('t',tap(p,'单独购买'),p,g)?.kind,'prepare_pdd_choose_sku');
 const s=stable(spec());assert.equal(classifyPreparationAction('t',tap(s,'确定'),s,g)?.kind,'prepare_pdd_confirm_sku');
 const bare=stable(page(APP,[n('商品详情',120),n('保温杯',400),n('单独购买价：¥18.00',500),b('单独购买',2100)]));assert.equal(classifyPreparationAction('t',tap(bare,'单独购买'),bare,g),null,'label alone is not evidence of a preparation-only transition');
 for(const transform of [rows=>rows.filter(r=>r.text!=='下一步：确认订单'),rows=>rows.map(r=>r.text==='数量：1'?{...r,text:'数量：2'}:r),rows=>rows.map(r=>r.text==='黑色'?{...r,selected:false}:r),rows=>[...rows,n('免密支付',1950)],rows=>[...rows,n('白色',1100,{selected:true})]]){
  const rows=spec().native.elements.slice(1),bad=stable(page(APP,transform(rows)));assert.equal(classifyPreparationAction('t',tap(bad,'确定'),bad,g),null);
 }
 const final=stable(checkout());assert.equal(classifyPreparationAction('t',tap(final,'提交订单'),final,g),null,'order creation remains a separate payment tool');
});
test('Broker → Phone PDD single purchase and SKU confirmation reaches checked checkout without creating an order',async()=>{
 const f=fixture(prompt,APP,product(),[spec([]),spec(['500ml']),spec(),checkout()],extra);await f.broker.execute('t','phone_use',{action:'read',mode:'full'});
 await f.broker.execute('t','phone_use',{action:'tap',target:'单独购买'});await f.broker.execute('t','phone_use',{action:'tap',target:'500ml'});await f.broker.execute('t','phone_use',{action:'tap',target:'黑色'});await f.broker.execute('t','phone_use',{action:'tap',target:'确定'});
 await f.broker.execute('t','finish_task',{outcome:'ready_for_user',summary:'prepared',evidence:[f.phone.observation.id],checkoutItem:'保温杯',checkoutQuantity:1,checkoutTotalFen:1800});
 assert.equal(f.t.status,'ready_for_user');assert.equal(f.t.checkout.platform,'pinduoduo');assert.equal(f.calls.filter(c=>c.name==='tap').length,4);assert.ok(f.data.actions.every(a=>a.authorization==='purchase_navigation'&&a.status==='completed'));assert.equal(f.calls.filter(c=>c.name==='tap').some(c=>c.args.y>=2250),false);
});
test('PDD unchanged screen is returned without automatically replaying a completed navigation',async()=>{
 const f=fixture(prompt,APP,product(),[product()],extra);await f.broker.execute('t','phone_use',{action:'read',mode:'full'});await f.broker.execute('t','phone_use',{action:'tap',target:'单独购买'});await f.broker.execute('t','phone_use',{action:'read',mode:'full'});assert.equal(f.phone.observation.ocr.lines.some(line=>line.text==='商品详情'),true);assert.equal(f.calls.filter(c=>c.name==='tap').length,1);
});
