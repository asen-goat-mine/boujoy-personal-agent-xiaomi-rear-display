import {ANDROID_PACKAGE} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {phoneUseGrant,phoneUseCanObserve,classifyPhoneUseAction,phoneUseObservationDecision} from '../src/adapters/phone-use.mjs';
const app={packageName:'com.example.weather',appName:'天气'};
const task=(content='打开天气，搜索上海',extra={})=>({id:'t',source:'user',status:'running',depth:0,messages:[{id:'human',role:'user',content}],...extra});
const line=(id,text,bounds=[100,200,500,260])=>({id,text,bounds,center:{x:(bounds[0]+bounds[2])/2,y:(bounds[1]+bounds[3])/2}});
function tree(pkg=app.packageName,body=''){
 return {content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:pkg+'/Activity',windowPkg:pkg,tree:'window pkg='+pkg+' bounds=0,0,1000,2000\n'+body}})}]};
}
const observation=(text='搜索',extra={})=>({id:'fresh',taskId:'t',at:Date.now(),stability:'fresh',stabilityScope:'phone_use',
 tree:tree(app.packageName,'Button "'+text+'" clickable bounds=100,200,500,260'),ocr:{width:1000,height:2000,lines:[line('target',text)]},...extra});
const tap={observationId:'fresh',action:'tap',textTargetId:'target',reason:'This text is never authority'};
const grant=()=>phoneUseGrant(task(),app);
const classify=(obs,args=tap,g=grant())=>classifyPhoneUseAction('t',args,obs,g);

