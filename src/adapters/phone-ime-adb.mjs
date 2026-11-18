import {ANDROID_PACKAGE} from '../distribution.mjs';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {DATA} from '../config.mjs';

// The application ID differs by edition; the Java namespace stays shared.
const IME=`${ANDROID_PACKAGE}/dev.boujoy.personalagent.BoujoyInputMethod`;
function adbBin(){
  const candidate=path.join(DATA,'tools/platform-tools/adb');
  return fs.existsSync(candidate)?candidate:null;
}
function run(adb,args){
  const out=spawnSync(adb,args,{encoding:'utf8',timeout:8000});
  if(out.error||out.status!==0)return null;
  return String(out.stdout||'').trim();
}
export function adbImeAvailable(){
  const adb=adbBin();if(!adb)return false;
  const devices=run(adb,['devices']);
  return !!devices&&devices.split('\n').some(line=>/\tdevice$/.test(line));
}
export async function withAdbIme(runJob){
  const adb=adbBin();if(!adb||!adbImeAvailable())return runJob();
  const previous=run(adb,['shell','settings','get','secure','default_input_method'])||'';
  run(adb,['shell','ime','enable',IME]);
  // Start the job first so Android can park pending text, then select our IME.
  const job=runJob();
  await new Promise(resolve=>setTimeout(resolve,500));
  run(adb,['shell','ime','set',IME]);
  try{return await job;}
  finally{
    if(previous&&previous!=='null'&&previous!==IME)run(adb,['shell','ime','set',previous]);
  }
}
