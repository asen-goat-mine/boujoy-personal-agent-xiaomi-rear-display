import {requireValue} from '../core/errors.mjs';
import {platformPackageMatches} from '../core/commerce-platforms.mjs';
import {inspectCheckout} from '../core/checkout.mjs';
const compact=value=>String(value||'').normalize('NFKC').replace(/\s+/g,'');
const amounts=text=>[...compact(text).matchAll(/[¥￥](\d+(?:\.\d{1,2})?)(?![\d.])/g)].map(match=>Math.round(Number(match[1])*100));
const fields={packagingFen:/^(?:包装费|打包费)/,deliveryFen:/^(?:配送费|运费)/,serviceFen:/^服务费/,discountFen:/^(?:优惠合计|优惠金额|总优惠)/,paidBenefitFen:/^(?:付费权益|会员费用)/};
export function verifyPhoneQuote(observation,claimed){
 requireValue(observation?.id===claimed.evidence&&Date.now()-observation.at<15000&&observation.stability==='stable'&&observation.stabilityScope==='full','报价需要最新稳定的完整平台页面','quote_unverified');
 let state;for(const block of observation.tree?.content||[])try{const value=JSON.parse(block.text);if(value.ok&&value.result?.tree)state=value.result;}catch{}
 requireValue(state?.display==='main'&&platformPackageMatches(claimed.platform,state.windowPkg)&&(state.foreground===state.windowPkg||String(state.foreground).startsWith(state.windowPkg+'/')),'报价来源与当前平台不一致','quote_unverified');
 const rows=observation.ocr?.lines||[],text=rows.map(row=>compact(row.text)),exact=value=>text.includes(compact(value));
 requireValue(exact(claimed.item)&&exact(claimed.spec)&&exact(claimed.merchant),'商品、规格或商家未在本次页面中逐项核实','quote_unverified');
 const items=rows.filter(row=>compact(row.text)===compact(claimed.item));requireValue(items.length===1,'商品行不唯一','quote_unverified');
 const item=items[0],near=rows.filter(row=>Math.abs((row.bounds[1]+row.bounds[3]-item.bounds[1]-item.bounds[3])/2)<observation.ocr.height*.1);
 requireValue(!near.some(row=>/会员价|会员专享|开通.{0,8}享|拼单价|券后|预估|起$|[¥￥]\d+(?:\.\d+)?[-~至]/.test(compact(row.text))),'条件价或区间价不能当作无条件商品价','quote_unverified');
 const prices=near.flatMap(row=>amounts(row.text));
 requireValue(new Set(prices).size===1&&prices[0]===claimed.itemsFen,'商品金额与当前商品行不一致','quote_unverified');
 const counts=text.flatMap(value=>[...value.matchAll(/^(?:[x×✕]|数量[:：]?)(\d{1,2})(?:件|份|杯)?$/g)].map(match=>Number(match[1])));
 requireValue(counts.length===1&&counts[0]===claimed.quantity,'商品数量未核实','quote_unverified');
 for(const [field,label] of Object.entries(fields)){
  if(claimed[field]===null)continue;
  const values=rows.filter(row=>label.test(compact(row.text))).flatMap(row=>amounts(row.text));
  requireValue(values.length===1&&values[0]===claimed[field],field+' 缺少明确费用证据，未知费用须为 null','quote_unverified');
 }
 if(claimed.estimatedFen!==null&&claimed.estimatedFen!==undefined){const values=rows.filter(row=>/^(?:预估到手价|预估实付|预估价)/.test(compact(row.text))).flatMap(row=>amounts(row.text));requireValue(values.length===1&&values[0]===claimed.estimatedFen,'预估价未核实','quote_unverified');}
 if(claimed.final){const facts=inspectCheckout(observation.ocr,{platform:claimed.platform,query:claimed.item,quantity:claimed.quantity,maxTotalFen:null});requireValue(facts&&Object.keys(fields).every(field=>claimed[field]!==null)&&facts.totalFen===claimed.itemsFen+claimed.packagingFen+claimed.deliveryFen+claimed.serviceFen+claimed.paidBenefitFen-claimed.discountFen,'结算总价或费用明细未核实','quote_unverified');}
 return {verified:true,source:'phone',observationId:observation.id,verifiedAt:new Date(observation.at).toISOString()};
}
