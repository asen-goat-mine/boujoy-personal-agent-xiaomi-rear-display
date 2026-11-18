import {ANDROID_PACKAGE} from '../distribution.mjs';
import {navigationPackages} from './phone-application-families.mjs';
import {outboundPackageAllowed} from './phone-outbound.mjs';
import {travelPreparationPackageAllowed,travelPreparationDialogAllowed} from './phone-travel-preparation.mjs';
import {attachmentPlan,validateAttachmentAuthorization} from '../core/attachment-contract.mjs';
import {routePackageAllowed} from './phone-routes.mjs';
import {hasDirectMealRequest,checkoutQueryFromPrompt} from '../core/checkout.mjs';
import {validateTaskContract} from '../core/task-contract.mjs';
import {parseTaskGraphRequest,taskGraphScope} from '../core/task-graph.mjs';
import {scheduleDialogLabelAllowed} from './phone-schedule.mjs';
import {effectPlan,classifyEffectAction,effectGoalStatus} from './phone-effects.mjs';
import {businessPackageAllowed,businessDialogLabelAllowed} from './phone-business.mjs';
import {travelPackageAllowed,travelDialogAllowed} from './phone-travel.mjs';
export {effectGoalStatus};
export function longPressResultVerified(observation,grant){
 const state=native(observation?.tree);if(!grant?.longPressTarget||!state||observation?.taskId!==grant.taskId||Date.now()-observation.at>15000)return false;
 const menu=nodes(state.tree).filter(node=>/clickable/.test(flags(node.line))&&node.labels.some(label=>/^(?:复制|选择|全选|重命名|分享|删除|详情|打开方式|Copy|Select|Rename|Share|Delete|Details)$/i.test(label)));
 return state.windowPkg===grant.packageName&&menu.length>=2;
}

