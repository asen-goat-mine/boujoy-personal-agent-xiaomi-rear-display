import {AppError,requireValue} from '../core/errors.mjs';

// DeepSeek's standalone application APIs (search, fetch, OCR, speech to text,
// text to speech). They use the same account key as the model. Every result is
// untrusted data. Callers decide whether the user allowed content to leave the
// Mac; this client only talks to the official endpoints.
export const DEEPSEEK_BASE='https://api.deepseek.com';
const OCR_PURPOSES=new Set(['text_recognition','rich_layout_recognition']);
export const TTS_VOICES=new Set(['stella','tide']);

function failure(status,body,fallback){
 const detail=typeof body?.error?.message==='string'?body.error.message.slice(0,200):typeof body?.message==='string'?body.message.slice(0,200):'';
 const map={400:['deepseek_invalid_request',`DeepSeek 拒绝了这个请求${detail?'：'+detail:''}`],401:['missing_credential','DeepSeek 凭证无效，请在设置里重新连接模型'],402:['deepseek_balance','DeepSeek 账户余额不足'],403:['deepseek_forbidden','DeepSeek 按安全策略拒绝了这个请求'],404:['deepseek_not_found','DeepSeek 没有取到可用内容'],408:['deepseek_timeout','上传到 DeepSeek 超时'],413:['deepseek_too_large','文件超过 DeepSeek 的大小上限'],429:['deepseek_busy','DeepSeek 当前请求过多，请稍后再试'],500:['deepseek_unavailable','DeepSeek 服务出错'],503:['deepseek_unavailable','DeepSeek 服务繁忙，请稍后再试'],504:['deepseek_timeout','DeepSeek 处理超时']};
 const [code,message]=map[status]||['deepseek_unavailable',fallback||`DeepSeek 返回 HTTP ${status}`];
 return Object.assign(new AppError(code,message,status>=500||status===429?503:409),{deepseekStatus:status,retryable:[408,429,500,503,504].includes(status)});
}

