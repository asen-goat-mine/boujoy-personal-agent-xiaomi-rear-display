import {effectPlan} from './phone-effects.mjs';
import {commercePlatform} from '../core/commerce-platforms.mjs';
import {nativeState,labelsAt} from './phone-purchase-navigation.mjs';

// Any app the user names in the current message may be operated without a
// hand-written scenario: reading, tapping, scrolling, typing and going back run
// automatically, including ordinary commits within that requested app task; the
// payment, passwords and verification codes are never operated by the agent.
const compact=text=>String(text||'').normalize('NFKC').replace(/\s+/g,'');
const USER_ONLY=/(?:支付|付款|免密|密码|验证码|收银台|转账|提现|充值|指纹|人脸|提交订单|确认下单)/;
// Shopping cards say "1万+人付款" / "300人已付款" / "付款人数" (sales counts), and
// listings mention "先用后付" or "免密支付可用". Those are product facts, not a
// payment step; only an actual pay/verify control should hand off.
const SALES_NOISE=/[0-9０-９.,，]+\s*(?:万|千|百|w|W)?\+?\s*人(?:已)?(?:付款|支付|购买|收货)|付款人数|已付款\d*|先用后付|支持免密支付/g;
export function userOnlyText(value){return compact(value).replace(SALES_NOISE,'');}
export const USER_ONLY_SCREEN=/(?:收银台|支付密码|输入密码|验证码|安全验证|身份验证|EnterPassword|EnterPIN|EnterOTP|VerificationCode)/i;
const COMMIT=/(?:发送|发布|发表|提交|确认|确定|下单|购买|删除|清空|移除|卸载|撤回|关注|点赞|保存|拨打|呼叫|拨号|视频通话|语音通话|退出登录|注销|授权|同意|允许|开通|订阅|领取|报名|预约|预订|加入购物车|立即购买|send|post|publish|delete|remove|submit|confirm|subscribe|follow|call)/i;
const TOGGLE=/^\s*(?:\S+\.)?(?:Switch(?:Compat|Material)?|CheckBox|ToggleButton|RadioButton|CompoundButton)\b/;
const MAX_AGE_MS=45000;

// Category words that the old app list treats as names; saying them is not choosing an app.
const GENERIC_APP_WORDS=new Set(['外卖','闪购','浏览器','文件','files','邮件','邮箱','maps','play','商店','地图','音乐']);
export function generalAppGrant(task,{packageName,label,appName,aliases=[]}={}){
  // 持续跟进 checks may look inside an app too; the broker refuses every commit for them.
  const delegated=task?.source==='delegation'&&task.originSource==='user';
  if(!task||typeof task.id!=='string'||task.source&&!['user','watch'].includes(task.source)&&!delegated||!delegated&&(task.parentId||(task.depth||0)>0))return null;
  if(!['running','waiting_approval'].includes(task.status)||!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName||''))return null;
  const users=(task.messages||[]).filter(item=>item.role==='user'&&!item.externalContent&&!item.external_content&&!item.interjection);
  const message=users.at(-1);
  if(!message||message.externalContent||message.external_content)return null;
  if((task.source||'user')==='user'||delegated)return {taskId:task.id,packageName,appName:compact(appName||label),mode:'general',decisionOwner:'harness',sourceMessageId:message.id||null};
  const text=compact(users.map(m=>m.content).join(' ')).toLowerCase();
  const named=[appName,label,...aliases].map(value=>compact(value).toLowerCase()).filter(value=>value.length>=2).find(value=>text.includes(value));
  const platform=commercePlatform(task.phoneQuery?.platform);
  const contractNamed=(task.taskContract?.allowedApps||[]).some(value=>[appName,label,packageName,...aliases].some(name=>compact(name).toLowerCase()===compact(value).toLowerCase()));
  // Model-led: for the user's own task the model may pick a suitable installed
  // app ("放首周杰伦的歌" → a music app). Opening and browsing are reversible;
  // sends, purchases and other commits keep their own checks downstream.
  // If the user named particular apps, stay in those; the model only picks when none was named.
  // Apps the system inferred (e.g. a default shopping platform) do not count as
  // the user's choice; only an app name the user actually wrote does.
  const userNamedApps=(task.taskContract?.allowedApps||[]).filter(value=>compact(value).length>=2&&!GENERIC_APP_WORDS.has(compact(value).toLowerCase())&&text.includes(compact(value).toLowerCase()));
  const modelSelected=!named&&!contractNamed&&!platform?.packages.includes(packageName)&&task.taskContract?.intent==='task'&&!userNamedApps.length;
  if(!named&&!contractNamed&&!platform?.packages.includes(packageName)&&!modelSelected)return null;
  for(const name of [named,appName,label,...aliases].map(value=>compact(value).toLowerCase()).filter(value=>value&&value.length>=2)){
    const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    if(new RegExp('(?:不要|别|不用|禁止|不许)(?:打开|进入|用|使用|碰)?'+escaped).test(text))return null;
  }
  const plan=effectPlan(task.taskContract),boundPlan=plan?.app&&![appName,label,...aliases].includes(plan.app)?null:plan;
  return {taskId:task.id,packageName,appName:compact(appName||label),mode:'general',sourceMessageId:message.id||null,effectPlan:boundPlan,contractId:task.taskContract?.id,contractRevision:task.taskContract?.revision,...(modelSelected?{modelSelected:true}:{}),...(task.source==='watch'?{readOnly:true}:{})};
}

