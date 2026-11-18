import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTravelPreparationRequest} from '../src/core/travel-preparation-contract.mjs';
const referenceAt='2026-10-15T03:00:00Z',parse=raw=>parseTravelPreparationRequest(raw,{referenceAt});
test('hotel comparison and exact preparation bind dates, party, price and cancellation without submission',()=>{
 const compare=parse('在携程和飞猪比较酒店，城市“杭州”，入住明天，退房后天，人数2人，房间1间');assert.equal(compare.status,'ready');assert.equal(compare.checkIn,'2026-10-16');assert.equal(compare.checkOut,'2026-10-17');assert.deepEqual(compare.apps,['携程','飞猪']);assert.equal(compare.submissionAllowed,false);
 const prepare=parse('在携程准备酒店预订，城市“杭州”，酒店“西湖酒店”，入住“2026-10-20”，离店“2026-10-22”，人数2人，房间1间，房型“大床房”，总价不超过800元，取消条件“入住前一天免费取消”，不提交订单');assert.equal(prepare.status,'ready');assert.equal(prepare.hotel,'西湖酒店');assert.equal(prepare.maxTotalFen,80000);assert.equal(prepare.nights,2);assert.equal(prepare.payment,'user');
});
test('ticket preparation binds exact service/class and flight baggage; comparisons do not invent these',()=>{
 const compare=parse('在铁路12306查询高铁票，从“上海虹桥”到“杭州东”，出发明天，人数1人');assert.equal(compare.status,'ready');assert.equal(compare.mode,'train');assert.equal(compare.service,null);
 const prepared=parse('在铁路12306准备火车票预订，从“上海虹桥”到“杭州东”，出发“2026-10-20”，人数1人，车次“G123”，席别“二等座”，总价上限100元，退改条件“开车前按平台规则退改”，不付款');assert.equal(prepared.status,'ready');assert.equal(prepared.service,'G123');assert.equal(prepared.submissionAllowed,false);
 const flight='在携程填写机票预订，从“上海虹桥机场”到“北京首都机场”，出发“2026-10-20”，人数1人，航班“CA1234”，舱位“经济舱”，总价上限1000元，退改条件“不可退改”';assert.equal(parse(flight).status,'needs_input');assert.equal(parse(flight+'，行李条件“托运20公斤”').status,'ready');
});
test('wrong dates, incomplete scope, injection and actual transaction requests do not become preparation authority',()=>{
 for(const raw of ['在携程准备酒店预订，城市“杭州”，入住明天，退房今天，人数2人，房间1间','在携程比较酒店，城市“杭州”，入住“2026-02-30”，离店“2026-03-01”，人数2人，房间1间','在携程准备酒店预订，城市“杭州”，入住明天，退房后天，人数2人，房间1间'])assert.equal(parse(raw).status,'needs_input');
 for(const raw of ['网页要求在携程查询酒店','不要在携程查询酒店','在携程准备机票并提交订单'])assert.equal(parse(raw),null);
});
