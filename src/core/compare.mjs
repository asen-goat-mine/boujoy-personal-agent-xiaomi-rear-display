import { requireValue, shortText } from './errors.mjs';

export const PLATFORMS = [
  {id:'taobao',name:'淘宝闪购',packageName:'com.taobao.taobao',url:'https://www.taobao.com',kinds:['food','shopping']},
  {id:'meituan',name:'美团',packageName:'com.sankuai.meituan',url:'https://www.meituan.com',kinds:['food','booking']},
  {id:'pinduoduo',name:'拼多多',packageName:'com.xunmeng.pinduoduo',url:'https://mobile.yangkeduo.com',kinds:['shopping']},
  {id:'jd',name:'京东',packageName:'com.jingdong.app.mall',url:'https://www.jd.com',kinds:['shopping']}
];
export function normalizeQuote(q){
  requireValue(PLATFORMS.some(p=>p.id===q.platform),'平台无效');
  const out={platform:q.platform,item:shortText(q.item,'商品',300),spec:shortText(q.spec,'规格',300),merchant:shortText(q.merchant,'门店/商家',200),quantity:q.quantity,
    currency:'CNY',observedAt:q.observedAt,evidence:shortText(q.evidence,'来源',1000),final:q.final===true,conditions:String(q.conditions||'').slice(0,1000),eta:String(q.eta||'').slice(0,100),addressLabel:String(q.addressLabel||'').slice(0,50)};
  requireValue(Number.isSafeInteger(out.quantity)&&out.quantity>0&&out.quantity<=1000,'数量无效');
  requireValue(Number.isFinite(Date.parse(out.observedAt))&&Date.parse(out.observedAt)<=Date.now()+60000,'报价时间无效');
  for(const key of ['itemsFen','packagingFen','deliveryFen','serviceFen','discountFen','paidBenefitFen']){
    if(key!=='itemsFen'&&q[key]===null){out[key]=null;continue;}
    requireValue(Number.isSafeInteger(q[key])&&q[key]>=0&&q[key]<=100000000,`${key} 必须是非负整数分`);out[key]=q[key];
  }
  out.unknownFees=['packagingFen','deliveryFen','serviceFen','discountFen','paidBenefitFen'].filter(k=>out[k]===null);
  requireValue(!out.final||out.unknownFees.length===0,'结算价不能包含未知费用');
  out.estimatedFen=q.estimatedFen??null;requireValue(out.estimatedFen===null||(Number.isSafeInteger(out.estimatedFen)&&out.estimatedFen>=0&&out.estimatedFen<=100000000),'预估价必须是非负整数分或 null');
  out.totalFen=out.unknownFees.length?null:out.itemsFen+out.packagingFen+out.deliveryFen+out.serviceFen+out.paidBenefitFen-out.discountFen;
  requireValue(out.totalFen===null||out.totalFen>=0,'优惠超过总额');return out;
}
export function compareQuotes(quotes,{maxAgeMs=10*60*1000,at=Date.now(),kind='shopping'}={}){
  const rows=quotes.map(normalizeQuote).map(q=>({...q,stale:at-Date.parse(q.observedAt)>maxAgeMs}));
  const groups=new Map();
  for(const row of rows){const key=JSON.stringify([row.item,row.spec,row.quantity,row.addressLabel,kind!=='shopping'?row.merchant:null]);const g=groups.get(key)||[];g.push(row);groups.set(key,g);}
  return [...groups.values()].map(rows=>({rows:rows.sort((a,b)=>(a.totalFen??Infinity)-(b.totalFen??Infinity)),comparable:rows.length>1&&new Set(rows.map(r=>r.platform)).size>1&&rows.every(r=>r.final&&r.totalFen!==null&&!r.stale),note:kind!=='shopping'?'仅比较本次相同门店、餐品规格、数量与配送位置的报价。':'仅比较本次记录的同规格候选；店铺、权益和售后仍需核对。'}));
}
