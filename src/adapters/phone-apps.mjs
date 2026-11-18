import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {DATA} from '../config.mjs';
import {AppError,requireValue} from '../core/errors.mjs';

const execute=promisify(execFile);
const VERIFIED_TTL_MS=15000,FAILURE_COOLDOWN_MS=5000;
const PACKAGE=/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;
const normalize=text=>String(text).normalize('NFKC').toLowerCase().replace(/\s+/g,'');
// Labels are a fixed local dictionary. Installation is always verified separately.
const knownApps=new Map([
 ['com.android.settings',['设置','Settings','系统设置']],
 ['com.sec.android.app.camera',['相机','Camera','三星相机']],
 ['com.android.camera',['相机','Camera']],['com.android.camera2',['相机','Camera']],
 ['com.google.android.GoogleCamera',['相机','Google Camera','谷歌相机']],
 ['com.sec.android.gallery3d',['相册','Gallery','三星相册']],
 ['com.android.gallery3d',['相册','Gallery']],
 ['com.google.android.apps.photos',['Google 相册','Google Photos','谷歌相册','相册']],
 ['com.sec.android.app.popupcalculator',['计算器','Calculator','三星计算器']],
 ['com.android.calculator2',['计算器','Calculator']],
 ['com.google.android.calculator',['计算器','Google Calculator']],
 ['com.tencent.mm',['微信','WeChat']],
 ['com.taobao.taobao',['淘宝','Taobao','淘宝闪购','闪购']],
 ['com.sankuai.meituan',['美团','Meituan']],
 ['com.sankuai.meituan.takeoutnew',['美团外卖','Meituan Waimai','外卖']],
 ['com.jingdong.app.mall',['京东','JD','Jingdong']],
 ['com.xunmeng.pinduoduo',['拼多多','Pinduoduo','PDD']],
 ['com.ss.android.ugc.aweme',['抖音','Douyin']],
 ['tv.danmaku.bili',['哔哩哔哩','Bilibili','Bili','B站']],
 ['com.MobileTicket',['铁路12306','12306']],['ctrip.android.view',['携程','携程旅行']],['com.tongcheng.android',['同程旅行','同程']],['com.taobao.trip',['飞猪','飞猪旅行']],
 ['com.autonavi.minimap',['高德地图','高德','Amap']],
 ['com.baidu.BaiduMap',['百度地图','Baidu Maps']],
 ['com.tencent.map',['腾讯地图','Tencent Maps']],
 ['com.google.android.apps.maps',['Google 地图','Google Maps','谷歌地图','Maps']],
 ['com.tencent.mobileqq',['QQ','腾讯QQ']],
 ['com.tencent.mtt',['QQ 浏览器','QQ Browser','腾讯浏览器']],
 ['com.sec.android.app.sbrowser',['三星浏览器','Samsung Internet','浏览器']],
 ['com.android.chrome',['Chrome','Google Chrome','谷歌浏览器','浏览器']],
 ['com.microsoft.emmx',['Edge','Microsoft Edge','微软浏览器','浏览器']],
 ['org.mozilla.firefox',['Firefox','火狐浏览器','浏览器']],
 ['com.baidu.searchbox',['百度','Baidu']],
 ['com.eg.android.AlipayGphone',['支付宝','Alipay']],
 ['com.xingin.xhs',['小红书','Xiaohongshu']],
 ['com.netease.cloudmusic',['网易云音乐','网易云','NetEase Music']],
 ['com.tencent.qqmusic',['QQ 音乐','QQ Music']],
 ['com.samsung.android.messaging',['短信','Messages','三星短信']],
 ['com.android.mms',['短信','Messages']],
 ['com.google.android.apps.messaging',['Google 短信','Google Messages','短信']],
 ['com.samsung.android.dialer',['电话','Phone','三星电话']],
 ['com.android.dialer',['电话','Phone']],['com.google.android.dialer',['电话','Google Phone']],
 ['com.samsung.android.contacts',['联系人','Contacts','三星联系人']],
 ['com.android.contacts',['联系人','Contacts']],['com.google.android.contacts',['联系人','Google Contacts']],
 ['com.sec.android.app.clockpackage',['时钟','Clock','闹钟']],
 ['com.android.deskclock',['时钟','Clock','闹钟']],['com.google.android.deskclock',['时钟','Google Clock','闹钟']],
 ['com.sec.android.app.myfiles',['我的文件','My Files','文件']],
 ['com.google.android.apps.nbu.files',['Google 文件','Google Files','文件']],
 ['com.android.documentsui',['文件','Files']],['com.google.android.gm',['Gmail','邮箱']],['com.microsoft.office.outlook',['Outlook']],['com.samsung.android.email.provider',['三星邮件','邮件']],
 ['com.android.vending',['Google Play','Play 商店']],
]);
export function canonicalPhoneApp(name){const term=normalize(name);return [...knownApps].find(([,aliases])=>aliases.some(alias=>normalize(alias)===term))?.[0]||term;}
export const PHONE_APP_NAMES=[...new Set([...knownApps.values()].flat())];
function app(packageName){const aliases=knownApps.get(packageName)||[packageName];return {packageName,label:aliases[0],aliases:[...aliases]};}
// A device label is used only for unknown packages; it cannot impersonate a
// trusted package's local aliases. Installation is verified by each transport.
export function phoneAppRecord(packageName,label){
 if(knownApps.has(packageName))return app(packageName);
 const clean=typeof label==='string'?label.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,120):'';
 return {packageName,label:clean||packageName,aliases:clean?[clean,packageName]:[packageName]};
}
function matches(packageName,query){
 if(!query)return 1;
 const pkg=normalize(packageName),aliases=(knownApps.get(packageName)||[packageName]).map(normalize);
 if(pkg===query)return 1000;
 if(aliases.includes(query))return 900;
 if(aliases.some(label=>label.startsWith(query)))return 700;
 if(aliases.some(label=>label.includes(query)))return 600;
 if(pkg.startsWith(query))return 500;
 return pkg.includes(query)?400:0;
}
function validSnapshot(value){
 return value?.version===1&&typeof value.observedAt==='string'&&Number.isFinite(Date.parse(value.observedAt))&&Array.isArray(value.packages)&&value.packages.length>0&&value.packages.length<=50000&&value.packages.every(pkg=>typeof pkg==='string'&&PACKAGE.test(pkg)&&pkg.length<=255);
}

