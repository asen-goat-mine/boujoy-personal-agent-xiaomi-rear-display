import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const context=vm.createContext({esc:escape});
vm.runInContext(source.slice(source.indexOf('function normalizeMessage('),source.indexOf('function approvals(')),context);
const view=t=>JSON.parse(JSON.stringify(context.conversationView(t)));
const u=content=>({role:'user',content}),a=content=>({role:'assistant',content});
test('each user turn keeps its final answer and preserves intermediate output in process',()=>{
 const t={status:'completed',messages:[u('first'),a('checking'),a('answer one'),u('second'),a('searching'),a('answer two')],result:'answer two'};
 const v=view(t);assert.deepEqual(v.messages.map(m=>m.content),['first','answer one','second','answer two']);assert.deepEqual(v.process.map(m=>m.content),['checking','searching']);assert.equal(t.messages.length,6);
});
test('while running only current intermediate output folds away; prior answer stays visible',()=>{
 for(const status of ['queued','running','waiting_children','waiting_approval']){const v=view({status,messages:[u('one'),a('done one'),u('two'),a('still checking')]});assert.deepEqual(v.messages.map(m=>m.content),['one','done one','two']);assert.equal(v.process[0].content,'still checking');}
});
test('authoritative result remains final even when later commentary follows it',()=>{
 const v=view({status:'ready_for_user',result:'Ready for payment',messages:[u('order'),a('Ready for payment'),a('process ended')]});assert.equal(v.messages.at(-1).content,'Ready for payment');assert.equal(v.process.length,1);assert.equal(v.process[0].content,'process ended');
});
test('duplicate final summary does not repeat; distinct details remain recoverable',()=>{
 const v=view({status:'completed',result:'done',messages:[u('one'),a('checking'),a('checking'),a('done'),a(' done ')]});assert.equal(v.messages.length,2);assert.equal(v.process.length,1);
});
test('failure, stopped and incomplete runs retain their last reply',()=>{
 for(const status of ['failed','blocked','cancelled','needs_review']){const v=view({status,messages:[u('go'),a('useful partial answer')]});assert.equal(v.messages.at(-1).content,'useful partial answer');}
});
test('result-only tasks and non-assistant roles do not manufacture empty replies',()=>{
 assert.equal(view({status:'completed',result:'done',messages:[]}).messages[0].content,'done');assert.equal(view({status:'running',messages:[u('go'),{role:'tool',content:'internal'}]}).messages.length,1);
});
test('markdown renders structured text and escapes untrusted HTML, including code',()=>{
 const html=context.messageMarkup('# Title\n\n1. First\n2. **Second**\n\n<script>alert(1)</script>\n\n```js\n<b>unsafe</b>\n```');assert.match(html,/<h3>Title<\/h3>/);assert.match(html,/<ol start="1">/);assert.match(html,/<strong>Second<\/strong>/);assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<b>'));assert.match(html,/&lt;script&gt;/);
});

const at=n=>`2026-10-14T13:26:59.${String(n).padStart(3,'0')}Z`;
function legacyChat(summary){return {kind:'general',status:'needs_review',messages:[{...u('你在干嘛'),at:at(1)},{...a('我在呢，随时可以帮你干活。'),at:at(100)},{...a(summary),at:at(160)},{...u('下一句'),at:at(300)},a('新的回复')],events:[{type:'model_timing',at:at(90)},{type:'tool',tool:'finish_task',at:at(150)},{type:'tool_timing',tool:'finish_task',at:at(200)}]};}
test('legacy conversational bookkeeping does not replace the actual reply, even after another user turn',()=>{
 const v=view(legacyChat('用户只是闲聊，已正常回应。'));assert.equal(v.messages[1].content,'我在呢，随时可以帮你干活。');assert.equal(v.process.length,0);
});
test('genuine blocked and actionable reports are not removed by legacy chat repair',()=>{
 for(const summary of ['连接失败，任务未完成。','已生成报告，请查收。'])assert.equal(view(legacyChat(summary)).messages[1].content,summary);
});
test('a third-person task report never replaces the real reply, even after tool work; it stays in that turn\'s process',()=>{const t=legacyChat('用户询问的事项已处理。');t.events.unshift({type:'tool',tool:'artifact_write',at:at(50)});const v=view(t);assert.equal(v.messages[1].content,'我在呢，随时可以帮你干活。');assert.deepEqual(v.process.map(p=>[p.content,p.turn]),[['用户询问的事项已处理。',0]]);
 assert.equal(view({status:'completed',messages:[u('hi'),a('用户只是打招呼，已回复。')]}).messages[1].content,'用户只是打招呼，已回复。','a report alone is still shown rather than nothing');});
