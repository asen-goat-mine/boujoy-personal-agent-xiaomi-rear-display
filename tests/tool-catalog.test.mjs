import test from 'node:test';
import assert from 'node:assert/strict';
import {toolsForTask,TOOL_DEFINITIONS} from '../src/tools/broker.mjs';
import {createTaskContract} from '../src/core/task-contract.mjs';
function task(prompt,extra={}){const task={id:'t',status:'running',source:'user',prompt,kind:'general',cloudConsent:true,memoryConsent:false,messages:[{id:'u',role:'user',content:prompt}],children:[],...extra};task.taskContract=createTaskContract(task);return task;}
const names=(t,options)=>toolsForTask(t,options).map(tool=>tool.name);
test('a phone contract keeps model choice across domains while retaining low-level compatibility',()=>{
 const t=task('在微信给张三发送“十分钟后到”');for(const name of ['phone_use','web_search','web_fetch','mac_files','python_run','document_create','conversation_task'])assert.ok(names(t).includes(name),name);
 assert.ok(TOOL_DEFINITIONS.some(tool=>tool.name==='phone_action'));assert.equal(names(t).includes('phone_action'),false);
 const home=task('回到桌面');assert.ok(names(home).includes('phone_use'));
 assert.equal(names(t).includes('shop_flow'),false,'business scripts are never advertised');
});
test('payment and comparison tools follow contract and task shape rather than always burdening phone work',()=>{
 const payment=task('在淘宝闪购点一份牛肉面，预算30元，进入付款页',{kind:'food',phoneQuery:{platform:'taobao',query:'牛肉面'}});
 assert.ok(!names(payment).includes('phone_prepare_payment'));assert.equal(names(payment).includes('quote_compare'),false);
 const checkout=task('在淘宝闪购点一份牛肉面，到结算页',{kind:'food',phoneQuery:{platform:'taobao',query:'牛肉面'}});assert.equal(names(checkout).includes('phone_prepare_payment'),false);
 const comparison=task('在淘宝和京东比较手机价格',{kind:'shopping'});assert.ok(names(comparison).includes('quote_compare'));assert.ok(names(comparison).includes('quote_record'));
});
test('attachments, configured connectors and permitted workflows add capabilities from actual state',()=>{
 const t=task('在微信给张三发送“十分钟后到”'),store={data:{artifacts:[{id:'input',taskId:'t'}],settings:{memoryEnabled:true}}};
 const menu=names(t,{store,hasConnectors:true,hasWorkflows:true});assert.ok(menu.includes('artifact_read'));assert.ok(menu.includes('connector_call'));assert.equal(menu.includes('workflow_read'),false);
 t.memoryConsent=true;t.taskContract=createTaskContract(t);const memory=names(t,{store,hasWorkflows:true});assert.ok(memory.includes('workflow_read'));assert.ok(memory.includes('memory_context'));
 assert.ok(names(task('在微信给张三发送“十分钟后到”'),{store:{data:{artifacts:[{taskId:'another'}]}}}).includes('artifact_read'),'tool discovery does not grant access to another task artifact');
});
test('mixed or uncertain work conservatively retains high-level tools, while a direct user chat keeps the whole catalog for the model',()=>{
 const unknown=task('帮我整理今天的资料');assert.ok(names(unknown).includes('document_create'));assert.ok(names(unknown).includes('browser_read'));
 const mixed=task('在淘宝点一份牛肉面，并生成一份报告',{kind:'food',phoneQuery:{platform:'taobao',query:'牛肉面'}});assert.ok(names(mixed).includes('phone_use'));assert.ok(names(mixed).includes('document_create'));
 const explicit=task('在微信给张三发送“十分钟后到”');assert.ok(names(explicit,{domains:['documents']}).includes('document_create'));
 // A direct user chat keeps every enabled capability; the model decides whether a greeting needs any of them.
 {const chat=names(task('你好'));assert.ok(chat.includes('phone_use'));assert.ok(chat.includes('web_search'));}
});

test('a concrete navigation task keeps phone capability even when its app is outside the static names',()=>{
 const t=task('打开豆包，搜索露营攻略');assert.equal(t.taskContract.allowedApps.length,0);assert.ok(names(t).includes('phone_use'));
});
