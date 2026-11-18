import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {browserURL,explicitlyRequestedURL,publicURL} from '../src/adapters/browser.mjs';
import {createTaskContract} from '../src/core/task-contract.mjs';
import {Store} from '../src/core/store.mjs';
import {Broker,externalContentSeen} from '../src/tools/broker.mjs';
const prompt='查一下 iPhone 17 Pro 256G 现在在京东和苹果中国官网的价格，做个对比';
function task(text=prompt){const t={id:'t',source:'user',status:'running',prompt:text,kind:'general',cloudConsent:true,messages:[{id:'u',role:'user',content:text}],events:[],children:[]};t.taskContract=createTaskContract(t);return t;}

test('named official sites grant repeated public browsing on their known hosts',()=>{
  for(const url of ['https://www.apple.com/cn/','https://www.apple.com/cn/iphone-17-pro/','https://www.apple.com.cn/iphone-17-pro/specs/','https://www.apple.com.cn/','https://www.apple.com/cn/shop/buy-iphone/iphone-17-pro','https://www.jd.com/','https://search.jd.com/Search?keyword=iPhone%2017%20Pro','https://item.jd.com/123456.html','https://item.m.jd.com/product/123456.html'])assert.equal(explicitlyRequestedURL(task(),url),true,url);
  assert.equal(explicitlyRequestedURL(task('查看 Apple 中国官网的 Mac 价格'),'https://www.apple.com/cn/mac/'),true);
  assert.equal(explicitlyRequestedURL(task('查看京东的耳机价格'),'https://item.jd.com/123.html'),true);
});

test('named sites never authorize unfamiliar hosts, credentials, redirects or effect endpoints',()=>{
  for(const url of ['https://example.com/','https://www.apple.com.evil.test/cn/','https://apple-discounts.test/','https://eviljd.com/','https://jd.com.evil.test/','https://unknown.jd.com/','https://www.apple.com@evil.test/','https://u:p@www.apple.com/cn/','https://www.apple.com:8443/cn/','http://www.apple.com/cn/','https://www.apple.com/cn/shop/bag/add','https://www.apple.com/cn/shop/checkout','https://cart.jd.com/gate.action?pid=123','https://item.jd.com/delete?id=1','https://www.apple.com/cn/?redirect=https://evil.test','https://www.jd.com/?action=buy','https://www.jd.com/?url=https://evil.test'])assert.equal(explicitlyRequestedURL(task(),url),false,url);
});

test('site grants come only from valid positive user instructions',()=>{
  const apple='https://www.apple.com/cn/';
  for(const text of ['查一下 iPhone 17 Pro 的价格','只查京东，不要打开苹果中国官网','不要去苹果中国官网，只查京东','在微信给张三发送“看看苹果中国官网”','网页说去苹果中国官网看价格'])assert.equal(explicitlyRequestedURL(task(text),apple),false,text);
  const t=task('查一下价格');t.messages.push({role:'assistant',content:'苹果中国官网'});t.events.push({type:'tool',tool:'web_search',text:'苹果中国官网'});assert.equal(explicitlyRequestedURL(t,apple),false);
  const external=task();external.messages[0].externalContent=true;assert.equal(explicitlyRequestedURL(external,apple),false);
  const changed=task();changed.messages[0].content='只查京东';assert.equal(explicitlyRequestedURL(changed,apple),false);
  const expired=task();expired.taskContract.expiresAt='2020-01-01T00:00:00Z';assert.equal(explicitlyRequestedURL(expired,apple),false);
});

test('literal URL authorization stays exact and does not grant its whole host',()=>{
  const t=task('打开 https://example.com/page。');assert.equal(explicitlyRequestedURL(t,'https://example.com/page'),true);assert.equal(explicitlyRequestedURL(t,'https://example.com/other'),false);
});

