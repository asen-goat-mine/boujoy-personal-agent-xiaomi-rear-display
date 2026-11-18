import {AppError,requireValue} from '../core/errors.mjs';

const compact=value=>String(value).normalize('NFKC').replace(/\s+/g,'');
const VERTICAL_CONTAINERS=new Set(['ScrollView','NestedScrollView','RecyclerView','ListView','AbsListView','ExpandableListView']);
const EFFECT=/(?:支付|付款|下单|提交|购买|抢购|加购|加入购物车|发送|发布|分享|评论|点赞|关注|删除|清空|卸载|安装|更新|登录|退出账号|注册|验证码|密码|授权|同意|允许|开通|订阅|转账|提现|充值|拨号|呼叫|保存|编辑|修改|更改|重置|恢复|启用|开启|关闭|切换)|\b(?:pay|payment|checkout|purchase|buy|send|post|publish|share|delete|remove|save|install|uninstall|update|subscribe|login|logout|password|passcode|OTP|allow|authorize|transfer)\b/i;
const TOGGLE=/^(?:Switch(?:Compat|Material)?|CheckBox|ToggleButton|RadioButton|CompoundButton)$/;
const FIELD_KEYS={tap:['target','targetId'],long_press:['target','targetId'],type:['text','inputMode'],scroll:['direction'],back:[]};

