import {validSession} from '../remote/display-commands.mjs';
import {nativeWindowConflict} from './phone-window-identity.mjs';
import {usbDebugWarning} from './phone-overlays.mjs';
import {taobaoSearchHeader} from './phone-search-layout.mjs';
import {authorizedSearchText} from './phone-search-terms.mjs';
import {platformPackageMatches} from '../core/commerce-platforms.mjs';

// Shopping apps change layouts, stores, spec sheets and ads constantly; an
// allow-list of known controls stalls on every new page. Inside a direct
// purchase task (user pays) the platform app may be navigated freely, and only
// controls that pay, submit, authenticate, consent or touch account data are
// refused. Reaching the order page is the hand-off point, never a tap target.
const compact=text=>String(text||'').normalize('NFKC').replace(/\s+/g,'');
const DANGER=/(?:提交订单|确认下单|立即支付|去支付|确认支付|确认付款|支付|付款|免密|密码|验证码|登录|注册|授权|同意|开通|订阅|删除|清空|取消订单|退款|退货|地址|客服|发送|拨打|电话|分享|举报|关注店铺)/;
const ADD=/^(?:\+|＋|加一份|加1份|加一杯|加1杯|加一件|加1件|加入购物车|确认加入购物车|加购)$/;
export const PURCHASE_ADD_KINDS=new Set(['purchase_add','prepare_add_one','prepare_add_selected']);
const HANDOFF=/(?:提交订单|收银台|支付密码|输入密码|短信验证码|安全验证|身份验证)/;
const MAX_AGE_MS=20000;

export function nativeState(observation){
  for(const item of observation?.tree?.content||[]){
    if(item?.type!=='text')continue;
    try{const data=JSON.parse(item.text);if(data.ok===true&&typeof data.result?.tree==='string')return data.result;}catch{}
  }
  // Screenshot-only observations retain the driver's validated window identity;
  // an empty tree explicitly means no accessibility nodes were observed.
  const n=observation?.native;
  if(observation?.screenshotOnly!==true||!Number.isSafeInteger(n?.windowId)||n.windowId<0||typeof n.packageName!=='string'||!n.observationId||!n.serviceInstanceId)return null;
  const result={display:'main',foreground:n.packageName,windowPkg:n.packageName,window:n.windowId,tree:''};
  if(n.display?.id===0)return n.displaySession==null?result:null;
  // normalizePhoneUseObservation binds this session to the requested display before
  // constructing native. A positive display ID alone never authorizes a fallback.
  const session=n.displaySession;
  if(!validSession(session)||n.display?.id!==session.displayId||typeof n.deviceId!=='string'||!n.deviceId
    ||typeof n.observationId!=='string'||typeof n.serviceInstanceId!=='string'||!n.observationId.startsWith(n.serviceInstanceId+':'))return null;
  const window=Array.isArray(n.windows)?n.windows.find(w=>w?.display_id===session.displayId&&w.window_id===n.windowId):null;
  if(!window||window.type!==1||window.package_name!==n.packageName||nativeWindowConflict(n))return null;
  // Keep the legacy policy label internal; model-facing results use these verified
  // display fields to describe the background destination without changing scope.
  return {...result,backend:'display',displayId:session.displayId,displaySession:{sessionId:session.sessionId,generation:session.generation,displayId:session.displayId}};
}
function inside(bounds,x,y){return Array.isArray(bounds)&&x>=bounds[0]&&x<=bounds[2]&&y>=bounds[1]&&y<=bounds[3];}
export function labelsAt(observation,state,x,y){
  const labels=(observation.ocr?.lines||[]).filter(line=>inside(line.bounds,x,y)).map(line=>line.text);
  const width=observation.ocr?.width||0,height=observation.ocr?.height||0,screen=width*height;
  for(const line of state.tree.split('\n')){
    const match=line.match(/bounds=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);if(!match)continue;
    const b=match.slice(1).map(Number);if(!inside(b,x,y))continue;
    if(screen&&(b[2]-b[0])*(b[3]-b[1])>screen*.25)continue;
    for(const quoted of line.matchAll(/"((?:[^"\\]|\\.)*)"/g))labels.push(quoted[1]);
  }
  return labels;
}

export function classifyPurchaseNavigation(taskId,args,observation,grant){
  if(!grant||grant.taskId!==taskId||grant.goal!=='checkout'||grant.payment!=='user')return null;
  if(observation?.taskId!==taskId||observation.id!==args?.observationId||!Number.isFinite(observation.at)||Date.now()-observation.at>MAX_AGE_MS||observation.at>Date.now()+1000)return null;
  const state=nativeState(observation);
  if(!state||state.display!=='main')return null;
  if(usbDebugWarning(observation.ocr))return args.action==='back'?{kind:'purchase_dismiss_notice'}:null;
  if(!platformPackageMatches(grant.platform,state.windowPkg))return null;
  if(args.action==='back'&&!Object.hasOwn(args,'textTargetId'))return {kind:'purchase_back'};
  const screen=(observation.ocr?.lines||[]).map(line=>compact(line.text)).join('|');
  if(HANDOFF.test(screen)||screen.split('|').some(label=>/^(?:确认订单|订单确认|填写订单)$/.test(label))||/\bpassword\b/.test(state.tree))return {kind:'purchase_handoff',handoff:true};
  if(args.action==='swipe')return {kind:'purchase_scroll'};
  if(args.action==='type'){
    const text=compact(args.text);
    const nativeSearch=state.tree.split('\n').some(line=>/\beditable\b/.test(line)&&/\bfocused\b/.test(line)&&!/password|offscreen/i.test(line)&&/搜索|查找|Search/i.test(line));
    const search=taobaoSearchHeader(observation.ocr);
    const currentSearch=nativeSearch||!!search.inputField||!!search.stripField;
    const blockedScreen=/收货地址|管理地址|编辑地址|收货人|手机号|联系客服|聊天|验证码|密码|登录/.test(screen);
    return text.length>=2&&text.length<=80&&!blockedScreen&&(authorizedSearchText(text,grant.query)||currentSearch)?{kind:'purchase_search'}:null;
  }
  if(!['tap','long_press'].includes(args.action)||args.action==='long_press')return null;
  let labels;
  if(typeof args.textTargetId==='string'){
    const target=(observation.ocr?.lines||[]).find(line=>line.id===args.textTargetId);if(!target)return null;
    labels=[target.text,...labelsAt(observation,state,target.center.x,target.center.y)];
  }else if(Number.isFinite(args.x)&&Number.isFinite(args.y))labels=labelsAt(observation,state,args.x,args.y);
  else return null;
  if(labels.some(label=>DANGER.test(compact(label))))return null;
  const label=compact(labels[0]||'').slice(0,40);
  const adds=labels.some(item=>ADD.test(compact(item)));
  const texts=(observation.ocr?.lines||[]).map(line=>compact(line.text));
  const specVisible=texts.some(text=>/^数量(?:[：:]?\d{1,2})?$/.test(text))&&texts.some(text=>/^(?:规格|选择规格|存储方式|储存方式|温度|口味|杯型|糖度|颜色|尺码|型号)$/.test(text));
  const opensSpec=adds&&/^(?:加入购物车|确认加入购物车)$/.test(label)&&!specVisible;
  return {kind:opensSpec?'purchase_open_spec':adds?'purchase_add':/^(?:立即购买|领券购买|立即买|马上购买)$/.test(label)?'purchase_buy_now':'purchase_tap',label};
}
