import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskContract} from '../src/core/task-contract.mjs';
import {parseRouteRequest} from '../src/core/route-contract.mjs';
import {phoneUseGrant,classifyPhoneUseAction,effectGoalStatus} from '../src/adapters/phone-use.mjs';
import {normalizePhoneUseObservation} from '../src/adapters/phoneuse-state.mjs';
import {Phone} from '../src/adapters/phone.mjs';
import {Broker} from '../src/tools/broker.mjs';
const APP={packageName:'com.autonavi.minimap',label:'高德地图',aliases:['高德地图','高德']};
const prompt='在高德地图查询从“上海虹桥站”到“外滩”的步行路线，只查询，不叫车';
const defaults={enabled:true,visible:true,editable:false,password:false,focused:false,checkable:false,checked:false,selected:false,content_invalid:false};
function n(text,y=500,extra={}){return {text,description:null,hint:null,class:'android.widget.TextView',bounds:[100,y,700,y+60],actions:[],...defaults,...extra};}
const button=(text,y,extra={})=>n(text,y,{class:'android.widget.Button',actions:['tap'],...extra});
function page(rows,{pkg=APP.packageName}={}){
 const at=Date.now(),root=n(null,0,{element_id:'0',parent_id:null,class:'android.widget.FrameLayout',bounds:[0,0,1000,2000]}),elements=[root];
 const insert=(row,id,parent)=>{const {children=[],...node}=row;elements.push({...node,element_id:id,parent_id:parent});children.forEach((child,i)=>insert(child,id+'.'+i,id));};rows.forEach((row,index)=>insert(row,'0.'+index,'0'));
 const raw={device_id:'fixture',service_instance_id:'service',observation_id:'service:1',window_id:2,package_name:pkg,ui_version:1,captured_at_ms:at,display:{id:0,width:1000,height:2000,rotation:0,coordinates:'physical_pixels',origin:'top_left',includes_system_bars_and_ime:true},tree:{output:'legacy',available:true,compact:false,scope_clipped:false,collected_nodes:elements.length,output_nodes:elements.length,merged_nodes:0,elements,collection_complete:true,collection_truncated:false,truncated:false,reason:null,started_at_ms:at-2,finished_at_ms:at-1},screenshot:null,windows:[{window_id:2,display_id:0,type:1,layer:0,active:true,focused:true,bounds:[0,0,1000,2000]}],observation_status:'complete',collection_attempts:1,inconsistency_detected:false};
 const normalized=normalizePhoneUseObservation(raw,{requireScreenshot:false,now:at});
 const lines=elements.filter(row=>row.text||row.description).map(row=>({id:row.element_id,text:row.text||row.description,bounds:row.bounds,center:{x:(row.bounds[0]+row.bounds[2])/2,y:(row.bounds[1]+row.bounds[3])/2}}));
 return {id:'o',taskId:'t',at,tree:normalized.tree,native:normalized.native,ocr:{width:1000,height:2000,lines},stability:'fresh',stabilityScope:'phone_use'};
}
function task(content=prompt){const t={id:'t',source:'user',status:'running',kind:'general',prompt:content,messages:[{id:'u',role:'user',content}],quotes:[],children:[]};t.taskContract=createTaskContract(t);return t;}
const grant=t=>phoneUseGrant(t,{...APP,appName:APP.label});
function form(origin='',destination='',focus=null,selected=false){return page([n(origin,200,{description:'起点',class:'android.widget.EditText',editable:true,focused:focus==='origin',actions:['tap','set_text']}),n(destination,400,{description:'终点',class:'android.widget.EditText',editable:true,focused:focus==='destination',actions:['tap','set_text']}),button('步行',600,{selected}),button('查询路线',800)]);}
const card=(extra={})=>n('推荐路线',950,{class:'android.view.View',bounds:[100,950,800,1500],children:[n('预计35分钟',1050),n('2.4公里',1150),n('票价 ¥2.00',1250)],...extra});
function result({origin='上海虹桥站',destination='外滩',mode='步行',route=card(),extra=[]}={}){return page([n(origin,200,{description:'起点'}),n(destination,400,{description:'终点'}),button(mode,600,{selected:true}),route,...extra]);}
const tap=(observation,text)=>({observationId:observation.id,action:'tap',textTargetId:observation.ocr.lines.find(row=>row.text===text)?.id});
test('route contract retains explicit endpoints and one requested mode; incomplete or booking requests have no route grant',()=>{
 assert.deepEqual(parseRouteRequest(prompt),{origin:'上海虹桥站',destination:'外滩',mode:'步行'});
 assert.deepEqual(parseRouteRequest('在百度地图查从北京西站到天安门的公交路线'),{origin:'北京西站',destination:'天安门',mode:'公交'});
 for(const content of ['在高德地图查询去外滩的步行路线','在高德地图查询从“上海虹桥站”到“外滩”的路线','在高德地图查询从“上海虹桥站”到“外滩”的步行或驾车路线','在高德地图查询从“上海虹桥站”到“外滩”的步行路线并叫车','在高德地图不要查询从“上海虹桥站”到“外滩”的步行路线'])assert.equal(grant(task(content)),null,content);
 assert.equal(phoneUseGrant(task(),{packageName:'com.fake.maps',appName:'高德地图'}),null);
 assert.equal(task('介绍高德地图路线是怎么规划的').taskContract.objects.routeRequested,undefined);
});
test('route field input and mode selection are bound to current native roles; no generic fallback or ride booking',()=>{
 const g=grant(task());assert.equal(g.effectPlan.kind,'route');
 const input=form('','','origin');assert.equal(classifyPhoneUseAction('t',{observationId:'o',action:'type',text:'上海虹桥站',inputMode:'replace'},input,g)?.kind,'effect_route_input');
 for(const text of ['外滩','其他起点'])assert.equal(classifyPhoneUseAction('t',{observationId:'o',action:'type',text,inputMode:'replace'},input,g),null);
 const ready=form('上海虹桥站','外滩',null,true);assert.equal(classifyPhoneUseAction('t',tap(ready,'查询路线'),ready,g)?.kind,'effect_route_query');
 const wrong=form('上海虹桥站','其他地点',null,true);assert.equal(classifyPhoneUseAction('t',tap(wrong,'查询路线'),wrong,g),null);
 for(const label of ['开始导航','叫车','立即预约']){const unsafe=page([button(label,1000)]);assert.equal(classifyPhoneUseAction('t',tap(unsafe,label),unsafe,g),null);}
});
test('actual native result binds endpoint roles, selected travel mode and one route card with ETA/distance/cost provenance',()=>{
 const g=grant(task()),observed=result(),proof=effectGoalStatus(observed,g,[]);assert.equal(proof.verified,true);assert.equal(proof.facts.etaSeconds,2100);assert.equal(proof.facts.distanceMeters,2400);assert.equal(proof.facts.costs,null);
 const transit=effectGoalStatus(result({mode:'公交'}),grant(task(prompt.replace('步行','公交'))),[]);assert.deepEqual(transit.facts.costs,[{type:'fare',amountFen:200,currency:'CNY'}]);
 const driving=effectGoalStatus(result({mode:'驾车',route:card({children:[n('30分钟',1050),n('12公里',1150),n('通行费 ¥5.00',1250)]})}),grant(task(prompt.replace('步行','驾车'))),[]);assert.deepEqual(driving.facts.costs,[{type:'toll',amountFen:500,currency:'CNY'}]);assert.equal(proof.facts.bookingCreated,false);assert.equal(proof.facts.sourcePackage,APP.packageName);
 for(const page of [result({origin:'外滩',destination:'上海虹桥站'}),result({mode:'驾车'}),result({extra:[card({text:'方案二'})]}),result({route:card({children:[n('35分钟',1050)]})}),result({extra:[n('正在规划',1700)]})])assert.equal(effectGoalStatus(page,g,[]).verified,false);
 const noCost=effectGoalStatus(result({route:card({children:[n('1小时5分钟',1050),n('15公里',1150)]})}),g,[]);assert.equal(noCost.facts.costs,null);assert.equal(noCost.facts.etaSeconds,3900);
 const selected=result({route:card({selected:true}),extra:[card({text:'方案二',children:[n('99分钟',1050),n('99公里',1150)]})]});assert.equal(effectGoalStatus(selected,g,[]).facts.etaSeconds,2100);
});
function fixture(content=prompt){
 const t=task(content),data={tasks:[t],actions:[],artifacts:[],settings:{phoneEnabled:true,memoryEnabled:false}},calls=[],store={data,task:()=>t,event(){},transaction:fn=>fn(data),updateTask:(id,fn)=>fn(t,data)};
 let state=form(),next=[form('','','origin'),form('上海虹桥站','','origin'),form('上海虹桥站','','destination'),form('上海虹桥站','外滩','destination'),form('上海虹桥站','外滩','destination',true),result()];
 const phone=new Phone(store,{wait:async()=>{},recognize:async()=>state.ocr});phone.apps={list:async()=>({source:'fixture',apps:[APP]}),resolve:async()=>APP};
 phone.call=async(name,args)=>{calls.push({name,args});if(name==='ui_tree')return state.tree;if(name==='screenshot')return {content:[{type:'image',mimeType:'image/png',data:Buffer.from(JSON.stringify(state.ocr)).toString('base64')}]};if(['tap','type'].includes(name)){state=next.shift()||state;return {content:[{type:'text',text:'{"ok":true}'}]};}throw Error('Unexpected '+name);};
 const broker=new Broker({store,phone,approvals:{request(){throw Error('Unexpected approval');}}});broker.engine={finishReport(){t.status='completed';}};return {t,data,phone,broker,calls};
}