function unavailable(code,message){throw new AppError(code,message,409);}
function validBounds(bounds){return Array.isArray(bounds)&&bounds.length===4&&bounds.every(n=>Number.isFinite(n)&&n>=0&&n<=10000)&&bounds[2]>bounds[0]&&bounds[3]>bounds[1];}
function inside(point,bounds){return Number.isFinite(point?.x)&&Number.isFinite(point?.y)&&point.x>=bounds[0]&&point.x<bounds[2]&&point.y>=bounds[1]&&point.y<bounds[3];}
function nativeState(observation){
 for(const block of observation.tree?.content||[]){
  if(block.type!=='text')continue;
  try{const data=JSON.parse(block.text);if(data.ok===true&&typeof data.result?.tree==='string')return data.result;}catch{}
 }
 return null;
}
function nativeNodes(state){
 if(!state||state.display!=='main'||typeof state.windowPkg!=='string'||!state.windowPkg)return [];
 const out=[],stack=[];let pkg=state.windowPkg;
 for(const line of state.tree.split('\n')){
  if(line.startsWith('window ')){pkg=line.match(/pkg=(\S+)/)?.[1]||'';stack.length=0;continue;}
  const match=line.match(/\bbounds=(-?\d+),(-?\d+),(-?\d+),(-?\d+)\s*$/);if(!match||pkg!==state.windowPkg)continue;
  const bounds=match.slice(1).map(Number);if(!validBounds(bounds))continue;
  const raw=line.replace(/"[^"\n]*"/g,''),words=raw.trim().split(/\s+/),kind=words[0].split('.').at(-1);
  const depth=line.length-line.trimStart().length;
  while(stack.length&&stack.at(-1).depth>=depth)stack.pop();
  const node={index:out.length,line,bounds,kind,depth,words,parent:stack.at(-1)||null,
   labels:[...line.matchAll(/"([^"\n]+)"/g)].map(match=>compact(match[1]))};
  out.push(node);stack.push(node);
 }
 return out;
}
function descendant(node,ancestor){for(let parent=node.parent;parent;parent=parent.parent)if(parent===ancestor)return true;return false;}
function interactive(node){return node.words.includes('clickable')||node.words.includes('editable');}
function visible(node){return !node.words.includes('offscreen');}
function secretOrToggle(node){
 return TOGGLE.test(node.kind)||node.words.some(word=>['checked','unchecked','checkable','password'].includes(word))||
  node.labels.some(label=>/^\[?password\]?$|密码|验证码|\b(?:passcode|OTP|PIN)\b/i.test(label));
}
function secretNode(node){return node.words.includes('password')||node.labels.some(label=>/密码|验证码|\b(?:passcode|OTP|PIN)\b/i.test(label));}
function clickAncestor(node){
 let candidate=node;
 for(let depth=0;candidate&&depth<=4;depth++,candidate=candidate.parent)if(candidate.words.includes('clickable')&&visible(candidate))return candidate;
 return null;
}
function safeLeafBinding(node,control,all,{allowScopedControls=false}={}){
 if(node===control||!['TextView','Button','ImageButton','ImageView','View'].includes(node.kind))return false;
 if(allowScopedControls){const point={x:(node.bounds[0]+node.bounds[2])/2,y:(node.bounds[1]+node.bounds[3])/2};return !secretNode(control)&&!all.some(child=>descendant(child,control)&&(secretNode(child)||secretOrToggle(child)&&inside(point,child.bounds)));}
 if(control.labels.some(label=>EFFECT.test(label))||secretOrToggle(control))return false;
 return !all.some(child=>descendant(child,control)&&(secretOrToggle(child)||interactive(child)&&child.labels.some(label=>EFFECT.test(label))));
}
function labelHits(node,target){
 const exact=node.labels.filter(label=>label===target);if(exact.length)return exact;
 // Cart / search / close icons often expose the name only as content description.
 return target.length>=2?node.labels.filter(label=>label.includes(target)&&label.length<=target.length+8):[];
}
function nativeTap(state,target,{allowScopedControls=false,longPress=false}={}){
 const all=nativeNodes(state);
 let matches=all.filter(node=>{if(!visible(node)||!labelHits(node,target).length)return false;return allowScopedControls||node.labels.length===1||labelHits(node,target).some(label=>label===target);});
 const exact=matches.filter(node=>node.labels.includes(target));if(exact.length)matches=exact;
 const candidates=[];
 const forbidden=node=>node.words.includes('password')||node.labels.some(label=>/密码|验证码|\b(?:passcode|OTP|PIN)\b/i.test(label))||!allowScopedControls&&secretOrToggle(node);
 for(const node of matches){
  if(forbidden(node))continue;
  const control=longPress?(node.words.includes('long_clickable')?node:null):node.words.includes('clickable')||node.words.includes('editable')?node:clickAncestor(node);
  if(!control||!visible(control)||forbidden(control))continue;
  const point={x:(node.bounds[0]+node.bounds[2])/2,y:(node.bounds[1]+node.bounds[3])/2};
  if(all.some(child=>descendant(child,control)&&(allowScopedControls?secretNode(child)||secretOrToggle(child)&&inside(point,child.bounds):secretOrToggle(child))))continue;
  if(control!==node&&(!inside(point,control.bounds)||!safeLeafBinding(node,control,all,{allowScopedControls})))continue;
  // Duplicate parent/child labels for one native control are one physical target.
  if(candidates.some(candidate=>candidate.control===control))continue;
  candidates.push({node,control});
 }
 const height=state?.tree.match(/window[^\n]*bounds=0,0,\d+,(\d+)/)?.[1]||2400;
 const rank=candidate=>Number(candidate.node.bounds[1]>=height*.12&&candidate.node.bounds[3]<=height*.88)*4+Number(candidate.control.words.includes('clickable'));
 candidates.sort((a,b)=>rank(b)-rank(a)||a.node.bounds[1]-b.node.bounds[1]||(a.node.bounds[2]-a.node.bounds[0])*(a.node.bounds[3]-a.node.bounds[1])-(b.node.bounds[2]-b.node.bounds[0])*(b.node.bounds[3]-b.node.bounds[1]));
 if(!candidates.length)unavailable('phone_target_missing','最新页面没有唯一可定位的目标，请先重新读取');
 const {node}=candidates[0],bounds=node.bounds;
 return {x:(bounds[0]+bounds[2])/2,y:(bounds[1]+bounds[3])/2};
}
function viewport(observation,state){
 const {width,height}=observation.ocr||{};
 if(Number.isFinite(width)&&Number.isFinite(height)&&width>0&&height>0&&width<=10000&&height<=10000)return {width,height};
 const windows=String(state?.tree||'').split('\n').filter(line=>line.startsWith('window ')&&line.match(/pkg=(\S+)/)?.[1]===state?.windowPkg)
  .map(line=>line.match(/\bbounds=(-?\d+),(-?\d+),(-?\d+),(-?\d+)\s*$/)?.slice(1).map(Number)).filter(bounds=>validBounds(bounds)&&bounds[0]===0&&bounds[1]===0);
 if(windows.length===1)return {width:windows[0][2],height:windows[0][3]};
 unavailable('phone_scroll_unavailable','最新页面缺少可核实的滚动区域，请先重新读取');
}
function nativeScroll(observation,direction,{allowViewportScroll=false}={}){
 const state=nativeState(observation),all=nativeNodes(state),{width,height}=viewport(observation,state);
 const viewportGesture=()=>({x1:width*.5,y1:height*(direction==='down'?.75:.3),x2:width*.5,y2:height*(direction==='down'?.3:.75)});
 const containers=all.filter(node=>visible(node)&&node.kind!=='HorizontalScrollView'&&(VERTICAL_CONTAINERS.has(node.kind)||node.words.includes('scrollable'))&&!secretOrToggle(node));
 if(!containers.length){if(allowViewportScroll)return viewportGesture();unavailable('phone_scroll_unavailable','最新页面没有可核实的纵向滚动容器');}
 // Choose a usable visible region before preferring a nested list. A tiny
 // embedded carousel must not prevent scrolling its full-height parent.
 const regions=containers.map(node=>{
  const b=node.bounds,left=Math.max(b[0]+1,width*.15),right=Math.min(b[2]-1,width*.85);
  const top=Math.max(b[1]+1,height*.15),bottom=Math.min(b[3]-1,height*.85);
  return {node,left,right,top,bottom,area:(right-left)*(bottom-top)};
 }).filter(r=>r.right>r.left&&.6*(r.bottom-r.top)>=height*.1);
 if(!regions.length){if(allowViewportScroll)return viewportGesture();unavailable('phone_scroll_unavailable','没有足够安全的滚动区域，未滑动，列表末尾未知。');}
 const nested=regions.find(r=>regions.every(other=>other===r||descendant(r.node,other.node)));
 const {left,right,top,bottom}=nested||regions.sort((a,b)=>b.area-a.area)[0];
 const x=(left+right)/2,low=top+(bottom-top)*.2,high=bottom-(bottom-top)*.2;
 return {x1:x,y1:direction==='down'?high:low,x2:x,y2:direction==='down'?low:high};
}

// This translates observed targets only. Broker/Phone still authorize and freshly
// recheck each action; even a resolved payment target carries no payment authority.
export function buildSimplePhoneAction(observation,args,{taskId,now=Date.now(),allowScopedControls=false,allowViewportScroll=false}={}){
 requireValue(args&&typeof args==='object'&&!Array.isArray(args),'手机操作参数不正确');
 requireValue(Object.hasOwn(FIELD_KEYS,args.action),'手机操作只支持 tap、long_press、type、scroll、back');
 const allowed=new Set(['action','reason',...FIELD_KEYS[args.action]]);
 args=Object.fromEntries(Object.entries(args).filter(([key])=>allowed.has(key))); 
 if(typeof taskId!=='string'||!taskId||observation?.taskId!==taskId||typeof observation.id!=='string'||!observation.id||
  !Number.isFinite(now)||!Number.isFinite(observation.at)||now-observation.at< -1000||now-observation.at>45000)
  unavailable('phone_observation_required','请先读取本任务的最新手机页面');
 const fresh=observation.stability==='fresh'&&['query','phone_use','general','purchase'].includes(observation.stabilityScope);
 const stable=observation.stability==='stable'&&['full','navigation'].includes(observation.stabilityScope);
 if(!fresh&&!stable)unavailable('phone_observation_required','请先读取可操作的最新手机页面');
 if(args.reason!==undefined)requireValue(typeof args.reason==='string'&&args.reason.trim()&&args.reason.length<=1000,'操作原因不正确');
 const base={observationId:observation.id,reason:args.reason?.trim()||'根据本任务的最新手机页面执行操作'};
 if(args.action==='back')return {...base,action:'back'};
 if(args.action==='type'){
  requireValue(typeof args.text==='string'&&args.text.length>0&&args.text.length<=2000,'输入内容不能为空或超过 2000 字符');
  requireValue(args.inputMode===undefined||['insert','replace'].includes(args.inputMode),'输入模式不正确');
  return {...base,action:'type',text:args.text,inputMode:args.inputMode||'replace'};
 }
 if(args.action==='scroll'){
  requireValue(['up','down'].includes(args.direction),'滚动方向必须为 up 或 down');
  return {...base,action:'swipe',...nativeScroll(observation,args.direction,{allowViewportScroll})};
 }
 if(args.targetId!==undefined){
  requireValue(typeof args.targetId==='string'&&args.targetId.length<=160,'目标编号无效');
  const matches=(observation.ocr?.lines||[]).filter(line=>line.id===args.targetId);
  requireValue(matches.length===1&&validBounds(matches[0].bounds)&&inside(matches[0].center,matches[0].bounds),'目标编号不属于最新页面，请重新读取','phone_target_missing');
  if(args.target!==undefined)requireValue(typeof args.target==='string'&&compact(matches[0].text).includes(compact(args.target)),'目标文字与编号不一致','phone_target_missing');
  return {...base,action:args.action,textTargetId:args.targetId};
 }
 requireValue(typeof args.target==='string'&&args.target.trim()&&args.target.length<=200,'点击目标必须是页面上的明确文字或当前 targetId');
 const target=compact(args.target);
 if(allowScopedControls&&args.action==='tap'&&/^(?:输入框|消息输入框|聊天输入框|搜索输入框)$/.test(target)){
  const state=nativeState(observation),all=nativeNodes(state),{width,height}=viewport(observation,state);
  const fields=all.filter(node=>visible(node)&&node.words.includes('editable')&&!secretNode(node)&&node.bounds[0]>=0&&node.bounds[1]>=0&&node.bounds[2]<=width&&node.bounds[3]<=height);
  fields.sort((a,b)=>Number(b.words.includes('focused'))-Number(a.words.includes('focused'))||a.bounds[1]-b.bounds[1]);
  if(!fields.length)unavailable('phone_target_missing','当前页面没有可定位的输入框，请选择实际目标');
  const b=fields[0].bounds;return {...base,action:'tap',x:(b[0]+b[2])/2,y:(b[1]+b[3])/2};
 }
 try{return {...base,action:args.action,...nativeTap(nativeState(observation),target,{allowScopedControls,longPress:args.action==='long_press'})};}catch(error){if(error.code!=='phone_target_missing')throw error;}
 let matches=(observation.ocr?.lines||[]).filter(line=>typeof line.text==='string'&&compact(line.text)===target);
 if(!matches.length&&target.length>=2)matches=(observation.ocr?.lines||[]).filter(line=>typeof line.text==='string'&&compact(line.text).includes(target)&&compact(line.text).length<=target.length+10);
 if(matches.length>1){const height=observation.ocr.height;matches.sort((a,b)=>Number(b.bounds[1]>height*.12&&b.bounds[3]<height*.88)-Number(a.bounds[1]>height*.12&&a.bounds[3]<height*.88)||a.bounds[1]-b.bounds[1]);matches=matches.slice(0,1);}
 // Product titles commonly wrap into adjacent OCR lines. Bind a joined title
 // to its first actual line, keeping the existing fresh-point verification.
 if(!matches.length){
  const lines=(observation.ocr?.lines||[]).filter(line=>validBounds(line.bounds));const joined=[];
  for(const first of lines){let text=compact(first.text),previous=first;const used=new Set([first]);
   for(let i=0;i<2;i++){
    const height=previous.bounds[3]-previous.bounds[1];
    const next=lines.filter(line=>!used.has(line)&&line.bounds[1]>=previous.bounds[3]-height*.25&&line.bounds[1]<=previous.bounds[3]+height*1.3&&Math.abs(line.bounds[0]-first.bounds[0])<height*2).sort((a,b)=>a.bounds[1]-b.bounds[1])[0];
    if(!next)break;text+=compact(next.text);used.add(next);previous=next;
    if(text===target){joined.push(first);break;}
   }
  }
  if(joined.length===1)matches=joined;
 }

 if(matches.length===1){
  const match=matches[0];
  requireValue(typeof match.id==='string'&&match.id&&validBounds(match.bounds)&&inside(match.center,match.bounds),'最新文字目标缺少有效定位信息','phone_target_missing');
  return {...base,action:args.action,textTargetId:match.id};
 }
 return {...base,action:args.action,...nativeTap(nativeState(observation),target,{allowScopedControls,longPress:args.action==='long_press'})};
}
