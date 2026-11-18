import test from 'node:test';
import assert from 'node:assert/strict';
import {fullHarnessPatches} from '../src/adapters/harness-full-profile.mjs';
test('each full Harness process gets its own session folder so a continued task can create its session again',()=>{
 const personal=[{id:'llm-deepseek',config:{maxTokens:8192}},{insert:[{id:'personal-tools',config:{}}]}];
 const at=root=>fullHarnessPatches({root:'/app',home:'/data/harness/t1',sessionId:'t1',personal,systemPrompt:'p',sessionRoot:root}).find(p=>p.id==='session-persistence-jsonl').config.root;
 assert.equal(at('/data/harness/t1/full-sessions-a'),'/data/harness/t1/full-sessions-a');
 assert.notEqual(at('/data/harness/t1/full-sessions-a'),at('/data/harness/t1/full-sessions-b'));
 assert.equal(fullHarnessPatches({root:'/app',home:'/h',sessionId:'t1',personal,systemPrompt:'p'}).find(p=>p.id==='session-persistence-jsonl').config.root,'/h/full-sessions','default kept for callers that pass none');
});
