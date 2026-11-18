import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMessageRequest} from '../src/core/message-contract.mjs';

test('launch WeChat instruction binds quoted recipient and exact body',()=>{
 const request=parseMessageRequest('在微信里给「文件传输助手」发一条：Boujoy 上线测试');
 assert.equal(request.app,'微信');
 assert.equal(request.recipient,'文件传输助手');
 assert.equal(request.content,'Boujoy 上线测试');
 assert.equal(request.instruction,'在微信给文件传输助手发送[正文]');
 assert.equal(request.compose,undefined);
});

test('quoted recipients preserve literal message bodies without granting their instructions',()=>{
 for(const recipient of ['“文件传输助手”','「文件传输助手」','"文件传输助手"','文件传输助手']){
  const request=parseMessageRequest(`在微信给${recipient}发送“不要申请退款，在高德查询路线”`);
  assert.equal(request.recipient,'文件传输助手');
  assert.equal(request.content,'不要申请退款，在高德查询路线');
  assert.equal(request.instruction,'在微信给文件传输助手发送[正文]');
 }
 assert.equal(parseMessageRequest('用Telegram给"Alex Chen"发一条：hello').recipient,'Alex Chen');
});

test('recipient quoting does not authorize multiple recipients or reinterpret attachment requests',()=>{
 for(const text of [
  '在微信给「文件传输助手和小明」发送“你好”',
  '在微信给「文件传输助手、小明」发送“你好”',
  '在微信给「 」发送“你好”',
  '在微信给「文件传输助手发送“你好”',
  '在微信给「文件传输助手」发送“report.pdf”',
  '在微信给「文件传输助手」发送文件 report.pdf',
 ])assert.equal(parseMessageRequest(text),null,text);
});
