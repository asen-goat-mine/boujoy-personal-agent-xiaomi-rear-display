import {resolveWallTime} from './schedule-contract.mjs';
const quote=(raw,label)=>{const m=[...raw.matchAll(new RegExp(label+'[“「"]([^”」"]{1,200})[”」"]','g'))];return m.length===1?m[0][1]:null;};
const amount=(raw,label)=>{const m=[...raw.matchAll(new RegExp(label+'(?:上限|不超过)?[：:]?\\s*(\\d{1,6}(?:\\.\\d{1,2})?)\\s*元','g'))];return m.length===1?Math.round(Number(m[0][1])*100):null;};
const count=raw=>{const m=[...raw.matchAll(/人数[：:]?\s*(\d{1,2})人(?=[，。；]|$)/g)];return m.length===1&&Number(m[0][1])>0&&Number(m[0][1])<=8?Number(m[0][1]):null;};
function instant(value){
 if(!value)return null;const m=value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) ([A-Za-z_]+(?:\/[A-Za-z_]+)+)$/);if(!m)return null;
 const parts=m.slice(1,6).map(Number),[year,month,day,hour,minute]=parts,utc=Date.UTC(year,month-1,day,hour,minute),date=new Date(utc);if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day||hour>23||minute>59)return null;
 try{new Intl.DateTimeFormat('en',{timeZone:m[6]}).format(0);}catch{return null;}
 const resolution=resolveWallTime(value.slice(0,10),value.slice(11,16),m[6]);if(resolution.status!=='unique')return null;
 return {local:value.slice(0,16),timezone:m[6],instant:resolution.instants[0]};
}
export function isTravelMutationRequest(raw=''){const positive=String(raw).replace(/[“「"][^”」"]*[”」"]/g,'').replace(/(?:不要|不用|无需|禁止|别|不允许|不)(?:再)?(?:导航|叫车|预约|预订|改约)[^，。；]*/g,'');return /开始(?:步行|驾车|骑行)?导航|(?:预约|预订)服务|改约|(?:叫车|呼叫网约车)/.test(positive);}
export function parseTravelRequest(raw='',{referenceAt=Date.now()}={}){
 raw=String(raw);const instruction=raw.replace(/[“「"][^”」"]*[”」"]/g,'[对象]');
 if(!isTravelMutationRequest(raw)||/(?:不要|不用|无需|禁止|别|不允许).{0,8}(?:导航|叫车|预约|预订|改约)|网页|转述|粘贴/.test(instruction))return null;
 const origin=quote(raw,'从'),destination=quote(raw,'到');
 if(/开始(?:步行|驾车|骑行)?导航/.test(instruction)){
  const modes=[...new Set(instruction.match(/步行|驾车|骑行/g)||[])];if(!origin||!destination||origin===destination||modes.length!==1||/叫车|预约|预订|改约/.test(instruction))return null;
  return {kind:'navigation',origin,destination,mode:modes[0]};
 }
 const passengers=count(instruction),maxTotalFen=amount(instruction,'(?:总价|费用)'),cancellation=quote(raw,'取消条件'),payment=quote(raw,'支付方式');
 if(!passengers||maxTotalFen===null||!cancellation||!payment)return null;
 if(/叫车|呼叫网约车/.test(instruction)){
  const carType=quote(raw,'车型');if(!origin||!destination||origin===destination||!carType||payment!=='行程结束后手动支付'||maxTotalFen<=0||/预约|预订|改约/.test(instruction))return null;
  return {kind:'ride_request',origin,destination,carType,passengers,maxTotalFen,cancellation,payment};
 }
 const operation=/改约/.test(instruction)?'reschedule':'create',service=quote(raw,'服务'),merchant=quote(raw,'商家'),location=quote(raw,'地点'),when=instant(quote(raw,operation==='reschedule'?'新时间':'时间'));
 const bookingId=operation==='reschedule'?quote(raw,'预约号'):null,originalWhen=operation==='reschedule'?instant(quote(raw,'原时间')):null;
 if(!service||!merchant||!location||!when||Date.parse(when.instant)<=Number(new Date(referenceAt))||!['无需付款','到店手动支付'].includes(payment)||payment==='无需付款'&&maxTotalFen!==0||operation==='reschedule'&&(!/^[A-Za-z0-9-]{6,64}$/.test(bookingId||'')||!originalWhen||JSON.stringify(originalWhen)===JSON.stringify(when)))return null;
 return {kind:'service_booking',operation,service,merchant,location,when,passengers,maxTotalFen,cancellation,payment,bookingId,originalWhen};
}
export function travelEffect(plan){return {navigation:'start_navigation',ride_request:'request_ride',service_booking:plan.operation==='reschedule'?'reschedule_booking':'book_service'}[plan.kind];}
