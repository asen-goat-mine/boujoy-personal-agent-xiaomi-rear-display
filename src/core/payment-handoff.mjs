import {commercePlatform,platformPackageMatches,COMMERCE_PLATFORMS} from './commerce-platforms.mjs';
import {createHash} from 'node:crypto';
import {requireValue} from './errors.mjs';
const compact=value=>String(value||'').normalize('NFKC').replace(/\s+/g,'');
const payments=new Set([...Object.values(COMMERCE_PLATFORMS).flatMap(profile=>profile.packages),'com.eg.android.AlipayGphone','com.tencent.mm']);
const labels=node=>[node.text,node.description,node.hint].filter(value=>typeof value==='string');

export function paymentSubmissionTarget({native,ocr,facts}){
 requireValue(platformPackageMatches(facts?.platform||'taobao',native?.packageName)&&facts?.paymentStatus==='not_submitted','当前不是已核实的平台结算页','checkout_unverified');
 const text=[...(ocr?.lines||[]).map(line=>line.text),...(native.elements||[]).flatMap(labels)].map(compact);
 requireValue(!text.some(value=>/免密|自动扣款|先用后付|极速付款|自动支付|一键付款/.test(value)),'当前支付方式可能直接扣款，请由用户操作','payment_requires_user');
 const matches=(native.elements||[]).filter(node=>node.visible===true&&node.enabled===true&&!node.password&&node.actions?.includes('tap')&&labels(node).some(value=>/^(?:提交订单|去支付|确认下单)(?:[¥￥]\d+(?:\.\d{1,2})?)?$/.test(compact(value)))&&node.bounds?.[1]>ocr.height*.55);
 requireValue(matches.length===1,'没有唯一明确的订单提交入口；不会把支付按钮当导航','payment_requires_user');
 const node=matches[0];return {x:(node.bounds[0]+node.bounds[2])/2,y:(node.bounds[1]+node.bounds[3])/2,elementId:node.element_id};
}

// Read only native semantics after submission. No screenshot or raw credential
// text is returned to the model, even when the provider exposes it as a label.
export function inspectPaymentHandoff(native,facts){
 const nodes=(native?.elements||[]).filter(node=>node.visible===true),text=nodes.flatMap(labels).map(compact),protectedInput=nodes.some(node=>node.password||node.editable&&labels(node).some(value=>/密码|验证码|PIN|OTP|password|passcode/i.test(value)))||text.some(value=>/请输入(?:支付)?密码|输入支付密码|输入验证码/.test(value));
 const identity={deviceId:native?.deviceId,serviceInstanceId:native?.serviceInstanceId,nativeObservationId:native?.observationId,credentialBoundary:protectedInput};
 if(!platformPackageMatches(facts.platform||'taobao',native?.packageName)&&!['com.eg.android.AlipayGphone','com.tencent.mm'].includes(native?.packageName))return {...identity,verified:false,paymentStatus:'unverified',orderCreated:'unverified',reason:protectedInput?'protected_unknown_surface':'payment_surface_unknown'};
 if(protectedInput)return {...identity,verified:true,paymentStatus:'credential_entry',orderCreated:'unverified',userInputRequired:true};
 const amounts=text.filter(value=>/^(?:实付|应付|待支付|付款金额|支付金额|合计|总计)[：:]?[¥￥]/.test(value)).map(value=>value.match(/[¥￥](\d+(?:\.\d{1,2})?)/)?.[1]).filter(Boolean).map(value=>Math.round(Number(value)*100));
 const total=amounts.length>0&&new Set(amounts).size===1&&amounts[0]===facts.totalFen;
 const pending=text.some(value=>/^(?:待付款|等待付款|等待买家付款|付款倒计时|支付倒计时)/.test(value)),item=text.some(value=>value.includes(compact(facts.item)));
 const order=text.find(value=>/^(?:订单号|订单编号)[：:]?[A-Za-z0-9-]{6,}$/.test(value));
 if(pending&&total&&item&&order)return {...identity,verified:true,paymentStatus:'pending_payment',orderCreated:true,orderReferenceSha256:createHash('sha256').update(order).digest('hex'),userInputRequired:true};
 if(!platformPackageMatches(facts.platform||'taobao',native.packageName)&&total&&text.some(value=>/^(?:收银台|确认付款|付款方式|选择付款方式)$/.test(value)))return {...identity,verified:true,paymentStatus:'payment_entry',orderCreated:'unverified',userInputRequired:true};
 return {...identity,verified:false,paymentStatus:'unverified',orderCreated:'unverified',reason:'payment_result_not_verified'};
}
