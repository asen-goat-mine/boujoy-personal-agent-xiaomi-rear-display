import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Phone} from '../src/adapters/phone.mjs';
import {phoneFingerprint} from '../src/adapters/phone-observation.mjs';

const tree=(text='')=>({content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:'com.taobao.taobao',windowPkg:'com.taobao.taobao',window:'main',tree:'window pkg=com.taobao.taobao bounds=0,0,968,2376\n'+text}})}]});
const ocr=(text,{clock='13:25',price='¥12.9'}={})=>({width:968,height:2376,lines:[
 {id:'clock',text:clock,bounds:[20,10,140,50],center:{x:80,y:30}},
 {id:'title',text,bounds:[40,200,600,270],center:{x:320,y:235}},
 {id:'price',text:price,bounds:[30,2050,420,2110],center:{x:225,y:2080}},
 {id:'pay',text:'立即支付',bounds:[640,2130,910,2220],center:{x:775,y:2175}}
]});
const frame=(text,extra={})=>({tree:tree(),ocr:ocr(text,extra),token:text+':'+(extra.price||'¥12.9'),...extra});
function fixture(frames,{idle=true,recognize,wait}={}){
 let cursor=0,last=null,time=0;const calls=[];
 const phone=new Phone({data:{settings:{phoneEnabled:true}}},{clock:()=>time,wait:wait||(async ms=>{time+=ms;}),recognize:recognize||(async image=>JSON.parse(Buffer.from(image.content[0].data,'base64').toString()).ocr)});
 phone.call=async(name,args)=>{
  calls.push({name,args});assert.equal(args.display,'main');
  if(name==='wait_idle'){time+=40;return {content:[{type:'text',text:JSON.stringify({ok:true,result:{settled:idle,waitedMs:40}})}]};}
  if(name==='ui_tree')return frames[Math.min(cursor,frames.length-1)].tree;
  if(name==='screenshot'){last=frames[Math.min(cursor++,frames.length-1)];return {content:[{type:'image',mimeType:'image/png',data:Buffer.from(JSON.stringify({token:last.token,ocr:last.ocr})).toString('base64')}]};}
  if(name==='tap')return {content:[{type:'text',text:'{"ok":true}'}]};
  throw Error('Unexpected command '+name);
 };
 return {phone,calls,advance:ms=>{time+=ms;}};
}
function baseline(phone,screen){
 const imageData=Buffer.from(JSON.stringify({token:screen.token,ocr:screen.ocr})).toString('base64');
 phone.actionBaseline={taskId:'t',at:0,id:'old',tree:screen.tree,ocr:screen.ocr,hash:phoneFingerprint(screen.tree),imageHash:createHash('sha256').update(imageData).digest('hex')};
}
const meta=result=>JSON.parse(result.content[0].text);

test('normal action follow-up validates two aligned frames and publishes a usable observation',async()=>{
 const {phone,calls}=fixture([frame('订单确认')]);baseline(phone,frame('商品列表'));
 const result=await phone.observeAfterAction('t');const m=meta(result);
 assert.equal(m.stability,'stable');assert.equal(m.attempts,2);assert.equal(m.idleSettled,true);assert.equal(m.changedSinceAction,true);
 assert.equal(phone.observation.id,m.observationId);assert.equal(phone.observation.stability,'stable');assert.deepEqual(phone.observation.stabilityMeta,result.meta);assert.equal(result.meta.stability,'stable');
 assert.deepEqual(calls.map(c=>c.name),['wait_idle','ui_tree','screenshot','ui_tree','screenshot']);
 assert.equal(calls[0].args.timeoutMs,1200);
});

test('idle timeout cannot accept two old frames before a delayed page transition',async()=>{
 const {phone}=fixture([frame('旧菜单'),frame('旧菜单'),frame('订单确认'),frame('订单确认'),frame('订单确认')],{idle:false});baseline(phone,frame('旧菜单'));
 const m=meta(await phone.observeAfterAction('t'));
 assert.equal(m.stability,'stable');assert.equal(m.attempts,5);assert.equal(m.idleSettled,false);assert.equal(m.changedSinceAction,true);
 assert.equal(phone.observation.ocr.lines[1].text,'订单确认');
});

test('a constant empty native tree cannot make changing OCR screens actionable',async()=>{
 const {phone}=fixture(['一','二','三','四','五'].map(s=>frame(s)));
 const m=meta(await phone.observeStable('t'));assert.equal(m.stability,'uncertain');assert.equal(m.attempts,5);assert.equal(m.observationId,undefined);assert.deepEqual(m.textTargets,[]);assert.equal(phone.observation,null);
 await assert.rejects(phone.act('t',{observationId:'old',action:'tap',x:1,y:1}),/重新观察/);
});

test('busy and misaligned captures never publish actionable observation IDs',async()=>{
 for(const frames of [[frame('加载中…')],Array.from({length:5},(_,i)=>frame('订单确认',{tree:tree(i%2?'Dialog bounds=0,0,968,1000':'')}))]){
  const {phone}=fixture(frames);const m=meta(await phone.observeStable('t'));
  assert.equal(m.stability,'uncertain');assert.equal(m.observationId,undefined);assert.equal(phone.observation,null);
 }
});