test('real earlier replies in a turn stay visible; step notes and repeats fold into that turn only',()=>{
 const long='先说明：我这边没有自检或修复底层的工具，改不了自己的运行机制。但我能修的是上次真正坏掉的那一步——答应重做策划案却没动手。';
 const v=view({status:'completed',messages:[u('修一下'),a('我先把上次没兑现的事补完。'),a(long),a(long.replace('先说明：','')),a('新版策划案已生成，见附件。'),u('好'),a('收到。')]});
 assert.deepEqual(v.messages.map(m=>m.content),['修一下',long,'新版策划案已生成，见附件。','好','收到。']);
 assert.deepEqual(v.process.map(p=>p.turn),[0,0],'folded notes belong to the first turn, not the newest');
 assert.deepEqual(v.messages.map(m=>m.turn),[0,0,0,1,1]);
});
test('process hides routine timing and finish bookkeeping but keeps errors and real actions',()=>{
 const events=[{type:'model_timing'},{type:'tool_timing'},{type:'turn'},{type:'tool',tool:'finish_task'},{type:'error',text:'失败'},{type:'tool',tool:'browser_read'}];assert.deepEqual(JSON.parse(JSON.stringify(context.conversationEvents({events}))),events.slice(4));
});

test('tables render semantic cells and preserve inline code pipes and escaped separators',()=>{
 const html=context.messageMarkup('| 名称 | 条件 |\n| --- | --- |\n| **咖啡** | `a|b` 与 c\\|d |');
 assert.match(html,/<table>/);assert.equal((html.match(/<th scope="col">/g)||[]).length,2);assert.equal((html.match(/<td>/g)||[]).length,2);assert.match(html,/<code>a\|b<\/code>/);assert.match(html,/c\|d/);
 assert.ok(!context.messageMarkup('a | b\n--- | nope\nc | d').includes('<table>'));
 assert.match(context.messageMarkup('a | b\n--- | ---\nc | d | e'),/c \| d \| e/,'malformed rows stay visible');
});
test('safe links work without executable schemes or automatic remote resources',()=>{
 const html=context.messageMarkup('[报告](https://example.com/report?q=1&x=2) https://example.com/test。\n[x](javascript:alert(1)) [x](data:text/html,x) <img src="https://example.com/pixel">');
 assert.match(html,/href="https:\/\/example.com\/report\?q=1&amp;x=2"/);assert.match(html,/rel="noopener noreferrer"/);assert.match(html,/href="https:\/\/example.com\/test"[^>]*>https:\/\/example.com\/test<\/a>。/);
 assert.ok(!html.includes('href="javascript:'));assert.ok(!html.includes('href="data:'));assert.ok(!html.includes('<img'));
});
test('code is literal and unfinished fences retain the entire answer',()=>{
 assert.equal(context.messageMarkup('`**not bold**`'),'<p><code>**not bold**</code></p>');
 const code='const a = "中文 👨‍👩‍👧‍👦";\n<script>x</script>\n**literal**';const html=context.messageMarkup('```js\n'+code);
 assert.match(html,/const a = &quot;中文 👨‍👩‍👧‍👦&quot;;/);assert.match(html,/&lt;script&gt;x&lt;\/script&gt;/);assert.match(html,/\*\*literal\*\*/);assert.ok(!html.includes('<strong>'));
});

