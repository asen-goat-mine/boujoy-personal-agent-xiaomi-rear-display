import test from 'node:test';
import assert from 'node:assert/strict';
import {modelRequestStats,modelErrorPreview} from '../src/core/model-diagnostics.mjs';
test('model diagnostics count nested tool images and UTF-8 bytes without exposing contents',()=>{
 const data={system:'私密',tools:[{name:'private-tool'}],messages:[{role:'user',content:[{type:'tool_result',content:[{type:'image',source:{data:'secret-image'}}]}]}],max_tokens:8192};
 const stats=modelRequestStats(data);assert.equal(stats.requestBytes,Buffer.byteLength(JSON.stringify(data)));assert.equal(stats.images,1);assert.equal(stats.hasImage,true);assert.equal(stats.toolResults,1);assert.equal(stats.tools,1);assert.ok(stats.toolResultBytes>stats.imageBytes);assert.doesNotMatch(JSON.stringify(stats),/私密|private-tool|secret-image/);
});
test('provider preview is bounded and redacts reflected text, secrets and unexpected fields',()=>{
 const preview=modelErrorPreview(JSON.stringify({error:{type:'invalid_request_error',message:'Maximum context length is 1000000 tokens. Requested 1005000 tokens. sk-example secretUserWords 私密 https://example.test/private',api_key:'secret'}}));
 assert.match(preview.message,/1000000 tokens/);assert.doesNotMatch(JSON.stringify(preview),/sk-example|secretUserWords|私密|example.test|api_key/);
 assert.doesNotMatch(JSON.stringify(modelErrorPreview('x'.repeat(2048)+'SHOULD_NOT_READ')),/SHOULD_NOT_READ/);
});