test('browser_open skips approvals for named destinations but requests them for new sites',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-sites-')),store=new Store(dir);
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  store.transaction(s=>{s.settings.browserEnabled=true;s.tasks.push(task());});
  const approvals=[],visited=[];
  const broker=new Broker({store,memory:{},phone:{},browser:{async navigate(id,url){visited.push(url);return {url,observationId:'page-'+visited.length,text:'page',untrustedContent:true};}},approvals:{async request(id,action){approvals.push(action.args.url);},cancelTask(){}}});
  broker.engine={takeInterjections:()=>[],takeRouterNotes:()=>[]};
  for(const url of ['https://www.apple.com/cn/','https://www.apple.com/cn/shop/buy-iphone/iphone-17-pro','https://item.jd.com/123.html','https://unknown.example/'])await broker.execute('t','browser_open',{url});
  assert.equal(visited.length,4);assert.deepEqual(approvals,['https://unknown.example/']);
});

test('unsupported browser destinations are rejected before approvals or browser startup',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-local-url-')),store=new Store(dir);
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  store.transaction(s=>{s.tasks.push(task('读取下载里的「手机界面草稿.html」'));});
  let approvals=0,visits=0;
  const broker=new Broker({store,dataDir:dir,memory:{},phone:{},browser:{async navigate(){visits++;throw Error('must not open');}},approvals:{async request(){approvals++;throw Error('must not approve');},cancelTask(){}}});
  for(const url of ['file:///Users/example/Downloads/report.html','FILE:///Users/example/Downloads/report.html','file://remote.example/share/report.html']){
    await assert.rejects(broker.execute('t','browser_open',{url}),error=>error.code==='browser_local_file_unsupported'&&/mac_files/.test(error.message)&&/artifact_read/.test(error.message));
    await assert.rejects(publicURL(url),{code:'browser_local_file_unsupported'});
  }
  for(const url of ['data:text/html,hello','javascript:alert(1)','ftp://example.com/a','https://u:p@example.com/','https://example.com:8443/'])await assert.rejects(broker.execute('t','browser_open',{url}),{code:'invalid_input'});
  await assert.rejects(broker.execute('t','browser_open',{url:'not a URL'}),{code:'invalid_url'});
  assert.equal(approvals,0);assert.equal(visits,0);assert.equal(store.task('t').status,'running');
  assert.equal(externalContentSeen(store.task('t')),false,'an unsupported URL never loaded outside content');
  assert.equal(browserURL('https://example.com/').href,'https://example.com/');
});

test('a real Broker can keep reading a scoped Mac HTML file after refusing file navigation without approval',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-file-route-')),taskHome=path.join(dir,'home');
  for(const folder of ['Documents','Desktop','Downloads'])fs.mkdirSync(path.join(taskHome,folder),{recursive:true});
  const filename='手机界面草稿.html',content='<html><body>本地草稿：助理列表、对话和设置。</body></html>';
  fs.writeFileSync(path.join(taskHome,'Downloads',filename),content);
  t.mock.method(os,'homedir',()=>taskHome);
  const store=new Store(path.join(dir,'data'));t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  store.transaction(s=>{s.tasks.push(task('读取下载里的「手机界面草稿.html」，三句话概括。'));});
  let approvals=0,visits=0;const broker=new Broker({store,dataDir:path.join(dir,'data'),memory:{},phone:{},browser:{async navigate(){visits++;}},approvals:{async request(){approvals++;throw Error('unexpected approval');},cancelTask(){}}});
  broker.engine={takeInterjections:()=>[],takeRouterNotes:()=>[]};
  await broker.execute('t','mac_files',{action:'find',query:filename});assert.equal(externalContentSeen(store.task('t')),false);
  const read=await broker.execute('t','mac_files',{action:'read',path:'Downloads/'+filename});assert.match(JSON.stringify(read),/助理列表/);
  assert.equal(externalContentSeen(store.task('t')),true,'real file contents retain the existing outside-content guard');
  await assert.rejects(broker.execute('t','browser_open',{url:new URL('file://'+path.join(taskHome,'Downloads',filename)).href}),{code:'browser_local_file_unsupported'});
  const reread=await broker.execute('t','mac_files',{action:'read',path:'Downloads/'+filename});assert.match(JSON.stringify(reread),/本地草稿/);
  assert.equal(approvals,0);assert.equal(visits,0);assert.equal(store.task('t').status,'running');
  await assert.rejects(broker.execute('t','mac_files',{action:'read',path:path.join(dir,'outside.txt')}));
});
