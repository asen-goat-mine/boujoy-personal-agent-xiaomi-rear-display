import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyQueryAction,queryGrant,queryGrantFromPrompt} from '../src/adapters/phone-query.mjs';
import {Phone} from '../src/adapters/phone.mjs';
import {Broker} from '../src/tools/broker.mjs';
const grant={platform:'taobao',query:'冰美式'};
function fixture(label='标准 美式'){
 const tree={content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:'com.taobao.taobao/Activity',windowPkg:'com.taobao.taobao',window:'0,0,968,2376',tree:'window pkg=com.taobao.taobao layer=0 bounds=0,0,968,2376\n  Button "'+label+'" clickable bounds=100,700,500,800'}})}]};
 const ocr={width:968,height:2376,lines:[{id:'text-1',text:label,bounds:[110,720,480,780],center:{x:295,y:750}},{id:'text-2',text:'杯型',bounds:[100,850,300,900],center:{x:200,y:875}}]};
 return {id:'o',taskId:'t',at:Date.now(),tree,ocr};
}
const tap={observationId:'o',action:'tap',textTargetId:'text-1',reason:'只是查看'};
test('query navigation is scoped to task, live observation, app and item',()=>{
 assert.ok(classifyQueryAction('t',tap,fixture(),grant));
 for(const [id,args,obs,g] of [['other',tap,fixture(),grant],['t',tap,fixture(),null],['t',{...tap,observationId:'old'},fixture(),grant],['t',tap,{...fixture(),at:0},grant],['t',tap,fixture('其他商品'),grant]])assert.equal(classifyQueryAction(id,args,obs,g),null);
 const other=fixture();other.tree.content[0].text=other.tree.content[0].text.replaceAll('com.taobao.taobao','com.other');assert.equal(classifyQueryAction('t',tap,other,grant),null);
});
test('purchase, cart, messages, benefits and arbitrary coordinate targets still require approval',()=>{
 for(const label of ['立即抢购','美式加入购物车','确认付款','领取红包','发送','开通会员','提交订单','选好了','收货地址'])assert.equal(classifyQueryAction('t',tap,fixture(label),grant),null,label);
 assert.equal(classifyQueryAction('t',{...tap,textTargetId:undefined,x:295,y:750},fixture(),grant),null);
 const obs=fixture();obs.tree.content[0].text=obs.tree.content[0].text.replace('标准 美式','美式 立即购买');assert.equal(classifyQueryAction('t',tap,obs,grant),null);
});
test('specification options need product context; only the granted query can be typed into a search field',()=>{
 const obs=fixture();obs.ocr.lines.push({id:'ice',text:'冰',bounds:[100,1000,300,1050],center:{x:200,y:1025}});
 assert.equal(classifyQueryAction('t',{...tap,textTargetId:'ice'},obs,grant)?.kind,'product_spec');
 const edit=fixture('搜索');edit.tree.content[0].text=edit.tree.content[0].text.replace('Button','EditText').replace('clickable','editable focused clickable');
 assert.ok(classifyQueryAction('t',{observationId:'o',action:'type',text:'冰美式'},edit,grant));
 assert.equal(classifyQueryAction('t',{observationId:'o',action:'type',text:'任意消息'},edit,grant),null);
 edit.ocr.lines.push({text:'聊天'});assert.equal(classifyQueryAction('t',{observationId:'o',action:'type',text:'冰美式'},edit,grant),null);
});
test('auto-authorized action is reclassified on the current native screen before dispatch',async()=>{
 const obs=fixture();const calls=[];const phone=new Phone({data:{settings:{phoneEnabled:true}}},{recognize:async()=>obs.ocr});phone.observation=obs;
 phone.call=async(name)=>{calls.push(name);return name==='ui_tree'?{content:[{type:'text',text:obs.tree.content[0].text.replace('标准 美式','美式 立即购买')}]}:{content:[]};};
 await assert.rejects(phone.act('t',tap,{queryGrant:grant}),e=>e.code==='query_scope_changed');assert.equal(calls.includes('tap'),false);
});
test('broker skips waits only for verified query actions, records authority, and forwards scope for recheck',async()=>{
 const task={id:'t',status:'running',phoneQuery:grant},data={actions:[]};let waits=0,received;
 const store={data,task:()=>task,event(){},transaction(fn){fn(data);},updateTask(id,fn){fn(task,data);}};
 const phone={queryAction:(id,args,g)=>classifyQueryAction(id,args,fixture(),g),act:async(id,args,opts)=>{received=opts.queryGrant;return {ok:true};},observe:async()=>({content:[{type:'text',text:JSON.stringify({observationId:'next'})}]})};
 const broker=new Broker({store,phone,approvals:{request:async()=>{waits++;}}});broker.evidence.set('o',{taskId:'t'});
 await broker.execute('t','phone_action',tap);assert.equal(waits,0);assert.deepEqual(received,grant);assert.equal(data.actions[0].authorization,'query_scope');
 await broker.execute('t','phone_action',{observationId:'o',action:'tap',x:500,y:200,reason:'Synthetic coordinate'});assert.equal(waits,1);assert.equal(received,null);assert.equal(data.actions[1].authorization,'approval');
});
test('grants accept only supported platform and bounded user query',()=>{
 assert.deepEqual(queryGrant(grant),grant);assert.equal(queryGrant(null),null);
 for(const g of [{platform:'other',query:'美式'},{platform:'taobao',query:''},{platform:'taobao',query:'a'.repeat(81)}])assert.throws(()=>queryGrant(g));
});

