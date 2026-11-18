import test from 'node:test';
import assert from 'node:assert/strict';
import {PhoneTyping} from '../src/remote/phone-typing.mjs';

test('the waiting phone receives the text once and a repeated receipt stays duplicate',async()=>{
 const typing=new PhoneTyping({timeoutMs:1000,pollMs:1000});
 const waiting=typing.wait('device-1');
 const result=typing.request({deviceId:'device-1',text:'你好',mode:'insert'});
 assert.equal((await waiting).text,'你好');
 const job=await waiting;
 await typing.complete('device-1',job.id,'typed');
 assert.deepEqual(await result,{id:job.id,status:'typed'});
 assert.equal(typing.complete('device-1',job.id,'failed').duplicate,true);
 assert.throws(()=>typing.complete('other',job.id,'typed'),error=>error.code==='typing_expired');
});
test('another phone cannot take the job, and a missed phone times out without sending',async()=>{
 const typing=new PhoneTyping({timeoutMs:40,pollMs:30});
 const other=typing.wait('device-2');
 const result=typing.request({deviceId:'device-1',text:'猪脚饭',mode:'replace'});
 assert.equal(await other,null);
 await assert.rejects(result,/没有在限定时间内/);
 assert.equal(typing.pending,null);
});

test('wireless typing binds a job to the observed app and returns an unverified submission honestly',async()=>{
 const typing=new PhoneTyping({timeoutMs:1000,pollMs:1000});
 const result=typing.request({deviceId:'device-1',text:'无糖可乐',mode:'replace',packageName:'com.taobao.taobao'}),job=await typing.wait('device-1');
 assert.equal(job.packageName,'com.taobao.taobao');typing.complete('device-1',job.id,'submitted');assert.equal((await result).status,'submitted');
});

test('a delivered job remains exclusive and a missing receipt never falsely says it was not sent',async()=>{
 const typing=new PhoneTyping({timeoutMs:30,pollMs:100});
 const result=typing.request({deviceId:'device-1',text:'无糖可乐',mode:'replace'}),job=await typing.wait('device-1');
 assert.throws(()=>typing.request({deviceId:'device-1',text:'另一次',mode:'insert'}),{code:'phone_input_busy'});
 assert.equal((await result).status,'submitted');assert.equal(typing.complete('device-1',job.id,'typed').duplicate,true);
});

test('wireless editor diagnostics retain only enumerated stages and never arbitrary supplied content',async()=>{
 for(const [diagnostic,expected] of [['prepare_exception','prepare_exception'],['private message body',undefined]]){
  const typing=new PhoneTyping({timeoutMs:1000,pollMs:1000});const result=typing.request({deviceId:'device-1',text:'test',mode:'replace'});const job=await typing.wait('device-1');
  typing.complete('device-1',job.id,'failed',diagnostic);const receipt=await result;assert.equal(receipt.diagnostic,expected);assert.equal(JSON.stringify(receipt).includes('private message body'),false);
 }
});

test('verify-only work is never delivered to an old phone poll and cannot be acknowledged as typed',async()=>{
 const typing=new PhoneTyping({timeoutMs:1000,pollMs:15}),referenceId='00000000-0000-4000-8000-000000000001';
 const pending=typing.request({deviceId:'device-1',text:'exact',mode:'replace',packageName:'com.example.app',operation:'verify_replace',referenceId,controlEpoch:8});
 assert.equal(await typing.wait('device-1'),null);assert.equal(typing.results.values().next().value.delivered,false);
 const job=await typing.wait('device-1',{protocol:2});assert.equal(job.operation,'verify_replace');assert.equal(job.referenceId,referenceId);
 assert.throws(()=>typing.complete('device-1',job.id,'typed'),{code:'typing_invalid_proof'});
 assert.throws(()=>typing.complete('device-1',job.id,'verified','readback_verified',{referenceId,controlEpoch:9,editorIdentity:'a'.repeat(64),exact:true,reads:2}),{code:'typing_invalid_proof'});
 typing.complete('device-1',job.id,'verified','readback_verified',{referenceId,controlEpoch:8,editorIdentity:'a'.repeat(64),exact:true,reads:2,privateText:'never store'});
 const result=await pending;assert.equal(result.status,'verified');assert.equal(JSON.stringify(result).includes('never store'),false);
});
test('unknown operation is rejected and a missing verification receipt remains unverified',async()=>{
 const typing=new PhoneTyping({timeoutMs:20,pollMs:10});assert.throws(()=>typing.request({deviceId:'device-1',text:'x',operation:'future-write'}));
 const pending=typing.request({deviceId:'device-1',text:'exact',mode:'replace',packageName:'com.example.app',operation:'verify_replace',referenceId:'00000000-0000-4000-8000-000000000001',controlEpoch:8});await typing.wait('device-1',{protocol:2});assert.equal((await pending).status,'unverified');
});
