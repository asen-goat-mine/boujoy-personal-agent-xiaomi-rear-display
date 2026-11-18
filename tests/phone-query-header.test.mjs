import test from 'node:test';
import assert from 'node:assert/strict';
import {Phone} from '../src/adapters/phone.mjs';
import {Broker} from '../src/tools/broker.mjs';
import {classifyQueryAction} from '../src/adapters/phone-query.mjs';
import {sameTextTarget} from '../src/adapters/phone-ocr.mjs';

const grant={platform:'taobao',query:'牛肉面'};
const line=(id,text,bounds)=>({id,text,bounds,center:{x:Math.round((bounds[0]+bounds[2])/2),y:Math.round((bounds[1]+bounds[3])/2)}});
function native(body=''){return {content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:'com.taobao.taobao/Activity',windowPkg:'com.taobao.taobao',window:'0,0,968,2376',tree:'window pkg=com.taobao.taobao layer=0 bounds=0,0,968,2376\n'+body}})}]};}
function result(query='瑞幸美式'){
 return {tree:native(),ocr:{width:968,height:2376,lines:[
  line('field','全部• '+query,[155,128,458,173]),line('flash','闪购',[28,218,114,259]),
  line('item','招牌'+query,[40,620,520,680]),line('delivery','配送费 ¥0 起送 ¥10',[40,710,620,770]),line('delivery2','配送约30分钟 月销500',[40,800,620,860]),line('ad','活动价 ¥18',[40,1600,600,1680])
 ]}};
}
function input(query='瑞幸美式'){
 return {tree:native(),ocr:{width:968,height:2376,lines:[line('field','全部• '+query,[155,128,458,173]),line('search','搜索',[823,128,896,169]),line('history','历史搜索清空',[31,314,400,356])]}};
}
function strip(){return {tree:native(),ocr:{width:968,height:2376,lines:[
 line('nav','关注推荐',[41,120,231,166]),line('primary','闪购',[262,121,355,173]),line('primary-other','外卖',[369,121,448,162]),
 line('strip-scope','闪购•',[48,221,186,266]),line('keyword','瑞幸美式',[207,221,375,266]),line('strip-other','•外卖',[393,228,482,259]),line('search','搜索',[806,221,889,266]),line('my','我的闪购',[772,328,923,366]),line('ad','活动价 ¥18',[40,1600,600,1680])
 ]}};}
function observation(page){return {id:'o',taskId:'t',at:Date.now(),...page};}
const focus=id=>({observationId:'o',action:'tap',textTargetId:id,reason:'只聚焦用户本次餐品查询'});
const type={observationId:'o',action:'type',text:'牛肉面',inputMode:'replace'};

function transport(frames){
 const task={id:'t',status:'running',phoneQuery:grant,messages:[{role:'user',content:'帮我点一份牛肉面'}],quotes:[],kind:'general'},data={actions:[],artifacts:[]},commands=[];let index=0,approvals=0;
 const store={data,task:()=>task,event(){},transaction(fn){fn(data);},updateTask(id,fn){fn(task,data);return task;}};
 const phone=new Phone(store,{recognize:async image=>JSON.parse(Buffer.from(image.content[0].data,'base64').toString()).ocr,wait:async()=>{}});
 phone.call=async(name,args)=>{
  const current=frames[Math.min(index,frames.length-1)];
  if(name==='ui_tree')return current.tree;
  if(name==='screenshot')return {content:[{type:'image',mimeType:'image/png',data:Buffer.from(JSON.stringify({ocr:current.ocr})).toString('base64')}]};
  if(['tap','type','key'].includes(name)){commands.push({name,args});index++;return {content:[{type:'text',text:'{"ok":true}'}]};}
  throw Error('Unexpected fake transport call '+name);
 };
 const broker=new Broker({store,phone,approvals:{request:async()=>{approvals++;throw Error('No approval bypass in local search');}},browser:{},memory:{}});
 return {task,data,phone,broker,commands,get approvals(){return approvals;},changeNextRead(page){frames[index]=page;}};
}

test('real no-button result geometry permits field focus but never OCR-only replacement',()=>{
 const obs=observation(result());assert.equal(classifyQueryAction('t',focus('field'),obs,grant)?.kind,'search_focus');assert.equal(classifyQueryAction('t',type,obs,grant),null);
 const realInput=observation(input());assert.equal(classifyQueryAction('t',type,realInput,grant)?.kind,'search_input');assert.equal(classifyQueryAction('t',{...type,text:'另一个餐品'},realInput,grant),null);
});