test('system clock changes do not delay stable material OCR but changed prices do',async()=>{
 const {phone}=fixture([frame('订单确认',{clock:'13:25',price:'¥12.9'}),frame('订单确认',{clock:'13:26',price:'¥13.9'}),frame('订单确认',{clock:'13:27',price:'¥13.9'})]);
 const m=meta(await phone.observeStable('t'));
 assert.equal(m.stability,'stable');assert.equal(m.attempts,3);assert.equal(phone.observation.ocr.lines[2].text,'¥13.9');
});

test('a settled but unchanged action result remains read-only until a fresh observation',async()=>{
 const same=frame('菜单');const {phone}=fixture([same]);baseline(phone,same);
 const first=meta(await phone.observeAfterAction('t'));assert.equal(first.stability,'uncertain');assert.equal(first.reason,'action_screen_unchanged');assert.equal(first.changedSinceAction,false);assert.equal(first.observationId,undefined);
 const next=meta(await phone.observeStable('t'));assert.equal(next.stability,'stable');assert.ok(next.observationId);
});

test('raw screenshots provide a stability fallback when local OCR is unavailable',async()=>{
 const {phone}=fixture([frame('原生页面')],{recognize:async()=>null});const m=meta(await phone.observeStable('t'));
 assert.equal(m.stability,'stable');assert.equal(m.screenSize,null);assert.ok(m.observationId);
});

test('cancelling stable acquisition clears old actionable state and stops publication',async()=>{
 const abort=new AbortController();const {phone}=fixture([frame('订单确认')],{recognize:async()=>{abort.abort();return ocr('订单确认');}});
 phone.observation={id:'old'};
 await assert.rejects(phone.observeStable('t',{signal:abort.signal}),e=>e.code==='cancelled');
 assert.equal(phone.observation,null);
});

test('aborting a hanging local OCR read does not publish a stale screen',async()=>{
 const abort=new AbortController();const {phone}=fixture([frame('订单确认')],{recognize:async()=>new Promise(()=>{})});
 setTimeout(()=>abort.abort(),5);
 await assert.rejects(phone.observeStable('t',{signal:abort.signal}),e=>e.code==='cancelled');assert.equal(phone.observation,null);
});



test('the acquisition deadline ends changing frames before another capture starts',async()=>{
 let f;f=fixture([frame('旧菜单'),frame('新菜单')],{wait:async()=>f.advance(8100)});
 const m=meta(await f.phone.observeStable('t'));assert.equal(m.stability,'uncertain');assert.equal(m.reason,'stability_timeout');assert.equal(m.attempts,1);assert.equal(m.observationId,undefined);assert.equal(f.phone.observation,null);
});

test('incidental image animation does not prevent aligned material text from settling after idle timeout',async()=>{
 const {phone}=fixture([frame('订单确认',{token:'广告1'}),frame('订单确认',{token:'广告2'}),frame('订单确认',{token:'广告3'})],{idle:false});baseline(phone,frame('旧菜单'));
 const m=meta(await phone.observeAfterAction('t'));assert.equal(m.stability,'stable');assert.equal(m.attempts,3);assert.equal(m.changedSinceAction,true);
});


