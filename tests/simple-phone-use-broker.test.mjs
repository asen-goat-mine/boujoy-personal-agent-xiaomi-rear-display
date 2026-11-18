import {createTaskContract} from '../src/core/task-contract.mjs';
import {checkoutQueryFromPrompt} from '../src/core/checkout.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Phone } from '../src/adapters/phone.mjs';
import { Broker, TOOL_DEFINITIONS } from '../src/tools/broker.mjs';
import { AppError } from '../src/core/errors.mjs';
import { classifyQueryAction } from '../src/adapters/phone-query.mjs';
import { SYSTEM } from '../src/adapters/harness.mjs';

const SETTINGS = { packageName: 'com.android.settings', label: '设置', aliases: ['设置', 'Settings'] };
const WEATHER = { packageName: 'com.example.weather', label: '天气', aliases: ['天气', 'Weather'] };
const box = (id, text, bounds = [100,200,600,260]) => ({ id, text, bounds, center: { x: (bounds[0]+bounds[2])/2, y: (bounds[1]+bounds[3])/2 } });
function frame(pkg, lines = [], body = '') {
  return { tree: { content: [{ type: 'text', text: JSON.stringify({ ok: true, result: { display: 'main', foreground: pkg+'/Activity', windowPkg: pkg, window: 'main', tree: `window pkg=${pkg} bounds=0,0,1000,2000\n${body}` } }) }] }, ocr: { width: 1000, height: 2000, lines } };
}
const objects = result => result.content.filter(block => block.type === 'text').map(block => { try { return JSON.parse(block.text); } catch { return null; } }).filter(Boolean);
const observed = result => objects(result).find(value => value.observationId || value.stability);
function fixture({ app = SETTINGS, prompt = '打开设置，查看电池用量，再返回设置首页', current, opened, next = [], catalog, wireless = false } = {}) {
  const home = frame(app.packageName, [box('battery', '电池')], 'Button "电池" clickable bounds=100,200,600,260');
  let state = current || home, queue = [...next], approvals = 0, reads = 0;
  const task = { id: 't', source: 'user', status: 'running', kind: 'general', depth: 0, parentId: null, phoneQuery: null, phoneUseScope: null, prompt, messages: [{ id: 'current-human', role: 'user', content: prompt }], quotes: [], children: [], events: [] };
  const data = { tasks: [task], actions: [], artifacts: [], roles: [], settings: { phoneEnabled: true, memoryEnabled: false } }, calls = [], directoryCalls = [], events = [];
  const store = { data, task: id => { assert.equal(id, 't'); return task; }, event: (id,type,text,extra) => events.push({ id,type,text,...extra }), transaction: fn => fn(data), updateTask: (id,fn) => { assert.equal(id,'t'); fn(task,data); return task; } };
  const phone = new Phone(store, { wait: async () => {}, recognize: async image => JSON.parse(Buffer.from(image.content[0].data, 'base64').toString()).ocr });
  phone.apps = {
    list: async query => { directoryCalls.push({ method: 'list', query }); return { source: 'fixture', cached: false, apps: catalog || [{ ...app }], totalMatched: (catalog || [app]).length }; },
    resolve: async packageName => { directoryCalls.push({ method: 'resolve', packageName }); assert.equal(packageName, app.packageName); return { ...app, source: 'fixture', cached: false }; }
  };
  phone.call = async (name,args) => {
    calls.push({ name,args }); assert.equal(args.display, 'main');
    if (name === 'ui_tree') return state.tree;
    if (name === 'screenshot') { reads++; return { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from(JSON.stringify(state)).toString('base64') }] }; }
    if (name === 'open_app') { assert.equal(args.packageName, app.packageName); state = opened || home; return { content: [{ type: 'text', text: '{"ok":true}' }] }; }
    if (['tap','type','key','swipe'].includes(name)) { if (queue.length) state = queue.shift(); return { content: [{ type: 'text', text: '{"ok":true}' }] }; }
    if (name === 'wait_idle') return { content: [{ type: 'text', text: '{"ok":true,"result":{"settled":true,"waitedMs":0}}' }] };
    throw Error('Unexpected local fixture call '+name);
  };
  if(wireless){
    phone.isPhoneUse=()=>true;phone.phoneUseDevice=()=> 'fixture-phone';let nativeSequence=0;
    phone.phoneUse={listApps:async(id,q)=>phone.apps.list(q),resolveApp:async(id,pkg)=>phone.apps.resolve(pkg),client:{remoteTransport:{}},capture:async()=>({tree:state.tree,image:{content:[{type:'image',mimeType:'image/png',data:Buffer.from(JSON.stringify(state)).toString('base64')}]},mapping:{physicalWidth:1000,physicalHeight:2000,imageWidth:1000,imageHeight:2000,scaleX:1,scaleY:1,offsetX:0,offsetY:0},native:{deviceId:'fixture-phone',serviceInstanceId:'fixture-service',observationId:'native-'+(++nativeSequence),windowId:1,packageName:app.packageName,elements:[]}}),recognize:async()=>state.ocr};
  }
  const broker = new Broker({ store,phone,approvals: { request: async () => { approvals++; throw new AppError('not_approved', 'Fixture has no manual approval'); }, cancelTask() {} } });
  return { broker,phone,task,data,calls,directoryCalls,events,home,counts: () => ({ approvals,reads }) };
}

