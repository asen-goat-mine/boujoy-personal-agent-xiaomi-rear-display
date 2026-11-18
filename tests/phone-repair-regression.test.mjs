import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';import {Engine} from '../src/core/engine.mjs';
import {nativePage,nativeNode,nativeButton,nativeBrokerFixture} from './helpers/phone-native-fixture.mjs';
import {checkoutHandoff,taskCheckoutPlan,checkoutQueryFromPrompt} from '../src/core/checkout.mjs';
import {buildSimplePhoneAction} from '../src/adapters/simple-phone-use.mjs';
import {PhoneUseDriver} from '../src/adapters/phoneuse-driver.mjs';
const app={packageName:'com.example.catalog',label:'示例商城',aliases:['示例商城']};
function engine(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-routing-')),store=new Store(dir,{lock:false}),e=new Engine({store,broker:{approvals:{cancelTask(){}},calls:new Map()},secrets:{get:async()=>null}});e.pump=async()=>{};t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {e,store};}
test('finished conversation starts isolated execution and replay keeps same new task',async t=>{
 const {e,store}=engine(t),old=e.create({prompt:'淘宝买一盒彩笔，到结算页',cloudConsent:true});store.updateTask(old.id,x=>{x.status='blocked';x.requests=59;x.checkout={old:true};x.phoneUseScope={old:true};});
 const input={message:'打开设置，查看存储空间',clientRequestId:randomUUID(),cloudConsent:true};
 const next=await e.message(old.id,input);assert.notEqual(next.id,old.id);assert.equal(next.conversationId,old.id);assert.equal(next.requests,0);assert.equal(next.phoneQuery,null);assert.equal(next.phoneUseScope,null);assert.ok(!next.checkout);assert.equal(next.messages.length,1);assert.equal((await e.message(old.id,input)).id,next.id);
});
test('new goal preserves queued work; correction is independently routed and cancellation targets the selected task',async t=>{
 const {e,store}=engine(t),old=e.create({prompt:'淘宝买两瓶苏打水，到结算页',cloudConsent:true});
 const next=await e.message(old.id,{message:'打开日历，看看明天安排',clientRequestId:randomUUID(),cloudConsent:true});assert.equal(store.task(old.id).status,'queued');assert.notEqual(next.id,old.id);
 const shopping=e.create({prompt:'淘宝买两瓶苏打水，到结算页',cloudConsent:true});const correction=await e.message(shopping.id,{message:'换成三瓶',clientRequestId:randomUUID(),cloudConsent:true});assert.notEqual(correction.id,shopping.id);assert.equal(taskCheckoutPlan(store.task(shopping.id)).quantity,2);
 await e.message(shopping.id,{message:'算了不要了',clientRequestId:randomUUID()});assert.equal(store.task(shopping.id).status,'cancelled');
});
test('duplicate labels select observed main content and irrelevant fields disappear',()=>{
 const page=nativePage(app,[nativeButton('查看',100),nativeButton('查看',600)]);page.stabilityScope='general';page.at=Date.now()-30000;
 const result=buildSimplePhoneAction(page,{action:'tap',target:'查看',mode:'full',extra:'ignore'},{taskId:'t',allowScopedControls:true});assert.equal(result.y,page.ocr.lines[1].center.y);assert.equal(result.x,page.ocr.lines[1].center.x);assert.ok(!('extra' in result));
});
test('visible unfocused input falls back to IME, password stays user-only',async()=>{
 const driver=new PhoneUseDriver({client:{}});let native={deviceId:'d',observationId:'o',serviceInstanceId:'s',windowId:1,elements:[{visible:true,enabled:true,editable:true,focused:false,password:false,actions:['set_text']}]};
 await assert.rejects(driver.call('d','type',{text:'replacement',mode:'replace'},6000,{native}),e=>e.code==='phone_input_unavailable');native.elements[0].focused=true;native.elements[0].password=true;
 await assert.rejects(driver.call('d','type',{text:'secret',mode:'replace'},6000,{native}),e=>e.code==='user_only_step');
});
test('OCR confirmation page is enough for handoff even with mixed cart/unknown amount',()=>{
 const page=nativePage(app,[nativeNode('确认订单',180),nativeNode('甲商品',700),nativeNode('乙商品',950),nativeButton('提交订单',2200)]);const result=checkoutHandoff(page,null);assert.equal(result.page,'checkout');assert.equal(result.verified,false);assert.equal(result.totalFen,null);
 const payment=nativePage(app,[nativeNode('收银台',180),nativeButton('立即支付',2200)]);assert.equal(checkoutHandoff(payment),null);
});
test('sending keeps exact recipient/content and verifies the new message',async()=>{
 const chat={packageName:'com.tencent.mm',label:'微信',aliases:['微信']};
 const edit=text=>nativeNode(text,1800,{editable:true,focused:true,class:'android.widget.EditText',actions:['set_text','tap']});
 const home=nativePage(chat,[nativeNode('文件传输助手',180),edit('旧草稿'),nativeButton('发送',2000)]),draft=nativePage(chat,[nativeNode('文件传输助手',180),edit('联调记录一'),nativeButton('发送',2000)]),sent=nativePage(chat,[nativeNode('文件传输助手',180),nativeNode('联调记录一',900),edit('')]);
 const f=nativeBrokerFixture('微信给文件助手发：联调记录一',chat,home,[draft,sent]);await f.broker.execute('t','phone_use',{action:'open_app',app:'微信'});await f.broker.execute('t','phone_use',{action:'type',text:'联调记录一'});await f.broker.execute('t','phone_use',{action:'tap',target:'发送'});
 await f.broker.execute('t','finish_task',{outcome:'completed',summary:'已发送',evidence:[f.phone.observation.id]});assert.equal(f.t.report.outcome,'completed');assert.equal(f.calls.filter(c=>c.name==='tap').length,1);
});