function homeFrame(ad='活动一',extra={}){
 const f=frame('淘宝首页',extra);
 f.ocr.lines=[
  {id:'nav-flash',text:'闪购',bounds:[40,160,130,220],center:{x:85,y:190}},
  {id:'nav-search',text:'搜索',bounds:[740,160,900,220],center:{x:820,y:190}},
  {id:'product',text:'招牌牛肉面',bounds:[40,650,500,730],center:{x:270,y:690}},
  {id:'ad',text:ad,bounds:[100,1000,700,1080],center:{x:400,y:1040}},
  {id:'cart',text:'立即抢购',bounds:[640,2100,910,2220],center:{x:775,y:2160}}
 ];return f;
}
test('native ad node changes alone do not block fully stable visible material content',async()=>{
 const {phone}=fixture([frame('列表',{tree:tree('View "活动一" bounds=0,1000,800,1500')}),frame('列表',{tree:tree('View "活动二" bounds=0,1000,800,1500')})]);
 const m=meta(await phone.observeStable('t'));assert.equal(m.stability,'stable');assert.equal(m.stabilityScope,'full');assert.equal(m.attempts,2);
});
test('changing lower ads produce a narrow header-navigation observation after two samples',async()=>{
 const {phone}=fixture([homeFrame('活动一 ¥10',{tree:tree('View "活动一" bounds=0,1000,800,1500')}),homeFrame('活动二 ¥11',{tree:tree('View "活动二" bounds=0,1000,800,1500')})]);
 const m=meta(await phone.observeStable('t'));assert.equal(m.stability,'stable');assert.equal(m.stabilityScope,'navigation');assert.equal(m.attempts,2);
 assert.deepEqual(m.stableTargetIds,['nav-search']);assert.deepEqual(m.textTargets.map(n=>n.id),m.stableTargetIds);
 assert.equal(phone.observation.stabilityScope,'navigation');assert.equal(phone.observation.ocr.lines.length,5);
 phone.observation.at=Date.now();
 for(const args of [{action:'tap',textTargetId:'product'},{action:'tap',textTargetId:'cart'},{action:'tap',x:80,y:180},{action:'type',text:'牛肉面'},{action:'back'},{action:'swipe',x1:100,y1:900,x2:100,y2:500}])await assert.rejects(phone.act('t',{observationId:m.observationId,...args}),e=>e.code==='navigation_only');
 assert.equal(phone.observation.id,m.observationId);
 await phone.act('t',{observationId:m.observationId,action:'tap',textTargetId:'nav-search'});
 assert.equal(phone.observation,null);
});
test('navigation fallback cannot cross moved controls, native dialogs or payment/account pages',async()=>{
 for(const mode of ['moving','dialog','static_dialog','checkout','context']){
  const frames=Array.from({length:5},(_,i)=>{
   const f=homeFrame('活动'+i);
   if(mode==='moving')for(const line of f.ocr.lines.slice(0,2)){line.bounds=line.bounds.map(n=>n+i*10);line.center={x:line.center.x+i*10,y:line.center.y+i*10};}
   if(mode==='dialog')f.tree=tree(i%2?'Dialog bounds=0,0,968,1000':'');
   if(mode==='static_dialog')f.tree=tree('Dialog bounds=0,0,968,1000');
   if(mode==='checkout')f.ocr.lines.push({id:'checkout',text:'确认订单',bounds:[20,230,400,290],center:{x:210,y:260}});
   if(mode==='context')f.tree={content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:'com.taobao.taobao',windowPkg:'com.taobao.taobao',window:'window'+i,tree:'window pkg=com.taobao.taobao bounds=0,0,968,2376'}})}]};
   return f;
  });
  const {phone}=fixture(frames);const m=meta(await phone.observeStable('t'));
  assert.equal(m.stability,'uncertain',mode);assert.equal(m.observationId,undefined,mode);assert.equal(phone.observation,null,mode);
 }
});


test('a fresh native dialog blocks a restricted navigation tap even when OCR header text is unchanged',async()=>{
 const {phone,calls}=fixture([homeFrame('活动一'),homeFrame('活动二'),homeFrame('活动三',{tree:tree('Dialog bounds=0,0,968,1000')})]);
 const m=meta(await phone.observeStable('t'));assert.equal(m.stabilityScope,'navigation');phone.observation.at=Date.now();
 await assert.rejects(phone.act('t',{observationId:m.observationId,action:'tap',textTargetId:'nav-search'}),/发生变化/);assert.equal(calls.some(c=>c.name==='tap'),false);
});

test('purchase browsing uses a fresh native frame without waiting for every lower advertisement to stop',async()=>{
 const {phone}=fixture([frame('搜索发现')]);let captures=0;
 phone.phoneUse={client:{remoteTransport:{}}};phone.captureStableFrame=async()=>{captures++;return {tree:tree('View bounds=0,300,968,1800'),ocr:ocr('搜索发现'),native:{deviceId:'phone',observationId:'native:'+captures,packageName:'com.taobao.taobao'},aligned:true,imageHash:'changing-ad-'+captures};};
 const grant={taskId:'t',platform:'taobao',query:'星巴克咖啡',payment:'user',goal:'checkout'};
 const out=await phone.observePurchase('t',grant),m=meta(out);assert.equal(captures,1);assert.equal(m.stabilityScope,'purchase');assert.equal(m.stability,'fresh');assert.equal(m.requiresFullObservationFor,'quotes,checkout');assert.ok(m.observationId);
 phone.captureStableFrame=async()=>({tree:tree().content?{content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:'com.tencent.mm',windowPkg:'com.tencent.mm',tree:'window pkg=com.tencent.mm bounds=0,0,968,2376'}})}]}:null,ocr:ocr('搜索发现'),aligned:true});
 assert.equal(meta(await phone.observePurchase('t',grant)).reason,'outside_task_scope');assert.equal(phone.observation,null);
});
test('full observation preserves a bounded diagnostic instead of swallowing the native failure',async()=>{
 const {phone}=fixture([]);phone.captureStableFrame=async()=>{throw Object.assign(Error('private internal details'),{code:'phoneuse_error',phoneuseCode:'NO_ACTIVE_WINDOW'});};
 const m=meta(await phone.observeStable('t'));assert.equal(m.failureCode,'NO_ACTIVE_WINDOW');assert.equal(JSON.stringify(m).includes('private internal'),false);
 phone.captureStableFrame=async()=>{throw Object.assign(Error('paused'),{code:'phone_control_paused'});};await assert.rejects(phone.observeStable('t'),{code:'phone_control_paused'});
});