test('model supplies only visible text and Chinese input while real Phone freshly checks the current search scope', async () => {
  const home = frame(WEATHER.packageName,[box('search','搜索')],'Button "搜索" clickable bounds=100,200,600,260');
  const input = value => frame(WEATHER.packageName,[box('field',value||'搜索城市',[100,200,750,260]),box('search','搜索',[820,200,970,260])], 'EditText "搜索城市" editable focused clickable bounds=100,200,750,260\n Button "搜索" clickable bounds=820,200,970,260');
  const result = frame(WEATHER.packageName,[box('city','上海'),box('temp','当前温度18°C',[100,500,600,560])]);
  const f = fixture({ app: WEATHER,prompt: '打开天气，搜索上海',current: home,next: [input(''),input('上海'),result] });
  await f.broker.execute('t','phone_use',{ action: 'open_app',app: '天气' });
  await f.broker.execute('t','phone_use',{ action: 'tap',target: '搜索' });
  await f.broker.execute('t','phone_use',{ action: 'type',text: '上海',inputMode: 'replace' });
  const output = await f.broker.execute('t','phone_use',{ action: 'tap',target: '搜索' });
  assert.equal(f.phone.observation.ocr.lines[1].text, '当前温度18°C'); assert.ok(observed(output).observationId);
  assert.deepEqual(f.calls.filter(call => ['tap','type','key','swipe'].includes(call.name)).map(call => call.name), ['tap','type','tap']);
  assert.equal(f.calls.find(call => call.name === 'type').args.mode, 'replace');
  assert.equal(f.broker.calls.get('t'), 4); assert.equal(f.counts().approvals, 0);
  const typed = f.data.actions.find(action => action.tool === 'phone_action'); assert.ok(typed.observationId);
});

test('scroll uses the observed container and stale or foreign observations are refreshed before dispatch',async()=>{
 const current=frame(WEATHER.packageName,[box('city','上海')],'RecyclerView "城市列表" bounds=0,150,1000,1800');
 const f=fixture({app:WEATHER,prompt:'打开天气，浏览城市列表',current,next:[current]});await f.broker.execute('t','phone_use',{action:'open_app',app:'天气'});
 await f.broker.execute('t','phone_use',{action:'scroll',direction:'down'});assert.equal(f.calls.filter(call=>call.name==='swipe').length,1);
 const effects=()=>f.calls.filter(call=>['tap','key','type','swipe'].includes(call.name)).length;
 const count=effects(),old=f.phone.observation.id;f.phone.observation.at=Date.now()-50000;await f.broker.execute('t','phone_use',{action:'back'});assert.equal(effects(),count+1);assert.notEqual(f.data.actions.at(-1).observationId,old);
 f.phone.observation.taskId='foreign';await f.broker.execute('t','phone_use',{action:'back'});assert.equal(effects(),count+2);assert.equal(f.phone.observation.taskId,'t');
 await assert.rejects(f.broker.execute('t','phone_use',{action:'tap',x:1001,y:1001}),{code:'invalid_input'});
});

