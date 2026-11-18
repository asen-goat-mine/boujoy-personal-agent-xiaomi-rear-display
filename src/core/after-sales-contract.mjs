// Only the current human request supplies after-sales scope. Native page text
// supplies evidence, never missing consent or a default refund reason.
const quoted=(raw,label)=>{const values=[...raw.matchAll(new RegExp(label+'[“「"]([^”」"]{1,160})[”」"]','g'))];return values.length===1?values[0][1]:null;};
const money=(raw,label)=>{const values=[...raw.matchAll(new RegExp(label+'(?:为|是|上限|不超过)?[：:]?\\s*(\\d{1,6}(?:\\.\\d{1,2})?)\\s*元','g'))];return values.length===1?Math.round(Number(values[0][1])*100):null;};
export function isAfterSalesRequest(raw=''){return /申请(?:仅退款|退款|退货退款)|申请退货/.test(String(raw).replace(/[“「"][^”」"]*[”」"]/g,''));}
export function parseAfterSalesRequest(raw=''){
 raw=String(raw);const instruction=raw.replace(/[“「"][^”」"]*[”」"]/g,'[对象]');
 if(!isAfterSalesRequest(raw)||/(?:不要|禁止|别|不允许|不用).{0,8}申请|网页|粘贴|转述/.test(instruction))return null;
 const types=[...instruction.matchAll(/申请(仅退款|退款|退货退款|退货)/g)];if(types.length!==1)return null;
 const operation=/退货/.test(types[0][1])?'return_refund':'refund',orderId=quoted(raw,'订单(?:号)?'),item=quoted(raw,'商品'),reason=quoted(raw,'(?:退款|退货|申请)原因'),refundMethod=quoted(raw,'退款方式'),goodsStatus=quoted(raw,'货物状态');
 const amountFen=money(raw,'退款金额'),maxFeeFen=money(raw,'(?:费用|手续费|退运费)(?:上限)?');
 const quantities=[...instruction.matchAll(/数量[：:]?\s*(\d{1,2})\s*(?:件|份|个)(?=[，。；]|$)/g)];
 const quantity=quantities.length===1?Number(quantities[0][1]):null;
 const returnMethod=operation==='return_refund'?quoted(raw,'退货方式'):null;
 // Only a no-fee application is implemented. A courier booking, refund to a
 // new account, an indemnity, or accepting a non-zero fee is another contract.
 if(!/^[A-Za-z0-9-]{6,64}$/.test(orderId||'')||!item||!reason||!Number.isSafeInteger(quantity)||quantity<1||quantity>20||!Number.isSafeInteger(amountFen)||amountFen<=0||maxFeeFen!==0||refundMethod!=='原路退回'||!['已收到货','未收到货'].includes(goodsStatus)||operation==='return_refund'&&(goodsStatus!=='已收到货'||returnMethod!=='自行寄回'))return null;
 if(/上门取件|预约快递|接受.{0,8}(?:扣费|违约金)|退至新账户|银行卡/.test(instruction))return null;
 return {kind:'after_sales',operation,orderId,item,quantity,amountFen,reason,refundMethod,goodsStatus,returnMethod,maxFeeFen};
}
