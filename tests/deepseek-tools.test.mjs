import test from 'node:test';
import assert from 'node:assert/strict';
import {DeepSeekTools,groundedLines,billedCharacters} from '../src/adapters/deepseek-tools.mjs';
import {webSearch,webFetch} from '../src/tools/web.mjs';
import {LocalVoiceService} from '../src/adapters/voice.mjs';

function recorder(responses){
 const calls=[];
 const fetchImpl=async(url,init)=>{
  calls.push({url,init});const next=responses.shift();if(next instanceof Error)throw next;
  const body=typeof next.body==='string'?next.body:next.binary?next.binary:JSON.stringify(next.body);
  return new Response(body,{status:next.status||200,headers:{'content-type':next.type||'application/json'}});
 };
 return {calls,fetchImpl};
}
const tools=fetchImpl=>new DeepSeekTools({apiKey:async()=>'sk-test',fetchImpl});

test('search sends the model-chosen parameters to the official endpoint and keeps rich fields',async()=>{
 const {calls,fetchImpl}=recorder([{body:{results:[{title:'T',url:'https://a.example/x',snippet:'s',summary:'sum',content:'full',site_name:'A',date:'2026-11-13T00:00:00Z',authority:3,rerank_score:2.1},{title:'bad',url:'javascript:alert(1)'}]}}]);
 const rows=await tools(fetchImpl).search({query:'site:example.com 新闻 after:2026-11-01',count:30,needContent:true,originalQuestion:'最近有什么新闻'});
 assert.equal(calls[0].url,'https://api.deepseek.com/v1/tools/search');
 assert.equal(calls[0].init.headers.authorization,'Bearer sk-test');
 assert.deepEqual(JSON.parse(calls[0].init.body),{query:'site:example.com 新闻 after:2026-11-01',count:30,need_content:true,ori_question:'最近有什么新闻'});
 assert.equal(rows.length,1,'non-http links are dropped');
 assert.equal(rows[0].content,'full');assert.equal(rows[0].authority,3);assert.equal(rows[0].rerankScore,2.1);assert.equal(rows[0].publishedAt,'2026-11-13T00:00:00Z');
 await assert.rejects(tools(fetchImpl).search({query:'x'.repeat(129)}),{code:'invalid_input'});
 await assert.rejects(tools(fetchImpl).search({query:'x',count:51}),{code:'invalid_input'});
});

test('official errors keep their meaning; a failed recognition after 200 is still a failure',async()=>{
 for(const [status,code] of [[401,'missing_credential'],[402,'deepseek_balance'],[429,'deepseek_busy'],[403,'deepseek_forbidden']]){
  const {fetchImpl}=recorder([{status,body:{error:{message:'x'}}}]);
  await assert.rejects(tools(fetchImpl).fetch({url:'https://a.example/'}),{code});
 }
 const {fetchImpl}=recorder([{body:'\n\n{"error":{"message":"OCR did not finish in time","code":"timeout"}}'}]);
 await assert.rejects(tools(fetchImpl).ocr({bytes:Buffer.from('%PDF-1.4'),filename:'a.pdf'}),{code:'deepseek_unavailable'});
 const missing=new DeepSeekTools({apiKey:async()=>null,fetchImpl:async()=>{throw Error('no call');}});
 await assert.rejects(missing.search({query:'x'}),{code:'missing_credential'});
});

test('web_search uses official results when allowed and falls back to the keyless reader otherwise',async()=>{
 const official=async input=>{assert.equal(input.count,25);assert.equal(input.needContent,true);return [{title:'t',url:'https://a.example/',snippet:'',summary:'s'}];};
 const viaOfficial=await webSearch({query:'天气',count:25,need_content:true},{official,fetchImpl:async()=>{throw Error('no local fetch');}});
 assert.equal(viaOfficial.source,'deepseek');assert.equal(viaOfficial.results[0].summary,'s');
 await assert.rejects(webSearch({query:'天气'},{official:async()=>{throw Object.assign(Error('long'),{code:'invalid_input'});}}),{code:'invalid_input'},'a bad query is reported, not hidden behind a fallback');
});