test('split Flash search strip permits keyword focus and requires actual input or native search focus for typing',()=>{
 const obs=observation(strip());assert.equal(classifyQueryAction('t',focus('keyword'),obs,grant)?.kind,'search_focus');assert.equal(classifyQueryAction('t',type,obs,grant),null);
 obs.tree=native('  EditText "搜索框" editable focused bounds=200,210,700,280');assert.equal(classifyQueryAction('t',type,obs,grant)?.kind,'search_input');assert.equal(classifyQueryAction('t',{...type,text:'任意消息'},obs,grant),null);
});

test('header navigation ignores distant ad prices while local prices and payment/account context remain checked',()=>{
 for(const page of [result(),strip()]){
  const target=page.ocr.lines.find(n=>n.id===(page.ocr.lines.some(n=>n.id==='field')?'field':'keyword'));
  const ads=structuredClone(page.ocr);ads.lines.find(n=>n.id==='ad').text='新活动 ¥25';assert.equal(sameTextTarget(page.ocr,ads,target),true);
  const local=structuredClone(page.ocr);local.lines.push(line('near-amount','¥25',[target.bounds[2]+8,target.bounds[1],target.bounds[2]+48,target.bounds[3]]));assert.equal(sameTextTarget(page.ocr,local,target),false);
  const payment=structuredClone(page.ocr);payment.lines.push(line('payment','立即支付 ¥25',[600,1950,920,2100]));assert.equal(sameTextTarget(page.ocr,payment,target),false);
  const account=structuredClone(page.ocr);account.lines.push(line('otp','输入验证码',[100,700,700,800]));assert.equal(sameTextTarget(page.ocr,account,target),false);
 }
});

test('a native purchase hit or changed overlay still blocks a valid-looking header field',async()=>{
 const blocked=observation(result());blocked.tree=native('  Button "立即支付" clickable bounds=100,100,700,230');assert.equal(classifyQueryAction('t',focus('field'),blocked,grant),null);
 const f=transport([result()]);const first=JSON.parse((await f.phone.observeQuery('t',grant)).content[0].text);
 const overlay=result();overlay.tree=native('Dialog bounds=0,0,968,1000');f.changeNextRead(overlay);
 await assert.rejects(f.phone.act('t',{...focus('field'),observationId:first.observationId},{queryGrant:grant}));assert.equal(f.commands.length,0);
});

test('actual Phone and Broker leave no-button query changes to explicit single model actions',async()=>{
 const f=transport([result(),input(),input('牛肉面'),result('牛肉面')]);
 const out=await f.broker.execute('t','phone_search',{},new AbortController().signal),summary=JSON.parse(out.content[0].text).search;
 assert.equal(summary.needsModel,true);assert.equal(summary.actions,0);assert.equal(f.commands.length,0);
 for(const action of [{action:'tap',targetId:'field'},{action:'type',text:'牛肉面',inputMode:'replace'},{action:'tap',targetId:'search'}])await f.broker.execute('t','phone_use',action,new AbortController().signal);
 assert.equal(f.approvals,0);assert.deepEqual(f.commands.map(c=>c.name),['tap','type','tap']);assert.deepEqual(f.commands[1].args,{text:'牛肉面',mode:'replace',display:'main'});
 assert.equal(f.data.actions.length,3);assert.ok(f.data.actions.every(a=>a.status==='completed'&&a.authorization==='query_scope'));
 assert.equal(f.phone.observation.stabilityScope,'query');assert.equal(f.phone.observation.queryGrant.query,'牛肉面');
});

test('actual Phone focus tolerates distant ad change and reclassifies the latest split search strip',async()=>{
 const f=transport([strip(),input()]),first=JSON.parse((await f.phone.observeQuery('t',grant)).content[0].text);
 const changed=strip();changed.ocr.lines.find(n=>n.id==='ad').text='活动价 ¥99';f.changeNextRead(changed);
 await f.phone.act('t',{...focus('keyword'),observationId:first.observationId},{queryGrant:grant});assert.equal(f.commands.length,1);assert.equal(f.commands[0].name,'tap');assert.equal(f.commands[0].args.x,291);
});

test('payment screen introduced during header focus is refused by the actual Phone fresh guard',async()=>{
 const f=transport([result()]),first=JSON.parse((await f.phone.observeQuery('t',grant)).content[0].text);
 const changed=result();changed.ocr.lines.push(line('payment','支付密码',[200,800,700,860]));f.changeNextRead(changed);
 await assert.rejects(f.phone.act('t',{...focus('field'),observationId:first.observationId},{queryGrant:grant}));assert.equal(f.commands.length,0);
});