test('a bottom cart tab does not turn a search page into a transaction page',()=>{
 const obs=fixture();obs.ocr.lines.push({text:'购物车',bounds:[600,2150,780,2250]});assert.ok(classifyQueryAction('t',tap,obs,grant));
 obs.ocr.lines.at(-1).bounds=[100,130,400,200];assert.equal(classifyQueryAction('t',tap,obs,grant),null);
});

test('native search placeholder accepts focus without granting arbitrary coordinate taps',()=>{
 const obs=fixture('搜索栏');const args={observationId:'o',action:'tap',x:295,y:750};assert.equal(classifyQueryAction('t',args,obs,grant)?.kind,'search_focus');
 assert.equal(classifyQueryAction('t',{...args,y:850},obs,grant),null);
});
test('OCR ordinal drift is rebound to the verified fresh label before query recheck',async()=>{
 const obs=fixture();const calls=[];const fresh=structuredClone(obs.ocr);fresh.lines[0].id='text-9';fresh.lines[1].id='text-1';
 const phone=new Phone({data:{settings:{phoneEnabled:true}}},{recognize:async()=>fresh});phone.observation=obs;
 phone.call=async(name)=>{calls.push(name);return name==='ui_tree'?obs.tree:{content:[]};};
 await phone.act('t',tap,{queryGrant:grant});assert.ok(calls.includes('tap'));
});

test('Taobao custom search input requires the observed header and exact query',()=>{
 const obs=fixture();obs.ocr.lines=[{text:'全部 瑞幸美式',bounds:[155,128,448,173]},{text:'搜索',bounds:[823,128,896,169]},{text:'历史搜索',bounds:[31,314,179,356]}];
 const type={observationId:'o',action:'type',text:'冰美式'};assert.equal(classifyQueryAction('t',type,obs,grant)?.kind,'search_input');
 assert.equal(classifyQueryAction('t',{...type,text:'发送消息'},obs,grant),null);obs.ocr.lines.pop();assert.equal(classifyQueryAction('t',type,obs,grant)?.kind,'search_input');obs.ocr.lines.shift();assert.equal(classifyQueryAction('t',type,obs,grant),null);
});