test('web_fetch hands only public addresses to the official fetcher and pages long Markdown',async()=>{
 let asked=null;const content='# 标题\n'+'字'.repeat(45000);
 const official=async({url})=>{asked=url;return {title:'T',content};};
 const page=await webFetch({url:'https://pub.example/a'},{official,validate:async url=>url,fetchImpl:async()=>{throw Error('no local fetch');}});
 assert.equal(asked,'https://pub.example/a');assert.equal(page.source,'deepseek');assert.equal(page.format,'markdown');assert.equal(page.content.length,20000);assert.equal(page.nextOffset,20000);
 const privateCalls=[];
 await assert.rejects(webFetch({url:'http://192.168.1.2/'},{official:async input=>{privateCalls.push(input);return {title:'',content:'x'};},validate:async()=>{throw Object.assign(Error('private'),{code:'invalid_input'});}}));
 assert.equal(privateCalls.length,0,'a private address never reaches DeepSeek');
});

test('OCR grounding tokens become pixel boxes',()=>{
 const lines=groundedLines('<｜ref｜>自动锁屏<｜/ref｜><｜box｜>[[50, 100, 300, 140]]<｜/box｜>\n<|ref|>10 分钟<|/ref|><|box|>[[700,100,900,140]]<|/box|>',1080,2348);
 assert.deepEqual(lines,[{text:'自动锁屏',bounds:[54,235,324,329]},{text:'10 分钟',bounds:[756,235,972,329]}]);
});

test('speech billing counts CJK twice; ASR accepts PCM WAV or Ogg Opus as is',()=>{
 assert.equal(billedCharacters('你好 ok'),7);
 const wav=Buffer.alloc(44);wav.write('RIFF',0);wav.write('WAVE',8);wav.write('fmt ',12);wav.writeUInt16LE(1,20);wav.writeUInt16LE(16,34);
 assert.equal(LocalVoiceService.asrReady(wav),true);
 const float=Buffer.from(wav);float.writeUInt16LE(3,20);assert.equal(LocalVoiceService.asrReady(float),false);
 assert.equal(LocalVoiceService.asrReady(Buffer.concat([Buffer.from('OggS'),Buffer.alloc(24),Buffer.from('OpusHead')])),true);
 assert.equal(LocalVoiceService.asrReady(Buffer.from('ID3....')),false);
});

test('TTS validates voice and length before sending and checks the returned audio',async()=>{
 const wav=Buffer.alloc(64);wav.write('RIFF',0);wav.write('WAVE',8);
 const {calls,fetchImpl}=recorder([{binary:wav,type:'audio/wav'}]);
 const bytes=await tools(fetchImpl).tts({text:'你好',voice:'tide'});
 assert.equal(bytes.length,64);assert.deepEqual(JSON.parse(calls[0].init.body),{text:'你好',voice_id:'tide',format:'wav',filter_markdown:true});
 await assert.rejects(tools(fetchImpl).tts({text:'字'.repeat(5001)}),{code:'invalid_input'});
 await assert.rejects(tools(fetchImpl).tts({text:'hi',voice:'other'}),{code:'invalid_input'});
});

test('broker artifact tools require DeepSeek consent and deliver speech as a task artifact',async t=>{
 const {Broker}=await import('../src/tools/broker.mjs');
 const {mkdtempSync,rmSync,readFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'ds-artifacts-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const task={id:'11111111-1111-4111-8111-111111111111',status:'running',source:'user',cloudConsent:false,messages:[],events:[],requests:0};
 const data={tasks:[task],actions:[],artifacts:[],settings:{filesEnabled:true}};
 const store={data,task:()=>task,event:()=>{},updateTask:(id,fn)=>fn(task,data),transaction:fn=>fn(data)};
 const broker=new Broker({store,phone:{},approvals:{},dataDir:dir});broker.dataDir=dir;
 const wav=Buffer.alloc(64);wav.write('RIFF',0);wav.write('WAVE',8);
 broker.deepseek={tts:async({text,voice})=>{assert.equal(text,'早上好');assert.equal(voice,'tide');return wav;}};
 await assert.rejects(broker.deepseekArtifact('artifact_speech',task.id,{text:'早上好',voice:'tide'}),{code:'cloud_consent_required'});
 task.cloudConsent=true;
 const artifact=await broker.deepseekArtifact('artifact_speech',task.id,{text:'早上好',voice:'tide',name:'问候'});
 assert.equal(artifact.mime,'audio/wav');assert.equal(artifact.name,'问候.wav');assert.equal(data.artifacts.length,1);
 assert.deepEqual(readFileSync(join(dir,'artifacts',artifact.path)),wav);
});