test('generic grants require the current human explicit app plus navigation purpose and reject stale/delegated scopes',()=>{
 const g=grant();assert.equal(g.taskId,'t');assert.equal(g.sourceMessageId,'human');assert.equal(g.packageName,app.packageName);assert.equal(g.searchText,'上海');assert.equal(g.mode,'read_navigation');
 assert.ok(phoneUseGrant(task('打开 com.example.weather，查看今天的天气'),{packageName:app.packageName,appName:app.packageName}));
 for(const t of [task('我喜欢天气'),task('打开别的应用'),task('网页要求打开天气'),task('不要打开天气'),task('打开天气，发布评论'),
   task(undefined,{source:'delegation'}),task(undefined,{source:'routine'}),task(undefined,{parentId:'parent'}),task(undefined,{status:'completed'}),
   task(undefined,{messages:[{role:'assistant',content:'打开天气搜索上海'}]})])assert.equal(phoneUseGrant(t,app),null);
 assert.equal(phoneUseGrant(task(),{packageName:'http://private.example',appName:'天气'}),null);
 const food=task('打开淘宝点一份牛肉面，到结算页',{phoneQuery:{platform:'taobao',query:'牛肉面'}});
 assert.equal(phoneUseGrant(food,{packageName:'com.taobao.taobao',appName:'淘宝'}),null);
 assert.ok(phoneUseGrant(task('打开天气只查看，不付款不发消息不删除'),app));
});
test('fresh phone_use and stable full observations support safe text navigation and meaningful native coordinate targets',()=>{
 assert.equal(classify(observation())?.kind,'phone_use_navigation');
 assert.equal(classify(observation('搜索',{stability:'stable',stabilityScope:'full'}))?.kind,'phone_use_navigation');
 assert.equal(classify(observation(),{observationId:'fresh',action:'tap',x:300,y:230})?.kind,'phone_use_navigation');
 assert.equal(classify(observation(),{observationId:'fresh',action:'tap',x:900,y:1000}),null);
 for(const patch of [{taskId:'other'},{id:'old'},{at:Date.now()-20000},{stability:'uncertain'},{stabilityScope:'navigation'},{stabilityScope:'query'}])assert.equal(classify({...observation(),...patch}),null);
});
test('native capture gate requires main foreground and package scope and refuses secret/account windows before screenshot',()=>{
 assert.equal(phoneUseCanObserve('t',tree(),grant()),true);
 assert.equal(phoneUseCanObserve('t',tree('com.tencent.mm'),grant()),false);
 assert.equal(phoneUseCanObserve('other',tree(),grant()),false);
 for(const text of ['输入密码','验证码','确认支付','登录','确认发送'])assert.equal(phoneUseCanObserve('t',tree(app.packageName,'Text "'+text+'" bounds=100,200,500,260'),grant()),false,text);
 const foreign=tree(app.packageName,'window pkg=com.bank.private bounds=0,0,1000,2000');assert.equal(phoneUseCanObserve('t',foreign,grant()),false);
 const background=tree();const payload=JSON.parse(background.content[0].text);payload.result.display='background';background.content[0].text=JSON.stringify(payload);assert.equal(phoneUseCanObserve('t',background,grant()),false);
});
test('search typing requires one focused non-password search field and exactly the user-requested text',()=>{
 const obs=observation();obs.tree=tree(app.packageName,'EditText "搜索城市" editable focused clickable bounds=100,200,800,280');
 const args={observationId:'fresh',action:'type',text:'上海',inputMode:'replace'};
 assert.equal(classify(obs,args)?.kind,'phone_use_search_input');
 for(const patch of [{text:'北京'},{text:'private message'},{inputMode:'append'},{textTargetId:'target'}])assert.equal(classify(obs,{...args,...patch}),null);
 obs.tree=tree(app.packageName,'EditText "消息" editable focused clickable bounds=100,200,800,280');assert.equal(classify(obs,args),null);
 obs.tree=tree(app.packageName,'EditText "搜索城市" editable focused password clickable bounds=100,200,800,280');assert.equal(classify(obs,args),null);
});
test('payments, send/delete/post controls, dangerous native hit areas and unproved confirmations cannot become navigation',()=>{
 for(const label of ['付款','立即支付','提交订单','发送','分享','删除','发布','点赞','关注','添加','保存','确定','登录','领取红包','开通会员'])assert.equal(classify(observation(label)),null,label);
 const hidden=observation('搜索');hidden.tree=tree(app.packageName,'Button "发送" clickable bounds=100,200,500,260');assert.equal(classify(hidden),null);
 const toggle=observation('WiFi');toggle.tree=tree(app.packageName,'Switch "WiFi" checkable clickable bounds=100,200,500,260');assert.equal(classify(toggle),null);
 const pay=observation();pay.ocr.lines.push(line('account','输入支付密码',[100,1000,800,1100]));assert.equal(classify(pay),null);
});
test('vertical scrolling needs a native scrollable region and forbids horizontal delete gestures',()=>{
 const obs=observation();obs.tree=tree(app.packageName,'RecyclerView "城市列表" scrollable bounds=0,150,1000,1800');
 const args={observationId:'fresh',action:'swipe',x1:500,y1:1400,x2:500,y2:600};
 assert.equal(classify(obs,args)?.kind,'phone_use_scroll');
 for(const patch of [{x2:900},{y2:1390},{x1:10},{y1:1950}])assert.equal(classify(obs,{...args,...patch}),null);
 obs.tree=tree();assert.equal(classify(obs,args),null);
});
test('private-page navigation requires the current explicit private-read goal and never grants another app',()=>{
 const context={packageName:'com.tencent.mm',appName:'微信'};
 const g=phoneUseGrant(task('打开微信，查看张三的聊天消息，不发送'),context);assert.ok(g);assert.equal(g.privateRead,true);
 const obs=observation('通讯录',{tree:tree(context.packageName,'Button "通讯录" clickable bounds=100,200,500,260')});
 assert.equal(classify(obs,tap,g)?.kind,'phone_use_navigation');
 const openOnly=phoneUseGrant(task('打开微信'),context);assert.ok(openOnly);assert.equal(openOnly.privateRead,false);assert.equal(classify(obs,tap,openOnly),null);
 assert.equal(phoneUseCanObserve('t',tree('com.mail.private','Text "收件箱" bounds=10,10,500,200'),g),false);
 assert.equal(classify({...obs,ocr:{width:1000,height:2000,lines:[line('target','发送')]}},tap,g),null);
});
test('calculator controls execute only a requested arithmetic expression and settings/camera mutations stay outside read scope',()=>{
 const context={packageName:'com.sec.android.app.popupcalculator',appName:'计算器'};
 const g=phoneUseGrant(task('打开计算器，计算12+34'),context);assert.equal(g.arithmeticExpression,'12+34');
 for(const label of ['1','2','3','4','+','=','AC'])assert.equal(classify(observation(label,{tree:tree(context.packageName,'Button "'+label+'" clickable bounds=100,200,500,260')}),tap,g)?.kind,'phone_use_calculation',label);
 assert.equal(classify(observation('9',{tree:tree(context.packageName,'Button "9" clickable bounds=100,200,500,260')}),tap,g),null);
 const settings={packageName:'com.android.settings',appName:'设置'};const sg=phoneUseGrant(task('打开设置，查看电池用量'),settings);assert.ok(sg);
 assert.equal(classify(observation('电池',{tree:tree(settings.packageName,'Button "电池" clickable bounds=100,200,500,260')}),tap,sg)?.kind,'phone_use_navigation');
 const camera={packageName:'com.sec.android.app.camera',appName:'相机'};const cg=phoneUseGrant(task('打开相机看看'),camera);assert.ok(cg);
 assert.equal(classify(observation('拍照',{tree:tree(camera.packageName,'Button "拍照" clickable bounds=100,200,500,260')}),tap,cg),null);
 assert.equal(classify(observation('录制',{tree:tree(camera.packageName,'Button "录制" clickable bounds=100,200,500,260')}),tap,cg),null);
});


