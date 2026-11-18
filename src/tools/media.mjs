// Video and large photos for the model. DeepSeek reads images, not video: a video
// becomes a few evenly spaced frames (with its length), and a large photo is
// shrunk before it is sent. Uses ffmpeg from PATH or the Remotion runtime that
// ships one; without ffmpeg the model is told plainly what it cannot see.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {ROOT} from '../config.mjs';

export const VIDEO_EXT=/\.(?:mp4|m4v|mov|webm|mkv|avi)$/i;
export const isVideo=artifact=>/^video\//i.test(String(artifact?.mime||''))||VIDEO_EXT.test(String(artifact?.name||''));

let cached;
export function findFfmpeg({env=process.env,home=os.homedir(),exists=fs.existsSync}={}){
  if(cached!==undefined&&env===process.env)return cached;
  // launchd gives the service a short PATH, so the usual install places are listed too.
  const dirs=[env.BOUJOY_FFMPEG_DIR,...String(env.PATH||'').split(':'),path.join(home,'.local/bin'),'/opt/homebrew/bin','/usr/local/bin','/usr/bin',path.join(home,'bin')].filter(Boolean);
  // A Remotion install ships its own ffmpeg; look in the repo runtime folder and an older install location.
  for(const runtimes of [path.join(ROOT,'.runtime'),path.join(home,'Documents/Codex/Boujoy-Restored/Runtimes')])
    try{for(const name of fs.readdirSync(runtimes))if(/remotion/i.test(name))dirs.push(path.join(runtimes,name,'node_modules/@remotion',process.arch==='arm64'?'compositor-darwin-arm64':'compositor-darwin-x64'));}catch{}
  let found=null;
  if(env.BOUJOY_FFMPEG&&exists(env.BOUJOY_FFMPEG))found={ffmpeg:env.BOUJOY_FFMPEG,ffprobe:path.join(path.dirname(env.BOUJOY_FFMPEG),'ffprobe')};
  for(const dir of dirs){if(found)break;const ffmpeg=path.join(dir,'ffmpeg');if(exists(ffmpeg))found={ffmpeg,ffprobe:path.join(dir,'ffprobe')};}
  // ffprobe may live elsewhere than ffmpeg (a wrapper on PATH, the real tools in /usr/bin).
  if(found&&!exists(found.ffprobe))for(const dir of dirs){const probe=path.join(dir,'ffprobe');if(exists(probe)){found.ffprobe=probe;break;}}
  if(env===process.env)cached=found;return found;
}
const run=(bin,args,{input,timeout=30000,maxBuffer=8*1024*1024}={})=>new Promise((resolve,reject)=>{
  // Run from the binary's own folder: Remotion's ffmpeg loads its libav*.dylib by a
  // bare name, which macOS resolves against the working directory.
  const child=execFile(bin,args,{cwd:path.dirname(bin),timeout,maxBuffer,encoding:'buffer',env:{...process.env,DYLD_LIBRARY_PATH:path.dirname(bin)}},(error,stdout)=>error?reject(error):resolve(stdout));
  if(input){child.stdin.on('error',()=>{});child.stdin.end(input);}
});

export async function videoDuration(file,tools=findFfmpeg()){
  if(!tools)return null;
  if(fs.existsSync(tools.ffprobe))try{const out=await run(tools.ffprobe,['-v','error','-show_entries','format=duration','-of','csv=p=0',file],{timeout:15000});const value=Number(String(out).trim());if(Number.isFinite(value)&&value>0)return value;}catch{}
  // Recordings from a browser (webm) often carry no duration: read through the
  // stream once (no decoding) and take the last timestamp ffmpeg reports.
  return new Promise(resolve=>{
    execFile(tools.ffmpeg,['-v','info','-i',file,'-map','0:v:0','-c','copy','-f','null','-'],{cwd:path.dirname(tools.ffmpeg),timeout:30000,maxBuffer:4*1024*1024,env:{...process.env,DYLD_LIBRARY_PATH:path.dirname(tools.ffmpeg)}},(error,stdout,stderr)=>{
      const times=[...String(stderr||'').matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].map(m=>Number(m[1])*3600+Number(m[2])*60+Number(m[3]));
      const value=times.at(-1);resolve(Number.isFinite(value)&&value>0?value:null);
    });
  });
}
// Evenly spaced JPEG frames, each at most `width` wide.
export async function videoFrames(file,{count=6,width=768,tools=findFfmpeg()}={}){
  if(!tools)return {available:false,frames:[]};
  const duration=await videoDuration(file,tools),frames=[];
  const times=duration?Array.from({length:count},(_,i)=>Math.min(duration-0.05,(duration*(i+0.5))/count)):[0];
  for(const at of times){
    try{const jpeg=await run(tools.ffmpeg,['-v','error','-ss',at.toFixed(2),'-i',file,'-frames:v','1','-vf',`scale='min(${width},iw)':-2`,'-q:v','4','-f','image2','-c:v','mjpeg','pipe:1'],{timeout:20000});if(jpeg.length>0)frames.push({at:Number(at.toFixed(1)),jpeg});}catch{}
  }
  return {available:true,duration,frames};
}
// A photo too large to send as-is, shrunk to a JPEG at most `width` wide.
export async function shrinkImage(bytes,{width=1600,tools=findFfmpeg()}={}){
  if(!tools)return null;
  try{const jpeg=await run(tools.ffmpeg,['-v','error','-i','pipe:0','-frames:v','1','-vf',`scale='min(${width},iw)':-2`,'-q:v','3','-f','image2','-c:v','mjpeg','pipe:1'],{input:bytes,timeout:20000});return jpeg.length?jpeg:null;}catch{return null;}
}