test('running status names the current action, and general handoffs never imply payment',()=>{
 const c=vm.createContext({esc:escape,online:true,performance:{now:()=>100},STATUS:{running:'正在处理',ready_for_user:'等你接手'},conversationView:()=>({messages:[]}),normalizeMessage:context.normalizeMessage});
 vm.runInContext(source.slice(source.indexOf('function robotCompanion('),source.indexOf('function statusTag(')),c);
 assert.match(c.robotCompanion({status:'running'},'查看手机页面'),/查看手机页面/);assert.ok(!c.robotCompanion({status:'running'},'查看手机页面').includes('正在思考'));
 assert.match(c.robotCompanion({status:'ready_for_user'},'等你接手'),/等你接手/);assert.ok(!c.robotCompanion({status:'ready_for_user'},'等你接手').includes('付款'));
});


test('links preserve balanced parentheses in real article destinations',()=>{
 for(const input of ['[文章](https://example.com/Foo_(bar))','https://example.com/Foo_(bar)。']){const html=context.messageMarkup(input);assert.match(html,/href="https:\/\/example.com\/Foo_\(bar\)"/);assert.equal((html.match(/<a /g)||[]).length,1);}
 assert.match(context.messageMarkup('(https://example.com/report)'),/href="https:\/\/example.com\/report"/);
});
test('a conversation spanning several execution tasks shows every earlier turn, not just the newest task',()=>{
 const t={id:'b',status:'completed',result:'后天多云。',messages:[u('那后天呢'),a('后天多云。')],
  conversation:{id:'a',taskIds:['a','b'],messages:[{...u('明天天气'),taskId:'a'},{...a('明天晴。'),taskId:'a'},{...u('那后天呢'),taskId:'b'},{...a('后天多云。'),taskId:'b'}]}};
 const v=view(t);assert.deepEqual(v.messages.map(m=>m.content),['明天天气','明天晴。','那后天呢','后天多云。']);assert.equal(v.messages[1].taskId,'a');
});

test('server: a third-person finish summary does not become a second reply when the model already answered',async()=>{
 const {settleReply}=await import('../src/core/engine.mjs');
 const t={result:'用户只是闲聊询问我在做什么，已正常回应。',messages:[{role:'user',content:'你在干嘛'},{role:'assistant',content:'我在呢，随时可以帮你干活。'}]};
 settleReply(t);assert.equal(t.messages.length,2);assert.equal(t.result,'我在呢，随时可以帮你干活。');
 const real={result:'已到确认订单页，实付 ¥15.9，请你付款。',messages:[{role:'user',content:'点咖啡'},{role:'assistant',content:'我先打开美团。'}]};
 settleReply(real);assert.equal(real.messages.at(-1).content,'已到确认订单页，实付 ¥15.9，请你付款。','a real report is still delivered');
 const alone={result:'用户只是打招呼。',messages:[{role:'user',content:'hi'}]};settleReply(alone);assert.equal(alone.messages.at(-1).content,'用户只是打招呼。','never leaves the user with nothing');
});


test('a draft animation is bound to its conversation and cannot leak after a switch',()=>{
 let tick=null,cleared=0;const c=vm.createContext({detail:{id:'old',liveDraft:''},matchMedia:()=>({matches:false}),renderTimeline(){},clearInterval(){cleared++;},setInterval(fn){tick=fn;return 1;}});
 vm.runInContext(source.slice(source.indexOf("let draftTarget="),source.indexOf('// Completed replies are shown')),c);
 c.typeDraft('OLD CONVERSATION TEXT');c.detail={id:'new',liveDraft:''};tick();assert.equal(c.detail.liveDraft,'');assert.ok(cleared>0);
 c.typeDraft('NEW CONVERSATION TEXT');tick();assert.ok(c.detail.liveDraft.length>0);assert.ok('NEW CONVERSATION TEXT'.startsWith(c.detail.liveDraft));
});