test('merged flash-shopping label is recognized without accepting benefit buttons',()=>{
 assert.equal(classifyQueryAction('t',tap,fixture('闪购［外卖'),grant)?.kind,'query_navigation');
 assert.equal(classifyQueryAction('t',tap,fixture('闪购外卖领取红包'),grant),null);
});
test('explicit natural language queries enable the same scope without extra UI controls',()=>{
 for(const text of ['帮我在淘宝查一杯冰美式','淘宝闪购搜索“冰美式”','在淘宝查询冰美式的价格'])assert.deepEqual(queryGrantFromPrompt(text),grant);
 for(const text of ['继续吧','淘宝帮我下单冰美式','发消息给客服','在饿了么查冰美式','淘宝怎么搜索'])assert.equal(queryGrantFromPrompt(text),null);
});


test('invalid phone field combinations fail before approval or dispatch',async()=>{
 let acted=false;const broker=new Broker({store:{event(){}},phone:{act:async()=>{acted=true;}},approvals:{request:async()=>{acted=true;}}});
 for(const args of [{action:'type',text:'猪脚饭',textTargetId:'text-3'},{action:'tap',inputMode:'replace'},{action:'type',inputMode:'unsupported'}])await assert.rejects(broker.execute('t','phone_action',{observationId:'o',reason:'输入搜索词',...args}),e=>e.code==='invalid_input');
 assert.equal(acted,false);
});


test('old search keywords can be focused and replaced for arbitrary new meals',()=>{
 const obs=fixture();obs.ocr.lines=[{id:'input',text:'全部 冰美式',bounds:[155,128,448,173],center:{x:302,y:150}},{id:'search',text:'搜索',bounds:[823,128,896,169],center:{x:860,y:150}},{id:'old',text:'旧店铺 咖啡',bounds:[100,600,800,660],center:{x:450,y:630}}];
 for(const query of ['黄焖鸡米饭','酸菜鱼','麻辣烫']){
  const food={platform:'taobao',query};
  assert.equal(classifyQueryAction('t',{observationId:'o',action:'tap',textTargetId:'input'},obs,food)?.kind,'search_focus');
  assert.equal(classifyQueryAction('t',{observationId:'o',action:'tap',x:600,y:150},obs,food)?.kind,'search_focus');
  assert.equal(classifyQueryAction('t',{observationId:'o',action:'type',text:query,inputMode:'replace'},obs,food)?.kind,'search_input');
  assert.equal(classifyQueryAction('t',{observationId:'o',action:'tap',x:600,y:600},obs,food),null);
  assert.equal(classifyQueryAction('t',{observationId:'o',action:'type',text:'其他查询',inputMode:'replace'},obs,food),null);
 }
 const transaction=structuredClone(obs);transaction.ocr.lines.push({text:'确认订单',bounds:[100,700,400,750]});
 assert.equal(classifyQueryAction('t',{observationId:'o',action:'type',text:'黄焖鸡米饭',inputMode:'replace'},transaction,{platform:'taobao',query:'黄焖鸡米饭'}),null);
 const foreign=structuredClone(obs);foreign.tree.content[0].text=foreign.tree.content[0].text.replace('Button', 'window pkg=com.alipay layer=1 bounds=0,0,968,2376\n  Button');
 assert.equal(classifyQueryAction('t',{observationId:'o',action:'type',text:'黄焖鸡米饭',inputMode:'replace'},foreign,{platform:'taobao',query:'黄焖鸡米饭'}),null);
});

test('meal specifications use generic options only in the granted product context',()=>{
 const obs=fixture('黄焖鸡米饭');obs.ocr.lines[1].text='规格';obs.ocr.lines.push({id:'default',text:'默认',bounds:[100,1000,300,1050],center:{x:200,y:1025}});
 const food={platform:'taobao',query:'黄焖鸡米饭'};
 assert.equal(classifyQueryAction('t',{...tap,textTargetId:'default'},obs,food)?.kind,'product_spec');
 assert.equal(classifyQueryAction('t',{...tap,textTargetId:'default'},obs,{platform:'taobao',query:'酸菜鱼'}),null);
 obs.ocr.lines.at(-1).text='默认加入购物车';assert.equal(classifyQueryAction('t',{...tap,textTargetId:'default'},obs,food),null);
});

