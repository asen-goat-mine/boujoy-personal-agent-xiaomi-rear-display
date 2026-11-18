import {assertExecutionPermission,withExecutionPermission} from '../core/execution-permissions.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { DATA } from '../config.mjs';
import { AppError, requireValue } from '../core/errors.mjs';
import {validateTaskContract} from '../core/task-contract.mjs';
import {parseMessageRequest} from '../core/message-contract.mjs';

// Named destinations are resolved locally, never learned from model/tool output.
// Exact known hosts plus public browsing routes avoid granting an entire domain's
// login, cart, checkout or arbitrary GET action endpoints.
const NAMED_SITES=[
  {name:/(?:苹果|\bapple\b)\s*(?:(?:中国|中国大陆|官方)\s*)?(?:官网|官方网站|网站|official\s+(?:site|website))/i,
    hosts:['apple.com','www.apple.com','apple.com.cn','www.apple.com.cn'],
    paths:/^\/(?:cn(?:\/|$))?(?:$|(?:iphone|ipad|mac|watch|airpods|homepod|accessibility|support)[a-z0-9-]*(?:\/[a-z0-9-]+)*\/?$|shop\/?$|shop\/(?:buy-[a-z-]+|product|refurbished|accessories)(?:\/[^.?#]*)?$)/i},
  {name:/京东|\bjd(?:\.com)?\b/i,
    hosts:['jd.com','www.jd.com','m.jd.com','search.jd.com','item.jd.com','item.m.jd.com'],
    paths:/^\/(?:$|Search|search(?:\/index)?|(?:product\/)?\d+\.html)$/i},
];
const BROWSE_QUERY_KEYS=new Set(['keyword','enc','wq','page','sort','psort','stock','cid1','cid2','cid3','ev','pvid','sku','th','psc','fnode','fs','afid','cid','utm_source','utm_medium','utm_campaign']);
function namedSiteRequested(goal,target){
  if(target.protocol!=='https:'||target.username||target.password||target.port)return false;
  const instruction=(parseMessageRequest(goal)?.instruction||goal)
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'|`[^`]*`/g,'[正文]')
    .replace(/(?:不要|不用|别|禁止|不允许|无需)(?:[^，。；;!！?？]*)/g,'');
  let pathname;try{pathname=decodeURIComponent(target.pathname);}catch{return false;}
  if(/(?:^|[\/._-])(?:add|remove|delete|submit|checkout|pay|payment|order|login|logout|signin|signout|redirect|bag|cart)(?:[\/._-]|$)/i.test(pathname))return false;
  for(const [key,value] of target.searchParams)if(!BROWSE_QUERY_KEYS.has(key.toLowerCase())||/https?:|^\/\//i.test(value))return false;
  return NAMED_SITES.some(site=>site.name.test(instruction)&&site.hosts.includes(target.hostname)&&site.paths.test(pathname));
}
export function explicitlyRequestedURL(task,value,{store}={}){
  const checked=validateTaskContract(task,{store});if(!checked.valid||checked.contract.intent!=='task'||!checked.contract.effects.includes('navigate'))return false;
  let target;try{target=new URL(value);}catch{return false;}
  const goal=checked.contract.goal;
  if((goal.match(/https?:\/\/[^\s<>"“”「」]+/g)||[]).some(raw=>{try{return new URL(raw.replace(/[，。；！？、）)]+$/,'')).href===target.href;}catch{return false;}}))return true;
  return namedSiteRequested(goal,target);
}

export function isPrivateAddress(ip){
  if(ip.includes(':'))return /^(::|fc|fd|fe[89ab])/i.test(ip)||ip.toLowerCase().includes('ffff:');
  const [a,b]=ip.split('.').map(Number);return a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127;
}
// Syntax/scheme admission is synchronous so a tool can reject unsupported
// destinations before asking the user to approve a navigation that cannot run.
export function browserURL(value){
  let u;try{u=new URL(value);}catch{throw new AppError('invalid_url','网址无效');}
  if(u.protocol==='file:')throw new AppError('browser_local_file_unsupported','browser_open 只支持公开 HTTP/HTTPS 网页，不支持 file: 本地文件。读取 Mac 文件请用 mac_files（先 find/list，再 read）；本任务附件请用 artifact_list / artifact_read。HTML 文件也可作为文本读取，无需打开浏览器或请求此导航授权。');
  requireValue(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&(!u.port||['80','443'].includes(u.port)),'仅支持标准端口的公开网页');
  return u;
}
export async function publicURL(value){
  const u=browserURL(value);
  const host=u.hostname.replace(/^\[|\]$/g,'');requireValue(host!=='localhost'&&!host.endsWith('.local'),'不允许访问本地服务');
  let addresses;try{addresses=isIP(host)?[{address:host}]:await lookup(host,{all:true});}catch{throw new AppError('dns_failed','无法解析该网址');}
  requireValue(addresses.length&&addresses.every(x=>!isPrivateAddress(x.address)),'不允许访问本地或私有网络');return u.href;
}
export class Browser {
  constructor(){this.context=null;this.pages=new Map();this.observations=new Map();this.manualOwners=new Map();this.pending=new Map();for(const method of ['workspaceInspection','workspaceCapture','workspaceAct']){const operation=this[method].bind(this);this[method]=(...args)=>withExecutionPermission(this.executionStore,['browser'],args[0],()=>operation(...args));}}
  assertAgentAccess(taskId){assertExecutionPermission(this.executionStore,'browser');requireValue(!this.manualOwners.has(taskId),'这项任务的电脑工作页正由你操作','browser_manual_control');}
  async agentOperation(taskId,fn){return withExecutionPermission(this.executionStore,['browser'],taskId,async()=>{this.assertAgentAccess(taskId);this.pending.set(taskId,(this.pending.get(taskId)||0)+1);try{const result=await fn();this.assertAgentAccess(taskId);return result;}finally{const n=(this.pending.get(taskId)||1)-1;if(n)this.pending.set(taskId,n);else this.pending.delete(taskId);}});}
  existingPage(taskId){const page=this.pages.get(taskId);requireValue(page&&!page.isClosed(),'这项任务没有可接管的电脑工作页','browser_page_missing');return page;}
  setManual(taskId,owner){this.existingPage(taskId);requireValue(!this.manualOwners.has(taskId),'这个工作页已经被接管','browser_manual_control');this.manualOwners.set(taskId,owner);this.observations.delete(taskId);}
  clearManual(taskId,owner){if(this.manualOwners.get(taskId)===owner){this.manualOwners.delete(taskId);this.observations.delete(taskId);}}
  async start(){
    if(this.context)return this.context;
    if(this.starting)return this.starting;
    this.starting=(async()=>{
      try{
        const {chromium}=await import('playwright');
        this.context=await chromium.launchPersistentContext(path.join(DATA,'browser'),{...(fs.existsSync(chromium.executablePath())?{}:{channel:'chrome'}),headless:false,viewport:{width:1280,height:900},acceptDownloads:false,serviceWorkers:'block',args:['--disable-background-networking','--disable-features=MediaRouter','--disable-quic']});
        try{assertExecutionPermission(this.executionStore,'browser');}catch(error){await this.context.close();this.context=null;throw error;}
        await this.context.route('**/*',async route=>{try{await publicURL(route.request().url());await route.continue();}catch{await route.abort();}});
        this.context.on('close',()=>{this.context=null;this.pages.clear();this.observations.clear();});return this.context;
      }catch(error){if(['execution_disabled','execution_revoked'].includes(error.code))throw error;throw new AppError('browser_unavailable','浏览器尚未就绪，请完成浏览器安装或重新启动。',503);}finally{this.starting=null;}
    })();return this.starting;
  }
  async page(taskId){this.assertAgentAccess(taskId);const ctx=await this.start();this.assertAgentAccess(taskId);let page=this.pages.get(taskId);if(!page||page.isClosed()){page=await ctx.newPage();this.assertAgentAccess(taskId);this.pages.set(taskId,page);}return page;}
  async navigate(taskId,url){return this.agentOperation(taskId,async()=>{const target=await publicURL(url),page=await this.page(taskId);this.assertAgentAccess(taskId);await page.goto(target,{waitUntil:'domcontentloaded',timeout:45000});return this.observe(taskId);});}
  async observe(taskId){return this.agentOperation(taskId,()=>this.observePage(taskId));}
  async observePage(taskId){
    const page=await this.page(taskId),id=randomUUID();const data=await page.evaluate(observationId=>{
      // The sensitive-field check looks at every visible control; only what is returned is capped.
      const all=[...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')].filter(e=>e.getClientRects().length&&!e.closest('[hidden]')),nodes=all.slice(0,180);
      const protectedInput=all.some(e=>e.getAttribute('type')==='password'||e.getAttribute('autocomplete')==='one-time-code'||['INPUT','TEXTAREA'].includes(e.tagName)&&/密码|验证码|PIN|OTP|passcode|password/i.test([e.getAttribute('aria-label'),e.getAttribute('placeholder'),e.getAttribute('name'),e.getAttribute('id')].join(' ')));
      if(protectedInput)return {title:'需要你在浏览器完成验证',url:location.origin,credentialBoundary:true,userInputRequired:true,text:'',elements:[]};
      nodes.forEach((e,index)=>e.setAttribute('data-boujoy-target',`${observationId}-${index}`));
      return {title:document.title,url:location.href,text:document.body.innerText.slice(0,18000),elements:nodes.map((e,index)=>({index,tag:e.tagName.toLowerCase(),type:e.getAttribute('type'),text:(e.innerText||e.getAttribute('aria-label')||e.getAttribute('placeholder')||'').slice(0,180),href:e.tagName==='A'?e.getAttribute('href'):undefined,password:e.getAttribute('type')==='password'}))};
    },id);
    this.assertAgentAccess(taskId);this.observations.set(taskId,{id,at:Date.now(),credentialBoundary:data.credentialBoundary===true,hash:createHash('sha256').update(JSON.stringify(data)).digest('hex')});return {observationId:id,...data,untrustedContent:true};
  }
  async validateObservation(taskId,observationId){
    const old=this.observations.get(taskId);if(!old||old.id!==observationId||Date.now()-old.at>180000)throw new AppError('stale_observation','页面观察已过期，请重新读取页面',409);
    await this.observe(taskId);const fresh=this.observations.get(taskId);if(old.hash!==fresh.hash)throw new AppError('page_changed','页面已经变化，请重新读取后决定操作',409);
    requireValue(!fresh.credentialBoundary,'浏览器验证由用户接管','credential_boundary');return fresh;
  }
  async act(taskId,args){return this.agentOperation(taskId,()=>this.actPage(taskId,args));}
  async actPage(taskId,args){
    const fresh=await this.validateObservation(taskId,args.observationId);const page=await this.page(taskId);
    const locator=page.locator(`[data-boujoy-target="${fresh.id}-${args.index}"]`);
    requireValue(Number.isInteger(args.index)&&args.index>=0&&args.index<180,'控件编号无效');
    requireValue(await locator.count()===1,'控件已变化，请重新读取');
    requireValue(await locator.getAttribute('type')!=='password','密码由用户接管输入');
    this.assertAgentAccess(taskId);
    if(args.action==='click')await locator.click({timeout:10000});
    else if(args.action==='fill'){requireValue(typeof args.text==='string'&&args.text.length<=4000,'输入内容过长');await locator.fill(args.text,{timeout:10000});}
    else throw new AppError('invalid_action','不支持的网页操作');
    this.observations.delete(taskId);return {accepted:true,requiresVerification:true,...await this.observe(taskId)};
  }
  async screenshot(taskId){return this.agentOperation(taskId,async()=>{const observed=await this.observe(taskId);requireValue(!observed.credentialBoundary,'验证页面由用户接管，不发送截图','credential_boundary');const p=await this.page(taskId);return {mimeType:'image/png',data:(await p.screenshot()).toString('base64')};});}
  async workspaceInspection(taskId,owner,guard){
    const callerGuard=guard;guard=()=>{assertExecutionPermission(this.executionStore,'browser');callerGuard();};
    assertExecutionPermission(this.executionStore,'browser');guard();requireValue(this.manualOwners.get(taskId)===owner,'工作页接管已失效','browser_session_expired');const page=this.existingPage(taskId),frames=[];
    requireValue(/^https?:\/\//.test(page.url()),'此页面不支持远程查看','browser_page_protected');
    for(const frame of page.frames()){
      const value=await frame.evaluate(()=>{
        const sensitive=/密码|验证码|口令|支付密码|银行卡|信用卡|安全码|card.?number|cvv|cvc|password|passcode|one.?time|\bpin\b|\botp\b/i;
        const inputs=[...document.querySelectorAll('input,textarea,[contenteditable="true"]')];
        const credentialBoundary=inputs.some(e=>e.type==='password'||/^(?:cc-|one-time-code)/i.test(e.autocomplete||'')||sensitive.test([e.type,e.name,e.id,e.getAttribute('aria-label'),e.getAttribute('placeholder'),e.getAttribute('autocomplete'),...Array.from(e.labels||[]).map(l=>l.innerText)].join(' ')))||/\/(?:login|signin|sign-in|oauth|authorize|authentication|payment|pay|checkout|captcha|recaptcha|challenge)(?:[/?#]|$)/i.test(location.href)||/扫码登录|扫描二维码.*登录|输入验证码|请输入密码|支付密码|信用卡安全码|scan.{0,20}(?:log.?in|sign.?in)|enter.{0,20}(?:verification code|password)/i.test(document.body?.innerText||'');
        const elements=[...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')].filter(e=>e.getClientRects().length&&!e.closest('[hidden]')).slice(0,180).map((e,index)=>({index,tag:e.tagName.toLowerCase(),type:e.getAttribute('type')||'',text:(e.innerText||e.getAttribute('aria-label')||e.getAttribute('placeholder')||'').slice(0,160),value:['INPUT','TEXTAREA'].includes(e.tagName)?e.value.slice(0,1000):'',href:e.getAttribute('href')||'',disabled:e.disabled===true}));
        return {url:location.href,title:document.title,credentialBoundary,text:document.body?.innerText.slice(0,24000)||'',elements,scrollX,scrollY};
      });assertExecutionPermission(this.executionStore,'browser');guard();frames.push(value);
    }
    requireValue(frames.every(f=>!f.credentialBoundary),'验证、密码或支付页面须在电脑上处理，不传送画面或输入','credential_boundary');
    const data={frames};return {page,data,hash:createHash('sha256').update(JSON.stringify(data)).digest('hex')};
  }
  async workspaceCapture(taskId,owner,guard){
    const callerGuard=guard;guard=()=>{assertExecutionPermission(this.executionStore,'browser');callerGuard();};
    const before=await this.workspaceInspection(taskId,owner,guard);guard();const image=await before.page.screenshot({type:'jpeg',quality:65,fullPage:false,scale:'css',timeout:5000});
    const after=await this.workspaceInspection(taskId,owner,guard);requireValue(before.hash===after.hash,'页面正在变化，请刷新工作页','page_changed');guard();
    const frameId=randomUUID(),elements=after.data.frames[0].elements;
    await after.page.evaluate(({frameId})=>{[...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')].filter(e=>e.getClientRects().length&&!e.closest('[hidden]')).slice(0,180).forEach((e,index)=>e.setAttribute('data-boujoy-human-target',frameId+'-'+index));},{frameId});guard();
    return {frameId,hash:after.hash,at:Date.now(),mime:'image/jpeg',imageBase64:image.toString('base64'),title:after.data.frames[0].title,elements:elements.map(({value,href,...e})=>e)};
  }
  async workspaceAct(taskId,owner,frame,args,guard){
    const callerGuard=guard;guard=()=>{assertExecutionPermission(this.executionStore,'browser');callerGuard();};
    requireValue(frame&&args.frameId===frame.frameId&&Date.now()-frame.at<=15000,'画面已过期，请刷新后操作','stale_observation');
    const current=await this.workspaceInspection(taskId,owner,guard);requireValue(current.hash===frame.hash,'网页已变化，请刷新后操作','page_changed');
    if(args.action==='scroll'){requireValue(['up','down'].includes(args.direction),'滚动方向无效');guard();await current.page.mouse.wheel(0,args.direction==='down'?500:-500);}
    else{
      requireValue(['click','fill'].includes(args.action)&&Number.isInteger(args.index)&&args.index>=0&&args.index<180,'工作页操作无效');
      const locator=current.page.locator(`[data-boujoy-human-target="${frame.frameId}-${args.index}"]`);requireValue(await locator.count()===1,'控件已变化，请刷新');guard();
      requireValue(!['password','file'].includes(await locator.getAttribute('type')),'此控件必须在电脑上处理','credential_boundary');guard();
      if(args.action==='click')await locator.click({timeout:3000});
      else{requireValue(typeof args.text==='string'&&args.text.length<=4000,'输入内容无效');await locator.fill(args.text,{timeout:3000});}
    }
    guard();return {accepted:true,requiresRefresh:true};
  }
  async closeTask(id){this.manualOwners.delete(id);const p=this.pages.get(id);if(p&&!p.isClosed())await p.close();this.pages.delete(id);this.observations.delete(id);}
  async close(){if(this.starting)try{await this.starting;}catch{}await this.context?.close();}
}