function queryWire() {
  let serial = 0, stage = 'input', keyword = '旧菜品';
  const task = { id: 'food',source: 'user',status: 'running',kind: 'checkout',depth: 0,parentId: null,prompt: '帮我点一份牛肉面，准备到结算，我自己付款',messages: [{ id: 'human-food',role: 'user',content: '帮我点一份牛肉面，准备到结算，我自己付款' }],phoneQuery: { platform: 'taobao',query: '牛肉面' },phoneUseScope: null,quotes: [],children: [],events: [] };
  const data = { tasks: [task],actions: [],artifacts: [],settings: { phoneEnabled: true,memoryEnabled: false } }, actions = [];
  const store = { data,task: id => { assert.equal(id,'food'); return task; },event() {},transaction: fn => fn(data),updateTask: (id,fn) => { assert.equal(id,'food'); fn(task,data); return task; } };
  const phone = { observation: null };
  const observe = (id,grant) => {
    const current = frame('com.taobao.taobao',[
      box('field','全部 '+keyword,[150,128,500,175]),box('search','搜索',[820,128,920,175]),box('food','美食',[40,380,160,430]),box('drink','咖啡奶茶',[230,380,450,430]),
      ...(stage === 'input' ? [box('history','历史搜索',[40,310,500,355])] : [box('item','招牌'+keyword,[40,620,520,680]),box('fee','配送费 ¥0 起送 ¥10',[40,710,620,770])])
    ],stage === 'input' ? 'EditText "搜索" editable focused bounds=150,128,700,180' : '');
    phone.observation = { ...current,id: 'query-'+(++serial),taskId: id,at: Date.now(),stability: 'fresh',stabilityScope: 'query',queryGrant: grant };
    return { content: [{ type: 'text',text: JSON.stringify({ observationId: phone.observation.id,stability: 'fresh',stabilityScope: 'query',textTargets: current.ocr.lines }) },...current.tree.content] };
  };
  phone.observeQuery = async (id,grant) => observe(id,grant);
  phone.observeQueryAfterAction = async (id,grant) => observe(id,grant);
  phone.queryAction = (id,args,grant) => classifyQueryAction(id,args,phone.observation,grant);
  phone.act = async (id,args,{ queryGrant,signal }) => {
    assert.equal(signal.aborted,false); assert.ok(classifyQueryAction(id,args,phone.observation,queryGrant));
    actions.push(args);
    if (args.action === 'type') keyword = args.text;
    if (args.action === 'tap') stage = 'results';
    phone.observation = null;
    return { ok: true };
  };
  const broker = new Broker({ store,phone,approvals: { request: async () => { assert.fail('query should not request manual approval'); } } });
  return { broker,phone,task,data,actions };
}


test('legacy simple search returns observation without actions and consumes one public step', async () => {
  const f = queryWire();
  const result = await f.broker.execute('food','phone_use',{ action: 'search' },new AbortController().signal);
  const summary = objects(result).find(value => value.search)?.search;
  assert.equal(summary.needsModel,true); assert.equal(summary.actions,0);
  assert.deepEqual(f.actions,[]);assert.equal(f.data.actions.length,0);
  assert.equal(f.broker.calls.get('food'),1); assert.equal(f.broker.evidence.get(f.phone.observation.id).taskId,'food');
});


test('a known phone takeover pauses once before app routing without approvals or phone traffic',async()=>{
 const f=fixture();f.data.settings.phoneBackend='phoneuse';f.phone.phoneUse.client.remoteTransport={dataPort:34561,controlPort:34562};f.phone.remoteControlState=()=>({paused:true});let pauses=0;
 f.broker.engine={pauseForPhoneControl(id,reason){assert.equal(id,'t');assert.ok(reason.includes('无需重新配对'));pauses++;f.task.status='paused';}};
 await assert.rejects(f.broker.execute('t','phone_use',{action:'open_app',app:'设置'}),e=>e.code==='phone_control_paused'&&e.dispatchState==='not_sent');
 assert.equal(pauses,1);assert.equal(f.task.status,'paused');assert.equal(f.directoryCalls.length,0);assert.equal(f.calls.length,0);assert.equal(f.data.actions.length,0);assert.equal(f.counts().approvals,0);
});


test('ordinary input tasks use general mode and finish with current screen evidence',async()=>{
 const home=frame(WEATHER.packageName,[box('input','输入城市')],'EditText "输入城市" editable focused bounds=100,200,600,260');
 const f=fixture({app:WEATHER,prompt:'打开天气，输入上海，查看天气',current:home});
 const {createTaskContract}=await import('../src/core/task-contract.mjs');f.task.taskContract=createTaskContract(f.task);
 const meta=observed(await f.broker.execute('t','phone_use',{action:'open_app',app:'天气'}));assert.equal(f.task.phoneUseScope.mode,'general');
 await f.broker.execute('t','finish_task',{outcome:'completed',summary:'已查看当前城市天气',evidence:[meta.observationId]});assert.equal(f.task.report.outcome,'completed');
});