test('explicit negative purchase boundaries permit read-only meal queries, mixed positive requests do not',()=>{
 for(const [prompt,query] of [['在淘宝闪购搜索黄焖鸡米饭，只比较价格，不下单不付款','黄焖鸡米饭'],['在淘宝查一份酸菜鱼，不加购，不提交订单','酸菜鱼'],['淘宝闪购搜索“麻辣烫”，不要自动付款','麻辣烫'],['在淘宝闪购搜索猪脚饭只比较，不下单不付款','猪脚饭'],['在淘宝搜索冰粉不要下单不要付款','冰粉']])assert.deepEqual(queryGrantFromPrompt(prompt),{platform:'taobao',query});
 for(const prompt of ['淘宝搜索猪脚饭，先下单不用付款','淘宝搜索猪脚饭，不下单但付款','淘宝搜索猪脚饭，不付款但是提交订单','淘宝搜索猪脚饭，不能不付款','淘宝搜索猪脚饭，不是不要支付','淘宝搜索猪脚饭，不加购，领取红包','饿了么搜索黄焖鸡米饭，不下单不付款'])assert.equal(queryGrantFromPrompt(prompt),null,prompt);
});


test('cold and hot food names keep their full word instead of beverage normalization',()=>{
 for(const query of ['冰粉','热狗','热干面','冰淇淋'])assert.equal(classifyQueryAction('t',tap,fixture(query),{platform:'taobao',query})?.kind,'product_detail');
 assert.equal(classifyQueryAction('t',tap,fixture('干面'),{platform:'taobao',query:'热干面'}),null);
 assert.equal(classifyQueryAction('t',tap,fixture('标准美式'),{platform:'taobao',query:'冰美式'})?.kind,'product_detail');
});

test('plain discovery search headers and source query subterms work across category names without merchant dictionaries',()=>{
 for(const query of ['星巴克咖啡','鸡腿饭','寿司拼盘','水果酸奶','鲜花花束','洗发水']){
  const obs=fixture();obs.ocr.lines=[{id:'field',text:'椰子🥥',bounds:[155,128,400,173],center:{x:277,y:150}},{id:'go',text:'搜索',bounds:[823,128,896,173],center:{x:860,y:150}},{id:'discover',text:'搜索发现',bounds:[30,270,220,320]}];
  assert.equal(classifyQueryAction('t',{observationId:'o',action:'type',text:query,inputMode:'replace'},obs,{platform:'taobao',query})?.kind,'search_input',query);
  assert.equal(classifyQueryAction('t',{observationId:'o',action:'tap',textTargetId:'field'},obs,{platform:'taobao',query})?.kind,'search_focus',query);
  assert.equal(classifyQueryAction('t',{observationId:'o',action:'type',text:'别的任务'},obs,{platform:'taobao',query}),null);
 }
 const obs=fixture(),native=JSON.parse(obs.tree.content[0].text);native.result.tree=native.result.tree.replace('Button','EditText "搜索" editable focused');obs.tree.content[0].text=JSON.stringify(native);
 assert.equal(classifyQueryAction('t',{observationId:'o',action:'type',text:'星巴克'},obs,{platform:'taobao',query:'星巴克咖啡'})?.kind,'search_input');
});

test('the actual failed Starbucks screenshot header permits query replacement without an invented layout',()=>{
 const obs=fixture();obs.ocr=JSON.parse(fs.readFileSync(new URL('./fixtures/phone/real-discovery-header.json',import.meta.url),'utf8'));
 for(const query of ['星巴克咖啡','鸡腿饭','水果酸奶'])assert.equal(classifyQueryAction('t',{observationId:'o',action:'type',text:query,inputMode:'replace'},obs,{platform:'taobao',query})?.kind,'search_input',query);
});
