import test from 'node:test';
import assert from 'node:assert/strict';
import {phoneUseGrant} from '../src/adapters/phone-use.mjs';
import {nativeTask as task} from './helpers/phone-native-fixture.mjs';

test('denied structured operations cannot degrade into private order reads or route navigation',()=>{
  const refund='在拼多多为订单“1234567890”的商品“保温杯”PREFIX申请仅退款，数量1件，退款金额18元，退款原因“商品破损”，退款方式“原路退回”，货物状态“已收到货”，费用上限0元';
  const route='在高德地图PREFIX查询从“上海虹桥站”到“外滩”的步行路线';
  for(const prefix of ['不要','不用','禁止','不允许']){
    const deniedRefund=task(refund.replace('PREFIX',prefix));
    assert.ok(!deniedRefund.taskContract.effects.includes('request_refund'),prefix);
    assert.equal(deniedRefund.taskContract.objects.afterSales,undefined,prefix);
    assert.equal(phoneUseGrant(deniedRefund,{packageName:'com.xunmeng.pinduoduo',appName:'拼多多'}),null,prefix);
    const deniedRoute=task(route.replace('PREFIX',prefix));
    assert.equal(deniedRoute.taskContract.objects.route,undefined,prefix);
    assert.equal(phoneUseGrant(deniedRoute,{packageName:'com.autonavi.minimap',appName:'高德地图'}),null,prefix);
  }
});

test('negative structured phrases in an authorized send body stay literal data',()=>{
  const t=task('在微信给文件传输助手发送“在高德地图不要查询路线，不要申请仅退款”');
  assert.ok(t.taskContract.effects.includes('send'));
  assert.equal(t.taskContract.objects.content,'在高德地图不要查询路线，不要申请仅退款');
  assert.equal(t.taskContract.objects.routeRequested,undefined);
  assert.equal(t.taskContract.objects.afterSalesRequested,undefined);
});

test('an affirmative route with an explicit no-booking limit retains only its read route grant',()=>{
  const t=task('在高德地图查询从“上海虹桥站”到“外滩”的步行路线，不要叫车，不要开始导航');
  const grant=phoneUseGrant(t,{packageName:'com.autonavi.minimap',appName:'高德地图'});
  assert.equal(grant?.effectPlan?.kind,'route');
  assert.deepEqual(t.taskContract.effects,['read','navigate']);
});