test('public phone_use accepts the returned targetId and ignores known stale fields before validation',async()=>{
 const current=frame(WEATHER.packageName,[box('search-a','搜索',[100,200,600,260]),box('search-b','搜索',[100,800,600,860])],
 'Button "搜索" clickable bounds=100,200,600,260\nButton "搜索" clickable bounds=100,800,600,860');
 const f=fixture({app:WEATHER,prompt:'打开天气，搜索上海',current,next:[current]});
 await f.broker.execute('t','phone_use',{action:'open_app',app:'天气'});
 await f.broker.execute('t','phone_use',{action:'tap',target:'搜索'});assert.equal(f.calls.find(c=>c.name==='tap').args.y,830);
 await f.broker.execute('t','phone_use',{action:'tap',targetId:'search-a',mode:'full',app:'天气'});
 assert.equal(f.calls.filter(c=>c.name==='tap').length,2);assert.equal(f.calls.filter(c=>c.name==='tap').at(-1).args.y,230);assert.equal(f.counts().approvals,0);
});
test('public typing replaces an old search query by default',async()=>{
 const field=value=>frame(WEATHER.packageName,[box('field',value,[100,200,750,260])],`EditText "搜索城市" "${value}" editable focused clickable bounds=100,200,750,260`);
 const f=fixture({app:WEATHER,prompt:'打开天气，搜索上海',current:field('北京'),next:[field('上海')]});
 await f.broker.execute('t','phone_use',{action:'open_app',app:'天气'});
 await f.broker.execute('t','phone_use',{action:'type',text:'上海'});
 assert.equal(f.calls.find(c=>c.name==='type').args.mode,'replace');assert.equal(f.counts().approvals,0);
});

test('a bound shopping task dismisses the real Samsung warning via Back and resumes the target app',async()=>{
 const app={packageName:'com.taobao.taobao',label:'淘宝',aliases:['淘宝']};
 const popup=frame('com.samsung.android.sm_cn',[box('title','支付安全',[100,1400,900,1460]),box('body','关闭 USB 调试来提升支付安全性。',[100,1500,900,1570]),box('ignore','忽略',[100,1700,400,1790]),box('close','关闭',[600,1700,900,1790])]);
 const product=frame(app.packageName,[box('buy','立即购买',[500,1700,900,1800])],'Button "立即购买" clickable bounds=500,1700,900,1800');
 const f=fixture({wireless:true,app,prompt:'淘宝买一瓶无糖可乐，到结算页',current:popup,next:[product]});f.task.phoneQuery=checkoutQueryFromPrompt(f.task.prompt);f.task.taskContract=createTaskContract(f.task);
 // Opening the allowed app can return a system overlay above it.
 const observation=await f.phone.observePurchase('t',{taskId:'t',platform:'taobao',goal:'checkout',payment:'user'});const meta=observed(observation);f.broker.remember('t',{...meta,content:observation.content});
 assert.equal(meta.systemOverlay,'samsung_usb_notice');assert.deepEqual(meta.permittedActions,['back']);
 await assert.rejects(f.broker.execute('t','phone_use',{action:'tap',target:'关闭'}));
 await f.broker.execute('t','phone_use',{action:'back'});assert.equal(f.calls.filter(c=>c.name==='key').length,1);assert.equal(f.calls.filter(c=>c.name==='tap').length,0);assert.equal(f.phone.observation.native.packageName,app.packageName);
});

test('legacy retail search observes the current screen without choosing either marketplace entry',async()=>{
 const app={packageName:'com.taobao.taobao',label:'淘宝',aliases:['淘宝']},home=frame(app.packageName,[box('flash','闪购'),box('search','搜索商品',[100,400,900,460])],'Button "闪购" clickable bounds=100,200,600,260');
 const f=fixture({wireless:true,app,prompt:'淘宝买一瓶洗发水，到结算页',current:home});f.task.phoneQuery=checkoutQueryFromPrompt(f.task.prompt);f.task.taskContract=createTaskContract(f.task);
 const result=await f.broker.execute('t','phone_use',{action:'search'});assert.equal(objects(result)[0].search.reason,'model_driven_search');assert.equal(objects(result)[0].search.actions,0);assert.ok(observed(result).observationId);assert.equal(f.calls.filter(c=>c.name==='tap').length,0);assert.equal(f.counts().approvals,0);
});

