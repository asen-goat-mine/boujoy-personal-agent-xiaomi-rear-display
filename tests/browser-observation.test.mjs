import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {Browser} from '../src/adapters/browser.mjs';
async function setup(t,html){const browser=await chromium.launch({channel:'chrome',headless:true}),ctx=await browser.newContext(),page=await ctx.newPage();t.after(()=>browser.close());await page.setContent(html);const adapter=new Browser();adapter.context=ctx;adapter.pages.set('task',page);return {page,adapter};}
test('real browser action uses the same visible observation mapping and returns the actual changed page',async t=>{
 const {adapter,page}=await setup(t,'<div hidden><button>Hidden</button></div><button onclick="document.querySelector(\'p\').textContent=\'Opened\'">Open</button><p>Before</p>');const observed=await adapter.observe('task');assert.equal(observed.elements.length,1);
 const after=await adapter.act('task',{observationId:observed.observationId,index:0,action:'click'});assert.equal(await page.locator('p').textContent(),'Opened');assert.match(after.text,/Opened/);assert.notEqual(after.observationId,observed.observationId);assert.equal(after.requiresVerification,true);
});
test('credential and OTP screens never return visible secret text, elements or screenshot',async t=>{
 const {adapter,page}=await setup(t,'<p>Your secret OTP 123456</p><input autocomplete="one-time-code" value="123456"><button>Confirm</button>');const observed=await adapter.observe('task');assert.equal(observed.credentialBoundary,true);assert.equal(observed.text,'');assert.deepEqual(observed.elements,[]);assert.ok(!JSON.stringify(observed).includes('123456'));
 await assert.rejects(adapter.screenshot('task'),e=>e.code==='credential_boundary');const latest=await adapter.observe('task');await assert.rejects(adapter.act('task',{observationId:latest.observationId,index:0,action:'fill',text:'123456'}),e=>e.code==='credential_boundary');
 await page.setContent('<input type="password" value="private"><p>private</p>');assert.equal((await adapter.observe('task')).text,'');
});
test('a changed browser page is rejected before clicking a replacement control',async t=>{
 const {adapter,page}=await setup(t,'<button>Open</button>');const observed=await adapter.observe('task');await page.setContent('<button onclick="window.acted=true">Delete</button>');await assert.rejects(adapter.act('task',{observationId:observed.observationId,index:0,action:'click'}),e=>e.code==='page_changed');assert.equal(await page.evaluate(()=>window.acted),undefined);
});

test('browser permission revocation during native locator inspection prevents both agent and manual clicks after re-enable',async t=>{
 const {setExecutionPermissions}=await import('../src/core/execution-permissions.mjs');
 for(const manual of [false,true]){
  const {adapter,page}=await setup(t,'<button onclick="window.acted=true">Open</button>');
  const state={settings:{browserEnabled:true,executionEpochs:{browser:0}},tasks:[],actions:[]},store={data:state,transaction:fn=>fn(state)};adapter.executionStore=store;
  let frame;if(manual){await page.route('https://example.test/**',route=>route.fulfill({body:'<button onclick="window.acted=true">Open</button>',contentType:'text/html'}));await page.goto('https://example.test/');adapter.setManual('task','human');frame=await adapter.workspaceCapture('task','human',()=>{});}else frame=await adapter.observe('task');
  const original=page.locator.bind(page);page.locator=(...args)=>{const locator=original(...args),attribute=locator.getAttribute.bind(locator);locator.getAttribute=async name=>{const value=await attribute(name);await setExecutionPermissions({store},{browserEnabled:false});await setExecutionPermissions({store},{browserEnabled:true});return value;};return locator;};
  await assert.rejects(manual?adapter.workspaceAct('task','human',frame,{frameId:frame.frameId,index:0,action:'click'},()=>{}):adapter.act('task',{observationId:frame.observationId,index:0,action:'click'}),{code:'execution_revoked'});assert.equal(await page.evaluate(()=>window.acted),undefined);
 }
});

test('a verification field is caught wherever it sits among the controls, not only in the first 180',async t=>{
 for(const count of [179,180,400]){
  const {adapter}=await setup(t,'<p>SECRET-PAGE-TEXT</p>'+'<button>b</button>'.repeat(count)+'<input autocomplete="one-time-code" value="123456">');
  const observed=await adapter.observe('task');
  assert.equal(observed.credentialBoundary,true,String(count));assert.equal(observed.text,'');assert.deepEqual(observed.elements,[]);
 }
});
