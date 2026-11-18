import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {Browser} from '../src/adapters/browser.mjs';
import {BrowserWorkspace} from '../src/remote/browser-workspace.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t){
 const runtime=await chromium.launch({channel:'chrome',headless:true}),context=await runtime.newContext(),page=await context.newPage();
 await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<title>Workspace fixture</title><button onclick="document.querySelector(\'p\').textContent=\'changed\'">Run</button><p>Original</p><input placeholder="Note">'}));await page.goto('https://fixture.invalid/work');
 const browser=new Browser();browser.context=context;browser.pages.set('task',page);
 const store={data:{tasks:[{id:'task',status:'running'}]}},state={data:{control:{controlEpoch:2,paused:true}},device:fp=>fp==='bound'?{id:'phone'}:null};
 const engine={active:new Map(),async stop(id){store.data.tasks.find(t=>t.id===id).status='paused';}},workspace=new BrowserWorkspace({browser,store,engine,state});
 t.after(async()=>{workspace.close();await runtime.close();});const device={id:'phone'};return {page,browser,store,state,engine,workspace,device};
}
test('human workspace requires a source-owned existing page and rejects changed frames, arbitrary operations and credential pages',async t=>{
 const f=await fixture(t);await assert.rejects(f.workspace.begin('missing',f.device,'bound',2),e=>e.code==='browser_page_missing');assert.equal(f.browser.pages.size,1);
 const session=await f.workspace.begin('task',f.device,'bound',2),args={sessionId:session.sessionId,controlEpoch:2};
 await assert.rejects(f.browser.observe('task'),e=>e.code==='browser_manual_control');
 const frame=await f.workspace.operate('task',f.device,'bound',args,'frame');await f.page.locator('p').evaluate(e=>e.textContent='externally changed');
 await assert.rejects(f.workspace.operate('task',f.device,'bound',{...args,frameId:frame.frameId,action:'click',index:0},'act'),e=>e.code==='page_changed');
 const fresh=await f.workspace.operate('task',f.device,'bound',args,'frame');await assert.rejects(f.workspace.operate('task',f.device,'bound',{...args,frameId:fresh.frameId,action:'navigate',url:'https://elsewhere.invalid'},'act'));
 await f.page.evaluate(()=>document.querySelector('p').textContent='扫码登录');await assert.rejects(f.workspace.operate('task',f.device,'bound',args,'frame'),e=>e.code==='credential_boundary');
});
test('invalidating a human operation retains the browser lock until the in-flight operation settles',async t=>{
 const f=await fixture(t),session=await f.workspace.begin('task',f.device,'bound',2),args={sessionId:session.sessionId,controlEpoch:2};
 let release,entered;const enteredPromise=new Promise(r=>entered=r),hold=new Promise(r=>release=r),capture=f.browser.workspaceCapture.bind(f.browser);
 f.browser.workspaceCapture=async(...input)=>{entered();await hold;return capture(...input);};
 const pending=f.workspace.operate('task',f.device,'bound',args,'frame');await enteredPromise;f.state.data.control.controlEpoch++;f.workspace.invalidateChanged();
 assert.equal(f.workspace.sessions.size,0);assert.equal(f.browser.manualOwners.has('task'),true);await assert.rejects(f.browser.observe('task'),e=>e.code==='browser_manual_control');
 release();await assert.rejects(pending,e=>e.code==='browser_session_expired');await delay(40);assert.equal(f.browser.manualOwners.has('task'),false);
});
test('takeover waits for an existing browser operation, and a local task resume invalidates the human session',async t=>{
 const f=await fixture(t);let release;const hold=new Promise(r=>release=r),agent=f.browser.agentOperation('task',()=>hold);
 const beginning=f.workspace.begin('task',f.device,'bound',2);await delay(50);assert.equal(f.browser.manualOwners.has('task'),true);release();await assert.rejects(agent,e=>e.code==='browser_manual_control');
 const session=await beginning;f.store.data.tasks[0].status='queued';f.workspace.invalidateChanged();assert.equal(f.browser.manualOwners.has('task'),false);assert.throws(()=>f.workspace.get(session.sessionId,f.device,'bound','task'),e=>e.code==='browser_session_expired');
});