test('an open-app the phone does not confirm in time is read and continued, not a stop',async()=>{
  const home=frame(SETTINGS.packageName,[box('battery','电池')],'Button "电池" clickable bounds=100,200,600,260');
  const f=fixture({current:frame('com.android.launcher'),opened:home});
  f.phone.openPackage=async()=>{const error=new AppError('outcome_unknown','动作结果尚未核实');error.dispatchState='sent';error.requestId='slow-launch';throw error;};
  // The app did come up; only the confirmation was late.
  const original=f.phone.call;f.phone.call=async(name,args)=>name==='ui_tree'&&f.calls.some(c=>c.name==='ui_tree')?home.tree:original(name,args);
  const result=await f.broker.execute('t','phone_use',{action:'open_app',app:'设置'});
  assert.notEqual(f.task.status,'unknown_result');
  const receipt=JSON.parse(result.content[0].text).receipt;assert.equal(receipt.accepted,'unconfirmed');
  const action=f.data.actions.find(a=>a.tool==='phone_open_app');assert.equal(action.status,'unknown');assert.equal(action.resolution.kind,'navigation_observed');assert.equal(action.resolution.reason,'open_app_has_no_lasting_effect');
  // A second open_app (the app was still starting) is not refused as an unverified step.
  await f.broker.execute('t','phone_use',{action:'open_app',app:'设置'});assert.notEqual(f.task.status,'unknown_result');
});

test('a follow-up that does not name the app keeps working in the app already in front',async()=>{
  const home=frame(SETTINGS.packageName,[box('battery','电池')],'Button "电池" clickable bounds=100,200,600,260');
  const battery=frame(SETTINGS.packageName,[box('title','电池用量'),box('level','当前电量80%',[100,500,600,560])]);
  const f=fixture({prompt:'继续，点开电池看看还剩多少',current:home,next:[battery]});
  f.task.taskContract=createTaskContract(f.task);
  await f.broker.execute('t','phone_use',{action:'read'});
  assert.equal(f.task.phoneUseScope,null);
  await f.broker.execute('t','phone_use',{action:'tap',target:'电池'});
  assert.equal(f.task.phoneUseScope?.packageName,SETTINGS.packageName);assert.ok(f.calls.some(c=>c.name==='tap'));
  assert.ok(f.events.some(e=>e.type==='phone_scope_adopted'));
});


test('unconfirmed navigation can reach native reconciliation on the next open instead of observing forever',async()=>{
 const home=frame(SETTINGS.packageName,[box('battery','电池')],'Button "电池" clickable bounds=100,200,600,260');
 const f=fixture({current:frame('com.android.launcher'),opened:home});
 const open=f.phone.openPackage.bind(f.phone);let attempts=0;
 f.phone.openPackage=async(...args)=>{if(++attempts===1){const error=new AppError('outcome_unknown','启动回执未确认');error.dispatchState='sent';error.requestId='first-unconfirmed';throw error;}return open(...args);};
 await f.broker.execute('t','phone_use',{action:'open_app',app:'设置'});
 assert.equal(f.data.actions.filter(a=>a.tool==='phone_open_app').length,1);
 const result=await f.broker.execute('t','phone_use',{action:'open_app',app:'设置'});
 assert.equal(attempts,2,'second intent reaches the native client, whose idle proof still governs dispatch');
 assert.ok(observed(result).observationId);assert.equal(f.task.status,'running');
});

test('a successful fresh open clears an old missing-frame recovery but not unrelated uncertainty',async()=>{
 const f=fixture();f.task.phoneRecovery={code:'phone_observation_required',count:1,startRequests:1};
 await f.broker.execute('t','phone_use',{action:'open_app',app:'设置'});
 assert.equal(f.task.phoneRecovery,null);
 f.task.phoneRecovery={code:'outcome_unknown',count:1,startRequests:1};
 await f.broker.execute('t','phone_use',{action:'read'});
 assert.equal(f.task.phoneRecovery.code,'outcome_unknown');
});

test('missing-frame recovery clears even when persistent storage replaces object identity',async()=>{const f=fixture();f.task.phoneRecovery={code:'phone_observation_required',count:1,startRequests:1};const update=f.broker.store.updateTask;f.broker.store.updateTask=(id,fn)=>{f.task.phoneRecovery=structuredClone(f.task.phoneRecovery);return update(id,fn);};const event=f.broker.store.event;f.broker.store.event=(...args)=>{f.task.phoneRecovery=structuredClone(f.task.phoneRecovery);event(...args);};await f.broker.execute('t','phone_use',{action:'open_app',app:'设置'});assert.equal(f.task.phoneRecovery,null);});
test('a local recovery message remains concrete and a different failure starts its own recovery window',()=>{const f=fixture();f.task.requests=10;f.task.phoneRecovery={code:'stale_observation',count:1,startRequests:2};f.broker.phoneFailure('t',{code:'phone_target_missing',message:'当前画面中没有这个控件，请按新页面选择'});assert.equal(f.task.phoneRecovery.reason,'当前画面中没有这个控件，请按新页面选择');assert.equal(f.task.phoneRecovery.startRequests,10);});
