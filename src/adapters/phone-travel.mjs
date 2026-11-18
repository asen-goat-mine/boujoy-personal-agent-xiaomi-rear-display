import {travelEffect} from '../core/travel-contract.mjs';
import {classifyRouteAction,verifyRouteResult} from './phone-routes.mjs';
const MAPS=new Set(['com.autonavi.minimap','com.baidu.BaiduMap']);
const BOOKINGS=new Set(['com.sankuai.meituan','com.sankuai.meituan.takeoutnew','com.dianping.v1']);
const clean=v=>String(v??'').normalize('NFKC').replace(/\s+/g,'');
const has=(nodes,value)=>nodes.some(n=>!n.editable&&n.values.includes(value));
const rowsFor=(nodes,label,editable=false)=>nodes.filter(n=>(editable||!n.editable)&&n.values.some(v=>v===label||v.startsWith(label+'：')||v.startsWith(label+':')));
const context=(nodes,label,value,{editable=false}={})=>{const rows=rowsFor(nodes,label,editable);return rows.length===1&&rows[0].values.some(v=>v===value||clean(v)===clean(label+':'+value));};
function numberValue(nodes,label){const rows=rowsFor(nodes,label);if(rows.length!==1)return null;const values=rows[0].values.map(v=>clean(v).replace(new RegExp('^'+label+'[:：]'),'' )).filter(v=>/^(?:[¥￥])?\d+(?:\.\d{1,2})?(?:元)?$/.test(v));return values.length===1?Math.round(Number(values[0].replace(/[¥￥元]/g,''))*100):null;}
function target(nodes,args,ocr){const refs=args.textTargetId?(ocr?.lines||[]).filter(l=>l.id===args.textTargetId):[];if(args.textTargetId&&refs.length!==1)return null;const ref=refs[0],p=ref?.center||{x:args.x,y:args.y},hits=nodes.filter(n=>(n.clickable||n.editable)&&p.x>=n.bounds[0]&&p.x<n.bounds[2]&&p.y>=n.bounds[1]&&p.y<n.bounds[3]);const node=hits.sort((a,b)=>(a.bounds[2]-a.bounds[0])*(a.bounds[3]-a.bounds[1])-(b.bounds[2]-b.bounds[0])*(b.bounds[3]-b.bounds[1]))[0],label=ref?.text||(node?.values.length===1?node.values[0]:null);return node&&label&&node.values.includes(label)?{node,label}:null;}
const unsafe=nodes=>nodes.some(n=>n.secret||n.values.some(v=>/免密|自动扣款|自动支付|先用后付|授权扣款|保证金|同意.*(?:协议|条款)|密码|验证码|加价|附加费用待定|另计|另付|按实际收取|不含.{0,8}费|额外收费|可能加收|自动续费/.test(v)));
const moneySafe=(nodes,p)=>{const total=numberValue(nodes,p.kind==='ride_request'?'预估最高费用':'总价'),upfront=numberValue(nodes,'预付金额'),changeFee=p.operation==='reschedule'?numberValue(nodes,'改约费用'):0;return total!==null&&total<=p.maxTotalFen&&upfront===0&&changeFee===0?total:null;};
const bookingIdentity=(nodes,p)=>context(nodes,'服务',p.service)&&context(nodes,'商家',p.merchant)&&context(nodes,'地点',p.location)&&context(nodes,'人数',String(p.passengers));
const whenBound=(nodes,when,label='时间')=>context(nodes,label,when.local)&&context(nodes,'时区',when.timezone);
const rideIdentity=(nodes,p)=>context(nodes,'上车地点',p.origin)&&context(nodes,'目的地',p.destination)&&context(nodes,'车型',p.carType)&&context(nodes,'人数',String(p.passengers));
const termsBound=(nodes,p)=>context(nodes,'取消条件',p.cancellation)&&context(nodes,'支付方式',p.payment);
export function travelPlan(contract){const p=contract?.objects?.travel;return p&&contract.effects.includes(travelEffect(p))?p:null;}
export function travelPackageAllowed(p,pkg){return ['navigation','ride_request'].includes(p.kind)?MAPS.has(pkg):p.kind==='service_booking'?BOOKINGS.has(pkg):true;}
export function travelDialogAllowed(label,p){return ['navigation','ride_request','service_booking'].includes(p?.kind)&&/^(?:开始导航|立即导航|确认呼叫|提交预约|确认预约|确认改约|修改预约|选择时间|取消条件|支付方式|取消)$/.test(label);}
export function classifyTravelAction(args,state,ocr,grant,nodes,actions=[],observation){
 const p=grant.effectPlan;if(!['navigation','ride_request','service_booking'].includes(p?.kind)||unsafe(nodes)||p.kind==='service_booking'&&Date.parse(p.when.instant)<=Date.now())return null;
 const decision=(kind,witness={})=>({kind,witness});
 if(p.kind==='navigation'){
  const scope={...grant,effectPlan:{...p,kind:'route'}};
  if(args.action==='tap'){
   const hit=target(nodes,args,ocr),proof=verifyRouteResult(nodes,scope,state,observation);
   if(hit&&['开始导航','立即导航'].includes(hit.label)&&proof.verified&&!has(nodes,'导航中'))return decision('effect_navigation_start',{origin:p.origin,destination:p.destination,mode:p.mode,route:proof.facts});
  }
  return classifyRouteAction(args,state,ocr,scope,nodes);
 }
 const identity=p.kind==='ride_request'?rideIdentity(nodes,p):bookingIdentity(nodes,p);
 if(args.action==='type'){
  const fields=nodes.filter(n=>n.editable&&n.focused);if(fields.length!==1||args.inputMode!=='replace'||args.textTargetId)return null;const field=fields[0];
  const mapping=p.kind==='ride_request'?{'上车地点':p.origin,'目的地':p.destination}:{'搜索服务':p.service,'搜索商家':p.merchant,'预约号':p.bookingId};
  for(const [role,value]of Object.entries(mapping))if(value&&field.values.includes(role)&&args.text===value&&field.values.every(v=>!v||v===role||v===value))return decision('effect_travel_input',{field:role});
  if(identity&&p.kind==='service_booking'&&context(nodes,'时区',p.when.timezone)){
   const entries={'日期':p.when.local.slice(0,10),'时间':p.when.local.slice(11),'人数':String(p.passengers)};
   for(const [role,value]of Object.entries(entries))if(field.values.includes(role)&&args.text===value&&field.values.every(v=>!v||v===role||v===value||role==='日期'&&/^\d{4}-\d{2}-\d{2}$/.test(v)||role==='时间'&&/^\d{2}:\d{2}$/.test(v)||role==='人数'&&/^[1-8]$/.test(v)))return decision('effect_booking_input',{field:role});
  }
  return null;
 }
 if(args.action!=='tap')return null;const hit=target(nodes,args,ocr);if(!hit)return null;const {node,label}=hit;
 if(p.kind==='ride_request'){
  if(node.editable&&node.values.some(v=>['上车地点','目的地'].includes(v)))return decision('effect_ride_field_focus');
  if(['选择上车地点','选择目的地'].some(role=>has(nodes,role))&&label===(has(nodes,'选择上车地点')?p.origin:p.destination)&&nodes.filter(n=>n.values.includes(label)).length===1)return decision('effect_ride_place_select');
  if(context(nodes,'上车地点',p.origin)&&context(nodes,'目的地',p.destination)&&label===p.carType&&has(nodes,'选择车型'))return decision('effect_ride_type_select');
  const total=identity&&termsBound(nodes,p)?moneySafe(nodes,p):null;
  if(label==='确认呼叫'&&total!==null&&!['等待司机接单','司机已接单','行程进行中'].some(v=>has(nodes,v)))return decision('effect_ride_submit',{origin:p.origin,destination:p.destination,carType:p.carType,maximumFareFen:total});
  return null;
 }
 if(label===p.merchant&&context(nodes,'服务',p.service)&&nodes.filter(n=>n.values.includes(label)).length===1)return decision('effect_booking_merchant');
 if(p.operation==='reschedule'&&label===p.bookingId&&nodes.filter(n=>n.values.includes(label)).length===1)return decision('effect_booking_open');
 if(!identity)return null;
 if(p.operation==='reschedule'){
  const bound=context(nodes,'预约号',p.bookingId);
  if(label==='修改预约'&&bound&&whenBound(nodes,p.originalWhen)&&has(nodes,'预约成功'))return decision('effect_booking_edit',{bookingId:p.bookingId,originalWhen:p.originalWhen});
  const prior=actions.some(a=>a.status==='completed'&&a.phoneEffect?.kind==='effect_booking_edit'&&a.phoneEffect.witness.contractId===grant.contractId&&a.phoneEffect.witness.contractRevision===grant.contractRevision&&a.phoneEffect.witness.bookingId===p.bookingId&&JSON.stringify(a.phoneEffect.witness.originalWhen)===JSON.stringify(p.originalWhen));
  if(!bound||!prior)return null;
 }
 if(label==='选择时间')return decision('effect_booking_time_open');
 if(node.editable&&node.values.some(value=>['日期','时间','人数'].includes(value)))return decision('effect_booking_field_focus');
 if(label===p.when.local.slice(0,10)&&has(nodes,'选择日期')&&context(nodes,'时区',p.when.timezone)&&nodes.filter(row=>row.values.includes(label)).length===1)return decision('effect_booking_date_select');
 if(context(nodes,'日期',p.when.local.slice(0,10))&&context(nodes,'时区',p.when.timezone)&&label===p.when.local.slice(11)&&has(nodes,'可预约时段'))return decision('effect_booking_time_select',{time:p.when.local});
 if(label==='确定'&&has(nodes,'选择时间')&&context(nodes,'日期',p.when.local.slice(0,10),{editable:true})&&context(nodes,'时间',p.when.local.slice(11),{editable:true})&&context(nodes,'时区',p.when.timezone))return decision('effect_booking_time_confirm');
 const total=whenBound(nodes,p.when)&&termsBound(nodes,p)?moneySafe(nodes,p):null;
 if((p.operation==='create'?['提交预约','确认预约'].includes(label):label==='确认改约')&&total!==null)return decision(p.operation==='create'?'effect_booking_submit':'effect_booking_reschedule',{service:p.service,merchant:p.merchant,location:p.location,time:p.when.local,timezone:p.when.timezone,totalFen:total,bookingId:p.bookingId});
 return null;
}
export function verifyTravelResult(nodes,grant,matches,state,observation){
 const p=grant.effectPlan,final=kind=>matches.filter(a=>a.phoneEffect?.kind===kind).at(-1);
 if(unsafe(nodes))return {verified:false,reason:'protected_or_unaccepted_terms'};
 if(p.kind==='navigation'){
  const started=final('effect_navigation_start'),identity=context(nodes,'目的地',p.destination)&&context(nodes,'出行方式',p.mode),eta=nodes.flatMap(n=>n.values).filter(v=>/^剩余\d+(?:小时)?\d*分钟$/.test(v)),distance=nodes.flatMap(n=>n.values).filter(v=>/^剩余\d+(?:\.\d+)?(?:公里|米)$/.test(v));
  const verified=!!started&&identity&&has(nodes,'导航中')&&nodes.some(n=>n.clickable&&n.values.includes('结束导航'))&&eta.length===1&&distance.length===1;
  return {verified,kind:'navigation_started',facts:verified?{destination:p.destination,mode:p.mode,eta:eta[0],distance:distance[0],navigationStarted:true,arrived:false}:null};
 }
 const kind=p.kind==='ride_request'?'effect_ride_submit':p.operation==='reschedule'?'effect_booking_reschedule':'effect_booking_submit',submitted=final(kind);
 const referenceLabel=p.kind==='ride_request'?'行程订单号':'预约号',refs=rowsFor(nodes,referenceLabel),reference=refs.length===1?refs[0].values.map(v=>v.replace(new RegExp('^'+referenceLabel+'[：:]\\s*'),'' )).find(v=>/^[A-Za-z0-9-]{6,64}$/.test(v)):null;
 const total=moneySafe(nodes,p),samePrice=submitted&&total===submitted.phoneEffect.witness[p.kind==='ride_request'?'maximumFareFen':'totalFen'];
 if(p.kind==='ride_request'){
  const statuses=['等待司机接单','司机已接单'].filter(v=>has(nodes,v)),verified=!!submitted&&!!reference&&rideIdentity(nodes,p)&&termsBound(nodes,p)&&samePrice&&statuses.length===1&&!nodes.some(n=>n.values.some(v=>/呼叫失败|已取消|正在提交/.test(v)));
  return {verified,kind:'ride_requested',facts:verified?{origin:p.origin,destination:p.destination,carType:p.carType,status:statuses[0],maximumFareFen:total,driverAssigned:statuses[0]==='司机已接单',paid:false}:null};
 }
 const verified=!!submitted&&!!reference&&(p.operation!=='reschedule'||reference===p.bookingId)&&bookingIdentity(nodes,p)&&whenBound(nodes,p.when)&&termsBound(nodes,p)&&samePrice&&has(nodes,p.operation==='create'?'预约成功':'改约成功')&&!nodes.some(n=>n.values.some(v=>/预约失败|改约失败|正在提交|待付款/.test(v)));
 return {verified,kind:p.operation==='create'?'booking_created':'booking_rescheduled',facts:verified?{service:p.service,merchant:p.merchant,location:p.location,time:p.when.local,timezone:p.when.timezone,totalFen:total,payment:p.payment,paid:false}:null};
}
export function travelSummary(result){const f=result.facts;if(result.kind==='navigation_started')return `已开始${f.mode}导航至${f.destination}，${f.eta}、${f.distance}。`;if(result.kind==='ride_requested')return `从${f.origin}到${f.destination}的${f.carType}叫车请求已提交，${f.status}，预估最高费用 ¥${(f.maximumFareFen/100).toFixed(2)}；尚未付款。`;return `${f.merchant}的${f.service}${result.kind==='booking_rescheduled'?'已改约':'已预约'}至 ${f.time}（${f.timezone}），总价 ¥${(f.totalFen/100).toFixed(2)}，${f.payment}。`;}
