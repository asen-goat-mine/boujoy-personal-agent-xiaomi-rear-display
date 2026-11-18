import test from 'node:test';
import assert from 'node:assert/strict';
import {Phone} from '../src/adapters/phone.mjs';
const grant={platform:'taobao',query:'牛肉面'};
const tree=(pkg='com.taobao.taobao',body='')=>({content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:pkg+'/Activity',windowPkg:pkg,window:'main',tree:'window pkg='+pkg+' bounds=0,0,968,2376\n'+body}})}]});
const line=(id,text,bounds)=>({id,text,bounds,center:{x:Math.round((bounds[0]+bounds[2])/2),y:Math.round((bounds[1]+bounds[3])/2)}});
const home=()=>({tree:tree(),ocr:{width:968,height:2376,lines:[line('flash','闪购',[40,140,150,210]),line('search','搜索',[800,140,930,210]),line('ad','活动广告',[100,1200,500,1260])]}});
const result=()=>({tree:tree(),ocr:{width:968,height:2376,lines:[line('search','搜索',[800,140,930,210]),line('item','招牌牛肉面',[100,650,500,730]),line('other','酸菜鱼',[100,850,500,930]),line('buy','立即抢购',[600,2000,900,2200])]}});
const search=()=>({tree:tree(),ocr:{width:968,height:2376,lines:[line('input','全部 冰美式',[155,128,448,173]),line('search','搜索',[823,128,896,169]),line('history','历史搜索',[31,314,179,356])]}});
const checkout=()=>({tree:tree(),ocr:{width:968,height:2376,lines:[line('title','确认订单',[100,140,500,200]),line('pay','立即支付',[650,2100,900,2220])]}});
function fixture(initial=[home()],{recognize}={}){
 let frames=initial,cursor=0,time=Date.now();const calls=[];
 const phone=new Phone({data:{settings:{phoneEnabled:true}}},{clock:()=>time,wait:async ms=>{time+=ms;},recognize:recognize||(async image=>JSON.parse(Buffer.from(image.content[0].data,'base64').toString()).ocr)});
 phone.call=async(name,args)=>{
  calls.push({name,args});assert.equal(args.display,'main');
  if(name==='ui_tree')return frames[Math.min(cursor,frames.length-1)].tree;
  if(name==='screenshot')return {content:[{type:'image',mimeType:'image/png',data:Buffer.from(JSON.stringify(frames[Math.min(cursor++,frames.length-1)])).toString('base64')}]};
  if(['tap','type','key','swipe'].includes(name))return {content:[{type:'text',text:'{"ok":true}'}]};
  throw Error('Unexpected '+name);
 };
 return {phone,calls,setFrames(next){frames=next;cursor=0;},advance(ms){time+=ms;}};
}
const meta=r=>JSON.parse(r.content[0].text);
test('normal query observation uses one native/image capture and stores an immutable exact grant',async()=>{
 const f=fixture(),input={...grant},r=await f.phone.observeQuery('t',input),m=meta(r);
 assert.equal(m.stability,'fresh');assert.equal(m.stabilityScope,'query');assert.equal(m.attempts,1);assert.equal(m.requiresFullObservationFor,'quotes,cart,checkout');
 assert.deepEqual(f.calls.map(c=>c.name),['ui_tree','screenshot']);assert.deepEqual(f.phone.observation.queryGrant,grant);
 input.query='酸菜鱼';assert.deepEqual(f.phone.observation.queryGrant,grant);assert.equal(f.phone.observation.stability,'fresh');
 const args={observationId:m.observationId,action:'tap',textTargetId:'flash'};
 assert.equal(f.phone.queryAction('t',args,grant)?.kind,'query_navigation');assert.equal(f.phone.queryAction('t',args,input),null);
});
test('fresh query observations allow exact query detail reads but reject transactions and unrelated products before dispatch',async()=>{
 const f=fixture([result()]),m=meta(await f.phone.observeQuery('t',grant));
 f.phone.assertActionScope('t',{observationId:m.observationId,action:'tap',textTargetId:'item'});
 for(const args of [{action:'tap',textTargetId:'buy'},{action:'tap',textTargetId:'other'},{action:'tap',x:700,y:2150},{action:'type',text:'私密消息'},{action:'type',text:'酸菜鱼'}]){
  await assert.rejects(f.phone.act('t',{observationId:m.observationId,...args}),e=>e.code==='query_scope_changed');
 }
 assert.equal(f.calls.some(c=>['tap','type','swipe','key'].includes(c.name)),false);
});
test('query action scope cannot be widened by another task grant or a caller override',async()=>{
 const f=fixture(),m=meta(await f.phone.observeQuery('t',grant)),args={observationId:m.observationId,action:'tap',textTargetId:'flash'};
 assert.throws(()=>f.phone.assertActionScope('other',args),e=>e.code==='query_scope_changed');
 await assert.rejects(f.phone.act('t',args,{queryGrant:{platform:'taobao',query:'酸菜鱼'}}),e=>e.code==='query_scope_changed');
 await assert.rejects(f.phone.observeQuery('t',null),e=>e.code==='query_scope_changed');
 assert.equal(f.calls.some(c=>c.name==='tap'),false);
});
test('accepted query action gets one fresh changed page without wait_idle or full stabilization',async()=>{
 const f=fixture(),m=meta(await f.phone.observeQuery('t',grant));
 await f.phone.act('t',{observationId:m.observationId,action:'tap',textTargetId:'flash'},{queryGrant:grant});f.setFrames([result()]);
 const start=f.calls.length,next=meta(await f.phone.observeQueryAfterAction('t',grant));
 assert.equal(next.stability,'fresh');assert.equal(next.attempts,1);assert.equal(next.changedSinceAction,true);
 assert.deepEqual(f.calls.slice(start).map(c=>c.name),['ui_tree','screenshot']);assert.equal(f.calls.some(c=>c.name==='wait_idle'),false);
});
test('one bounded extra read handles an old post-action frame but never republishes two unchanged frames',async()=>{
 for(const changes of [false,true]){
  const f=fixture(),m=meta(await f.phone.observeQuery('t',grant));await f.phone.act('t',{observationId:m.observationId,action:'tap',textTargetId:'flash'});
  f.setFrames(changes?[home(),result()]:[home()]);const start=f.calls.length,next=meta(await f.phone.observeQueryAfterAction('t',grant));
  assert.equal(next.attempts,2);assert.deepEqual(f.calls.slice(start).map(c=>c.name),['ui_tree','screenshot','ui_tree','screenshot']);
  assert.equal(next.stability,changes?'fresh':'uncertain');
  if(!changes){assert.equal(next.reason,'action_screen_unchanged');assert.equal(next.observationId,undefined);assert.equal(f.phone.observation,null);}
 }
});
test('loading frames get at most one retry and remain non-actionable if still busy',async()=>{
 const busy={tree:tree(),ocr:{width:968,height:2376,lines:[line('loading','加载中…',[100,650,500,730])]}};
 for(const changes of [false,true]){
  const f=fixture(changes?[busy,home()]:[busy]),m=meta(await f.phone.observeQuery('t',grant));
  assert.equal(m.attempts,2);assert.equal(m.stability,changes?'fresh':'uncertain');if(!changes)assert.equal(m.reason,'screen_loading');
 }
});
test('checkout, account, foreign app and unavailable OCR are not forwarded under a query observation',async()=>{
 const account=home();account.ocr.lines.push(line('login','验证码',[100,650,500,730]));
 const foreign=home();foreign.tree=tree('com.tencent.mm');
 const dialog=home();dialog.tree=tree('com.taobao.taobao','Dialog bounds=0,0,968,1000');
 for(const screen of [checkout(),account,foreign,dialog]){
  const f=fixture([screen]),r=await f.phone.observeQuery('t',grant),m=meta(r);
  assert.equal(m.stability,'uncertain');assert.equal(m.reason,'query_scope_changed');assert.equal(m.observationId,undefined);assert.equal(r.content.length,1);assert.equal(f.phone.observation,null);
 }
 const f=fixture([home()],{recognize:async()=>null});assert.equal(meta(await f.phone.observeQuery('t',grant)).stability,'uncertain');
});
test('custom query typing re-reads OCR and blocks a newly changed checkout even with the same empty native tree',async()=>{
 for(const changed of [false,true]){
  const f=fixture([search()]),m=meta(await f.phone.observeQuery('t',grant));f.setFrames(changed?[checkout()]:[search()]);
  const start=f.calls.length,run=f.phone.act('t',{observationId:m.observationId,action:'type',text:grant.query,inputMode:'replace'});
  if(changed){await assert.rejects(run,e=>e.code==='query_scope_changed');assert.equal(f.calls.some(c=>c.name==='type'),false);}
  else {await run;assert.deepEqual(f.calls.at(-1),{name:'type',args:{text:grant.query,mode:'replace',display:'main'}});}
  assert.deepEqual(f.calls.slice(start,start+2).map(c=>c.name),['ui_tree','screenshot']);
 }
});
test('query observation budget and cancellation clear old actionable state',async()=>{
 let f;f=fixture();const m=meta(await f.phone.observeQuery('t',grant));await f.phone.act('t',{observationId:m.observationId,action:'tap',textTargetId:'flash'});
 f.phone.wait=async()=>f.advance(6100);const exhausted=meta(await f.phone.observeQueryAfterAction('t',grant));assert.equal(exhausted.reason,'query_observation_timeout');assert.equal(exhausted.observationId,undefined);
 const abort=new AbortController();f=fixture([home()],{recognize:async()=>{abort.abort();return home().ocr;}});
 await assert.rejects(f.phone.observeQuery('t',grant,{signal:abort.signal}),e=>e.code==='cancelled');assert.equal(f.phone.observation,null);
});



test('action cancellation is distinct and never dispatches a late command after fresh validation',async()=>{
 const f=fixture(),m=meta(await f.phone.observeQuery('t',grant)),abort=new AbortController();
 abort.abort();const initial=f.calls.length;await assert.rejects(f.phone.act('t',{observationId:m.observationId,action:'tap',textTargetId:'flash'},{signal:abort.signal}),e=>e.code==='action_cancelled');assert.equal(f.calls.length,initial);
 const late=new AbortController();f.phone.recognize=async image=>{late.abort();return JSON.parse(Buffer.from(image.content[0].data,'base64').toString()).ocr;};
 await assert.rejects(f.phone.act('t',{observationId:m.observationId,action:'tap',textTargetId:'flash'},{signal:late.signal}),e=>e.code==='action_cancelled');assert.equal(f.calls.some(c=>c.name==='tap'),false);
});
