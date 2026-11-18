import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

test('the MCP bridge announces listChanged and notifies when the session moves to a task with a new catalog',async t=>{
 let version=0,auth=null;
 const server=http.createServer((req,res)=>{auth=req.headers.authorization;let body='';req.on('data',c=>body+=c);req.on('end',()=>{res.setHeader('Content-Type','application/json');if(req.url==='/internal/tools/version')return res.end(JSON.stringify({version}));if(req.url==='/internal/tools/list')return res.end(JSON.stringify({tools:[]}));res.statusCode=404;res.end('{}');});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const child=spawn(process.execPath,[new URL('../src/adapters/mcp-bridge.mjs',import.meta.url).pathname],{env:{...process.env,BOUJOY_INTERNAL_URL:`http://127.0.0.1:${server.address().port}/internal`,BOUJOY_RUNTIME_TOKEN:'tok'},stdio:['pipe','pipe','inherit']});
 t.after(()=>child.kill());
 const lines=[];createInterface({input:child.stdout}).on('line',line=>lines.push(JSON.parse(line)));
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})+'\n');
 await new Promise(r=>setTimeout(r,1300));
 assert.equal(lines.find(l=>l.id===1).result.capabilities.tools.listChanged,true);assert.equal(auth,'Bearer tok');
 assert.equal(lines.some(l=>l.method==='notifications/tools/list_changed'),false,'no notification while the version is unchanged');
 version=1;await new Promise(r=>setTimeout(r,1300));
 assert.equal(lines.filter(l=>l.method==='notifications/tools/list_changed').length,1);
});