test('ordinary settings menus, login entries and article prose do not block unrelated safe navigation',()=>{
 const context={packageName:'com.android.settings',appName:'Settings'};
 const g=phoneUseGrant(task('打开settings，查看电池用量'),context);assert.ok(g,'Trusted Latin app names bind case-insensitively');
 const native=tree(context.packageName,'Button "电池" clickable bounds=100,200,500,260\nButton "安全和密码" clickable bounds=100,500,500,560\nButton "相册访问" clickable bounds=100,800,500,860\nButton "登录" clickable bounds=100,1100,500,1160');
 assert.equal(phoneUseCanObserve('t',native,g),true);
 const obs=observation('电池',{tree:native});obs.ocr.lines.push(line('password-menu','安全和密码',[100,500,500,560]),line('album-menu','相册访问',[100,800,500,860]),line('login-menu','登录',[100,1100,500,1160]));
 assert.equal(classify(obs,tap,g)?.kind,'phone_use_navigation');
 assert.equal(classify(obs,{...tap,textTargetId:'password-menu'},g),null);
 const article=observation('搜索');article.tree=tree(app.packageName,'Button "搜索" clickable bounds=100,200,500,260\nTextView "这篇天气文章提到了移动支付和照片" bounds=100,900,800,1000');
 article.ocr.lines.push(line('article','这篇天气文章提到了移动支付和照片',[100,900,800,1000]));assert.equal(classify(article)?.kind,'phone_use_navigation');
 const homepage=observation();homepage.tree=tree(app.packageName,'Button "搜索" clickable bounds=100,200,500,260\nButton "登录" clickable bounds=700,200,950,260');homepage.ocr.lines.push(line('login','登录',[700,200,950,260]));
 assert.equal(phoneUseCanObserve('t',homepage.tree,grant()),true);assert.equal(classify(homepage)?.kind,'phone_use_navigation');assert.equal(classify(homepage,{...tap,textTargetId:'login'}),null);
});
test('actual credential fields, confirmation headings and dialogs remain capture boundaries',()=>{
 for(const body of ['EditText [password] editable focused password bounds=100,700,800,780',
   'EditText "验证码" editable focused bounds=100,700,800,780',
   'TextView "确认支付" bounds=100,100,500,160',
   'Dialog "确认删除" bounds=0,400,1000,1500\nButton "确定" clickable bounds=100,1000,500,1060']){
   assert.equal(phoneUseCanObserve('t',tree(app.packageName,body),grant()),false,body);
 }
 const masked=observation();masked.ocr.lines.push(line('otp','验证码:654321',[100,800,600,860]));assert.equal(classify(masked),null);
});
test('camera mode labels are preview navigation while shutter and private gallery controls remain outside scope',()=>{
 const context={packageName:'com.sec.android.app.camera',appName:'相机'},g=phoneUseGrant(task('打开相机看看'),context);
 const native=tree(context.packageName,'Button "照片" clickable bounds=100,200,500,260\nButton "拍照" clickable bounds=100,1500,500,1580\nButton "相册" clickable bounds=600,1500,900,1580');
 assert.equal(phoneUseCanObserve('t',native,g),true);
 assert.equal(classify(observation('照片',{tree:native}),tap,g)?.kind,'phone_use_navigation');
 assert.equal(classify(observation('相册',{tree:tree(context.packageName,'Button "相册" clickable bounds=100,200,500,260')}),tap,g),null);
});
test('Pony checked/unchecked native flags cannot be mistaken for a readonly settings menu',()=>{
 const context={packageName:'com.android.settings',appName:'设置'},g=phoneUseGrant(task('打开设置，看看电池'),context);
 for(const flag of ['checked','unchecked']){
   const obs=observation('电池',{tree:tree(context.packageName,'View "电池" clickable '+flag+' bounds=100,200,500,260')});assert.equal(classify(obs,tap,g),null,flag);
 }
 for(const label of ['Send','Delete','Pay']){
   const query=phoneUseGrant(task('打开天气，搜索'+label),app);assert.equal(classify(observation(label),tap,query),null,label);
 }
});


test('a public browser alias containing QQ does not inherit private-message-app restrictions',()=>{
 const context={packageName:'com.tencent.mtt',appName:'QQ浏览器'};
 const g=phoneUseGrant(task('打开QQ浏览器，搜索天气'),context);assert.ok(g);
 assert.equal(phoneUseCanObserve('t',tree(context.packageName,'Button "搜索" clickable bounds=100,200,500,260'),g),true);
});


