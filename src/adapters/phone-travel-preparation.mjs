const PACKAGES={'铁路12306':['com.MobileTicket'],'携程':['ctrip.android.view'],'同程旅行':['com.tongcheng.android'],'飞猪':['com.taobao.trip'],'美团':['com.sankuai.meituan']};
const compact=v=>String(v??'').normalize('NFKC').replace(/\s+/g,'');
const has=(nodes,v)=>nodes.some(n=>!n.editable&&n.values.includes(v));
const rows=(nodes,key,edit=false)=>nodes.filter(n=>(edit||!n.editable)&&n.values.some(v=>v===key||v.startsWith(key+'：')||v.startsWith(key+':')));
function value(nodes,key,{edit=false}={}){const found=rows(nodes,key,edit);if(found.length!==1)return null;const values=[...new Set(found[0].values.filter(v=>v!==key).map(v=>v.replace(new RegExp('^'+key+'[：:]\\s*'),'')))];return values.length===1?values[0]:null;}
const exact=(nodes,key,want,edit=false)=>value(nodes,key,{edit})===String(want);
const unsafe=nodes=>nodes.some(n=>n.secret||n.values.some(v=>/密码|验证码|免密|自动扣款|自动支付|先用后付|同意.{0,8}(?:协议|条款)|已提交订单|预订成功|出票成功|订单已创建/.test(v)));
const price=v=>typeof v==='string'&&/^[¥￥]?\d+(?:\.\d{1,2})?(?:元)?$/.test(v)?Math.round(Number(v.replace(/[¥￥元]/g,''))*100):null;
export function travelPreparationPlan(contract){const p=contract?.objects?.travelPreparation;return p?.status==='ready'&&p.submissionAllowed===false&&contract.effects.every(e=>['read','navigate'].includes(e))?p:null;}
export function travelPreparationPackageAllowed(p,pkg){return p?.kind!=='travel_preparation'||p.apps.some(a=>PACKAGES[a]?.includes(pkg));}
export function travelPreparationDialogAllowed(label,p){return p?.kind==='travel_preparation'&&/^(?:确认订单|填写订单|核对订单|选择日期|选择城市|选择房型|选择席别|乘客信息|入住信息|完成|确定|取消)$/.test(label);}
function queryFields(p){return p.category==='hotel'?{'目的地':p.destination,'入住日期':p.checkIn,'离店日期':p.checkOut,'人数':String(p.passengers),'房间数':String(p.rooms)}:{'出发地':p.origin,'目的地':p.destination,'出发日期':p.departureDate,'人数':String(p.passengers)};}
function queryBound(nodes,p,{edit=false}={}){return Object.entries(queryFields(p)).every(([k,v])=>exact(nodes,k,v,edit));}
function offer(nodes,p){
 if(unsafe(nodes))return null;
 const totalFen=price(value(nodes,'总价')),cancellation=value(nodes,p.category==='hotel'?'取消条件':'退改条件');
 if(totalFen===null||!cancellation||!exact(nodes,'费用范围','含全部税费及服务费'))return null;
 if(p.maxTotalFen!==null&&totalFen>p.maxTotalFen||p.cancellation&&p.cancellation!==cancellation)return null;
 if(p.category==='hotel'){
  const hotel=value(nodes,'酒店'),roomType=value(nodes,'房型');if(!hotel||!roomType||p.hotel&&hotel!==p.hotel||p.roomType&&roomType!==p.roomType)return null;
  return {category:'hotel',hotel,roomType,totalFen,cancellation,...queryFields(p)};
 }
 const service=value(nodes,p.mode==='flight'?'航班':'车次'),seatType=value(nodes,p.mode==='flight'?'舱位':'席别'),baggage=p.mode==='flight'?value(nodes,'行李条件'):null;
 if(!service||!seatType||p.service&&service!==p.service||p.seatType&&seatType!==p.seatType||p.mode==='flight'&&(!baggage||p.baggage&&baggage!==p.baggage))return null;
 return {category:'ticket',mode:p.mode,service,seatType,baggage,totalFen,cancellation,...queryFields(p)};
}
function subtrees(nodes){return nodes.flatMap((node,index)=>{const depth=node.line.length-node.line.trimStart().length;const children=[];for(let i=index+1;i<nodes.length&&(nodes[i].line.length-nodes[i].line.trimStart().length)>depth;i++)children.push(nodes[i]);return children.length?[{root:node,rows:[node,...children]}]:[];});}
export function inspectTravelOffers(observation,grant,nodes,state){
 const p=grant.effectPlan;if(p?.kind!=='travel_preparation'||!queryBound(nodes,p)||unsafe(nodes))return [];
 const found=subtrees(nodes).map(group=>({root:group.root,offer:offer(group.rows,p)})).filter(x=>x.offer);
 // Keep the smallest complete native card, never combine price from one row
 // with a room/flight or refund policy elsewhere on the page.
 const minimal=found.filter(x=>!found.some(y=>y!==x&&y.root.bounds[0]>=x.root.bounds[0]&&y.root.bounds[1]>=x.root.bounds[1]&&y.root.bounds[2]<=x.root.bounds[2]&&y.root.bounds[3]<=x.root.bounds[3]));
 return minimal.map(x=>({...x.offer,packageName:state.windowPkg,observationId:observation.id,observedAt:observation.at,contractId:grant.contractId,contractRevision:grant.contractRevision}));
}
function target(nodes,args,ocr){const refs=args.textTargetId?(ocr?.lines||[]).filter(l=>l.id===args.textTargetId):[];if(args.textTargetId&&refs.length!==1)return null;const ref=refs[0],point=ref?.center||{x:args.x,y:args.y},hits=nodes.filter(n=>(n.clickable||n.editable)&&point.x>=n.bounds[0]&&point.x<n.bounds[2]&&point.y>=n.bounds[1]&&point.y<n.bounds[3]);const node=hits.sort((a,b)=>(a.bounds[2]-a.bounds[0])*(a.bounds[3]-a.bounds[1])-(b.bounds[2]-b.bounds[0])*(b.bounds[3]-b.bounds[1]))[0],label=ref?.text||(node?.values.length===1?node.values[0]:null);return node&&label&&node.values.includes(label)?{node,label}:null;}
export function classifyTravelPreparationAction(args,state,ocr,grant,nodes,actions=[],observation){
 const p=grant.effectPlan;if(p?.kind!=='travel_preparation'||unsafe(nodes))return null;const fields=queryFields(p),decision=(kind,witness={})=>({kind,witness});
 if(args.action==='type'){
  const editors=nodes.filter(n=>n.editable&&n.focused);if(args.inputMode!=='replace'||args.textTargetId||editors.length!==1)return null;
  for(const [key,want] of Object.entries({...fields,...(p.hotel?{'搜索酒店':p.hotel}:{}),...(p.service?{'搜索班次':p.service}:{})}))if(editors[0].values.includes(key)&&args.text===want)return decision('effect_travel_prepare_input',{field:key});
  return null;
 }
 if(args.action!=='tap')return null;const hit=target(nodes,args,ocr);if(!hit)return null;const {node,label}=hit;
 if(node.editable&&node.values.some(v=>Object.hasOwn(fields,v)||['搜索酒店','搜索班次'].includes(v)))return decision('effect_travel_prepare_focus');
 if(['酒店','火车票','机票'].includes(label)&&label===(p.category==='hotel'?'酒店':p.mode==='flight'?'机票':'火车票'))return decision('effect_travel_prepare_section');
 if(['搜索','查询','查询车票','搜索酒店','搜索航班'].includes(label)&&queryBound(nodes,p,{edit:true}))return decision('effect_travel_prepare_search');
 for(const [key,want]of Object.entries(fields))if(label===want&&has(nodes,'选择'+key)&&nodes.filter(n=>n.values.includes(label)).length===1)return decision('effect_travel_prepare_select',{field:key});
 const named=p.category==='hotel'?p.hotel:p.service;
 if(named&&label===named&&queryBound(nodes,p)&&nodes.filter(n=>n.values.includes(label)).length===1)return decision('effect_travel_prepare_open');
 if(p.operation==='prepare'&&label===(p.category==='hotel'?p.roomType:p.seatType)&&queryBound(nodes,p)&&has(nodes,named)&&nodes.filter(n=>n.values.includes(label)).length===1)return decision('effect_travel_prepare_option');
 if(p.operation==='prepare'&&label==='填写订单'&&queryBound(nodes,p)){
  const facts=offer(nodes,p);if(facts)return decision('effect_travel_prepare_form',{...facts,submitted:false});
 }
 return null;
}
export function verifyTravelPreparationResult(nodes,grant,matches,state,observation){
 const p=grant.effectPlan;if(p?.kind!=='travel_preparation'||unsafe(nodes)||!queryBound(nodes,p))return {verified:false,kind:'travel_prepared',reason:'travel_query_or_terms_unverified'};
 if(p.operation==='compare'){
  const quotes=inspectTravelOffers(observation,grant,nodes,state);return {verified:quotes.length>=1,kind:'travel_offers_observed',facts:{quotes}};
 }
 const facts=offer(nodes,p),entered=matches.some(a=>a.phoneEffect?.kind==='effect_travel_prepare_form'),form=['填写订单','确认订单','核对订单'].some(v=>has(nodes,v));
 const verified=!!facts&&entered&&form&&has(nodes,'待确认')&&nodes.some(n=>n.clickable&&n.values.some(v=>['提交订单','确认预订'].includes(v)))&&!nodes.some(n=>n.values.some(v=>/^订单号[：:]|^预订号[：:]|^已支付/.test(v)));
 return {verified,kind:'travel_prepared',facts:verified?{...facts,submitted:false,paid:false,requiresUser:true,packageName:state.windowPkg,observationId:observation.id}:null};
}
export function compareTravelOffers(quotes,grant){
 const now=Date.now(),p=grant.effectPlan,usable=quotes.filter(q=>q.contractId===grant.contractId&&q.contractRevision===grant.contractRevision&&now-q.observedAt>=0&&now-q.observedAt<=120000&&travelPreparationPackageAllowed(p,q.packageName));
 const key=q=>JSON.stringify(p.category==='hotel'?[q.hotel,q.roomType,q.cancellation,...Object.values(queryFields(p))]:[q.mode,q.service,q.seatType,q.baggage,q.cancellation,...Object.values(queryFields(p))]);
 const groups=new Map();for(const q of usable){const k=key(q),values=groups.get(k)||[];const previous=values.findIndex(x=>x.packageName===q.packageName);if(previous<0)values.push(q);else if(values[previous].observedAt<=q.observedAt)values[previous]=q;groups.set(k,values);}
 return [...groups.values()].filter(group=>group.length>=2&&p.apps.every(app=>group.some(q=>PACKAGES[app]?.includes(q.packageName)))).map(group=>group.sort((a,b)=>a.totalFen-b.totalFen));
}
export function travelPreparationSummary(facts){return `${facts.hotel?facts.hotel+' '+facts.roomType: facts.service+' '+facts.seatType}，总价 ¥${(facts.totalFen/100).toFixed(2)}，${facts.cancellation}。已核实填写订单页；尚未提交预订或付款，请在手机接手。`;}
