import {normalizePhoneUseObservation} from '../../src/adapters/phoneuse-state.mjs';
import {createTaskContract} from '../../src/core/task-contract.mjs';
import {Phone} from '../../src/adapters/phone.mjs';
import {Broker} from '../../src/tools/broker.mjs';
const defaults={enabled:true,visible:true,editable:false,password:false,focused:false,checkable:false,checked:false,selected:false,content_invalid:false};
export function nativeNode(text,y=500,extra={}){return {text,description:null,hint:null,class:'android.widget.TextView',bounds:[100,y,700,y+40],actions:[],...defaults,...extra};}
export const nativeButton=(text,y,extra={})=>nativeNode(text,y,{class:'android.widget.Button',actions:['tap'],...extra});
export function nativeEnvelope(app,rows){
 const at=Date.now(),elements=[nativeNode(null,0,{element_id:'0',parent_id:null,class:'android.widget.FrameLayout',bounds:[0,0,1000,2400]})];
 const insert=(row,id,parent)=>{const {children=[],...node}=row;elements.push({...node,element_id:id,parent_id:parent});children.forEach((child,i)=>insert(child,id+'.'+i,id));};rows.forEach((row,i)=>insert(row,'0.'+i,'0'));
 const raw={device_id:'fixture',service_instance_id:'service',observation_id:'service:1',window_id:2,package_name:app.packageName,ui_version:1,captured_at_ms:at,display:{id:0,width:1000,height:2400,rotation:0,coordinates:'physical_pixels',origin:'top_left',includes_system_bars_and_ime:true},tree:{output:'legacy',available:true,compact:false,scope_clipped:false,collected_nodes:elements.length,output_nodes:elements.length,merged_nodes:0,elements,collection_complete:true,collection_truncated:false,truncated:false,reason:null,started_at_ms:at-2,finished_at_ms:at-1},screenshot:null,windows:[{window_id:2,display_id:0,type:1,layer:0,active:true,focused:true,bounds:[0,0,1000,2400]}],observation_status:'complete',collection_attempts:1,inconsistency_detected:false};
 return raw;
}
export function nativePage(app,rows){
 const raw=nativeEnvelope(app,rows),at=raw.captured_at_ms,elements=raw.tree.elements;
 const normalized=normalizePhoneUseObservation(raw,{requireScreenshot:false,now:at}),lines=elements.filter(row=>row.text||row.description).map(row=>({id:row.element_id,text:row.text||row.description,bounds:row.bounds,center:{x:(row.bounds[0]+row.bounds[2])/2,y:(row.bounds[1]+row.bounds[3])/2}}));
 return {id:'o',taskId:'t',at,tree:normalized.tree,native:normalized.native,ocr:{width:1000,height:2400,lines},stability:'fresh',stabilityScope:'phone_use'};
}
export function nativeTask(content,extra={}){const t={id:'t',source:'user',status:'running',kind:'general',prompt:content,messages:[{id:'u',role:'user',content}],quotes:[],children:[],...extra};t.taskContract=createTaskContract(t);return t;}
export const nativeTap=(observation,text)=>({observationId:observation.id,action:'tap',textTargetId:observation.ocr.lines.find(row=>row.text===text)?.id});
export function nativeBrokerFixture(prompt,app,first,next=[],taskExtra={}){
 const t=nativeTask(prompt,taskExtra),data={tasks:[t],actions:[],artifacts:[],settings:{phoneEnabled:true,memoryEnabled:false}},calls=[],store={data,task:()=>t,event(){},transaction:fn=>fn(data),updateTask:(id,fn)=>fn(t,data)};let state=first;
 const phone=new Phone(store,{wait:async()=>{},recognize:async()=>state.ocr});phone.apps={list:async()=>({source:'fixture',apps:[app]}),resolve:async()=>app};
 phone.call=async(name,args)=>{calls.push({name,args});if(name==='ui_tree')return state.tree;if(name==='screenshot')return {content:[{type:'image',mimeType:'image/png',data:Buffer.from(JSON.stringify(state.ocr)).toString('base64')}]};if(name==='wait_idle')return {content:[{type:'text',text:'{"ok":true,"result":{"settled":true}}'}]};if(['tap','type','key'].includes(name)){const page=next.shift();if(page instanceof Error)throw page;if(page)state=page;return {content:[{type:'text',text:'{"ok":true}'}]};}throw Error('Unexpected '+name);};
 const broker=new Broker({store,phone,approvals:{request(){throw Error('Unexpected approval');}}});broker.engine={finishReport(){t.status='completed';},readyForUser(){t.status='ready_for_user';}};
 return {t,data,store,phone,broker,calls,setState(value){state=value;}};
}
