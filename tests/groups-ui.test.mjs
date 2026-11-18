import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from 'playwright';

test('desktop and narrow group UI creates a real persisted group, single @ dispatch, preserves drafts', {timeout:45000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-groups-ui-')),socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const origin=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['src/server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,BOUJOY_PORT:String(port),BOUJOY_DATA:dir,BOUJOY_MEMORY_VAULT:path.join(dir,'no-personal-memory')},stdio:'ignore'});let browser;
 t.after(async()=>{await browser?.close();if(child.exitCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');await stopped;}fs.rmSync(dir,{recursive:true,force:true});});
 let ready=false;for(let n=0;n<100;n++){try{if((await fetch(origin+'/api/session')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready,'isolated fixture server starts');
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1200,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await page.locator('[data-action=groups]').click({timeout:10000}).catch(async e=>{throw Error(e.message+' PAGE='+await page.locator('body').innerText());});await page.getByRole('button',{name:'＋ 建群',exact:true}).click();
 await page.locator('.group-editor [name=name]').fill('项目协作');await page.locator('.group-editor [name=members][value=work]').check();await page.locator('.group-editor [name=members][value=life]').check();await page.locator('.group-editor [name=coordinatorRoleId]').selectOption('work');await page.getByRole('button',{name:'建群',exact:true}).click();await page.locator('[name=content]').waitFor();
 assert.equal(await page.locator('.group-composer [name=memoryConsent]').count(),0);assert.equal(await page.locator('[name=cloudConsent]').isChecked(),false);await page.locator('[name=content]').fill('@生活管家 检查本地时间');await page.getByRole('button',{name:'发送',exact:true}).click();await page.locator('.group-message.user').waitFor();
 // Group and main chat share one CSRF session. Replacing its cookie (another
 // window/restart recovery) must retry only a pre-dispatch authentication rejection.
 const authChecks=await page.evaluate(async()=>{
  const first=await api('/tasks',{prompt:'isolated auth check',roleId:'concierge',cloudConsent:false});
  await fetch('/api/session');
  const recovered=await api('/tasks',{prompt:'isolated refreshed auth check',roleId:'concierge',cloudConsent:false});
  return [first.id,recovered.id];
 });assert.equal(new Set(authChecks).size,2);
 let deniedCalls=0;await page.route('**/api/auth-denial-fixture',route=>{deniedCalls++;return route.fulfill({status:403,json:{error:{code:'denied',message:'not authorized'}}});});
 assert.equal(await page.evaluate(()=>api('/auth-denial-fixture',{}).then(()=>'',e=>e.code)),'denied');assert.equal(deniedCalls,1);
 const data=await page.evaluate(async()=>{const groups=await (await fetch('/api/groups')).json();return (await fetch('/api/groups/'+groups.groups[0].id)).json();});assert.equal(data.tasks.length,1);assert.equal(data.tasks[0].roleId,'life');assert.equal(data.tasks[0].status,'waiting_consent');assert.equal(data.messages.filter(m=>m.kind==='user').length,1);
 await page.getByRole('button',{name:'发送',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'发送',exact:true}).isEnabled(),true);
 const output=path.resolve(import.meta.dirname,'../qa/groups-preview');fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,'web-desktop.png')});await page.locator('[name=content]').fill('还未发送的群草稿');await page.waitForTimeout(4300);assert.equal(await page.locator('[name=content]').inputValue(),'还未发送的群草稿');

 // Change real polling responses while composing: the input must never leave the DOM.
 const changed=structuredClone(data);changed.messages.push({id:'poll-answer',kind:'assistant',roleId:'life',content:'状态更新，草稿应保持输入中\n\n**交付内容**\n\n| 项目 | 结果 |\n| --- | --- |\n| 视频 | 完成 |\n\n<script>window.injected=true</script>',artifacts:[{id:'ui-video',name:'预览视频.webm',mime:'video/webm',size:200} ]});
 changed.tasks[0].status='running';changed.tasks[0].title='仍在处理的老任务';changed.receipts=[];
 for(let n=0;n<30;n++)changed.tasks.push({id:'history-'+n,roleId:'life',status:'completed',title:'历史任务 '+n});
 await page.route('**/api/groups/'+data.id,route=>route.fulfill({json:changed}));
 await page.locator('[name=content]').focus();await page.evaluate(()=>{
   window.draftInput=document.querySelector('[name=content]');window.inputDetached=false;window.inputBlurred=0;
   draftInput.addEventListener('blur',()=>window.inputBlurred++);
   window.inputObserver=new MutationObserver(records=>{for(const record of records)for(const removed of record.removedNodes)if(removed===draftInput||removed.contains?.(draftInput))window.inputDetached=true;});
   inputObserver.observe(document.querySelector('.group-body'),{childList:true,subtree:true});
   draftInput.dispatchEvent(new CompositionEvent('compositionstart',{data:'正在'}));
 });
 await page.getByText('状态更新，草稿应保持输入中',{exact:true}).waitFor({timeout:6500});
 assert.deepEqual(await page.evaluate(()=>({same:document.activeElement===draftInput,detached:inputDetached,blurred:inputBlurred})),{same:true,detached:false,blurred:0});
 assert.equal(await page.locator('.group-message-content strong').last().textContent(),'交付内容');
 assert.equal(await page.locator('.group-message-content table').count(),1);
 assert.equal(await page.locator('.group-message video[controls]').count(),1);
 assert.equal(await page.locator('.group-message a[download]').count(),1);
 assert.equal(await page.evaluate(()=>window.injected),undefined);
 await page.evaluate(()=>window.originalVideo=document.querySelector('.group-message video'));
 assert.equal(await page.locator('[data-task-id="'+data.tasks[0].id+'"]').count(),1);
 assert.equal(await page.locator('.group-active [data-group-action=pause]').isVisible(),false);
 assert.ok((await page.locator('.group-active').boundingBox()).height<=48,'collapsed follow-up is a single row');
 await page.locator('.group-active>summary').click();
 assert.equal(await page.locator('.group-active [data-group-action=pause]').isVisible(),true);
 assert.equal(await page.locator('.group-receipts summary').textContent(),'已结束任务 · 30');
 await page.evaluate(()=>{draftInput.dispatchEvent(new CompositionEvent('compositionend',{data:'正在'}));inputObserver.disconnect();});
 await page.route('**/api/groups/'+data.id+'/tasks/*/pause',route=>route.fulfill({status:503,json:{error:{message:'临时断开，请重试'}}}));
 await page.locator('[data-group-action=pause]').click();await page.getByText('临时断开，请重试',{exact:true}).waitFor();
 assert.equal(await page.locator('[data-group-action=pause]').isEnabled(),true,'failed control remains retryable');
 await page.screenshot({path:path.join(output,'web-refresh-recovery.png')});

 for(let n=0;n<35;n++)changed.messages.push({id:'long-history-'+n,kind:'user',content:'历史内容 '+n+'，检查阅读位置在新结果到达时保持不变。'});
 await page.getByText('历史内容 34，检查阅读位置在新结果到达时保持不变。',{exact:true}).waitFor({timeout:6500});
 await page.evaluate(()=>document.querySelector('.group-transcript').scrollTop=document.querySelector('.group-transcript').scrollHeight);
 await page.waitForFunction(()=>!document.querySelector('.group-new-messages'));
 await page.locator('[name=content]').focus();await page.evaluate(()=>document.querySelector('.group-transcript').scrollTop=0);await page.waitForTimeout(100);
 changed.messages.push({id:'new-result',kind:'assistant',roleId:'life',content:'阅读历史期间到达的新结果'});
 await page.getByRole('button',{name:'1 条新消息 ↓',exact:true}).waitFor({timeout:6500});
 assert.equal(await page.locator('.group-active').evaluate(el=>el.open),true,'polling preserves expanded controls');
 assert.equal(await page.locator('.group-transcript').evaluate(el=>el.scrollTop),0,'new result does not move reading position');
 assert.equal(await page.locator('[name=content]').evaluate(el=>document.activeElement===el),true);
 await page.getByRole('button',{name:'1 条新消息 ↓',exact:true}).click();
 assert.equal(await page.locator('.group-transcript').evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight<5),true,'jump reaches latest result');
 assert.equal(await page.locator('.group-new-messages').count(),0);
 assert.equal(await page.evaluate(()=>document.querySelector('.group-message video')===window.originalVideo),true,'refresh preserves the existing media player');
 await page.unroute('**/api/groups/'+data.id);
 await page.getByRole('button',{name:'＋ 建群',exact:true}).click();await page.locator('.group-editor [name=name]').fill('第二资料群');await page.locator('.group-editor [name=members][value=work]').check();await page.locator('.group-editor [name=coordinatorRoleId]').selectOption('work');await page.getByRole('button',{name:'建群',exact:true}).click();await page.locator('[name=content]').waitFor();
 assert.equal(await page.locator('[name=content]').inputValue(),'');await page.locator('[name=content]').fill('第二群独立草稿');
 await page.locator('.group-nav button').filter({hasText:'项目协作'}).click();await page.locator('.group-conversation h3').filter({hasText:'项目协作'}).waitFor();assert.equal(await page.locator('[name=content]').inputValue(),'还未发送的群草稿');
 let release,entered;const gate=new Promise(resolve=>release=resolve),received=new Promise(resolve=>entered=resolve);
 t.after(()=>release());await page.route('**/api/groups/'+data.id+'/messages',async route=>{entered();await gate;await route.continue();});
 await page.getByRole('button',{name:'发送',exact:true}).click();await received;
 await page.locator('.group-nav button').filter({hasText:'第二资料群'}).click();await page.locator('.group-conversation h3').filter({hasText:'第二资料群'}).waitFor();assert.equal(await page.locator('[name=content]').inputValue(),'第二群独立草稿');
 const confirmed=page.waitForResponse(response=>response.url().endsWith('/groups/'+data.id+'/messages'));release();await confirmed;
 await page.waitForFunction(()=>document.querySelector('.group-composer button[type=submit]')?.textContent==='发送');assert.equal(await page.locator('[name=content]').inputValue(),'第二群独立草稿');
 await page.locator('.group-nav button').filter({hasText:'项目协作'}).click();await page.locator('.group-conversation h3').filter({hasText:'项目协作'}).waitFor();assert.equal(await page.locator('[name=content]').inputValue(),'');assert.equal(await page.locator('.group-message.user').count(),2);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'web-narrow.png')});const bounds=await page.getByRole('button',{name:'发送',exact:true}).boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390&&bounds.y+bounds.height<=844);assert.deepEqual(errors,[]);
});
