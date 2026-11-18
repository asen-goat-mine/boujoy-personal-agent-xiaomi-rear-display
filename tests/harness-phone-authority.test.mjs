import {systemPromptForTools} from '../src/core/agent-instructions.mjs';
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


test('Harness directs buttons without business-label or inferred read-only veto',async()=>{
 for(const label of ['加入购物车','领券购买','保存','提交订单','立即支付']){
  const page=frame(SETTINGS.packageName,[box('action',label)],`Button "${label}" clickable bounds=100,200,600,260`);
  const f=fixture({current:page,opened:page,next:[page]});
  await f.broker.execute('t','phone_use',{action:'open_app',app:'设置'});
  assert.equal(f.task.phoneUseScope.decisionOwner,'harness');
  await f.broker.execute('t','phone_use',{action:'tap',target:label});
  assert.equal(f.calls.filter(c=>c.name==='tap').length,1,label);
  assert.equal(f.data.actions.at(-1).authorization,'harness');
  assert.equal(f.task.status,'running');
 }
});
test('Harness can finish a recommendation without checkout and decides checkout handoff',async()=>{
 const page=frame(SETTINGS.packageName,[box('title','确认订单'),box('action','提交订单')]);
 const f=fixture({current:page});
 f.broker.engine={finishReport:()=>{f.task.status='completed';}};
 await f.broker.execute('t','phone_use',{action:'open_app',app:'设置'});
 assert.equal(f.task.status,'running');
 await f.broker.execute('t','finish_task',{outcome:'completed',summary:'根据已读取页面完成核对',evidence:[f.phone.observation.id]});
 assert.equal(f.task.status,'completed');
 assert.equal(f.calls.filter(c=>c.name==='tap').length,0);
});
test('cancelled Harness actions never dispatch',async()=>{
 const f=fixture();const c=new AbortController();c.abort();
 await assert.rejects(f.broker.execute('t','phone_use',{action:'open_app',app:'设置'},c.signal));
 assert.equal(f.calls.length,0);
});

test('direct Harness prompt has no mandatory purchase classifier or fixed checkout stop',()=>{
 const prompt=systemPromptForTools(['phone_use','finish_task','purchase_plan'],{task:{source:'user',taskContract:{effects:['read']}}});
 assert.match(prompt,/操作决策者/);
 assert.match(prompt,/只是可选/);
 assert.doesNotMatch(prompt,/绝不点击提交订单|始终由用户本人完成|购物或点餐任务先用/);
});