export function generalForeground(observation){
  const state=nativeState(observation);
  return state?.display==='main'&&typeof state.windowPkg==='string'?state.windowPkg:null;
}

export function classifyGeneralAction(taskId,args,observation,grant){
  if(grant?.mode!=='general'||grant.taskId!==taskId)return null;
  if(observation?.taskId!==taskId||observation.id!==args?.observationId||!Number.isFinite(observation.at)||Date.now()-observation.at>MAX_AGE_MS||observation.at>Date.now()+1000)return null;
  if(grant.decisionOwner==='harness'){
    const supported={tap:'general_tap',long_press:'general_long_press',type:'general_type',back:'general_back',swipe:'general_scroll'};
    return supported[args.action]?{kind:supported[args.action]}:null;
  }
  if(observation.returnOnly)return args.action==='back'&&!args.textTargetId?{kind:'general_back'}:null;
  const state=nativeState(observation);
  if(!state||state.display!=='main'||![grant.packageName,...(grant.followedPackages||[])].includes(state.windowPkg))return null;
  if(args.action==='back'&&!Object.hasOwn(args,'textTargetId'))return {kind:'general_back'};
  if(args.action==='swipe')return {kind:'general_scroll'};
  const screen=(observation.ocr?.lines||[]).map(line=>compact(line.text)).join('|');
  if(USER_ONLY_SCREEN.test(screen))return {kind:'general_user_only',handoff:true};
  if(args.action==='type'){
    if(state.tree.split('\n').some(line=>/\bfocused\b/.test(line)&&/\bpassword\b/.test(line)))return {kind:'general_user_only',handoff:true};
    return typeof args.text==='string'&&args.text.length?{kind:'general_type'}:null;
  }
  if(!['tap','long_press'].includes(args.action))return null;
  let labels,x,y;
  if(typeof args.textTargetId==='string'){
    const target=(observation.ocr?.lines||[]).find(line=>line.id===args.textTargetId);if(!target)return null;
    ({x,y}=target.center);labels=[target.text,...labelsAt(observation,state,x,y)];
  }else if(Number.isFinite(args.x)&&Number.isFinite(args.y)){x=args.x;y=args.y;labels=labelsAt(observation,state,x,y);}
  else return null;
  const label=compact(labels[0]||'').slice(0,40);
  if(labels.some(item=>USER_ONLY.test(userOnlyText(item))))return {kind:'general_user_only',handoff:true,label};
  const hit=state.tree.split('\n').filter(line=>{const m=line.match(/bounds=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);if(!m)return false;const b=m.slice(1).map(Number);return x>=b[0]&&x<=b[2]&&y>=b[1]&&y<=b[3];});
  if(hit.some(line=>/\bpassword\b/.test(line)))return {kind:'general_user_only',handoff:true,label};
  if(args.action==='long_press')return {kind:'general_long_press',label};
  if(labels.some(item=>COMMIT.test(compact(item)))||hit.some(line=>TOGGLE.test(line)))return {kind:'general_commit',confirm:true,label};
  return {kind:'general_tap',label};
}
