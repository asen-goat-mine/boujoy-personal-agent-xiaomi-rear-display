import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { ROOT,DATA,ORIGIN,PORT,prepareData } from '../src/config.mjs';
import {SERVICE_LABEL,BUILD_IDENTITY} from '../src/distribution.mjs';
import serviceIdentity from '../desktop/service-identity.cjs';
prepareData();
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const label=SERVICE_LABEL;const domain=`gui/${process.getuid()}`;
const dir=path.join(os.homedir(),'Library/LaunchAgents');fs.mkdirSync(dir,{recursive:true});const plist=path.join(dir,label+'.plist');
async function healthy(){return serviceIdentity.probeService({origin:ORIGIN,expectedIdentity:BUILD_IDENTITY,timeoutMs:1000});}
let loaded=false;try{execFileSync('/bin/launchctl',['print',domain+'/'+label],{stdio:'ignore'});loaded=true;}catch{}
if(loaded){if(await healthy()){console.log('Existing background service is online.');process.exit(0);}throw Error('后台服务已登记但没有响应，请先检查日志或卸载后重试。');}
if(await healthy())throw Error('当前已有前台服务，请先正常停止它，再安装常驻服务。');
const previous=fs.existsSync(plist)?fs.readFileSync(plist):null;
const xml=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(path.join(ROOT,'src/server.mjs'))}</string></array><key>WorkingDirectory</key><string>${escape(DATA)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(process.env.PATH)}</string><key>HOME</key><string>${escape(os.homedir())}</string><key>BOUJOY_DATA</key><string>${escape(DATA)}</string><key>BOUJOY_PORT</key><string>${PORT}</string></dict><key>StandardOutPath</key><string>${escape(path.join(DATA,'logs/launch.log'))}</string><key>StandardErrorPath</key><string>${escape(path.join(DATA,'logs/launch-error.log'))}</string></dict></plist>`;
fs.writeFileSync(plist,xml,{mode:0o600});
try{
  execFileSync('/bin/launchctl',['bootstrap',domain,plist],{stdio:'inherit'});
  const deadline=Date.now()+12000;
  while(!await healthy()){if(Date.now()>deadline)throw Error('服务未能通过启动检查。请检查 macOS 文件夹访问权限及 launch-error.log；本次安装已撤回。');await new Promise(r=>setTimeout(r,300));}
  console.log('Background service installed and verified online.');
}catch(error){
  try{execFileSync('/bin/launchctl',['bootout',domain+'/'+label],{stdio:'ignore'});}catch{}
  if(previous)fs.writeFileSync(plist,previous,{mode:0o600});else fs.rmSync(plist,{force:true});
  throw error;
}
