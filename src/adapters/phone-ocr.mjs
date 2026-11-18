import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT} from '../config.mjs';
import {taobaoSearchHeader,sameSearchHeaderLine,searchHeaderTarget} from './phone-search-layout.mjs';
const execute=promisify(execFile);
const NAVIGATION_WORDS=new Set(['淘宝闪购外卖','淘宝闪购','闪购外卖','闪购','外卖','搜索栏','搜索框','搜索','返回','取消']);
const SENSITIVE_ROW=/(支付|付款|下单|提交|购买|抢购|加购|加入|结算|确认|订阅|开通|领取|删除|发送|预订|密码|验证码|安全验证|身份验证|登录|收货地址|授权|同意|客服|聊天)/;
export function normalizePhoneRecognition(data){
  if(!data||!Number.isInteger(data.width)||!Number.isInteger(data.height)||data.width<=0||data.height<=0||data.width>10000||data.height>10000||!Array.isArray(data.lines))return null;
  const validBounds=b=>Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[0]>=0&&b[1]>=0&&b[2]<=data.width&&b[3]<=data.height&&b[2]>b[0]&&b[3]>b[1];
  const rows=data.lines.map((row,index)=>({row,index})).filter(({row})=>typeof row?.text==='string'&&row.text.trim()&&validBounds(row.bounds)).slice(0,160);
  const knownRows=new Map(rows.map(({row,index})=>[index,row]));
  const entries=rows.map(({row,index})=>({text:row.text.slice(0,240),bounds:row.bounds,kind:'row',sourceRow:index}));
  for(const word of (Array.isArray(data.words)?data.words:[]).slice(0,160)){
    const row=knownRows.get(word?.sourceRow),range=word?.range;
    if(!row||word.geometrySource!=='vision_subrange'||!NAVIGATION_WORDS.has(word.text)||SENSITIVE_ROW.test(row.text)||!validBounds(word.bounds)||!Number.isInteger(range?.location)||!Number.isInteger(range?.length)||range.location<0||range.length!==word.text.length||row.text.slice(range.location,range.location+range.length)!==word.text||row.text===word.text)continue;
    const [left,top,right,bottom]=word.bounds,b=row.bounds;
    if(right-left>=b[2]-b[0]-2||left<b[0]-2||top<b[1]-2||right>b[2]+2||bottom>b[3]+2)continue;
    if(entries.some(n=>n.text===word.text&&n.bounds.every((v,i)=>Math.abs(v-word.bounds[i])<=2)))continue;
    entries.push({text:word.text,bounds:word.bounds,kind:'word',sourceRow:word.sourceRow,range:{location:range.location,length:range.length},geometrySource:'vision_subrange'});
  }
  return {width:data.width,height:data.height,lines:entries.map((n,i)=>({...n,id:'text-'+(i+1),center:{x:Math.round((n.bounds[0]+n.bounds[2])/2),y:Math.round((n.bounds[1]+n.bounds[3])/2)}}))};
}
export async function recognizePhoneImage(result){
  const image=result?.content?.find(c=>c.type==='image');
  if(process.platform!=='darwin'||!image)return null;
  let dir;
  try{
    const bytes=Buffer.from(image.data,'base64');if(!bytes.length||bytes.length>20000000)return null;
    dir=await fs.mkdtemp(path.join(os.tmpdir(),'boujoy-phone-ocr-'));
    const file=path.join(dir,'screen');await fs.writeFile(file,bytes,{mode:0o600});
    const {stdout}=await execute('/usr/bin/osascript',['-l','JavaScript',path.join(ROOT,'scripts/phone-ocr.js'),file],{timeout:6000,maxBuffer:500000});
    return normalizePhoneRecognition(JSON.parse(stdout));
  }catch{return null;}finally{if(dir)await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}
}
// OCR targets are still observations, not proof of clickability or permission.
// Re-read before acting. Transactions retain whole-screen checks; safe navigation may ignore distant content changes.
export function sameTextScreen(a,b){
  if(!a||!b||a.width!==b.width||a.height!==b.height)return false;
  const visible=s=>s.lines.filter(n=>n.bounds[1]>=s.height*0.04&&n.bounds[3]<=s.height*0.95).sort((a,b)=>a.bounds[1]-b.bounds[1]||a.bounds[0]-b.bounds[0]);
  const x=visible(a),y=visible(b);
  return x.length>0&&x.length===y.length&&x.every((n,i)=>n.text===y[i].text&&n.bounds.every((v,j)=>Math.abs(v-y[i].bounds[j])<=3));
}

