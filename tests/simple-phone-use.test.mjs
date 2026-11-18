import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSimplePhoneAction} from '../src/adapters/simple-phone-use.mjs';
import {phoneUseGrant,classifyPhoneUseAction} from '../src/adapters/phone-use.mjs';

const at=Date.now(),context={taskId:'t',now:at},pkg='com.android.settings';
const line=(id,text,bounds=[100,200,500,260])=>({id,text,bounds,center:{x:(bounds[0]+bounds[2])/2,y:(bounds[1]+bounds[3])/2}});
function tree(body='',{packageName=pkg,width=1000,height=2000}={}){
 return {content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',windowPkg:packageName,foreground:packageName+'/Activity',tree:`window pkg=${packageName} bounds=0,0,${width},${height}\n${body}`}})}]};
}
function observation(body='',lines=[],extra={}){
 return {id:'obs-current',taskId:'t',at,stability:'fresh',stabilityScope:'phone_use',tree:tree(body),ocr:{width:1000,height:2000,lines},...extra};
}
const build=(obs,args,options=context)=>buildSimplePhoneAction(obs,args,options);
const fails=(obs,args,code)=>assert.throws(()=>build(obs,args),error=>error.code===code);

test('tap resolves the unique exact normalized OCR target from the latest observation without rewriting evidence',()=>{
 const obs=observation('Button "电池" clickable bounds=100,200,500,260',[line('battery','电 池')]);
 const before=JSON.stringify(obs),args=build(obs,{action:'tap',target:' 电池 ',reason:'查看电量'});
 assert.deepEqual(args,{observationId:'obs-current',reason:'查看电量',action:'tap',x:300,y:230});assert.equal(JSON.stringify(obs),before);
 const width=observation('',[line('search','Ｓｅａｒｃｈ')]);assert.equal(build(width,{action:'tap',target:'Search'}).textTargetId,'search');
});
test('duplicate labels prefer the content area while invalid OCR geometry is rejected',()=>{
 const native='Button "电池" clickable bounds=100,200,500,260';
 assert.equal(build(observation('',[line('one','电池'),line('two','电池',[100,600,500,660])]),{action:'tap',target:'电池'}).textTargetId,'two');
 assert.equal(build(observation('',[line('one','电池用量')]),{action:'tap',target:'用量'}).textTargetId,'one');
 for(const bad of [{bounds:[0,0,0,10]},{center:{x:999,y:999}},{id:''}])fails(observation('',[{...line('one','电池'),...bad}]),{action:'tap',target:'电池'},'phone_target_missing');
});
test('native-only exact labels resolve physical coordinates rather than assuming a device or app layout',()=>{
 for(const bounds of [[80,180,900,300],[400,900,800,980],[160,360,1800,600]]){
  const obs=observation(`  Button "电池" clickable bounds=${bounds.join(',')}`);
  const args=build(obs,{action:'tap',target:'电池'});assert.equal(args.x,(bounds[0]+bounds[2])/2);assert.equal(args.y,(bounds[1]+bounds[3])/2);assert.equal(Object.hasOwn(args,'textTargetId'),false);
 }
 assert.equal(build(observation('Button "电池" clickable bounds=100,200,500,260\nButton "电池" clickable bounds=100,600,500,660'),{action:'tap',target:'电池'}).y,630);
 fails(observation('TextView "电池" bounds=100,200,500,260'),{action:'tap',target:'电池'},'phone_target_missing');
 fails(observation('Button "电池" clickable offscreen bounds=100,200,500,260'),{action:'tap',target:'电池'},'phone_target_missing');
});
test('native exact noninteractive leaf binds only to its real bounded clickable ancestor',()=>{
 const body='  LinearLayout "电池 电量99%" clickable bounds=80,180,950,300\n    TextView "电池" bounds=100,200,600,260\n    TextView "99%" bounds=700,200,900,260';
 const args=build(observation(body),{action:'tap',target:'电池'});assert.equal(args.x,350);assert.equal(args.y,230);
 // The duplicate leaf name and its own clickable parent describe one control.
 const duplicate='  Button "电池" clickable bounds=80,180,950,300\n    TextView "电池" bounds=100,200,600,260';
 assert.equal(build(observation(duplicate),{action:'tap',target:'电池'}).x,515);
 const unrelated='  LinearLayout "电池 电量99%" clickable bounds=80,180,950,300\n  TextView "电池" bounds=100,200,600,260';
 fails(observation(unrelated),{action:'tap',target:'电池'},'phone_target_missing');
 const outside='  LinearLayout "电池 电量99%" clickable bounds=80,180,950,300\n    TextView "电池" bounds=100,500,600,560';
 fails(observation(outside),{action:'tap',target:'电池'},'phone_target_missing');
});
test('native fallback refuses toggles, credential ancestors and unrelated effect descendants even outside target center',()=>{
 for(const suffix of ['Switch "WiFi" clickable checked bounds=800,200,900,260',
  'View "WiFi" clickable unchecked bounds=800,200,900,260',
  'EditText [password] editable password bounds=800,200,900,260',
  'Button "立即安装" clickable bounds=800,200,900,260']){
  const body='  LinearLayout "网络详情" clickable bounds=80,180,950,300\n    TextView "WiFi" bounds=100,200,600,260\n    '+suffix;
  fails(observation(body),{action:'tap',target:'WiFi'},'phone_target_missing');
 }
 const direct='  LinearLayout "WiFi" clickable bounds=80,180,950,300\n    Switch "WiFi" clickable unchecked bounds=800,200,900,260';
 fails(observation(direct),{action:'tap',target:'WiFi'},'phone_target_missing');
 for(const tag of ['Switch','CheckBox','ToggleButton','RadioButton'])fails(observation(`${tag} "电池" clickable bounds=100,200,500,260`),{action:'tap',target:'电池'},'phone_target_missing');
});
test('effect-scoped native row selection can avoid a distinct toggle, but never lands on it or enters a secret subtree',()=>{
 const safe='  View "09:00" "每天" clickable bounds=80,180,950,400\n    Switch "启用闹钟" clickable checked bounds=800,200,900,260';
 const args=build(observation(safe),{action:'tap',target:'09:00'},{...context,allowScopedControls:true});assert.equal(args.x,515);assert.equal(args.y,290);
 fails(observation(safe),{action:'tap',target:'09:00'},'phone_target_missing');
 for(const child of ['Switch "启用闹钟" clickable checked bounds=400,200,700,350','EditText "密码" editable password bounds=800,200,900,260'])assert.throws(()=>build(observation('  View "09:00" "每天" clickable bounds=80,180,950,400\n    '+child),{action:'tap',target:'09:00'},{...context,allowScopedControls:true}),e=>e.code==='phone_target_missing');
});
test('native fallback does not resolve foreign-window controls or widget words merely printed as text',()=>{
 const body='TextView "Button clickable 电池" bounds=100,200,500,260\nwindow pkg=com.private.other bounds=0,0,1000,2000\nButton "电池" clickable bounds=100,200,500,260';
 fails(observation(body),{action:'tap',target:'电池'},'phone_target_missing');
});
test('scroll down reveals lower content using bounds of the observed container and up reverses its gesture',()=>{
 const obs=observation('  RecyclerView "设置列表" bounds=0,150,1000,1800');
 const down=build(obs,{action:'scroll',direction:'down'}),up=build(obs,{action:'scroll',direction:'up'});
 assert.equal(down.action,'swipe');assert.equal(down.x1,500);assert.equal(down.x1,down.x2);assert.ok(down.y1>down.y2);
 assert.equal(up.y1,down.y2);assert.equal(up.y2,down.y1);
 assert.ok([down.y1,down.y2].every(y=>y>=300&&y<=1700));
 const larger=observation('  RecyclerView bounds=0,300,2000,3600',[],{tree:tree('  RecyclerView bounds=0,300,2000,3600',{width:2000,height:4000}),ocr:{width:2000,height:4000,lines:[]}});
 const gesture=build(larger,{action:'scroll',direction:'down'});assert.equal(gesture.x1,1000);assert.equal(gesture.y1,down.y1*2);assert.equal(gesture.y2,down.y2*2);
});
test('scroll selects the innermost list or largest observed pane',()=>{
 const nested='  NestedScrollView bounds=0,100,1000,1900\n    RecyclerView bounds=80,300,920,1600';
 const gesture=build(observation(nested),{action:'scroll',direction:'down'});assert.ok(gesture.y1<1600&&gesture.y2>300);
 for(const body of ['  RecyclerView bounds=0,150,480,1800\n  RecyclerView bounds=520,150,1000,1800',
  '  NestedScrollView bounds=0,100,1000,1900\n    RecyclerView bounds=0,150,480,1800\n    RecyclerView bounds=520,150,1000,1800'])assert.equal(build(observation(body),{action:'scroll',direction:'down'}).action,'swipe');
});
test('scroll requires actual vertical evidence, usable geometry and fresh scope rather than hardcoded coordinates',()=>{
 for(const name of ['ScrollView','NestedScrollView','ListView','AbsListView','ExpandableListView','androidx.recyclerview.widget.RecyclerView'])assert.equal(build(observation(`  ${name} bounds=0,150,1000,1800`),{action:'scroll',direction:'down'}).action,'swipe');
 assert.equal(build(observation('  View scrollable bounds=0,150,1000,1800'),{action:'scroll',direction:'down'}).action,'swipe');
 for(const body of ['HorizontalScrollView scrollable bounds=0,150,1000,1800',
  'TextView "RecyclerView scrollable" bounds=0,150,1000,1800',
  'View scrollable=false bounds=0,150,1000,1800',
  'RecyclerView offscreen bounds=0,150,1000,1800',
  'RecyclerView bounds=0,20,1000,120'])fails(observation(body),{action:'scroll',direction:'down'},'phone_scroll_unavailable');
 const missing=observation('  RecyclerView bounds=0,150,1000,1800',[],{ocr:null});assert.equal(build(missing,{action:'scroll',direction:'down'}).x1,500);
});
test('the helper requires a recent same-task actionable observation and never synthesizes an id or grant',()=>{
 const obs=observation();
 for(const patch of [{taskId:'other'},{id:''},{at:at-45001},{at:at+1001},{stability:'uncertain'},{stabilityScope:'unknown'}])fails({...obs,...patch},{action:'back'},'phone_observation_required');
 assert.throws(()=>buildSimplePhoneAction(obs,{action:'back'}),error=>error.code==='phone_observation_required');
 for(const extra of [{stability:'fresh',stabilityScope:'query'},{stability:'stable',stabilityScope:'full'},{stability:'stable',stabilityScope:'navigation'}])assert.equal(build({...obs,...extra},{action:'back'}).observationId,obs.id);
 assert.equal(build({...obs,at:at-45000},{action:'back'}).action,'back');
});
test('type and back normalize only the requested arguments without choosing text, focus or permissions',()=>{
 const obs=observation(),typed=build(obs,{action:'type',text:'电池',inputMode:'replace'});
 assert.equal(typed.text,'电池');assert.equal(typed.inputMode,'replace');assert.equal(typed.action,'type');assert.equal(Object.hasOwn(typed,'textTargetId'),false);
 assert.equal(build(obs,{action:'type',text:' A\nB '}).text,' A\nB ');assert.equal(build(obs,{action:'type',text:'x'}).inputMode,'replace');
 assert.deepEqual(Object.keys(build(obs,{action:'back'})).sort(),['action','observationId','reason']);
 for(const args of [{action:'type',text:''},{action:'type',text:42},{action:'type',text:'x',inputMode:'append'},{action:'scroll',direction:'left'},{action:'open_app'},{action:'back',reason:''},{action:'back',reason:12}])fails(obs,args,'invalid_input');
});
test('resolved transaction text grants no authority and existing classifiers still decide the business scope',()=>{
 const task={id:'t',source:'user',status:'running',depth:0,messages:[{id:'human',role:'user',content:'打开设置，查看电池'}]},grant=phoneUseGrant(task,{packageName:pkg,appName:'设置'});
 for(const label of ['加入购物车','去结算','立即付款']){
  const obs=observation(`Button "${label}" clickable bounds=100,200,500,260`,[line('actual',label)]),args=build(obs,{action:'tap',target:label});
  assert.equal(args.x,300);assert.equal(Object.hasOwn(args,'grant'),false);assert.equal(Object.hasOwn(args,'authorization'),false);assert.equal(classifyPhoneUseAction('t',args,obs,grant),null,label);
  const native=build(observation(`Button "${label}" clickable bounds=100,200,500,260`),{action:'tap',target:label});assert.equal(native.x,300,label);
 }
});


test('resolved ordinary native tap and container scroll stay compatible with existing read-navigation guards',()=>{
 const task={id:'t',source:'user',status:'running',depth:0,messages:[{id:'human',role:'user',content:'打开设置，查看电池'}]},grant=phoneUseGrant(task,{packageName:pkg,appName:'设置'});
 const obs=observation('  RecyclerView bounds=0,150,1000,1800\n    Button "电池" clickable bounds=100,500,600,560');
 assert.equal(classifyPhoneUseAction('t',build(obs,{action:'tap',target:'电池'}),obs,grant)?.kind,'phone_use_navigation');
 assert.equal(classifyPhoneUseAction('t',build(obs,{action:'scroll',direction:'down'}),obs,grant)?.kind,'phone_use_scroll');
 assert.equal(classifyPhoneUseAction('t',build(obs,{action:'back'}),obs,grant)?.kind,'phone_use_back');
});

test('ambiguous labels can be selected by their returned targetId without another read',()=>{
 const obs=observation('',[line('one','加入购物车'),line('two','加入购物车',[100,600,500,660])]);
 assert.equal(build(obs,{action:'tap',target:'加入购物车'}).textTargetId,'two');
 assert.equal(build(obs,{action:'tap',targetId:'two'}).textTargetId,'two');
 fails(obs,{action:'tap',targetId:'foreign'},'phone_target_missing');
});
test('a wrapped product title resolves to its actual first line',()=>{
 const obs=observation('',[line('first','可口可乐 零度无糖',[100,200,500,260]),line('second','330ml/罐',[100,270,400,330])]);
 assert.equal(build(obs,{action:'tap',target:'可口可乐 零度无糖330ml/罐'}).textTargetId,'first');
});

test('a clipped nested list does not hide a usable outer scroll region',()=>{
 const body='  ScrollView bounds=0,120,1000,1880\n    RecyclerView bounds=20,80,980,160';
 const gesture=build(observation(body),{action:'scroll',direction:'down'});
 assert.equal(gesture.action,'swipe');
 assert.ok(gesture.y1>gesture.y2&&gesture.y2>160);
});

test('a clipped incidental scroller does not disable an authorized viewport gesture',()=>{
 const obs=observation('  WebView bounds=0,100,1000,1900\n    RecyclerView bounds=0,20,1000,80');
 assert.throws(()=>build(obs,{action:'scroll',direction:'down'}),error=>error.code==='phone_scroll_unavailable');
 for(const direction of ['down','up']){
  const gesture=build(obs,{action:'scroll',direction},{...context,allowViewportScroll:true});
  assert.equal(gesture.action,'swipe');assert.equal(gesture.x1,500);
  assert.equal(gesture.y1>gesture.y2,direction==='down');
  assert.ok(Math.min(gesture.y1,gesture.y2)>80&&Math.max(gesture.y1,gesture.y2)<1900);
 }
});