export class PhoneApps {
 constructor({adbPath=path.join(DATA,'tools/platform-tools/adb'),cachePath=path.join(DATA,'phone/apps.json'),exec=execute,clock=Date.now,files=fs,env}={}){
  Object.assign(this,{adbPath,cachePath,exec,clock,files,env});this.snapshot=null;this.reading=null;this.lastVerifiedAt=null;this.lastFailureAt=null;
 }
 async cached(){
  if(this.snapshot)return this.snapshot;
  try{const value=JSON.parse(await this.files.readFile(this.cachePath,'utf8'));if(validSnapshot(value))this.snapshot={version:1,observedAt:value.observedAt,packages:[...new Set(value.packages)]};}catch{}
  return this.snapshot;
 }
 async save(snapshot){
  const temp=this.cachePath+'.'+randomUUID()+'.tmp';
  try{await this.files.mkdir(path.dirname(this.cachePath),{recursive:true,mode:0o700});await this.files.writeFile(temp,JSON.stringify(snapshot),{encoding:'utf8',mode:0o600});await this.files.rename(temp,this.cachePath);return true;}
  catch{try{await this.files.rm(temp,{force:true});}catch{}return false;}
 }
 async read(){
  if(this.reading)return this.reading;
  const current=this.clock(),verifiedAge=current-this.lastVerifiedAt,failureAge=current-this.lastFailureAt;
  // Only this instance's ADB-verified snapshot qualifies for short reuse.
  // Neither cached installation nor directory lookup proves an app was opened.
  // Device identity is not yet recorded; reuse is intentionally short-lived.
  if(this.snapshot&&this.lastFailureAt!==null&&failureAge>=0&&failureAge<FAILURE_COOLDOWN_MS)return {snapshot:this.snapshot,source:'cache',cached:true,stale:true,reason:'adb_failure_cooldown',unavailableReason:'当前无法读取手机，短期复用上次本机应用目录。'};
  if(this.snapshot&&this.lastVerifiedAt!==null&&verifiedAge>=0&&verifiedAge<VERIFIED_TTL_MS)return {snapshot:this.snapshot,source:'cache',cached:true,stale:false,reason:'recent_verified_catalog'};
  this.reading=this.readCatalog();try{return await this.reading;}finally{this.reading=null;}
 }
 async readCatalog(){
  try{
   const output=await this.exec(this.adbPath,['shell','pm','list','packages'],{timeout:5000,maxBuffer:1024*1024,...(this.env?{env:this.env}:{})});
   const packages=[...new Set(String(output?.stdout||'').split(/\r?\n/).flatMap(line=>{const match=line.trim().match(/^package:(\S+)$/);return match&&match[1].length<=255&&PACKAGE.test(match[1])?[match[1]]:[];}))].sort();
   if(!packages.length)throw new Error('empty_package_catalog');
   const verifiedAt=this.clock(),snapshot={version:1,observedAt:new Date(verifiedAt).toISOString(),packages};this.snapshot=snapshot;this.lastVerifiedAt=verifiedAt;this.lastFailureAt=null;
   const cachePersisted=await this.save(snapshot);
   return {snapshot,source:'adb',cached:false,reason:'fresh_adb',cachePersisted};
  }catch{
   const snapshot=await this.cached();
   if(!snapshot)throw new AppError('app_catalog_unavailable','手机应用目录不可用：请连接并授权 USB 调试后重试。',503);
   this.lastFailureAt=this.clock();return {snapshot,source:'cache',cached:true,stale:true,reason:'adb_unavailable',unavailableReason:'当前无法读取手机，使用上次本机应用目录。'};
  }
 }
 info(catalog){return {source:catalog.source,cached:catalog.cached,reason:catalog.reason,observedAt:catalog.snapshot.observedAt,ageMs:Math.max(0,this.clock()-Date.parse(catalog.snapshot.observedAt)),...(catalog.cached?{stale:catalog.stale,...(catalog.unavailableReason?{unavailableReason:catalog.unavailableReason}:{})}:{cachePersisted:catalog.cachePersisted})};}
 async list(query=''){
  requireValue(typeof query==='string'&&query.length<=120,'应用查询应为不超过 120 字符的名称或包名');
  const catalog=await this.read(),term=normalize(query.trim());
  const rows=catalog.snapshot.packages.map(packageName=>({packageName,score:matches(packageName,term)})).filter(row=>row.score>0).sort((a,b)=>b.score-a.score||a.packageName.localeCompare(b.packageName));
  return {...this.info(catalog),query:query.trim(),apps:rows.slice(0,10).map(row=>app(row.packageName)),totalInstalled:catalog.snapshot.packages.length,totalMatched:rows.length,truncated:rows.length>10};
 }
 async resolve(packageName){
  requireValue(typeof packageName==='string'&&packageName.length<=255&&PACKAGE.test(packageName),'应用包名无效');
  const catalog=await this.read();
  if(!catalog.snapshot.packages.includes(packageName))throw new AppError('app_not_installed','当前应用目录中没有这个应用。',404);
  return {...app(packageName),...this.info(catalog)};
 }
}