const SAFE_NAVIGATION=/^(闪购|淘宝闪购|闪购外卖|淘宝闪购外卖|外卖|搜索|搜索栏|搜索框|返回|取消|商品|商家|综合|销量|距离|价格)$/;
const SENSITIVE_ACTION=/(支付|付款|下单|提交|购买|抢购|加购|加入|结算|选好了|确认|订阅|开通|领取|删除|发送|预订)/;
const SENSITIVE_CONTEXT=/(密码|验证码|安全验证|身份验证|登录|收货地址|管理地址|授权|同意|联系客服|聊天)/;
export const sameText=(a,b)=>String(a).replace(/\s+/g,'')===String(b).replace(/\s+/g,'');
// On autoplaying feeds (short video, live rooms) captions and counters next to a
// tab change every second, so the OCR neighbourhood never repeats. When the
// accessibility tree has the very control under the label, compare that control
// instead: same visible text or description, same bounds, still tappable.
// Payment, sending, deleting and sign-in words never take this path.
export function sameNativeTextTarget(before,after,target){
  if(!before||!after||!target?.text||!Array.isArray(target.bounds)||COMMIT_ACTION.test(target.text)||SENSITIVE_CONTEXT.test(target.text))return false;
  if(before.windowId!==after.windowId||before.packageName!==after.packageName)return false;
  // A payment, sign-in or verification prompt that was not on the page before stops the tap.
  const prompts=list=>new Set((Array.isArray(list)?list:[]).filter(node=>node?.visible===true).flatMap(node=>[node.text,node.description]).filter(v=>typeof v==='string').map(v=>v.replace(/\s+/g,'')).filter(v=>COMMIT_ACTION.test(v)||SENSITIVE_CONTEXT.test(v)));
  const known=prompts(before.elements);for(const text of prompts(after.elements))if(!known.has(text))return false;
  const label=String(target.text).replace(/\s+/g,''),cx=(target.bounds[0]+target.bounds[2])/2,cy=(target.bounds[1]+target.bounds[3])/2;
  const names=node=>[node.text,node.description].filter(v=>typeof v==='string').map(v=>v.replace(/\s+/g,''));
  const control=node=>node?.visible===true&&node.enabled===true&&!node.password&&Array.isArray(node.bounds)&&node.bounds.length===4&&cx>=node.bounds[0]&&cx<=node.bounds[2]&&cy>=node.bounds[1]&&cy<=node.bounds[3]&&names(node).some(name=>name===label||name.startsWith(label)&&name.length<=label.length+6);
  const matches=list=>(Array.isArray(list)?list:[]).filter(control);
  const old=matches(before.elements),now=matches(after.elements);
  if(!old.length||old.length>4||old.length!==now.length)return false;
  const left=[...now];
  return old.every(node=>{const i=left.findIndex(next=>names(next).join('|')===names(node).join('|')&&next.bounds.every((v,j)=>Math.abs(v-node.bounds[j])<=4));if(i<0)return false;left.splice(i,1);return true;});
}
// What a re-read must establish before tapping a label on a live page: the label
// is still where it was read, no payment, sign-in or verification prompt has
// appeared anywhere, and the amounts printed right beside it are the same.
// Countdowns, banners, other items' prices and cart badges may change freely.
// Words whose tap spends money, sends or deletes, and the search-header field,
// keep the stricter comparison below.
const COMMIT_ACTION=/(支付|付款|下单|提交|购买|抢购|结算|确认|订阅|开通|删除|发送|预订)/;
const squash=text=>String(text).replace(/\s+/g,'');
function labelStillThere(a,b,target){
  if(!Array.isArray(target?.bounds))return false;
  const hits=b.lines.filter(line=>sameText(line.text,target.text)&&Array.isArray(line.bounds)&&line.bounds.every((v,i)=>Math.abs(v-target.bounds[i])<=10));
  if(hits.length!==1)return false;
  const sensitive=s=>new Set(s.lines.map(line=>squash(line.text)).filter(text=>COMMIT_ACTION.test(text)||SENSITIVE_CONTEXT.test(text)));
  const before=sensitive(a);for(const text of sensitive(b))if(!before.has(text))return false;
  const [left,top,right,bottom]=target.bounds;
  const amounts=s=>s.lines.filter(n=>{const x=(n.bounds[0]+n.bounds[2])/2,y=(n.bounds[1]+n.bounds[3])/2;return x>=left-72&&x<=right+72&&y>=top-112&&y<=bottom+112;}).flatMap(n=>[...squash(n.text).matchAll(/[¥￥](\d+(?:\.\d+)?)/g)].map(m=>m[1])).sort().join(',');
  return amounts(a)===amounts(b);
}
export function sameTextTarget(a,b,target){
  if(sameTextScreen(a,b))return true;
  if(!a||!b||a.width!==b.width||a.height!==b.height)return false;
  if(!COMMIT_ACTION.test(target.text)&&!SENSITIVE_CONTEXT.test(target.text)&&!searchHeaderTarget(a,target))return labelStillThere(a,b,target);
  if(SENSITIVE_ACTION.test(target.text)||SENSITIVE_CONTEXT.test(target.text))return false;
  const normalized=target.text.replace(/\s+/g,'');
  // The custom search field displays the previous keyword, not a static “搜索” label.
  const beforeHeader=taobaoSearchHeader(a),afterHeader=taobaoSearchHeader(b);
  const headerNavigation=searchHeaderTarget(a,target)&&afterHeader.focusFields.some(line=>sameSearchHeaderLine(line,target))&&((!beforeHeader.button&&!afterHeader.button)||sameSearchHeaderLine(beforeHeader.button,afterHeader.button));
  const navigation=SAFE_NAVIGATION.test(normalized.replace(/[［］\[\]【】、·•]/g,''))||!!headerNavigation;
  const critical=s=>s.lines.filter(n=>n.bounds[1]>=s.height*.04&&n.bounds[3]<=s.height*.95).flatMap(n=>{const text=n.text.replace(/\s+/g,'');const signals=navigation?[]:[...text.matchAll(/[¥￥](\d+(?:\.\d+)?)/g)].map(m=>'amount:'+m[1]);if(SENSITIVE_ACTION.test(text)||SENSITIVE_CONTEXT.test(text))signals.push('critical:'+text);return signals;}).sort();
  if(JSON.stringify(critical(a))!==JSON.stringify(critical(b)))return false;
  const [left,top,right,bottom]=target.bounds;
  const nearby=s=>s.lines.filter(n=>{const x=(n.bounds[0]+n.bounds[2])/2,y=(n.bounds[1]+n.bounds[3])/2;return x>=left-72&&x<=right+72&&y>=Math.max(s.height*.04,top-112)&&y<=Math.min(s.height*.95,bottom+112);});
  const before=nearby(a),remaining=[...nearby(b)];
  return before.length>0&&before.length===remaining.length&&before.every(n=>{const i=remaining.findIndex(next=>sameText(n.text,next.text)&&n.bounds.every((v,j)=>Math.abs(v-next.bounds[j])<=4));if(i<0)return false;remaining.splice(i,1);return true;});
}
