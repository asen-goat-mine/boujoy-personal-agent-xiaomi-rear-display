import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {AppError,requireValue} from '../core/errors.mjs';

const MAX_AUDIO=8*1024*1024,MAX_DURATION=120,MODEL_SHA='3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fileHash(file){const hash=createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');}
function libraryDirectories(executable,seen=new Set()){if(seen.has(executable))return [];seen.add(executable);const found=new Set();const fd=fs.openSync(executable,'r'),prefix=Buffer.alloc(4096);let length;try{length=fs.readSync(fd,prefix);}finally{fs.closeSync(fd);}if(prefix.subarray(0,2).toString()==='#!'){const wrapper=prefix.subarray(0,length).toString(),target=wrapper.match(/^exec (\/[^\n]+?) \"\$@\"$/m)?.[1];if(target&&fs.existsSync(target)){found.add(path.dirname(fs.realpathSync(target)));for(const item of libraryDirectories(fs.realpathSync(target),seen))found.add(item);}}let parent=path.dirname(executable);for(let depth=0;depth<4;depth++,parent=path.dirname(parent)){const lib=path.join(parent,'lib');if(!fs.existsSync(lib)||!fs.statSync(lib).isDirectory())continue;found.add(fs.realpathSync(lib));for(const name of fs.readdirSync(lib))if(/\.dylib$/.test(name)){try{found.add(path.dirname(fs.realpathSync(path.join(lib,name))));}catch{}}}return [...found];}
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
function directory(root,relative){
 fs.mkdirSync(root,{recursive:true,mode:0o700});const canonical=fs.realpathSync(root);let current=canonical;
 for(const part of relative.split('/')){requireValue(part&&part!=='.'&&part!=='..'&&!part.includes('\\'),'语音文件路径无效');current=path.join(current,part);if(fs.existsSync(current))requireValue(fs.lstatSync(current).isDirectory()&&!fs.lstatSync(current).isSymbolicLink(),'语音目录不能使用链接');else fs.mkdirSync(current,{mode:0o700});}
 return current;
}
function formatOf(bytes){
 if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE')return 'wav';
 if(bytes.subarray(4,8).toString()==='ftyp')return 'mov';
 if(bytes.subarray(0,4).toString()==='OggS')return 'ogg';
 if(bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))return 'matroska';
 if(bytes.subarray(0,3).toString()==='ID3'||bytes[0]===0xff&&(bytes[1]&0xe0)===0xe0)return 'mp3';
 throw new AppError('audio_format_invalid','请选择 WAV、M4A、MP3、Ogg 或 WebM 音频');
}
function profile({read=[],write=[],tts=false}){
 requireValue(process.platform==='darwin'&&fs.existsSync('/usr/bin/sandbox-exec'),'本机语音目前需要 macOS 本地隔离环境','voice_unavailable');
 // The OS boundary prevents decoder references or inference libraries from
 // opening network URLs or reading unrelated user files.
 return `(version 1)(allow default)(deny network*)${tts?'':`(deny file-read-data)(allow file-read-data ${['/System/Library','/usr/bin','/bin','/usr/lib','/usr/share','/Library/Apple','/private/var/db/dyld',...read].map(p=>`(subpath ${JSON.stringify(p)})`).join(' ')} (literal "/") (literal "/dev/null") (literal "/dev/urandom"))`}(deny file-write*)(allow file-write* ${write.map(p=>`(subpath ${JSON.stringify(p)})`).join(' ')})`;
}
function run(executable,args,{signal,input='',sandbox,cwd,timeout=60000,maxBytes=512*1024}={}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(new AppError('voice_cancelled','语音处理已取消'));
  const candidate=[process.env.BOUJOY_PYTHON,path.join(os.homedir(),'.local/bin/python3')].find(p=>p&&fs.existsSync(p));
  if(!candidate)return reject(new AppError('voice_unavailable','本机语音进程环境尚未准备'));
  const child=spawn(fs.realpathSync(candidate),['-I','-B','-S',fileURLToPath(new URL('./voice-supervisor.py',import.meta.url))],{cwd,env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',TOKENIZERS_PARALLELISM:'false',XDG_CACHE_HOME:cwd},stdio:['pipe','pipe','pipe','pipe']});
  const stop=()=>{if(child.stdio[3]?.writable)child.stdio[3].end('cancel');child.kill('SIGTERM');};
  let output=[],errors=[],length=0,failure=null;const cancel=()=>{failure ||=new AppError('voice_cancelled','语音处理已取消');stop();};
  const timer=setTimeout(()=>{failure ||=new AppError('voice_timeout','语音处理超时');stop();},timeout);timer.unref();signal?.addEventListener('abort',cancel,{once:true});
  for(const [stream,chunks]of [[child.stdout,output],[child.stderr,errors]])stream.on('data',bytes=>{length+=bytes.length;if(length>maxBytes){failure ||=new AppError('voice_output_limit','语音处理输出过大');stop();}else chunks.push(bytes);});
  child.on('error',error=>{failure=error;});child.stdin.on('error',()=>{});child.stdio[3].on('error',()=>{});child.stdin.end(JSON.stringify({executable,args,input,sandbox,timeout,maxBytes}));
  child.on('close',(code,exitSignal)=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(failure)return reject(failure);if(code!==0){const error=new AppError('voice_process_failed','本机语音处理失败，请检查语音运行环境');error.diagnostic={program:path.basename(executable),code,signal:exitSignal,stderr:Buffer.concat(errors).toString().slice(0,2000)};return reject(error);}resolve(Buffer.concat(output));});
 });
}
export class LocalVoiceService{
 // deepseek: official speech to text / text to speech. The local model and macOS
 // voices remain as the fallback when the official service is unavailable.
 constructor({dataDir,store,runtimeDir=path.join(dataDir,'build-tools/voice'),deepseek=null}){this.dataDir=dataDir;this.runtimeDir=runtimeDir;this.store=store;this.deepseek=deepseek;this.active=new Map();this.runtimeCache=null;}
 status(){const ready=fs.existsSync(path.join(this.runtimeDir,'runtime.json')),official=!!this.deepseek;return {transcriptionReady:ready||official,speechReady:official||process.platform==='darwin'&&fs.existsSync('/usr/bin/say'),provider:official?'deepseek':'local',localOnly:!official,localFallback:ready,maxBytes:MAX_AUDIO,maxDurationSeconds:MAX_DURATION};}
 // Audio the official recognizer accepts as is: 16-bit PCM WAV or Ogg Opus.
 static asrReady(bytes){
  if(bytes.subarray(0,4).toString()==='OggS')return bytes.includes(Buffer.from('OpusHead'));
  if(bytes.subarray(0,4).toString()!=='RIFF'||bytes.subarray(8,12).toString()!=='WAVE')return false;
  const at=bytes.indexOf(Buffer.from('fmt '));return at>=12&&bytes.length>=at+24&&bytes.readUInt16LE(at+8)===1&&bytes.readUInt16LE(at+22)===16;
 }
 // Convert any accepted upload to 16 kHz mono PCM WAV with the bundled ffmpeg.
 async toAsrAudio(bytes,{signal}={}){
  if(LocalVoiceService.asrReady(bytes))return bytes;
  const format=formatOf(bytes),runtime=await this.runtime(),scratch=directory(this.dataDir,'voice-work/'+randomUUID()),source=path.join(scratch,'input'),decoded=path.join(scratch,'decoded.wav');
  try{
   fs.writeFileSync(source,bytes,{mode:0o600,flag:'wx'});const sandbox=profile({read:[scratch,path.dirname(runtime.ffmpeg),...libraryDirectories(runtime.ffmpeg)],write:[scratch]});
   await run(runtime.ffmpeg,['-v','error','-nostdin','-protocol_whitelist','file,pipe','-f',format,'-i',source,'-map','0:a:0','-t','120.1','-ac','1','-ar','16000','-c:a','pcm_s16le','-fs','3900000',decoded],{signal,cwd:scratch,sandbox});
   return fs.readFileSync(decoded);
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
 }
 async runtime(){
  const root=this.runtimeDir,file=path.join(root,'runtime.json');requireValue(fs.existsSync(file),'本机语音模型尚未准备','voice_unavailable');const stamp=fs.statSync(file).mtimeMs;
  if(this.runtimeCache?.stamp===stamp&&this.runtimeCache.files.every(row=>{const stat=fs.statSync(row.file);return stat.size===row.size&&stat.mtimeMs===row.mtimeMs;}))return this.runtimeCache.value;
  const value=JSON.parse(fs.readFileSync(file,'utf8'));requireValue(value.version===1&&value.localOnly===true&&value.modelRevision==='536b0662742c02347bc0e980a01041f333bce120','本机语音配置无效');
  const canonicalRoot=fs.realpathSync(root);requireValue(fs.realpathSync(value.model).startsWith(canonicalRoot+path.sep)&&path.resolve(value.python).startsWith(path.resolve(root)+path.sep),'本机语音运行环境路径无效');
  const files=[];for(const [name,metadata]of Object.entries(value.modelFiles||{})){requireValue(['config.json','model.bin','tokenizer.json','vocabulary.txt'].includes(name),'本机语音模型文件无效');const file=path.join(value.model,name),stat=fs.lstatSync(file);requireValue(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===metadata.size&&await fileHash(file)===metadata.sha256,'本机语音模型校验失败');files.push({file,size:stat.size,mtimeMs:stat.mtimeMs});}
  requireValue(value.modelFiles?.['model.bin']?.sha256===MODEL_SHA&&Object.keys(value.modelFiles).length===4,'本机语音模型校验缺失');
  for(const key of ['python','pythonBase','ffmpeg','ffprobe'])requireValue(typeof value[key]==='string'&&path.isAbsolute(value[key])&&fs.existsSync(value[key]),'本机语音依赖缺失');
  this.runtimeCache={stamp,value,files};return value;
 }
 async operation(key,signal,work){
  requireValue(!this.active.has(key)&&this.active.size<2,'语音正在处理中，请稍候','voice_busy');const controller=new AbortController(),timeout=AbortSignal.timeout(key.startsWith('speech:')?180000:150000),combined=AbortSignal.any([controller.signal,timeout,...(signal?[signal]:[])]);this.active.set(key,controller);
  try{return await work(combined);}finally{this.active.delete(key);}
 }
 async transcribeUpload(input,{signal}={}){
  requireValue(input&&typeof input.bytesBase64==='string'&&input.bytesBase64.length<=Math.ceil(MAX_AUDIO/3)*4,'音频超过 8 MiB');
  requireValue(/^[A-Za-z0-9+/]*={0,2}$/.test(input.bytesBase64)&&input.bytesBase64.length%4===0,'音频编码无效');const bytes=Buffer.from(input.bytesBase64,'base64');
  requireValue(bytes.length>44&&bytes.length<=MAX_AUDIO&&bytes.toString('base64')===input.bytesBase64&&sha(bytes)===input.sha256,'音频校验失败');const format=formatOf(bytes);
  requireValue(input.language===undefined||['zh','en','auto'].includes(input.language),'语音语言无效');
  return this.operation('transcription',signal,async combined=>{
   if(this.deepseek){
    try{
     const audio=await this.toAsrAudio(bytes,{signal:combined}),result=await this.deepseek.asr({bytes:audio,filename:audio.subarray(0,4).toString()==='OggS'?'audio.ogg':'audio.wav'},{signal:combined});
     requireValue(typeof result.text==='string'&&result.text.length<=12000,'转写结果无效');requireValue(!combined.aborted,'语音处理已取消','voice_cancelled');
     return {text:result.text,provider:'deepseek',localOnly:false,audioSha256:input.sha256,duration:Number.isFinite(result.durationMs)?result.durationMs/1000:null,editable:true};
    }catch(error){if(combined.aborted||error.code==='voice_cancelled'||!fs.existsSync(path.join(this.runtimeDir,'runtime.json')))throw error;}
   }
   const runtime=await this.runtime(),scratch=directory(this.dataDir,'voice-work/'+randomUUID()),source=path.join(scratch,'input'),decoded=path.join(scratch,'decoded.wav');
   try{
    fs.writeFileSync(source,bytes,{mode:0o600,flag:'wx'});const decoderSandbox=profile({read:[scratch,path.dirname(runtime.ffprobe),path.dirname(runtime.ffmpeg),...libraryDirectories(runtime.ffprobe),...libraryDirectories(runtime.ffmpeg)],write:[scratch]});
    const meta=JSON.parse((await run(runtime.ffprobe,['-v','error','-protocol_whitelist','file,pipe','-f',format,'-i',source,'-show_entries','stream=codec_type,channels,sample_rate:format=duration','-of','json'],{signal:combined,cwd:scratch,sandbox:decoderSandbox})).toString());
    const declaredDuration=Number(meta.format?.duration);requireValue((!Number.isFinite(declaredDuration)||declaredDuration>0&&declaredDuration<=MAX_DURATION)&&meta.streams?.length===1&&meta.streams[0].codec_type==='audio'&&meta.streams[0].channels<=2&&Number(meta.streams[0].sample_rate)<=192000,'请使用不超过两分钟的单轨音频','audio_duration_invalid');
    await run(runtime.ffmpeg,['-v','error','-nostdin','-protocol_whitelist','file,pipe','-f',format,'-i',source,'-map','0:a:0','-t','120.1','-ac','1','-ar','16000','-c:a','pcm_s16le','-fs','3900000',decoded],{signal:combined,cwd:scratch,sandbox:decoderSandbox});
    const decodedMeta=JSON.parse((await run(runtime.ffprobe,['-v','error','-f','wav','-i',decoded,'-show_entries','format=duration','-of','json'],{signal:combined,cwd:scratch,sandbox:decoderSandbox})).toString());const duration=Number(decodedMeta.format?.duration);requireValue(Number.isFinite(duration)&&duration>0&&duration<=MAX_DURATION,'请使用不超过两分钟的音频','audio_duration_invalid');
    const script=fileURLToPath(new URL('./voice-transcribe.py',import.meta.url)),read=[scratch,path.dirname(script),path.dirname(path.dirname(runtime.python)),runtime.pythonBase,runtime.model];
    const result=JSON.parse((await run(runtime.python,['-I','-B',script],{signal:combined,cwd:scratch,sandbox:profile({read,write:[scratch]}),input:JSON.stringify({file:decoded,model:runtime.model,language:input.language==='auto'?null:input.language||'zh'})})).toString());
    requireValue(typeof result.text==='string'&&result.text.length<=12000&&result.localOnly===true,'转写结果无效');requireValue(!combined.aborted,'语音处理已取消','voice_cancelled');return {...result,audioSha256:input.sha256,duration,editable:true};
   }finally{fs.rmSync(scratch,{recursive:true,force:true});}
  });
 }
 async synthesizeMessage(taskId,messageId,{signal}={}){
  requireValue(uuid(taskId),'对话无效');const task=this.store.task(taskId),message=messageId==='result'?{role:'assistant',content:task.result}:task.messages.find(m=>m.id===messageId);
  requireValue(message?.role==='assistant'&&typeof message.content==='string'&&message.content.trim(),'请选择助理的一条回答');requireValue(message.content.length<=5000,'这条回答较长，请先选取不超过 5000 字的内容');const digest=sha(message.content),key='speech:'+taskId+':'+messageId;
  const existing=this.store.data.artifacts.find(a=>a.taskId===taskId&&a.kind==='speech'&&a.sourceMessageId===messageId&&a.sourceTextSha256===digest);
  if(existing){const file=path.resolve(this.dataDir,'artifacts',existing.path),root=fs.realpathSync(path.join(this.dataDir,'artifacts'));if(file.startsWith(path.resolve(this.dataDir,'artifacts')+path.sep)&&fs.existsSync(file)&&fs.realpathSync(file).startsWith(root+path.sep)&&sha(fs.readFileSync(file))===existing.sha256)return existing;}
  return this.operation(key,signal,async combined=>{
   const id=randomUUID(),scratch=directory(this.dataDir,'voice-work/'+id);let finalDir=null,registered=false;
   try{
    let official=null;
    if(this.deepseek){try{official=await this.deepseek.tts({text:message.content,voice:this.store.data.settings?.speechVoice==='tide'?'tide':'stella'},{signal:combined});}catch(error){if(combined.aborted)throw error;}}
    const bytes=official||await (async()=>{
    const voices=(await run('/usr/bin/say',['-v','?'],{signal:combined,cwd:scratch,sandbox:profile({write:[scratch],tts:true})})).toString();
    const choices=voices.split('\n').map(line=>line.match(/^(.+?)\s+(zh_CN|en_US)\s+#/)).filter(Boolean),wanted=/[\u3400-\u9fff]/u.test(message.content)?'zh_CN':'en_US';const voice=choices.find(row=>row[2]===wanted&&/Tingting|Samantha/.test(row[1]))||choices.find(row=>row[2]===wanted);requireValue(voice,'这台 Mac 没有对应的本地语音','voice_unavailable');
    const aiff=path.join(scratch,'speech.aiff'),wav=path.join(scratch,'speech.wav');
    await run('/usr/bin/say',['-v',voice[1].trim(),'-r','190','-o',aiff,'-f','-'],{signal:combined,cwd:scratch,sandbox:profile({write:[scratch],tts:true}),input:message.content.replace(/\[\[/g,'［［').replace(/\]\]/g,'］］')});
    await run('/usr/bin/afconvert',['-f','WAVE','-d','LEI16@16000','-c','1',aiff,wav],{signal:combined,cwd:scratch,sandbox:profile({write:[scratch],tts:true})});
    return fs.readFileSync(wav);})();
    requireValue(bytes.length>44&&bytes.length<=64*1024*1024&&formatOf(bytes)==='wav','朗读音频无效或过长');requireValue(!combined.aborted&&this.store.task(taskId),'语音处理已取消','voice_cancelled');
    finalDir=directory(path.join(this.dataDir,'artifacts'),taskId+'/'+id);const file=path.join(finalDir,'speech.wav'),fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const dirfd=fs.openSync(finalDir,'r');try{fs.fsyncSync(dirfd);}finally{fs.closeSync(dirfd);}
    const artifact={id,taskId,path:taskId+'/'+id+'/speech.wav',name:'助理朗读.wav',mime:'audio/wav',size:bytes.length,sha256:sha(bytes),kind:'speech',sourceMessageId:messageId,sourceTextSha256:digest,createdAt:new Date().toISOString(),provider:official?'deepseek':'local',localOnly:!official};
    this.store.transaction(s=>s.artifacts.push(artifact));registered=true;return artifact;
   }finally{fs.rmSync(scratch,{recursive:true,force:true});if(finalDir&&!registered)fs.rmSync(finalDir,{recursive:true,force:true});}
  });
 }
 close(){for(const controller of this.active.values())controller.abort();}
}