const compact=value=>String(value||'').normalize('NFKC').replace(/\s+/g,'');
const PKG=/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){1,12}$/;
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const DANGEROUS=/(?:支付|付款|下单|提交|购买|抢购|加购|加入购物车|发送|发消息|发短信|发布|分享|评论|点赞|收藏|关注|删除|清空|卸载|安装|登录|登出|退出账号|注册|验证码|密码|授权|同意|允许|会员|开通|订阅|领券|领取|红包|转账|提现|充值|预约|预订|拨号|呼叫|打电话|新建|添加|保存|编辑|修改|更改|重置|恢复|启用|开启|关闭|切换)/i;
const ACCOUNT_HEADER=/^(?:输入密码|输入支付密码|支付密码|输入验证码|验证码|验证码登录|账号登录|登录|注册|收银台|确认订单|提交订单|订单确认|待付款|付款确认|支付确认|确认付款|确认支付|安全验证|身份验证|授权确认|权限申请|删除确认|确认删除|发布确认|确认发送|发送确认|转账确认|提现确认|SignIn|LogIn|Payment|Checkout|ConfirmDelete|ConfirmSend|PermissionRequest)$/i;
const CREDENTIAL_TEXT=/^(?:请输入(?:支付)?密码|输入(?:支付)?密码|支付密码|请输入验证码|输入验证码|验证码[：:]?\d{4,8}|EnterPassword|EnterPIN|EnterOTP|VerificationCode[：:]?\d{4,8})$|(?:您的验证码|验证码是|验证码为|一次性密码[：:]?\d{4,8})/i;
const ENGLISH_DANGEROUS=/\b(?:pay|payment|checkout|purchase|buy|send|post|publish|share|delete|remove|save|install|uninstall|subscribe|login|logout|password|passcode|OTP|allow|authorize|transfer|withdraw|deposit)\b/i;
const PRIVATE_PAGE=/(?:聊天|通讯录|联系人|短信|邮件|收件箱|日程|账单|余额|相册|照片|笔记|文件列表)/i;
const NAV=/^(?:返回|取消|搜索|查询|查找|首页|主页|发现|浏览|分类|推荐|筛选|排序|详情|更多|今天|昨日|昨天|明天|后天|日|周|月|年|日历|日程|列表|地图|天气|城市|设置|电池|电池用量|关于手机|设备信息|存储空间|显示|声音|网络和互联网|WLAN|WiFi|蓝牙|照片|视频|相册|图库|通讯录|联系人|消息|收件箱|已发送|收藏|最近|全部|Back|Cancel|Search|Find|Home|Browse|Details|Today|Week|Month|Year|Calendar|Settings|Battery|About|Storage)$/i;
const EXTERNAL=/(?:网页|页面|广告|商家|模型|助理|知识库).{0,12}(?:说|显示|要求|建议|指示)|(?:引用|转述|粘贴)/;
function currentUser(task){return (task?.messages||[]).filter(item=>item.role==='user').at(-1);}
function native(tree){
 for(const block of tree?.content||[])try{const data=JSON.parse(block.text);if(block.type==='text'&&data.ok===true&&typeof data.result?.tree==='string')return data.result;}catch{}
 return null;
}
function labels(tree){return [...String(tree||'').matchAll(/"([^"\n]+)"/g)].map(match=>compact(match[1]));}
function nodes(tree){
 return String(tree||'').split('\n').flatMap(line=>{const match=line.match(/bounds=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);return match&&!line.includes('offscreen')?[{line,bounds:match.slice(1).map(Number),labels:labels(line)}]:[];});
}
function flags(line){return String(line).replace(/"[^"\n]*"/g,'');}
function isDangerous(label){return DANGEROUS.test(label)||ENGLISH_DANGEROUS.test(label);}
function inside(point,bounds){return Number.isFinite(point?.x)&&Number.isFinite(point?.y)&&point.x>=bounds[0]&&point.x<bounds[2]&&point.y>=bounds[1]&&point.y<bounds[3];}
function searchText(prompt){
 const match=String(prompt).match(/(?:搜索|搜一下|搜|查询|查找|查一下)(?:一下)?[：:「“"\s]*(.{1,100}?)(?:[」”"，。；！？!?]|$)/);
 return match?match[1].trim():null;
}
function navigationTerms(prompt,appName){
 let text=compact(prompt).replaceAll(compact(appName),'');
 const matches=[...text.matchAll(/(?:查看|看看|浏览|进入|打开|查询|搜索|查找|看)([^，。；！？!?]{1,80})/g)];
 return [...new Set(matches.flatMap(match=>match[1].split(/的|里的|里面|页面|界面|列表|和|、|以及|然后|看看|查看|搜索/)).filter(term=>term.length>=2&&term.length<=40&&!DANGEROUS.test(term)))].slice(0,12);
}
// packageName/appName must be grounded in the caller's installed-app catalog.
// The model cannot create a grant from page text or its action reason.
export function phoneUseGrant(task,{packageName,appName,label}={},{store}={}){
 const name=typeof appName==='string'?appName:label;
 let scopeContract=null;
 if(task?.taskContract&&typeof name==='string'&&PKG.test(packageName||'')){
  const checked=validateTaskContract(task,{store}),graphRequested=checked.valid&&!!parseTaskGraphRequest(checked.contract.goal),contract=graphRequested?taskGraphScope(task,{store}):checked.contract;let plan=checked.valid&&contract?effectPlan(contract):null;
  if(!checked.valid||!contract||contract.intent!=='task'||!contract.effects.includes('read')||!contract.effects.includes('navigate'))return null;
  const appBound=checked.valid&&contract.allowedApps.some(app=>compact(app).toLowerCase()===compact(name).toLowerCase()||app===packageName);
  if(graphRequested&&!appBound)return null;
  if(appBound&&contract.objects?.mailRequested&&plan?.kind!=='send_mail')return null;
  if(appBound&&contract.objects?.mediaRequested&&plan?.kind!=='publish_media')return null;
  if(appBound&&contract.objects?.travelPreparationRequested&&plan?.kind!=='travel_preparation')return null;
  if(appBound&&contract.objects?.attachmentRequested&&plan?.kind!=='send_attachment')return null;
  if((plan?.kind==='send_attachment'||plan?.kind==='publish_media'||plan?.kind==='send_mail'&&plan.attachment)&&appBound){try{plan=attachmentPlan(task,{store});validateAttachmentAuthorization({task,store,artifactId:plan.artifact.id,targetPackage:packageName,authorization:plan});}catch{return null;}}
  if(appBound&&contract.objects?.routeRequested&&!['route','navigation'].includes(plan?.kind))return null;
  if(appBound&&contract.objects?.afterSalesRequested&&plan?.kind!=='after_sales')return null;
  if(appBound&&contract.objects?.travelRequested&&!['navigation','ride_request','service_booking'].includes(plan?.kind))return null;
  if(appBound)scopeContract=contract;
  if(plan&&appBound&&['running','waiting_approval'].includes(task.status)&&contract.effects.includes('navigate')){
   const callPackages={'com.samsung.android.dialer':['com.samsung.android.incallui'],'com.google.android.dialer':[],'com.android.dialer':['com.android.incallui']};
   if(plan.kind==='call'&&!Object.hasOwn(callPackages,packageName))return null;
   if(!businessPackageAllowed(plan,packageName)||!routePackageAllowed(plan,packageName)||!travelPackageAllowed(plan,packageName)||!travelPreparationPackageAllowed(plan,packageName)||!outboundPackageAllowed(plan,packageName))return null;
   return {taskId:task.id,sourceMessageId:contract.source.messageId,packageName,appName:name,mode:'task_effects',contractId:contract.id,contractRevision:contract.revision,expiresAt:contract.expiresAt,effectPlan:plan,...(['send_attachment','send_mail','publish_media'].includes(plan.kind)?{attachmentTransfer:task.phoneAttachment||null}:{}),privateRead:true,navigationTerms:[plan.origin,plan.destination,plan.recipient,plan.field,plan.name,plan.directory,plan.destination,typeof plan.target==='string'?plan.target:null,plan.title,plan.orderId,'闹钟','日程','日历',...(['after_sales','order_read','order_cancel'].includes(plan.kind)?['我的订单','全部订单','订单详情','查看物流']:[])].filter(Boolean),searchText:plan.recipient||plan.orderId||null,...(plan.kind==='call'?{observationPackages:callPackages[packageName]}:{})};
  }
 }
 if(!task||typeof task.id!=='string'||!scopeContract&&(task.source&&task.source!=='user'||task.parentId||(task.depth||0)>0)||!['running','waiting_approval'].includes(task.status))return null;
 if(typeof packageName!=='string'||!PKG.test(packageName)||typeof name!=='string'||!name.trim()||name.length>100)return null;
 const message=scopeContract?{id:scopeContract.source.messageId,content:scopeContract.goal}:currentUser(task),text=compact(message?.content),named=compact(name);
 const normalizedText=text.toLowerCase(),normalizedName=named.toLowerCase();
 if(!message||message.externalContent||message.external_content||EXTERNAL.test(text))return null;
 if(!scopeContract&&!normalizedText.includes(normalizedName)&&!normalizedText.includes(packageName.toLowerCase()))return null;
 if(!/(?:打开|进入|查看|看看|浏览|搜索|搜|查询|查找|查一下|看|计算|算|长按)/.test(text)||/(?:不要|不用|别|禁止).{0,5}(?:打开|进入|查看|看看|浏览|搜索|长按)/.test(text))return null;
 const food=task.phoneQuery?.query||checkoutQueryFromPrompt(message.content)?.query;
 if(food&&hasDirectMealRequest(message.content,food))return null;
 // Explicit prohibitions constrain navigation, not positive transaction intent.
 if(/(?:不要不|不得不|不能不|并非不|不是不)(?:再|进行)?(?:修改|更改|调整|改变)/.test(text))return null;
 const negated=/(?:不要|不用|无需|禁止|别|不(?:需要|允许)?)(?:进行|实际|直接|立即|自动|替我|帮我)?(?:任何|一切|各项)?(?:付款|支付|下单|购买|加购|发送|发消息|发短信|发布|分享|评论|点赞|关注|删除|清空|开通|订阅|授权|登录|修改|更改|调整|改变)/g;
 let purpose=text.replace(new RegExp(escape(named),'gi'),'').replace(new RegExp(escape(packageName),'gi'),'').replace(negated,'');
 const requestedSearch=searchText(message.content);
 if(requestedSearch)purpose=purpose.replaceAll(compact(requestedSearch),'');
 if(isDangerous(purpose)||/(?:点|订|买|准备)(?:\d{1,2}|一|两|二|三|四|五|六|七|八|九|十)?(?:份|碗|杯|件|个)/.test(purpose))return null;
 const calculator=/计算器|calculator/i.test(name);
 const expression=calculator?String(message.content).match(/(?:计算|算)(?:一下)?[：:\s]*([0-9][0-9+\-×÷*/().%\s]{2,100})/)?.[1]?.replace(/\s+/g,'')||null:null;
 const privateRead=!!scopeContract?.objects.longPressTarget||/(?:查看|看看|阅读|读|搜索|查询|查找|看).{0,20}(?:聊天|消息|短信|邮件|联系人|通讯录|日程|安排|相册|照片|文件|笔记|账单|余额)/.test(text);
 return {taskId:task.id,sourceMessageId:message.id||null,packageName,appName:name.trim(),mode:'read_navigation',
  searchText:requestedSearch,privateRead,...(packageName==='com.android.settings'?{observationPackages:navigationPackages(packageName).filter(pkg=>pkg!==packageName)}:{}),navigationTerms:navigationTerms(message.content,name),arithmeticExpression:expression,...(scopeContract?{contractId:scopeContract.id,contractRevision:scopeContract.revision,expiresAt:scopeContract.expiresAt,longPressTarget:scopeContract.objects.longPressTarget||null}:{})};
}
function validScope(taskId,grant){return grant?.taskId===taskId&&['read_navigation','task_effects'].includes(grant.mode)&&PKG.test(grant.packageName||'')&&(!grant.expiresAt||Date.parse(grant.expiresAt)>Date.now());}

function viewportHeight(state){
 const window=nodes(state.tree).filter(node=>/^window /.test(node.line));
 return window.length?Math.max(...window.map(node=>node.bounds[3])):null;
}
function credentialNode(node){
 const raw=flags(node.line);
 return /\bpassword\b|\[password\]/i.test(raw)||/editable|EditText/i.test(raw)&&node.labels.some(label=>/密码|验证码|PIN|OTP|passcode|password/i.test(label));
}
function accountSurface(state,ocrLines=[],grant){
 const all=nodes(state.tree),height=viewportHeight(state);
 if(all.some(credentialNode)||all.some(node=>node.labels.some(label=>CREDENTIAL_TEXT.test(label))))return true;
 const actualDialog=/Dialog|PopupWindow|AlertDialog/.test(state.tree);
 const allowedDialogLabel=label=>grant?.mode==='task_effects'&&(/^(?:确认发送|发送确认|发送|新建闹钟|添加闹钟|添加|新建|保存|修改|编辑|Send|Save)$/i.test(label)||businessDialogLabelAllowed(label,grant.effectPlan)||travelDialogAllowed(label,grant.effectPlan)||travelPreparationDialogAllowed(label,grant.effectPlan)||scheduleDialogLabelAllowed(label,grant.effectPlan))||grant?.longPressTarget&&/^(?:复制|选择|全选|重命名|分享|删除|详情|打开方式|Copy|Select|Rename|Share|Delete|Details)$/i.test(label);
 if(actualDialog&&labels(state.tree).some(label=>isDangerous(label)&&!allowedDialogLabel(label)))return true;
 const clickable=all.filter(node=>/clickable|editable/.test(flags(node.line)));
 const isInteractive=(bounds,text)=>{
  const point={x:(bounds[0]+bounds[2])/2,y:(bounds[1]+bounds[3])/2};
  return clickable.some(node=>inside(point,node.bounds)&&node.labels.some(label=>label===text||label.includes(text)));
 };
 const heading=(text,bounds)=>ACCOUNT_HEADER.test(text)&&!allowedDialogLabel(text)&&Array.isArray(bounds)&&Number.isFinite(height)&&bounds[1]<height*.22&&!isInteractive(bounds,text);
 if(all.some(node=>node.labels.some(label=>heading(label,node.bounds))))return true;
 return ocrLines.some(line=>CREDENTIAL_TEXT.test(compact(line.text))||heading(compact(line.text),line.bounds));
}
function messagingApp(grant){return /(?:^com\.tencent\.mm$|^com\.tencent\.mobileqq$|^org\.telegram\.|^com\.whatsapp|^com\.google\.android\.apps\.messaging$|^com\.samsung\.android\.messaging$)/i.test(grant.packageName)||/^(?:微信|QQ|腾讯QQ|短信|telegram|whatsapp|messenger|电子邮件|邮件|Gmail|Outlook|网易邮箱|QQ邮箱)$/i.test(grant.appName);}
function privateSurface(state,grant,ocrLines=[]){
 if(grant.privateRead)return false;
 // Reading a messaging/mail app requires a current content-reading request.
 if(messagingApp(grant))return true;
 const height=viewportHeight(state),all=nodes(state.tree);
 const interactive=all.filter(node=>/clickable|editable/.test(flags(node.line)));
 const heading=(text,bounds)=>/^(?:聊天|通讯录|联系人|短信|邮件|收件箱|日程|账单|余额|相册|笔记|文件列表)$/.test(text)&&
  Array.isArray(bounds)&&Number.isFinite(height)&&bounds[1]<height*.2&&!interactive.some(node=>inside({x:(bounds[0]+bounds[2])/2,y:(bounds[1]+bounds[3])/2},node.bounds)&&node.labels.includes(text));
 return all.some(node=>node.labels.some(label=>heading(label,node.bounds)))||ocrLines.some(line=>heading(compact(line.text),line.bounds));
}

export function phoneUseObservationDecision(taskId,tree,grant){
 const state=native(tree),pkg=state?.windowPkg;
 const foregroundPackage=PKG.test(pkg||'')?pkg:null;
 const allowedPackages=validScope(taskId,grant)?[grant.packageName,...(grant.observationPackages||[])]:[];
 const denied=(reason,extra={})=>({allowed:false,reason,foregroundPackage,allowedPackages,...extra});
 if(!validScope(taskId,grant))return denied('task_scope_invalid');
 if(!state||state.display!=='main')return denied('native_observation_unavailable');
 if(!allowedPackages.includes(pkg)||!(state.foreground===pkg||String(state.foreground).startsWith(pkg+'/')))
  return denied(pkg===ANDROID_PACKAGE?'assistant_chat_foreground':'outside_task_scope');
 const overlays=String(state.tree).split('\n').filter(line=>line.startsWith('window '))
  .map(line=>line.match(/pkg=(\S+)/)?.[1])
  .filter(value=>PKG.test(value||'')&&![pkg,'com.android.systemui','com.samsung.android.honeyboard','com.google.android.inputmethod.latin','com.sohu.inputmethod.sogou'].includes(value));
 if(overlays.length)return denied('foreign_window_overlay',{overlayPackages:[...new Set(overlays)].slice(0,8)});
 if(accountSurface(state,[],grant))return denied('protected_account_surface');
 if(privateSurface(state,grant))return denied('private_content_outside_scope');
 return {allowed:true,reason:'within_task_scope',foregroundPackage,allowedPackages};
}
function allowedNative(taskId,tree,grant){
 return phoneUseObservationDecision(taskId,tree,grant).allowed?native(tree):null;
}
export function phoneUseCanObserve(taskId,tree,grant){return !!allowedNative(taskId,tree,grant);}
function calculatorControl(label,grant){
 if(!grant.arithmeticExpression)return false;
 const symbols=new Set(grant.arithmeticExpression.replace(/\*/g,'×').replace(/\//g,'÷'));
 return /^\d$/.test(label)&&symbols.has(label)||['+','-','×','÷','(',')','%'].includes(label)&&symbols.has(label)||/^(?:=|AC|C|CE|⌫)$/.test(label);
}
function searchControl(label){
 return typeof label==='string'&&label.length<=50&&!isDangerous(label)&&/^(?:(?:搜索|查询|查找).{0,30}|(?:Search|Find)[A-Za-z0-9._-]{0,40})$/i.test(label);
}
function scrollContainer(node){
 const raw=flags(node.line),name=raw.trim().split(/\s+/)[0];
 // Pony serializes widget classes but not AccessibilityNodeInfo.isScrollable.
 return /\bscrollable\b/.test(raw)||/^(?:ScrollView|NestedScrollView|RecyclerView|ListView|AbsListView|ExpandableListView)$/.test(name);
}
function safeLabel(label,grant){
 if(calculatorControl(label,grant))return true;
 if(!label||label.length>120||isDangerous(label)||/^(?:确定|确认|OK|Done)$/i.test(label))return false;
 const camera=/相机|camera/i.test(grant.appName);
 if(!grant.privateRead&&PRIVATE_PAGE.test(label)&&!(camera&&/^(?:照片|视频|Photo|Video)$/i.test(label)))return false;
 return NAV.test(label)||searchControl(label)||(grant.navigationTerms||[]).some(term=>term===label||term.includes(label)&&label.length>=2||label.includes(term)&&term.length>=2)||
  !!grant.searchText&&label.includes(compact(grant.searchText));
}
export function classifyPhoneUseAction(taskId,args,observation,grant,actions=[]){
 if(!validScope(taskId,grant)||observation?.taskId!==taskId||observation.id!==args?.observationId||!Number.isFinite(observation.at)||Date.now()-observation.at>15000||observation.at>Date.now()+1000)return null;
 const full=observation.stability==='stable'&&observation.stabilityScope==='full';
 const fresh=observation.stability==='fresh'&&observation.stabilityScope==='phone_use';
 if(!full&&!fresh)return null;
 const state=allowedNative(taskId,observation.tree,grant),ocr=observation.ocr;
 if(!state)return null;
 const lines=Array.isArray(ocr?.lines)?ocr.lines:[];
 if(lines.some(line=>typeof line.text!=='string')||accountSurface(state,lines,grant)||privateSurface(state,grant,lines))return null;
 if(grant.mode==='task_effects'){
  const effect=classifyEffectAction(args,state,ocr,grant,actions,observation);if(effect)return effect;
  // Do not turn an ambiguous schedule target or rejected edit into generic navigation.
  if(['send_mail','publish_media','travel_preparation','send_attachment','alarm','calendar','route','after_sales','navigation','ride_request','service_booking'].includes(grant.effectPlan?.kind)&&['tap','type'].includes(args.action))return null;
 }
 const allNodes=nodes(state.tree),result=kind=>({kind,packageName:grant.packageName});
 if(args.action==='back')return ['textTargetId','x','y','text','inputMode'].some(key=>Object.hasOwn(args,key))?null:result('phone_use_back');
 if(args.action==='type'){
   if(args.textTargetId||!['insert','replace',undefined].includes(args.inputMode)||typeof args.text!=='string'||args.text.length>2000)return null;
   const focused=allNodes.filter(node=>/editable/.test(node.line)&&/focused/.test(flags(node.line))&&!credentialNode(node));
   if(focused.length!==1)return null;
   const search=focused[0].labels.some(searchControl),text=compact(args.text);
   const requested=[grant.searchText,...(grant.navigationTerms||[])].filter(value=>typeof value==='string'&&value.length>=1);
   if(search&&requested.some(value=>text===compact(value))&&!isDangerous(text))return result('phone_use_search_input');
   if(grant.arithmeticExpression&&compact(args.text)===grant.arithmeticExpression)return result('phone_use_calculation_input');
   return null;
 }
 if(args.action==='swipe'){
   if(!Number.isFinite(ocr?.width)||!Number.isFinite(ocr?.height)||args.textTargetId)return null;
   const {width,height}=ocr;
   if(![args.x1,args.x2].every(x=>Number.isFinite(x)&&x>=width*.15&&x<=width*.85)||![args.y1,args.y2].every(y=>Number.isFinite(y)&&y>=height*.15&&y<=height*.85)||Math.abs(args.x1-args.x2)>width*.08||Math.abs(args.y1-args.y2)<height*.1)return null;
   const scroll=allNodes.some(node=>scrollContainer(node)&&inside({x:args.x1,y:args.y1},node.bounds)&&inside({x:args.x2,y:args.y2},node.bounds)&&!node.labels.some(isDangerous));
   return scroll?result('phone_use_scroll'):null;
 }
 if(!['tap','long_press'].includes(args.action))return null;
 const matches=args.textTargetId?lines.filter(line=>line.id===args.textTargetId):[];
 if(args.textTargetId&&matches.length!==1)return null;
 const target=matches[0],point=target?.center||{x:args.x,y:args.y};
 if(target&&(!Array.isArray(target.bounds)||!inside(point,target.bounds)))return null;
 const hit=allNodes.filter(node=>inside(point,node.bounds)&&/clickable|editable/.test(node.line));
 if(hit.some(node=>credentialNode(node)||/\b(?:checked|unchecked|checkable)\b|Switch(?:Compat|Material)?|CheckBox|ToggleButton|RadioButton|SeekBar|Slider/i.test(flags(node.line))||node.labels.some(label=>isDangerous(label)&&!calculatorControl(label,grant))))return null;
 const smallest=hit.sort((a,b)=>(a.bounds[2]-a.bounds[0])*(a.bounds[3]-a.bounds[1])-(b.bounds[2]-b.bounds[0])*(b.bounds[3]-b.bounds[1]))[0];
 const label=target?compact(target.text):smallest?.labels.length===1?smallest.labels[0]:null;
 if(args.action==='long_press')return grant.longPressTarget&&label===compact(grant.longPressTarget)&&smallest&&/\blong_clickable\b/.test(flags(smallest.line))&&!isDangerous(label)?{...result('phone_use_long_press'),label}:null;
 if(!safeLabel(label,grant))return null;
 if(!target&&!smallest)return null; // coordinates require a native semantic control
 if(smallest?.labels.length&&smallest.labels.some(value=>value!==label))return null;
 return {...result(calculatorControl(label,grant)?'phone_use_calculation':'phone_use_navigation'),label};
}
