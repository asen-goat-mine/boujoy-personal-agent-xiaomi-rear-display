import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../src/core/engine.mjs';
import {Broker} from '../src/tools/broker.mjs';
import {preparationGrant} from '../src/adapters/phone-preparation.mjs';
import {classifyQueryAction} from '../src/adapters/phone-query.mjs';

let sequence=0;
const box=(id,text,bounds,extra={})=>({id,text,bounds,center:{x:(bounds[0]+bounds[2])/2,y:(bounds[1]+bounds[3])/2},...extra});
function page(stage,{query='旧菜品',history='历史搜索',native='',foreign=false}={}){
 const body=[box('food','美食',[40,380,160,430]),box('drink','咖啡奶茶',[230,380,450,430])];
 let lines;
 if(stage==='home')lines=[
  box('row','关注推荐闪购外卖直播',[30,180,920,230],{kind:'row',sourceRow:0}),
  box('compound','闪购外卖',[300,180,500,230],{kind:'word',sourceRow:0,geometrySource:'vision_subrange'}),
  box('flash','闪购',[300,180,400,230],{kind:'word',sourceRow:0,geometrySource:'vision_subrange'}),
  box('takeaway','外卖',[400,180,500,230],{kind:'word',sourceRow:0,geometrySource:'vision_subrange'}),
  box('market-search','搜索',[800,300,920,350])
 ];
 else if(stage==='food'){
  lines=[box('focus','搜索框',[160,180,500,230]),...body];
  native+='\n  Button "搜索框" clickable bounds=150,170,800,250';
 }else{
  lines=[box('field','全部 '+query,[150,128,500,175]),box('search','搜索',[820,128,920,175]),...body];
  if(stage==='input')lines.push(box('history',history,[40,310,500,355]));
  if(stage==='results')lines.push(box('item','招牌'+query,[40,620,520,680]),box('delivery','配送费 ¥0 起送 ¥10',[40,710,620,770]));
 }
 const pkg=foreign?'com.other':'com.taobao.taobao';
 return {id:'integration-'+(++sequence),at:Date.now(),stability:'fresh',stabilityScope:'query',tree:{content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',windowPkg:pkg,foreground:pkg+'/Activity',window:'0,0,968,2376',tree:`window pkg=${pkg} layer=0 bounds=0,0,968,2376`+native}})}]},ocr:{width:968,height:2376,lines}};
}
function wire(frames,prompt='帮我点一份牛肉面'){
 const data={tasks:[],roles:[{id:'concierge'}],settings:{phoneEnabled:true,memoryEnabled:false},actions:[],artifacts:[],outbox:[]};
 const events=[],commands=[],grants=[],queue=[...frames];let queryReads=0,approvalWaits=0;
 const store={data,on(){},off(){},task:id=>{const task=data.tasks.find(t=>t.id===id);assert.ok(task);return task;},transaction(fn){fn(data);},updateTask(id,fn){const task=this.task(id);fn(task,data);return task;},event(id,type,text,extra){events.push({id,type,text,...extra});}};
 const phone={observation:null};
 const observe=(taskId,grant)=>{
  const current=queue.shift();assert.ok(current,'fixture ran out of pages');
  phone.observation={...current,taskId,queryGrant:grant};
  return {content:[{type:'text',text:JSON.stringify({display:'main',observationId:current.id,stability:'fresh',stabilityScope:'query',queryActionsOnly:true,screenSize:{width:968,height:2376},textTargets:current.ocr.lines})},...current.tree.content,{type:'image',mimeType:'image/png',data:'fixture'}]};
 };
 phone.observeQuery=async(taskId,scope,{signal})=>{assert.equal(signal.aborted,false);queryReads++;grants.push(scope);return observe(taskId,scope);};
 phone.observeQueryAfterAction=async(taskId,scope,{signal})=>{assert.equal(signal.aborted,false);grants.push(scope);return observe(taskId,scope);};
 phone.queryAction=(id,args,scope)=>classifyQueryAction(id,args,phone.observation,scope);
 phone.act=async(id,args,{queryGrant:scope,signal})=>{
  assert.equal(signal.aborted,false);assert.ok(scope);assert.ok(classifyQueryAction(id,args,phone.observation,scope));
  assert.equal('x'in args,false);assert.equal('y'in args,false);commands.push(args);phone.observation=null;return {ok:true};
 };
 const broker=new Broker({store,phone,approvals:{request:async()=>{approvalWaits++;throw new Error('approval must not be requested by composed query');},cancelTask(){}},browser:{},memory:{}});
 const engine=new Engine({store,broker,secrets:{get:async()=>null},memory:{}});engine.pump=async()=>{};
 const task=engine.newTask({prompt,cloudConsent:true,memoryConsent:false,memoryMode:'session_only'});task.status='running';data.tasks.push(task);
 return {task,engine,store,broker,phone,commands,events,grants,get queryReads(){return queryReads;},get approvalWaits(){return approvalWaits;}};
}
const searchSummary=output=>JSON.parse(output.content[0].text).search;

test('legacy search observes once; only subsequent model-selected single steps operate the phone',async()=>{
 const f=wire([page('home'),page('food'),page('input'),page('input',{query:'牛肉面'}),page('results',{query:'牛肉面'})]);
 assert.deepEqual(f.task.phoneQuery,{platform:'taobao',query:'牛肉面'});assert.equal(preparationGrant(f.task).quantity,1);
 const out=await f.broker.execute(f.task.id,'phone_search',{},new AbortController().signal);
 assert.equal(searchSummary(out).needsModel,true);assert.equal(searchSummary(out).actions,0);assert.equal(f.queryReads,1);assert.equal(f.commands.length,0);
 for(const action of [{action:'tap',targetId:'flash'},{action:'tap',targetId:'focus'},{action:'type',text:'牛肉面',inputMode:'replace'},{action:'tap',targetId:'search'}]){
  const before=f.commands.length;await f.broker.execute(f.task.id,'phone_use',action,new AbortController().signal);assert.equal(f.commands.length,before+1,'each model choice dispatches exactly one action');
 }
 assert.equal(f.approvalWaits,0);assert.equal(f.store.data.actions.length,4);assert.ok(f.store.data.actions.every(a=>a.status==='completed'&&a.authorization==='query_scope'));
 assert.ok(f.grants.every(g=>g.query==='牛肉面'));assert.ok(out.content.some(c=>c.type==='image'));
});
test('current search results are returned as evidence without invented success or another search',async()=>{
 const f=wire([page('results',{query:'牛肉面',native:'\n EditText "搜索" editable focused offscreen bounds=150,128,700,180'})]);
 const out=await f.broker.execute(f.task.id,'phone_search',{},new AbortController().signal);
 assert.equal(searchSummary(out).needsModel,true);assert.equal(f.commands.length,0);assert.equal(f.approvalWaits,0);assert.equal(f.store.data.actions.length,0);
});
test('a model-selected entry with an unchanged page is not silently retried',async()=>{
 const f=wire([page('home'),page('home')]);await f.broker.execute(f.task.id,'phone_search',{},new AbortController().signal);
 await f.broker.execute(f.task.id,'phone_use',{action:'tap',targetId:'flash'},new AbortController().signal);
 assert.equal(f.commands.length,1);assert.equal(f.store.data.actions.length,1);assert.equal(f.phone.observation.ocr.lines[0].text,'关注推荐闪购外卖直播');
});
test('an old shopping macro is a non-mutating compatibility response even if an app is already open',async()=>{
 const f=wire([]);for(const action of ['search','prepare','status']){
  const output=await f.broker.execute(f.task.id,'shop_flow',{action,targetId:'made-up'},new AbortController().signal),summary=JSON.parse(output.content[0].text).shopFlow;
  assert.equal(summary.actions,0);assert.equal(summary.accepted,false);assert.equal(summary.needsModel,true);
 }
 assert.equal(f.commands.length,0);assert.equal(f.store.data.actions.length,0);assert.equal(f.queryReads,0);
});
test('phone_search without a current human scope is refused before any phone observation',async()=>{
 const f=wire([],'1');await assert.rejects(f.broker.execute(f.task.id,'phone_search',{},new AbortController().signal),{code:'invalid_input'});
 assert.equal(f.queryReads,0);assert.equal(f.commands.length,0);assert.equal(f.approvalWaits,0);
});
