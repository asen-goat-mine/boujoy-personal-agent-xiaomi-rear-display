import {validTimeZone} from './schedule-contract.mjs';

const APPS=['铁路12306','携程','同程旅行','飞猪','美团'];
const cleanInstruction=raw=>String(raw||'').replace(/[“「"][^”」"]*[”」"]/g,'[对象]');
const quoted=(raw,label)=>{const matches=[...raw.matchAll(new RegExp('(?:'+label+')[“「"]([^”」"\\n]{1,160})[”」"]','g'))];return matches.length===1?matches[0][1]:null;};
function number(raw,label,max){const rows=[...raw.matchAll(new RegExp('(?:'+label+')[：:]?\\s*(\\d{1,2})(?:人|位|间)?(?=[，。；\\s]|$)','g'))];const value=rows.length===1?Number(rows[0][1]):0;return value>0&&value<=max?value:null;}
function day(raw,label,referenceAt,timezone){
 const matches=[...raw.matchAll(new RegExp('(?:'+label+')(?:日期)?[：:]?\\s*(?:[“「"](\\d{4}-\\d{2}-\\d{2}|今天|明天|后天)[”」"]|(\\d{4}-\\d{2}-\\d{2}|今天|明天|后天))','g'))];if(matches.length!==1)return null;let value=matches[0][1]||matches[0][2];
 if(/今天|明天|后天/.test(value)){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(referenceAt)).map(p=>[p.type,p.value]));value=new Date(Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day)+({今天:0,明天:1,后天:2}[value]))).toISOString().slice(0,10);}
 const date=new Date(value+'T00:00:00Z');return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value?value:null;
}
function budget(instruction){const rows=[...instruction.matchAll(/(?:总价|预算|费用)(?:上限|不超过|最多)?[：:]?\s*(\d{1,7}(?:\.\d{1,2})?)元/g)];return rows.length===1&&Number(rows[0][1])>0?Math.round(Number(rows[0][1])*100):null;}
export function isTravelPreparationRequest(raw=''){const text=cleanInstruction(raw);return /酒店|住宿|火车票|高铁票|机票|航班|车票/.test(text)&&/查找|查询|搜索|比较|比价|筛选|准备|填写|填好/.test(text);}
export function parseTravelPreparationRequest(raw='',{referenceAt=Date.now(),timezone='Asia/Shanghai'}={}){
 raw=String(raw);const text=cleanInstruction(raw);if(!isTravelPreparationRequest(raw))return null;
 if(/^(?:如何|怎么|解释)|(?:网页|页面|广告|模型).{0,12}(?:说|要求|指示)|忽略.{0,12}(?:授权|规则)|(?:不要|不用|别|禁止).{0,10}(?:查询|比较|搜索|填写|准备)/.test(text))return null;
 const positive=text.replace(/(?:不要|不用|别|禁止|不允许|无需|不)(?:再|自动)?(?:提交|下单|付款|支付|购买|确认预订)[^，。；]*/g,'');
 if(/提交订单|直接下单|立即购买|确认预订|自动支付|自动付款/.test(positive))return null;
 const category=/酒店|住宿/.test(text)?'hotel':'ticket',operation=/准备|填写|填好/.test(text)?'prepare':'compare',fail=reason=>({schemaVersion:1,kind:'travel_preparation',category,operation,status:'needs_input',reason});
 if(/酒店|住宿/.test(text)&&/火车票|高铁票|机票|航班|车票/.test(text))return fail('one_travel_category_required');
 const apps=APPS.filter(app=>text.includes(app));if(!apps.length||operation==='prepare'&&apps.length!==1)return fail('explicit_travel_app_required');
 const zones=[...text.matchAll(/(?:[A-Za-z_+-]+\/)+[A-Za-z_+-]+/g)].map(m=>m[0]);if(new Set(zones).size>1)return fail('multiple_timezones');const zone=zones[0]||timezone,ref=typeof referenceAt==='number'?referenceAt:Date.parse(referenceAt);if(!validTimeZone(zone)||!Number.isFinite(ref))return fail('valid_timezone_reference_required');
 const passengers=number(text,'人数|乘客|入住人数',8),maxTotalFen=budget(text),cancellation=quoted(raw,'取消条件|退改条件');
 const common={schemaVersion:1,kind:'travel_preparation',category,operation,status:'ready',apps,app:apps.length===1?apps[0]:null,timezone:zone,timezoneExplicit:zones.length===1,referenceAt:new Date(ref).toISOString(),passengers,maxTotalFen,cancellation,submissionAllowed:false,payment:'user'};
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ref));
 if(!passengers)return fail('explicit_passenger_count_required');
 if(operation==='prepare'&&(maxTotalFen===null||!cancellation))return fail('preparation_budget_and_cancellation_required');
 if(category==='hotel'){
  const destination=quoted(raw,'目的地|城市|地点'),checkIn=day(raw,'入住',ref,zone),checkOut=day(raw,'离店|退房',ref,zone),rooms=number(text,'房间|房间数',8),roomType=quoted(raw,'房型'),hotel=quoted(raw,'酒店');
  if(!destination||!checkIn||!checkOut||!rooms)return fail('hotel_location_dates_rooms_required');
  const nights=(Date.parse(checkOut)-Date.parse(checkIn))/86400000;if(checkIn<today||nights<=0||nights>30)return fail('hotel_dates_invalid');
  if(operation==='prepare'&&(!hotel||!roomType))return fail('exact_hotel_and_room_type_required');
  return {...common,destination,checkIn,checkOut,nights,rooms,roomType,hotel};
 }
 const origin=quoted(raw,'从|出发地'),destination=quoted(raw,'到|目的地'),departureDate=day(raw,'出发',ref,zone),mode=/机票|航班/.test(text)?'flight':'train',service=quoted(raw,'班次|航班|车次'),seatType=quoted(raw,'座席|舱位|席别'),baggage=quoted(raw,'行李条件');
 if(!origin||!destination||origin===destination||!departureDate||departureDate<today)return fail('ticket_origin_destination_date_required');
 if(operation==='prepare'&&(!service||!seatType||mode==='flight'&&!baggage))return fail('exact_service_class_and_baggage_required');
 return {...common,mode,origin,destination,departureDate,service,seatType,baggage};
}