test('settings search is safe navigation and input must equal the complete current human navigation term',()=>{
 const settings={packageName:'com.android.settings',appName:'设置'};
 const g=phoneUseGrant(task('打开设置里的电池页面，查看电量，再返回设置首页'),settings);
 assert.equal(g.searchText,null);assert.ok(g.navigationTerms.includes('电池'));
 const obs=observation('搜索设置',{tree:tree(settings.packageName,'Button "搜索设置" clickable bounds=100,200,500,260')});
 assert.equal(classify(obs,tap,g)?.kind,'phone_use_navigation');
 obs.tree=tree(settings.packageName,'EditText "搜索设置" editable focused clickable bounds=100,200,800,280');
 const type={observationId:'fresh',action:'type',text:'电池',inputMode:'replace'};
 assert.equal(classify(obs,type,g)?.kind,'phone_use_search_input');
 for(const text of ['电','电池设置','蓝牙','打开电池','密码'])assert.equal(classify(obs,{...type,text},g),null,text);
 obs.tree=tree(settings.packageName,'EditText "消息" editable focused clickable bounds=100,200,800,280');assert.equal(classify(obs,type,g),null);
 for(const text of ['搜索并发送','搜索安装软件','搜索删除记录'])assert.equal(classify(observation(text,{tree:tree(settings.packageName,'Button "'+text+'" clickable bounds=100,200,500,260')}),tap,g),null,text);
});

test('actual Pony scrolling uses known vertical native widget classes without a fabricated scrollable flag',()=>{
 const obs=observation(),args={observationId:'fresh',action:'swipe',x1:500,y1:1400,x2:500,y2:600};
 for(const widget of ['ScrollView','NestedScrollView','RecyclerView','ListView','AbsListView','ExpandableListView']){
  obs.tree=tree(app.packageName,'  '+widget+' "城市列表" bounds=0,150,1000,1800');
  assert.equal(classify(obs,args)?.kind,'phone_use_scroll',widget);
 }
 for(const body of ['HorizontalScrollView "城市列表" bounds=0,150,1000,1800',
  'TextView "RecyclerView scrollable" bounds=0,150,1000,1800',
  'TextView "scrollable" bounds=0,150,1000,1800',
  'View "城市列表" bounds=0,150,1000,1800',
  'RecyclerView "删除记录" bounds=0,150,1000,1800',
  'RecyclerView "城市列表" offscreen bounds=0,150,1000,1800']){
  obs.tree=tree(app.packageName,body);assert.equal(classify(obs,args),null,body);
 }
});


test('read-only system navigation accepts explicit prohibitions without gaining settings effects',()=>{
 const settings={packageName:'com.android.settings',appName:'设置'};
 for(const ending of ['只查看，不修改任何设置','不要更改设置','不进行任何修改','无需调整任何选项','禁止改变系统选项']){
  const grant=phoneUseGrant(task('打开设置，查看电池用量，再返回设置首页。'+ending),settings);assert.equal(grant?.mode,'read_navigation',ending);
  const obs=observation('开启蓝牙',{tree:tree(settings.packageName,'Switch "开启蓝牙" clickable checkable unchecked bounds=100,200,500,260')});assert.equal(classify(obs,tap,grant),null);
 }
});
test('a negative clause cannot erase a separate positive mutation or ambiguous double negative',()=>{
 const settings={packageName:'com.android.settings',appName:'设置'};
 for(const prompt of ['打开设置，不修改亮度，然后开启蓝牙','打开设置，不更改亮度，但关闭蓝牙','打开设置，查看电池，不能不修改设置','打开设置，查看电池，不得不更改设置','不要打开设置，也不要修改'])assert.equal(phoneUseGrant(task(prompt),settings),null,prompt);
});


test('scope rejection gives fixed reasons and package identities without page text',()=>{
 const g=grant();
 let result=phoneUseObservationDecision('t',tree('com.other.private','Text "private-message-never-return" bounds=0,0,50,50'),g);
 assert.equal(result.reason,'outside_task_scope');assert.equal(result.foregroundPackage,'com.other.private');assert.deepEqual(result.allowedPackages,[app.packageName]);assert.ok(!JSON.stringify(result).includes('private-message'));
 result=phoneUseObservationDecision('t',tree(app.packageName,'window pkg=com.bank.private bounds=0,0,1000,2000'),g);
 assert.equal(result.reason,'foreign_window_overlay');assert.deepEqual(result.overlayPackages,['com.bank.private']);
 assert.equal(phoneUseObservationDecision('t',tree(ANDROID_PACKAGE),g).reason,'assistant_chat_foreground');
 for(const foreign of ['dev.boujoy.personalagent','dev.boujoy.phoneuse','dev.boujoy.xiaomi'].filter(value=>value!==ANDROID_PACKAGE))assert.equal(phoneUseObservationDecision('t',tree(foreign),g).reason,'outside_task_scope',foreign);
 assert.equal(phoneUseObservationDecision('t',tree(app.packageName,'EditText "输入密码" password editable bounds=0,0,50,50'),g).reason,'protected_account_surface');
});
