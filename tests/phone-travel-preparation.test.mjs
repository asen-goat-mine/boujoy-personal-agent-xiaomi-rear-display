import test from 'node:test';
import assert from 'node:assert/strict';
import {toolsForTask} from '../src/tools/broker.mjs';
import {phoneUseGrant,classifyPhoneUseAction} from '../src/adapters/phone-use.mjs';
import {nativeNode as n,nativeButton as b,nativePage as page,nativeTask as task,nativeTap as tap,nativeBrokerFixture as fixture} from './helpers/phone-native-fixture.mjs';
const APP={packageName:'ctrip.android.view',label:'携程',appName:'携程'},SECOND={packageName:'com.taobao.trip',label:'飞猪',appName:'飞猪'};
const prompt='在携程准备酒店订单，目的地“上海”，酒店“测试酒店”，房型“大床房”，入住2026-11-20，离店2026-11-22，人数2人，房间数1间，总价上限800元，取消条件“入住前一天免费取消”，不要提交订单';
const ticket='在携程准备机票订单，从“上海”到“北京”，出发2026-11-20，人数1人，航班“MU5101”，舱位“经济舱”，行李条件“托运20kg”，总价上限1000元，退改条件“起飞前退票费100元”，不要提交订单';
const fields=(values,start=100)=>Object.entries(values).map(([description,text],i)=>n(text,start+i*70,{description}));
const hotelQuery={'目的地':'上海','入住日期':'2026-11-20','离店日期':'2026-11-22','人数':'2','房间数':'1'},hotelOffer={'酒店':'测试酒店','房型':'大床房','总价':'¥688.00','费用范围':'含全部税费及服务费','取消条件':'入住前一天免费取消'};
const ticketQuery={'出发地':'上海','目的地':'北京','出发日期':'2026-11-20','人数':'1'},ticketOffer={'航班':'MU5101','舱位':'经济舱','行李条件':'托运20kg','总价':'¥980.00','费用范围':'含全部税费及服务费','退改条件':'起飞前退票费100元'};
function ready(query,offer,{form=false,changes={}}={}){return page(APP,[...fields({...query,...offer,...changes}),...(form?[n('确认订单',1700),n('待确认',1800),b('提交订单',2100)]:[b('填写订单',2100)])]);}
function results(app=APP,total='¥688.00'){return page(app,[...fields(hotelQuery),n(null,700,{class:'android.widget.LinearLayout',bounds:[40,700,950,1300],children:fields({...hotelOffer,'总价':total},760)})]);}
test('traveler count, dates, service, baggage, fees and cancellation cannot silently change or auto-submit',()=>{
 const t=task(ticket),grant=phoneUseGrant(t,APP);for(const changes of [{'人数':'2'},{'出发日期':'2026-11-21'},{'航班':'MU5102'},{'行李条件':'无托运'},{'总价':'¥1001.00'},{'费用范围':'不含服务费'},{'退改条件':'不可退'}]){const bad=ready(ticketQuery,ticketOffer,{changes});assert.equal(classifyPhoneUseAction('t',tap(bad,'填写订单'),bad,grant),null,JSON.stringify(changes));}
 const form=ready(ticketQuery,ticketOffer,{form:true});assert.equal(classifyPhoneUseAction('t',tap(form,'提交订单'),form,grant),null);
});
test('native same-condition hotel comparison records exact source observations across two installed apps',async()=>{
 const raw=prompt.replace('在携程准备酒店订单','在携程和飞猪比较酒店价格'),first=results(),f=fixture(raw,APP,first);f.phone.apps={list:async query=>({source:'fixture',apps:[APP,SECOND].filter(a=>a.label===query)}),resolve:async pkg=>[APP,SECOND].find(a=>a.packageName===pkg)};
 await f.broker.execute('t','phone_use',{action:'open_app',app:'携程'});await f.broker.execute('t','phone_travel',{action:'record'});const firstComparison=JSON.parse((await f.broker.execute('t','phone_travel',{action:'compare'})).content[0].text);assert.deepEqual(firstComparison.groups,[],'one source cannot establish cheapest');
 f.setState(results(SECOND,'¥678.00'));await f.broker.execute('t','phone_use',{action:'open_app',app:'飞猪'});await f.broker.execute('t','phone_travel',{action:'record'});await f.broker.execute('t','finish_task',{outcome:'completed',summary:'已核实两个同条件来源，飞猪总价678.00元。',evidence:[f.phone.observation.id]});assert.equal(f.t.travelQuotes.length,2);assert.match(f.t.report.summary,/678.00/);assert.doesNotMatch(f.t.report.summary,/免费$/);
});
test('search fields use actual editable roles and exact task values, never generic personal data',()=>{
 const t=task(ticket),grant=phoneUseGrant(t,APP),search=page(APP,[...fields(ticketQuery),n('出发地',1700,{class:'android.widget.EditText',editable:true,focused:true,actions:['set_text']})]);assert.equal(classifyPhoneUseAction('t',{observationId:search.id,action:'type',text:'上海',inputMode:'replace'},search,grant)?.kind,'effect_travel_prepare_input');assert.equal(classifyPhoneUseAction('t',{observationId:search.id,action:'type',text:'北京',inputMode:'replace'},search,grant),null);
});

test('travel preparation preserves extra requested effects instead of silently downgrading the whole task',()=>{const mixed=task(prompt+'，并删除文件');assert.ok(mixed.taskContract.effects.includes('delete'));assert.equal(phoneUseGrant(mixed,APP),null);});