export class DeepSeekTools{
 // apiKey: async () => key. Kept out of logs and results.
 constructor({apiKey,fetchImpl=fetch,base=DEEPSEEK_BASE}={}){Object.assign(this,{apiKey,fetchImpl,base});}
 async request(pathname,{json,form,signal,timeoutMs=60000,binary=false}={}){
  const key=await this.apiKey();if(!key)throw new AppError('missing_credential','模型凭证尚未配置',503);
  const timeout=AbortSignal.timeout(timeoutMs),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  let response;
  try{
   response=await this.fetchImpl(this.base+pathname,{method:'POST',redirect:'error',signal:combined,headers:{authorization:`Bearer ${key}`,...(json?{'content-type':'application/json'}:{})},body:json?JSON.stringify(json):form});
  }catch(error){
   if(signal?.aborted)throw new AppError('cancelled','任务已停止',409);
   if(timeout.aborted)throw Object.assign(new AppError('deepseek_timeout','DeepSeek 处理超时',503),{retryable:true});
   throw Object.assign(new AppError('deepseek_unavailable','连不上 DeepSeek',503),{retryable:true});
  }
  if(!response.ok){let body=null;try{body=await response.json();}catch{}throw failure(response.status,body);}
  if(binary)return {bytes:Buffer.from(await response.arrayBuffer()),contentType:response.headers.get('content-type')||''};
  // OCR keeps the connection alive with leading newlines; JSON.parse ignores them.
  const text=await response.text();
  let body;try{body=JSON.parse(text);}catch{throw new AppError('deepseek_invalid_response','DeepSeek 返回的内容无法解析',502);}
  // A recognition that fails after starting still answers 200 with an error object.
  if(body&&typeof body==='object'&&!Array.isArray(body)&&body.error&&!body.pages)throw failure(500,body,'DeepSeek 处理失败');
  return body;
 }
 async search({query,count=10,needContent=false,originalQuestion},{signal}={}){
  const q=String(query||'').trim();
  requireValue([...q].length>=1&&[...q].length<=128,'搜索词需要 1 到 128 个字符；太长请拆成几个更具体的查询','invalid_input');
  requireValue(Number.isInteger(count)&&count>=1&&count<=50,'count 需要在 1 到 50 之间','invalid_input');
  const ori=originalQuestion===undefined?undefined:String(originalQuestion).trim().slice(0,128);
  const body=await this.request('/v1/tools/search',{json:{query:q,count,need_content:needContent===true,...(ori?{ori_question:ori}:{})},signal,timeoutMs:30000});
  requireValue(Array.isArray(body?.results),'DeepSeek 搜索结果格式无效','deepseek_invalid_response');
  return body.results.filter(row=>typeof row?.url==='string'&&/^https?:\/\//.test(row.url)).map(row=>({
   title:String(row.title||'').slice(0,300),url:row.url,siteName:typeof row.site_name==='string'?row.site_name.slice(0,100):null,
   snippet:String(row.snippet||'').slice(0,600),summary:String(row.summary||'').slice(0,2000),
   ...(needContent&&typeof row.content==='string'&&row.content?{content:row.content}:{}),
   publishedAt:typeof row.date==='string'?row.date:null,
   rerankScore:Number.isFinite(row.rerank_score)?row.rerank_score:null,authority:Number.isInteger(row.authority)?row.authority:null
  }));
 }
 async fetch({url},{signal}={}){
  const body=await this.request('/v1/tools/fetch',{json:{url},signal,timeoutMs:45000});
  requireValue(typeof body?.content==='string','DeepSeek 没有返回网页正文','deepseek_not_found');
  return {title:typeof body.title==='string'?body.title:'',content:body.content};
 }
 async ocr({bytes,filename='file',purpose='text_recognition'},{signal,timeoutMs=180000}={}){
  requireValue(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=100*1024*1024,'文件为空或超过 100 MiB','invalid_input');
  requireValue(OCR_PURPOSES.has(purpose),'识别模式无效','invalid_input');
  const form=new FormData();form.append('purpose',purpose);form.append('file',new Blob([bytes]),String(filename).replace(/[\r\n"]/g,'_').slice(0,120)||'file');
  const body=await this.request('/v1/tools/ocr',{form,signal,timeoutMs});
  requireValue(Array.isArray(body?.pages),'DeepSeek 识别结果格式无效','deepseek_invalid_response');
  return {pageCount:Number.isInteger(body.page_count)?body.page_count:body.pages.length,pages:body.pages.map(page=>({index:page.index,text:typeof page.text==='string'?page.text:'',complete:page.finish_reason!=='length'}))};
 }
 async asr({bytes,filename='audio.wav'},{signal}={}){
  requireValue(Buffer.isBuffer(bytes)&&bytes.length>44&&bytes.length<=8*1024*1024,'音频为空或超过 8 MiB','invalid_input');
  const form=new FormData();form.append('file',new Blob([bytes]),filename);
  const body=await this.request('/v1/tools/asr',{form,signal,timeoutMs:150000});
  requireValue(typeof body?.text==='string','DeepSeek 没有返回转写文字','deepseek_invalid_response');
  return {text:body.text,durationMs:Number.isFinite(body.duration_ms)?body.duration_ms:null};
 }
 async tts({text,voice='stella',format='wav',filterMarkdown=true},{signal}={}){
  requireValue(typeof text==='string'&&text.trim()&&Buffer.byteLength(text)<=64*1024,'朗读内容为空或过长','invalid_input');
  requireValue(billedCharacters(text)<=10000,'朗读内容超过 10000 计费字符（汉字算 2 个）；请分段','invalid_input');
  requireValue(TTS_VOICES.has(voice),'音色只能是 stella（女声）或 tide（男声）','invalid_input');
  requireValue(['wav','pcm'].includes(format),'音频格式只能是 wav 或 pcm','invalid_input');
  const {bytes}=await this.request('/v1/tools/tts',{json:{text,voice_id:voice,format,filter_markdown:filterMarkdown!==false},signal,timeoutMs:180000,binary:true});
  if(format==='wav')requireValue(bytes.length>44&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE','DeepSeek 朗读音频不完整','deepseek_invalid_response');
  return bytes;
 }
}

export function billedCharacters(text){let n=0;for(const char of String(text))n+=/[㐀-鿿豈-﫿\u{20000}-\u{2ffff}]/u.test(char)?2:1;return n;}

// Rewrite DeepSeek OCR grounding tokens into lines with pixel boxes.
// <｜ref｜>Text<｜/ref｜><｜box｜>[[x1, y1, x2, y2]]<｜/box｜>, coordinates 0..1000.
export function groundedLines(text,width,height){
 const lines=[];
 const pattern=/<[|｜]ref[|｜]>([\s\S]*?)<[|｜]\/ref[|｜]>\s*<[|｜](?:box|det)[|｜]>\s*(\[\[[\d\s.,\[\]]+\]\])\s*<[|｜]\/(?:box|det)[|｜]>/g;
 for(const match of String(text).matchAll(pattern)){
  const label=match[1].replace(/\s+/g,' ').trim();if(!label)continue;
  let boxes;try{boxes=JSON.parse(match[2]);}catch{continue;}
  for(const box of boxes){
   if(!Array.isArray(box)||box.length!==4||!box.every(Number.isFinite))continue;
   const [x1,y1,x2,y2]=box.map(v=>Math.max(0,Math.min(1000,v)));
   const bounds=[Math.round(x1*width/1000),Math.round(y1*height/1000),Math.round(x2*width/1000),Math.round(y2*height/1000)];
   if(bounds[2]>bounds[0]&&bounds[3]>bounds[1])lines.push({text:label,bounds});
  }
 }
 return lines;
}
