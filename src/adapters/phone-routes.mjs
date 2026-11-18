const compact=value=>String(value||'').normalize('NFKC').replace(/\s+/g,'');
const maps=new Set(['com.autonavi.minimap','com.baidu.BaiduMap']);
const fieldLabels={origin:/^(?:起点|出发地|输入起点|请输入起点|从哪里出发)$/,destination:/^(?:终点|目的地|输入终点|请输入终点|到哪里去)$/};
const bad=/叫车|打车|预约|预订|支付|付款|下单|开始导航|导航开始|授权|登录|同意|允许/;
const inside=(point,b)=>point&&point.x>=b[0]&&point.x<b[2]&&point.y>=b[1]&&point.y<b[3];
export function routePlan(contract){
 const route=contract?.objects?.route;if(!route||!contract.effects?.includes('read')||!contract.effects.includes('navigate')||contract.effects.some(effect=>!['read','navigate'].includes(effect)))return null;
 if(!['步行','驾车','骑行','公交'].includes(route.mode)||typeof route.origin!=='string'||typeof route.destination!=='string'||!route.origin||!route.destination)return null;
 return {kind:'route',origin:route.origin,destination:route.destination,mode:route.mode};
}
export const routePackageAllowed=(plan,pkg)=>plan?.kind!=='route'||maps.has(pkg);
function fieldBound(node,key,value){const aliases=key==='origin'?['起点','出发地']:['终点','目的地'];return node.labels.some(label=>fieldLabels[key].test(label))&&node.labels.includes(compact(value))||node.labels.some(label=>aliases.some(alias=>label===alias+':'+compact(value)));}
function role(nodes){const roles=Object.entries({origin:/^(?:选择起点|搜索起点|设置起点|输入起点)$/,destination:/^(?:选择终点|搜索终点|设置终点|输入终点)$/}).filter(([,pattern])=>nodes.some(node=>!node.editable&&node.labels.some(label=>pattern.test(label))));return roles.length===1?roles[0][0]:null;}
function modeSelected(nodes,plan){const modes=nodes.filter(node=>node.labels.includes(plan.mode)&&(/\bselected\b|\bchecked\b/.test(node.raw)||node.labels.includes('交通方式')));return modes.length===1;}
function target(args,nodes,ocr){
 const matches=args.textTargetId?(ocr?.lines||[]).filter(line=>line.id===args.textTargetId):[];if(args.textTargetId&&matches.length!==1)return null;
 const match=matches[0],point=match?.center||{x:args.x,y:args.y};
 const hits=nodes.filter(node=>(node.clickable||node.editable)&&inside(point,node.bounds));
 if(hits.some(node=>node.secret||node.labels.some(label=>bad.test(label))))return null;
 const node=hits.sort((a,b)=>(a.bounds[2]-a.bounds[0])*(a.bounds[3]-a.bounds[1])-(b.bounds[2]-b.bounds[0])*(b.bounds[3]-b.bounds[1]))[0];if(!node)return null;
 const label=match?compact(match.text):node.labels.length===1?node.labels[0]:null;if(match&&!node.labels.includes(label))return null;return {node,label};
}
function endpoints(nodes,plan){return ['origin','destination'].every(key=>nodes.filter(node=>fieldBound(node,key,plan[key])).length===1);}
export function classifyRouteAction(args,state,ocr,grant,nodes){
 const plan=grant.effectPlan;if(plan?.kind!=='route'||!maps.has(state.windowPkg))return null;
 const result=(kind,witness={})=>({kind,witness:{...witness,origin:plan.origin,destination:plan.destination,mode:plan.mode}});
 if(args.action==='type'){
  if(args.inputMode!=='replace'||typeof args.text!=='string'||args.textTargetId)return null;
  const fields=nodes.filter(node=>node.editable&&node.focused&&!node.secret);if(fields.length!==1)return null;
  const activeRole=role(nodes),field=fields[0];
  for(const key of ['origin','destination'])if(args.text===plan[key]&&(field.labels.some(label=>fieldLabels[key].test(label))||activeRole===key&&field.labels.some(label=>/^(?:搜索地点|搜索|输入地点|地点)$/.test(label))))return result('effect_route_input',{field:key});
  return null;
 }
 if(args.action!=='tap')return null;const selected=target(args,nodes,ocr);if(!selected)return null;const {node,label}=selected;
 if(/^(?:路线|路线规划|查路线|查询路线)$/.test(label||'')&&!nodes.some(n=>n.editable))return result('effect_route_navigation');
 for(const key of ['origin','destination'])if(node.labels.some(value=>fieldLabels[key].test(value)))return result('effect_route_focus',{field:key});
 const activeRole=role(nodes);
 if(activeRole&&label===compact(plan[activeRole])&&nodes.filter(n=>!n.editable&&n.labels.includes(label)&&n.clickable).length===1)return result('effect_route_place_select',{field:activeRole});
 if(activeRole&&label==='搜索'&&nodes.some(n=>n.editable&&n.labels.includes(compact(plan[activeRole]))))return result('effect_route_place_search',{field:activeRole});
 if(label===plan.mode&&endpoints(nodes,plan))return result('effect_route_mode');
 if(/^(?:查询路线|查看路线|规划路线|开始查询|搜索)$/.test(label||'')&&endpoints(nodes,plan)&&modeSelected(nodes,plan))return result('effect_route_query');
 return null;
}
function cards(nodes){
 const roots=nodes.filter(node=>node.labels.some(label=>/^(?:推荐路线|推荐方案|路线方案|方案[一二三123])$/.test(label)));
 return roots.map(root=>{const index=nodes.indexOf(root),depth=root.line.length-root.line.trimStart().length,children=[root];for(let i=index+1;i<nodes.length;i++){const child=nodes[i];if(child.line.length-child.line.trimStart().length<=depth)break;children.push(child);}return {root,nodes:children};});
}
function uniqueValue(values){const unique=[...new Set(values)];return unique.length===1?unique[0]:null;}
export function verifyRouteResult(nodes,grant,state,observation){
 const plan=grant.effectPlan;if(plan?.kind!=='route')return null;
 const fail=reason=>({verified:false,kind:'route_verified',reason});
 if(!maps.has(state.windowPkg)||!endpoints(nodes,plan)||!modeSelected(nodes,plan))return fail('route_endpoints_or_mode_unverified');
 if(nodes.some(node=>node.labels.some(label=>/路线规划失败|暂无路线|未找到路线|查询失败|加载中|正在规划|定位失败/.test(label))))return fail('route_result_unavailable');
 const all=cards(nodes),selected=all.filter(card=>/\bselected\b|\bchecked\b/.test(card.root.raw)||card.root.labels.includes('已选中'));
 const card=selected.length===1?selected[0]:all.length===1?all[0]:null;if(!card)return fail('route_alternative_ambiguous');
 const texts=card.nodes.flatMap(node=>node.labels);
 const times=texts.flatMap(text=>[...text.matchAll(/(?:(\d{1,2})小时)?(\d{1,3})分钟/g)].map(match=>(Number(match[1]||0)*60+Number(match[2]))*60));
 const distances=texts.flatMap(text=>[...text.matchAll(/(\d+(?:\.\d{1,3})?)(公里|千米|米)/g)].map(match=>Math.round(Number(match[1])*(match[2]==='米'?1:1000))));
 const etaSeconds=uniqueValue(times),distanceMeters=uniqueValue(distances);if(etaSeconds===null||etaSeconds<=0||distanceMeters===null||distanceMeters<=0)return fail('route_eta_or_distance_unverified');
 const costs=[];
 for(const [type,label] of (plan.mode==='公交'?[['fare','票价|公交票价|预计票价']]:plan.mode==='驾车'?[['toll','路桥费|过路费|通行费']]:[])){
  const values=texts.flatMap(text=>[...text.matchAll(new RegExp('(?:'+label+')[：:]?[¥￥]?(\\d+(?:\\.\\d{1,2})?)(?:元|$)','g'))].map(match=>Math.round(Number(match[1])*100)));
  if(values.length){const fen=uniqueValue(values);if(fen===null)return fail('route_cost_ambiguous');costs.push({type,amountFen:fen,currency:'CNY'});}
 }
 return {verified:true,kind:'route_verified',facts:{origin:plan.origin,destination:plan.destination,mode:plan.mode,etaSeconds,distanceMeters,costs:costs.length?costs:null,sourcePackage:state.windowPkg,observationId:observation.id,observedAt:observation.at,bookingCreated:false}};
}
export function routeSummary(facts){const distance=facts.distanceMeters>=1000?`${Number((facts.distanceMeters/1000).toFixed(3))} 公里`:`${facts.distanceMeters} 米`,cost=facts.costs?facts.costs.map(row=>`${row.type==='toll'?'通行费':'票价'} ¥${(row.amountFen/100).toFixed(2)}`).join('，'):'费用未显示';return `${facts.origin} → ${facts.destination}，${facts.mode}，页面预计 ${facts.etaSeconds/60} 分钟，${distance}；${cost}。`;}
