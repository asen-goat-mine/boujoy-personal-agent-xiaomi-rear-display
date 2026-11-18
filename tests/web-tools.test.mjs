import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBingResults,htmlToText,fetchPublic,webSearch,webFetch} from '../src/tools/web.mjs';
import {AppError} from '../src/core/errors.mjs';
import {toolExecutionDomains} from '../src/core/execution-permissions.mjs';

const BING=`<html><body><ol id="b_results">
<li class="b_algo"><h2><a href="https://weather.example.com/la" h="ID=1">洛杉矶 <strong>天气</strong> 预报</a></h2><div class="b_caption"><p>明天晴，最高 26&deg;C &amp; 微风。</p></div></li>
<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&p=x&u=a1${Buffer.from('https://news.example.org/a?b=1').toString('base64').replace(/=+$/,'')}&ntb=1">新闻 &quot;标题&quot;</a></h2><p>摘要二</p></li>
<li class="b_algo"><h2><a href="/relative">bad</a></h2></li>
</ol></body></html>`;
const allowAll=async url=>new URL(url).href;
function fakeFetch(routes){const calls=[];const fn=async(url,init)=>{calls.push({url,init});const route=routes[url];if(!route)throw new Error('offline');const body=new TextEncoder().encode(route.body||'');return {status:route.status||200,headers:new Headers(route.headers||{'content-type':'text/html; charset=utf-8'}),body:new ReadableStream({start(c){c.enqueue(body);c.close();}})};};fn.calls=calls;return fn;}

