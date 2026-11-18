import test from 'node:test';
import {NEEDS_VOICE} from './helpers/requirements.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {LocalVoiceService} from '../src/adapters/voice.mjs';
import {allowedAudio} from '../desktop/media-permission.cjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const runtimeDir=path.join(os.homedir(),'Library/Application Support/Boujoy Personal Agent/build-tools/voice');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-voice-')),task={id:randomUUID(),messages:[{id:randomUUID(),role:'assistant',content:'这是本地语音测试。明天早上八点提醒我。'},{id:randomUUID(),role:'user',content:'私人草稿'}]},store={data:{artifacts:[]},task:id=>{assert.equal(id,task.id);return task;},transaction:fn=>fn(store.data)};
 const voice=new LocalVoiceService({dataDir:dir,store,runtimeDir});t.after(()=>{voice.close();fs.rmSync(dir,{recursive:true,force:true});});return {dir,voice,store,task};
}
test('microphone permission is limited to the main local audio frame; camera, other windows and embeds stay denied',()=>{
 const main={isDestroyed:()=>false,getURL:()=> 'http://127.0.0.1:18891/#home'},base={contents:main,mainContents:main,permission:'media',expectedOrigin:'http://127.0.0.1:18891',origin:'http://127.0.0.1:18891',details:{requestingUrl:'http://127.0.0.1:18891/',isMainFrame:true,mediaType:'audio'}};
 assert.equal(allowedAudio(base),true);assert.equal(allowedAudio({...base,details:{...base.details,mediaType:'video'}}),false);assert.equal(allowedAudio({...base,mainContents:{}}),false);assert.equal(allowedAudio({...base,details:{...base.details,isMainFrame:false}}),false);assert.equal(allowedAudio({...base,origin:'https://example.com'}),false);
 assert.equal(allowedAudio({...base,request:true,details:{...base.details,mediaTypes:['audio']}}),true);assert.equal(allowedAudio({...base,request:true,details:{...base.details,mediaTypes:['audio','video']}}),false);
});
test('real local speech produces a verified WAV, deduplicates the answer, and rejects reading user messages',{skip:NEEDS_VOICE},async t=>{
 const {dir,voice,store,task}=fixture(t),artifact=await voice.synthesizeMessage(task.id,task.messages[0].id);const bytes=fs.readFileSync(path.join(dir,'artifacts',artifact.path));
 assert.equal(bytes.subarray(0,4).toString(),'RIFF');assert.equal(digest(bytes),artifact.sha256);assert.ok(bytes.length>1000);assert.equal(artifact.localOnly,true);assert.equal((await voice.synthesizeMessage(task.id,task.messages[0].id)).id,artifact.id);assert.equal(store.data.artifacts.length,1);
 await assert.rejects(voice.synthesizeMessage(task.id,task.messages[1].id));assert.deepEqual(fs.readdirSync(path.join(dir,'voice-work')),[]);
});
test('actual offline recognition turns synthetic speech into editable text without creating a task or outbound request', {skip:!fs.existsSync(path.join(runtimeDir,'runtime.json'))?'Local speech runtime not installed':false},async t=>{
 const {dir,voice,store,task}=fixture(t),artifact=await voice.synthesizeMessage(task.id,task.messages[0].id),bytes=fs.readFileSync(path.join(dir,'artifacts',artifact.path));
 const result=await voice.transcribeUpload({bytesBase64:bytes.toString('base64'),sha256:digest(bytes),language:'zh'});
 assert.match(result.text,/本地语音测试/);assert.match(result.text,/8点|八点/);assert.equal(result.localOnly,true);assert.equal(result.editable,true);assert.equal(result.audioSha256,artifact.sha256);assert.ok(result.duration>0&&result.duration<10);assert.equal(store.data.artifacts.length,1);assert.equal(task.messages.length,2);assert.deepEqual(fs.readdirSync(path.join(dir,'voice-work')),[]);
});
test('voice rejects malformed hash, type, and aborted processing without leftover artifacts',{skip:NEEDS_VOICE},async t=>{
 const {voice,dir,task,store}=fixture(t),bytes=Buffer.alloc(48);bytes.write('RIFF');bytes.write('WAVE',8);
 await assert.rejects(voice.transcribeUpload({bytesBase64:bytes.toString('base64'),sha256:'0'.repeat(64)}));await assert.rejects(voice.transcribeUpload({bytesBase64:Buffer.alloc(50).toString('base64'),sha256:digest(Buffer.alloc(50))}));
 const controller=new AbortController();controller.abort();await assert.rejects(voice.synthesizeMessage(task.id,task.messages[0].id,{signal:controller.signal}),e=>e.code==='voice_cancelled');assert.equal(store.data.artifacts.length,0);assert.deepEqual(fs.readdirSync(path.join(dir,'voice-work')),[]);
});
test('actual decoder refuses audio over two minutes and corrupt audio before inference', {skip:!fs.existsSync(path.join(runtimeDir,'runtime.json'))?'Local speech runtime not installed':false},async t=>{
 const {voice,dir}=fixture(t),samples=121*16000,bytes=Buffer.alloc(44+samples*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);
 await assert.rejects(voice.transcribeUpload({bytesBase64:bytes.toString('base64'),sha256:digest(bytes)}),e=>e.code==='audio_duration_invalid');
 const corrupt=Buffer.alloc(128);corrupt.write('RIFF');corrupt.write('WAVE',8);await assert.rejects(voice.transcribeUpload({bytesBase64:corrupt.toString('base64'),sha256:digest(corrupt)}));assert.deepEqual(fs.readdirSync(path.join(dir,'voice-work')),[]);
});
