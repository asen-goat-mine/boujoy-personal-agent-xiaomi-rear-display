import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {nativeToolDetail} from '../src/core/engine.mjs';

const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const tools=source.slice(source.indexOf('const TOOLS='),source.indexOf('\n',source.indexOf('const TOOLS=')));
const block=source.slice(source.indexOf('const NATIVE_TOOLS='),source.indexOf('const REPORT_NOTE='));
const web=new Function('esc',tools+'\n'+block+';return {turnSteps,stepsMarkup,childrenMarkup,stepLabel};')(v=>String(v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])));

test('a native tool call is described by its command, file or query, never by what it writes',()=>{
  assert.equal(nativeToolDetail({name:'bash',arguments:{command:'ls  -la\n~/Desktop'}}),'ls -la ~/Desktop');
  assert.equal(nativeToolDetail({name:'write',arguments:{file_path:'/tmp/a.txt',content:'secret body'}}),'/tmp/a.txt');
  assert.equal(nativeToolDetail({name:'x',arguments:{content:'only content'}}),'');
  assert.equal(nativeToolDetail({name:'x'}),'');assert.equal(nativeToolDetail({arguments:{command:'x'.repeat(500)}}).length,160);
});

test('the steps of a turn list Boujoy and native tools in order, fold repeats and stay inside the turn',()=>{
  const view={messages:[{role:'user',turn:0,at:'2026-01-01T00:00:00Z'},{role:'assistant',turn:0,at:'2026-01-01T00:01:00Z'},{role:'user',turn:1,at:'2026-01-01T00:02:00Z'}]};
  const t={events:[
    {type:'tool',tool:'task_context',at:'2026-01-01T00:00:01Z'},
    {type:'tool',tool:'phone_use',action:'tap',at:'2026-01-01T00:00:02Z'},{type:'tool',tool:'phone_use',action:'tap',at:'2026-01-01T00:00:03Z'},
    {type:'harness_tool',phase:'tool/call',tool:'mcp__personal__phone_use',at:'2026-01-01T00:00:03Z'},
    {type:'harness_tool',phase:'tool/call',tool:'bash',detail:'ls <b>',at:'2026-01-01T00:00:04Z'},
    {type:'harness_tool',phase:'tool/result',tool:'bash',at:'2026-01-01T00:00:05Z'},
    {type:'tool',tool:'finish_task',at:'2026-01-01T00:00:06Z'},
    {type:'tool',tool:'browser_open',at:'2026-01-01T00:03:00Z'}]};
  const steps=web.turnSteps(t,view,0);
  assert.deepEqual(steps.map(s=>[s.label,s.count]),[['操作手机（点按）',2],['运行命令：ls <b>',1]]);
  assert.deepEqual(web.turnSteps(t,view,1).map(s=>s.label),['打开网页']);
  const html=web.stepsMarkup(steps);assert.match(html,/×2/);assert.match(html,/ls &lt;b&gt;/);assert.equal(web.stepsMarkup([]),'');
});

test('subagents are shown by name and state',()=>{
  const html=web.childrenMarkup({harnessChildren:[{id:'a',label:'查<价格>',status:'running'},{id:'b',label:'写总结',status:'completed'}]});
  assert.match(html,/查&lt;价格&gt;/);assert.match(html,/is-running/);assert.match(html,/已完成/);assert.equal(web.childrenMarkup({}),'');
});