test('Bing results are parsed tolerantly, wrapped links unwrapped and relative links dropped',()=>{
 const rows=parseBingResults(BING);assert.equal(rows.length,2);
 assert.deepEqual(rows[0],{title:'洛杉矶 天气 预报',url:'https://weather.example.com/la',snippet:'明天晴，最高 26°C & 微风。'});
 assert.equal(rows[1].url,'https://news.example.org/a?b=1');assert.equal(rows[1].title,'新闻 "标题"');
});
test('page text drops scripts and styles and keeps headings and list items readable',()=>{
 const {title,text}=htmlToText('<html><head><title>A &amp; B</title><style>.x{}</style></head><body><script>alert(1)</script><h1>标题</h1><p>第一段</p><ul><li>一</li><li>二</li></ul></body></html>');
 assert.equal(title,'A & B');assert.doesNotMatch(text,/alert|\.x\{/);assert.match(text,/## 标题/);assert.match(text,/- 一\n- 二/);
});
test('every redirect hop is re-validated so a public page cannot bounce to a private address',async()=>{
 const validate=async url=>{if(/127\.0\.0\.1|192\.168\./.test(url))throw new AppError('invalid_input','不允许访问本地或私有网络');return url;};
 const fetchImpl=fakeFetch({'https://a.example/':{status:302,headers:{location:'http://127.0.0.1:18791/api/state'}}});
 await assert.rejects(fetchPublic('https://a.example/',{fetchImpl,validate}),/私有网络/);assert.equal(fetchImpl.calls.length,1);
 assert.equal(fetchImpl.calls[0].init.redirect,'manual');assert.equal(fetchImpl.calls[0].init.headers.Cookie,undefined);
});
test('search falls back to the second host and reports untrusted results; fetch pages long text',async()=>{
 const fetchImpl=fakeFetch({[`https://cn.bing.com/search?q=${encodeURIComponent('洛杉矶天气')}&setlang=zh-Hans&count=12`]:{body:BING}});
 const result=await webSearch({query:'洛杉矶天气'},{fetchImpl,validate:allowAll});assert.equal(result.source,'cn.bing.com');assert.equal(result.results.length,2);assert.equal(result.untrustedContent,true);
 const long='<p>'+'字'.repeat(25000)+'</p>';const page=await webFetch({url:'https://long.example/'},{fetchImpl:fakeFetch({'https://long.example/':{body:long}}),validate:allowAll});
 assert.equal(page.content.length,20000);assert.equal(page.nextOffset,20000);
 const next=await webFetch({url:'https://long.example/',offset:24000},{fetchImpl:fakeFetch({'https://long.example/':{body:long}}),validate:allowAll});assert.equal(next.nextOffset,null);
 await assert.rejects(webFetch({url:'https://gone.example/'},{fetchImpl:fakeFetch({'https://gone.example/':{status:404,body:'nope'}}),validate:allowAll}),{code:'web_http_error'});
});
test('GBK pages decode correctly and web tools obey the browser switch',async()=>{
 const gbk=Buffer.from([0x3c,0x70,0x3e,0xc4,0xe3,0xba,0xc3,0x3c,0x2f,0x70,0x3e]);// <p>你好</p>
 const fetchImpl=async()=>({status:200,headers:new Headers({'content-type':'text/html; charset=gb2312'}),body:new ReadableStream({start(c){c.enqueue(gbk);c.close();}})});
 const page=await webFetch({url:'https://gbk.example/'},{fetchImpl,validate:allowAll});assert.equal(page.content,'你好');
 assert.deepEqual(toolExecutionDomains('web_search'),['browser']);assert.deepEqual(toolExecutionDomains('web_fetch'),['browser']);
});

import {deepseekSearch,mapDeepSeekSearch,DEEPSEEK_SEARCH_URL} from '../src/tools/web.mjs';
const DS={content:[{type:'server_tool_use',name:'web_search'},{type:'web_search_tool_result',content:[{type:'web_search_result',url:'https://a.example/1',title:'洛杉矶天气',page_age:'2026-10-31'},{type:'web_search_result',url:'https://a.example/1',title:'dup'},{type:'web_search_result',url:'javascript:alert(1)',title:'bad'}]},{type:'text',text:'明天晴',citations:[{url:'https://a.example/1',cited_text:'明天晴，26°C'}]}],usage:{input_tokens:10,output_tokens:20}};
test('DeepSeek native search maps result blocks with citation snippets, dedupes and drops unsafe links',async()=>{
 assert.deepEqual(mapDeepSeekSearch(DS),[{title:'洛杉矶天气',url:'https://a.example/1',snippet:'明天晴，26°C',publishedAt:'2026-10-31'}]);
 assert.throws(()=>mapDeepSeekSearch({content:[{type:'text',text:'I think…'}]}),{code:'web_provider_error'});
 let sent;const found=await deepseekSearch('洛杉矶天气',{apiKey:'k',fetchImpl:async(url,init)=>{sent={url,init,body:JSON.parse(init.body)};return {ok:true,status:200,json:async()=>DS};}});
 assert.equal(sent.url,DEEPSEEK_SEARCH_URL);assert.equal(sent.init.headers['x-api-key'],'k');assert.equal(sent.body.tools[0].type,'web_search_20250305');assert.equal(found.results.length,1);assert.deepEqual(found.usage,DS.usage);
 await assert.rejects(deepseekSearch('x',{apiKey:''}),{code:'missing_credential'});
});
test('web_search prefers DeepSeek and falls back to the keyless reader only when it fails',async()=>{
 const viaDeepSeek=await webSearch({query:'天气'},{deepseek:async()=>({results:[{title:'t',url:'https://a.example/',snippet:''}]}),fetchImpl:async()=>{throw new Error('should not fetch');}});assert.equal(viaDeepSeek.source,'deepseek');
 const fetchImpl=fakeFetch({[`https://www.bing.com/search?q=${encodeURIComponent('天气')}&setlang=zh-Hans&count=12`]:{body:BING}});
 const fallback=await webSearch({query:'天气'},{deepseek:async()=>{throw new AppError('web_provider_error','down',502);},fetchImpl,validate:allowAll});assert.equal(fallback.source,'www.bing.com');
 await assert.rejects(webSearch({query:'天气'},{deepseek:async()=>{throw new AppError('daily_request_budget','用完了',429);},fetchImpl,validate:allowAll}),{code:'daily_request_budget'});
});

import {Broker} from '../src/tools/broker.mjs';
import {modelToolResult} from '../src/adapters/model-tool-result.mjs';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
test('real broker web_fetch wraps a 20000-character page as MCP text instead of spreading its characters',async()=>{
 const task={id:'web',status:'running',source:'user',messages:[],events:[],requests:0},data={tasks:[task],actions:[],settings:{browserEnabled:true}};
 const store={data,task:()=>task,event:()=>{},updateTask:(id,fn)=>fn(task,data)};
 const broker=new Broker({store,phone:{},approvals:{}});
 broker.web={fetch:args=>webFetch(args,{fetchImpl:fakeFetch({'https://long.example/':{body:'<p>'+'字'.repeat(30000)+'</p>'}}),validate:allowAll})};
 const wire=modelToolResult('web_fetch',await broker.execute('web','web_fetch',{url:'https://long.example/'}));
 assert.equal(CallToolResultSchema.safeParse(wire).success,true);
 assert.equal(JSON.parse(wire.content[0].text).content.length,20000);
 assert.equal(JSON.parse(wire.content[0].text).nextOffset,20000);
 assert.ok(wire.content.length<=3);assert.ok(Buffer.byteLength(JSON.stringify(wire))<80000,'one text block, not one block per character');
});

test('a page that times out while its body is still arriving is reported as unreachable',async()=>{
  const {fetchPublic}=await import('../src/tools/web.mjs');
  const fetchImpl=async()=>({status:200,headers:new Headers({'content-type':'text/html'}),body:{getReader:()=>({read:async()=>{throw new DOMException('The operation timed out.','TimeoutError');},cancel:async()=>{}})}});
  await assert.rejects(fetchPublic('https://example.com/',{fetchImpl,validate:async url=>url}),e=>e.code==='web_unreachable'&&/读取超时/.test(e.message));
});
