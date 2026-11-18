import test from 'node:test';
import assert from 'node:assert/strict';
import {modelToolResult} from '../src/adapters/model-tool-result.mjs';
test('phone status reaches the model without pairing credentials or action logs',()=>{
 const raw={enabled:true,result:{content:[{type:'text',text:JSON.stringify({connected:true,link:'ready',listening:true,remainingMs:5000,token:'private-test-token',safetyCode:'private-test-code',pairingLink:'pony://private-test',log:[{text:'private-test-typed'}],futureSecret:'private-test-future'})}]}};
 const result=modelToolResult('phone_status',{content:[{type:'text',text:JSON.stringify(raw)}]});
 assert.equal(JSON.stringify(result).includes('private-test'),false);
 assert.deepEqual(JSON.parse(result.content[0].text),{enabled:true,connected:true,link:'ready',listening:true,display:'main',remainingMs:5000});
});
test('unexpected phone status shapes fail closed without echoing their content',()=>{
 const raw={content:[{type:'text',text:'private malformed data'}],structuredContent:{secret:'private'}};
 const result=modelToolResult('phone_status',raw);
 assert.equal(JSON.stringify(result).includes('private'),false);
 assert.equal(JSON.parse(result.content[0].text).connected,false);
 assert.equal(modelToolResult('phone_observe',raw),raw);
});


test('phone completion guidance cites only actual Boujoy observation refs and preserves native proof',()=>{
 const result={content:[{type:'text',text:JSON.stringify({observationId:'screen-current',stability:'fresh'})},{type:'text',text:JSON.stringify({request_id:'native-unknown',action_executed:null})}]};
 const reply=modelToolResult('phone_use',result);assert.deepEqual(JSON.parse(reply.content[0].text).finishEvidenceRefs,['screen-current']);assert.deepEqual(reply.content.slice(1),result.content);
});
