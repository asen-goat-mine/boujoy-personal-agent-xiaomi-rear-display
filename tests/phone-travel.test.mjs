import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTravelRequest} from '../src/core/travel-contract.mjs';
import {phoneUseGrant,classifyPhoneUseAction,effectGoalStatus} from '../src/adapters/phone-use.mjs';
import {nativeNode as n,nativeButton as b,nativePage as page,nativeTask as task,nativeTap as tap,nativeBrokerFixture as fixture} from './helpers/phone-native-fixture.mjs';
const MAP={packageName:'com.autonavi.minimap',appName:'高德地图',label:'高德地图'},APP={packageName:'com.sankuai.meituan',appName:'美团',label:'美团'};
const navPrompt='在高德地图从“上海虹桥站”到“外滩”开始步行导航';
const ridePrompt='在高德地图叫车，从“上海虹桥站”到“外滩”，车型“经济型”，人数1人，费用上限50元，取消条件“接单前免费取消”，支付方式“行程结束后手动支付”';
const bookPrompt='在美团预约服务“理发”，商家“测试店”，地点“测试路1号”，时间“2026-11-20 14:00 Asia/Shanghai”，人数1人，总价上限30元，取消条件“随时免费取消”，支付方式“到店手动支付”';
const changePrompt=bookPrompt.replace('预约服务','改约服务').replace('时间“','新时间“')+'，预约号“BK12345678”，原时间“2026-11-19 14:00 Asia/Shanghai”';
function fields(pairs,start=100){return Object.entries(pairs).map(([description,text],i)=>n(text,start+i*80,{description}));}
function ride({changes={},status=null,extra=[]}={}){return page(MAP,[...fields({'上车地点':'上海虹桥站','目的地':'外滩','车型':'经济型','人数':'1','预估最高费用':'¥45.00','预付金额':'¥0.00','取消条件':'接单前免费取消','支付方式':'行程结束后手动支付',...changes}),...(status?[n(status,1400),n('TR12345678',1500,{description:'行程订单号'})]:[b('确认呼叫',2100)]),...extra]);}
function booking({changes={},status=null,reschedule=false,extra=[]}={}){return page(APP,[...fields({'服务':'理发','商家':'测试店','地点':'测试路1号','时间':'2026-11-20 14:00','时区':'Asia/Shanghai','人数':'1','总价':'¥28.00','预付金额':'¥0.00','取消条件':'随时免费取消','支付方式':'到店手动支付',...(reschedule?{'预约号':'BK12345678','改约费用':'¥0.00'}:{}),...changes}),...(status?[n(status,1600),...(!reschedule?[n('BK12345678',1700,{description:'预约号'})]:[])]:[b(reschedule?'确认改约':'提交预约',2100)]),...extra]);}
const navReady=()=>page(MAP,[n('上海虹桥站',100,{description:'起点'}),n('外滩',200,{description:'终点'}),b('步行',400,{selected:true}),n('推荐路线',700,{bounds:[100,700,800,1100],children:[n('35分钟',800),n('2.4公里',900)]}),b('开始导航',2100)]);
const navActive=()=>page(MAP,[n('外滩',100,{description:'目的地'}),n('步行',200,{description:'出行方式'}),n('导航中',400),n('剩余35分钟',600),n('剩余2.4公里',700),b('结束导航',2100)]);
const g=(raw,app)=>phoneUseGrant(task(raw),app);
test('travel contracts bind navigation or explicit financial/booking terms, never infer omitted objects',()=>{
 assert.equal(g(navPrompt,MAP).effectPlan.kind,'navigation');assert.equal(g(ridePrompt,MAP).effectPlan.kind,'ride_request');assert.equal(g(bookPrompt,APP).effectPlan.kind,'service_booking');assert.equal(g(changePrompt,APP).effectPlan.operation,'reschedule');
 for(const raw of [ridePrompt.replace('，费用上限50元',''),ridePrompt.replace('行程结束后手动支付','免密支付'),bookPrompt.replace('，取消条件“随时免费取消”',''),bookPrompt.replace('Asia/Shanghai','Wrong/Zone'),bookPrompt.replace('2026-11-20 14:00 Asia/Shanghai','2026-11-01 01:30 America/New_York'),changePrompt.replace('，原时间“2026-11-19 14:00 Asia/Shanghai”','')])assert.equal(g(raw,raw.includes('高德')?MAP:APP),null,raw);
 assert.equal(parseTravelRequest(bookPrompt.replace('2026-11-20','2020-01-01')),null);assert.equal(g(bookPrompt,{...APP,packageName:'com.fake.meituan'}),null);
});
test('ride request requires exact pickup/destination/type, bounded native fare, manual payment and cancellation terms',()=>{
 const grant=g(ridePrompt,MAP),initial=ride(),decision=classifyPhoneUseAction('t',tap(initial,'确认呼叫'),initial,grant);assert.equal(decision?.kind,'effect_ride_submit');
 for(const changes of [{'上车地点':'另一个出口'},{'目的地':'另一个地方'},{'车型':'豪华型'},{'人数':'2'},{'预估最高费用':'¥50.01'},{'预付金额':'¥1'},{'取消条件':'取消收费'},{'支付方式':'自动扣款'}]){const bad=ride({changes});assert.equal(classifyPhoneUseAction('t',tap(bad,'确认呼叫'),bad,grant),null);}
 assert.equal(effectGoalStatus(ride({status:'等待司机接单'}),grant,[{status:'completed',phoneEffect:decision}]).verified,true);assert.equal(effectGoalStatus(ride({status:'等待司机接单'}),grant,[]).verified,false);assert.equal(effectGoalStatus(ride({status:'等待司机接单',changes:{'预估最高费用':'¥46.00'}}),grant,[{status:'completed',phoneEffect:decision}]).verified,false);
});
test('booking refuses changed time, ambiguous duplicate identity, prepayment and new agreement',()=>{
 const grant=g(bookPrompt,APP);for(const options of [{changes:{'时间':'2026-11-21 14:00'}},{changes:{'时区':'Asia/Tokyo'}},{changes:{'总价':'¥31'}},{changes:{'预付金额':'¥1'}},{extra:[n('同意服务协议',1900)]},{extra:[n('其他店',1900,{description:'商家'})]}]){const bad=booking(options);assert.equal(classifyPhoneUseAction('t',tap(bad,'提交预约'),bad,grant),null);}
});
test('ride and booking submissions with unknown result are recorded once and cannot be replayed',async()=>{
 for(const [raw,app,start,target]of [[ridePrompt,MAP,ride(),'确认呼叫'],[bookPrompt,APP,booking(),'提交预约']]){const f=fixture(raw,app,start,[new Error('connection lost')]);await f.broker.execute('t','phone_use',{action:'open_app',app:app.label});await assert.rejects(f.broker.execute('t','phone_use',{action:'tap',target}));assert.equal(f.data.actions[0].status,'unknown');await assert.rejects(f.broker.execute('t','phone_use',{action:'tap',target}));assert.equal(f.calls.filter(c=>c.name==='tap').length,1);}
});
