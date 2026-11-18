import {semanticPurchase,hasSemanticPurchaseReview} from './semantic-purchase.mjs';
import {affirmativeInstructions,attributedInstruction} from './instruction-scope.mjs';
import {isDesktopWork} from './work-kind.mjs';
import {PHONE_APP_NAMES} from '../adapters/phone-apps.mjs';
import {commercePlatform} from './commerce-platforms.mjs';
import {isTaskContinuation} from './task-continuation.mjs';
import {parseMessageRequest} from './message-contract.mjs';
import {stripTopLevelRoleMentions} from './role-mentions.mjs';
import {parseScreenshotScheduleRequest} from './screenshot-schedule-contract.mjs';
import {isMailSendRequest,parseMailRequest} from './mail-contract.mjs';
import {isMediaPublishRequest,parseMediaRequest} from './media-contract.mjs';
import {isTravelPreparationRequest,parseTravelPreparationRequest} from './travel-preparation-contract.mjs';
import {parseRouteRequest,isRouteRequest} from './route-contract.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {validateDelegationGrant} from './delegation.mjs';
import {validateEventAuthorization} from './event-triggers.mjs';
import {checkoutQueryFromPrompt} from './checkout.mjs';
import {parseScheduleRequest} from './schedule-contract.mjs';
import {isAfterSalesRequest,parseAfterSalesRequest} from './after-sales-contract.mjs';
import {isTravelMutationRequest,parseTravelRequest,travelEffect} from './travel-contract.mjs';
import {isAttachmentSendRequest,parseAttachmentRequest} from './attachment-contract.mjs';

export const requestHash=value=>createHash('sha256').update(String(value||'')).digest('hex');
// Messages the user sent while a run was going (interjections) are delivered to
// the model as guidance; they never replace the source of the running contract.
const textOf=task=>(task.messages||[]).filter(m=>m.role==='user'&&!m.interjection).at(-1);
const EXTERNAL_REFERENCE=/(?:引用|转述|粘贴)/;
const CONTINUE=/^(?:继续(?:吧|执行|刚才的任务)?|接着(?:做|执行)?|好的?|可以(?:了|继续)?|嗯+|ok|收到)[。.!！\s]*$/i;
const CHAT=/^(?:你好|您好|嗨|hello|hi|谢谢|晚安|早上好|你在(?:吗|干嘛|做什么)|你是谁|你能.{0,50}(?:吗|么)|(?:怎么|如何|为什么|什么是|解释|分析|介绍|讲讲|告诉我.{0,8}原理))/i;
const SMALL_TALK=/^(?:你(?:现在)?(?:在)?(?:干嘛|做什么|忙什么)(?:呢|呀|啊|吗)?|在吗|你还在吗)[。！？?!，,\s]*$/;
const APP_NAMES=PHONE_APP_NAMES;
function mentionsApp(instruction,name){
  // The device noun in “my phone” is not a choice of the dialer application.
  if(name.toLowerCase()==='phone'&&!targetsApp(instruction,name)&&! /\bphone\s+app\b/i.test(instruction))return false;
  // ASCII aliases are words, not substrings of product names or other words.
  // Chinese adjacency still permits natural requests such as 打开Phone / QQ音乐.
  if(/^[\x00-\x7f]+$/.test(name)&&/[a-z0-9]/i.test(name))return new RegExp('(?<![a-z0-9_])'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![a-z0-9_])','i').test(instruction);
  return instruction.toLowerCase().includes(name.toLowerCase());
}
function targetsApp(instruction,name){
  const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp('(?:在|用|使用|通过|打开|开启|进入|启动|切换到|切到)(?:手机(?:上|里|中的|的)?|应用|APP)?\\s*'+escaped,'i').test(instruction)||new RegExp('\\b(?:open|launch|use|switch to|in)\\s+(?:the\\s+)?'+escaped+'(?![a-z0-9_])','i').test(instruction);
}
function instructionText(text){
  const raw=String(text);
  return raw.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'|`[^`]*`/g,(part,offset)=>{
    const literal=part.slice(1,-1).trim(),alias=APP_NAMES.find(name=>name.toLowerCase()===literal.toLowerCase());
    const target=/(?:打开|开启|进入|启动|切换到|切到|在|用|使用|通过)(?:手机(?:上|里|中的|的)?|应用|APP)?\s*$/i.test(raw.slice(0,offset));
    return alias&&target?literal:'[正文]';
  });
}
const positiveInstruction=text=>affirmativeInstructions(instructionText(text));
function bluetoothValue(text){
  if(/(?:开启|打开|启用)(?:手机(?:的)?)?蓝牙|蓝牙(?:开关)?(?:改成|设为|调整为)?(?:开启|打开|启用)/.test(text))return true;
  if(/(?:关闭|禁用)(?:手机(?:的)?)?蓝牙|蓝牙(?:开关)?(?:改成|设为|调整为)?(?:关闭|禁用)/.test(text))return false;
  return undefined;
}

export function isExplicitNewGoal(text=''){
  return /^(?:新任务|另一个任务|换个任务|重新开始|重新执行|重新跑一遍|从头开始|另一个话题|聊点别的|different task|unrelated task)/i.test(stripTopLevelRoleMentions(text).trim());
}
// Model-led routing (2026-10-31): the contract no longer decides what the model
// may attempt. Anything that is not obviously pure chat becomes a task with
// read/navigate, so the model sees its tools and chooses itself. Consequential
// effects (send, purchase, delete, call, publish…) still require the user's own
// words below, and payment/passwords/verification always stay with the user.
const ACTION_HINT=/帮我|替我|请你|麻烦|打开|看看|查|搜|找|发|设|调|买|点|订|放|播|导航|提醒|记得|安排|整理|生成|下载|打电话|拍|关|开|删|改|回复|天气|新闻|价格|多少钱|最新|最近|今天|明天|现在|股价|汇率|比分/;
function classifyRequest(raw){
  const text=String(raw||'').trim();
  if(SMALL_TALK.test(text))return {intent:'conversation',effects:[]};
  if(CHAT.test(text)&&!ACTION_HINT.test(text.replace(/^(?:你好|您好|嗨|hello|hi)[，,。！!\s]*/i,'')))return {intent:'conversation',effects:[]};
  if(!text||/^[\d０-９]+[。.!！\s]*$/.test(text)||CONTINUE.test(text))return {intent:'clarification',effects:[]};
  // Negated effects do not grant permission. Scope/object validation remains the Broker's responsibility.
  const positive=positiveInstruction(text);
  const effects=new Set();
  if(/播放|放首|放一首|搜一下|搜一首|打开|开启|关闭|进入|查看|看看|搜索|查找|查询|读取|浏览|计算|导航|帮我|替我|请|设(?:个|置)|调(?:到|成|高|低)|创建|新建|发送|发给|发(?:一条|个|条)?(?:消息|微信|短信|邮件)|告诉|回复|拨打|打电话|点.{0,20}(?:饭|面|餐|咖啡)|买|下单|删除|改成|换成|发布|发帖|评论|点赞|收藏|呼叫|修改|更改|重命名|移动|保存|整理|设为|清空|移除|取消(?:闹钟|日程|日历|会议)|取消(?:未付款的|待付款的)?订单|拍照|拍一张照片|拍张照片|添加|安排|长按|(?:回到|返回)(?:桌面|主屏幕)|最近任务|最近应用/.test(positive)){
    effects.add('read');effects.add('navigate');
    // Turning source material into a summary/plan is text generation. It must
    // not invent a mutation that strips a read-only worker's inherited scope.
    if(/修改|更改|改(?:成|为|到)|调(?:到|成|高|低)|重命名|移动|保存|整理(?!成|为)|设为|关闭|开启|设置.{0,15}(?:亮度|音量)/i.test(positive)||bluetoothValue(positive)!==undefined)effects.add('modify');
    if(/发送|发给|告诉.{1,30}(?:我|说)|回复|发(?:一条|个|条)?(?:消息|邮件|短信|微信)/.test(positive))effects.add('send');
    if(/(?:点(?=[一二三四五六七八九十两几些个份杯])|(?:^|[，。；：\s])点|买|订(?!单|阅)|准备(?:购买|下单|点餐)).{0,40}(?:饭|面|餐|咖啡|美式|拿铁|奶茶|份|杯|商品|手机|衣服|购买)|加购|加入购物车/.test(positive))effects.add('prepare_purchase');
    if(/淘宝|美团|京东|拼多多/.test(positive)&&/(?:买|购买|加购|加入购物车|准备商品)(?:[正文]|[^，。；!！?？]){0,60}/.test(positive))effects.add('prepare_purchase');
    const explicitPayment=/(?:提交|创建)(?:这个|该|本次)?订单|(?:到|进入|停在|跳到).{0,8}(?:付款|支付)(?:页|界面)/.test(positive);
    const checkoutEndpoint=/(?:到|进入|停在|跳到).{0,6}结算(?:页|界面)/.test(positive);
    if(explicitPayment||!checkoutEndpoint&&/我自己.{0,5}(?:付|输密码)/.test(positive))effects.add('submit_order');
    if(/删除|清空|移除|取消.{0,30}(?:闹钟|日程|日历|会议)/.test(positive))effects.add('delete');
    if(/拨打|打电话|呼叫(?!网约车)/.test(positive))effects.add('call');
    if(/发布|发帖|评论|点赞|收藏/.test(positive))effects.add('publish');
    if(/(?:拍照|拍一张照片|拍张照片)/.test(positive))effects.add('capture');
    if(/取消(?:未付款的|待付款的)?订单/.test(positive))effects.add('cancel_order');
    if(/(?:设|新建|创建|添加|安排).{0,20}(?:闹钟|提醒|日程|日历|待办)|(?:提醒|闹钟).{0,20}(?:设|新建|创建)/.test(positive))effects.add('create_schedule');
    return {intent:'task',effects:[...effects]};
  }
  // Previously anything unmatched became "clarification" with no tools, so a
  // plain request such as "小宇宙上有什么好听的AI播客" could never act.
  // Only a bare reference with nothing to act on asks back; "那后天呢" is a follow-up.
  if(/^(?:那|这)(?:个|件|些)(?:东西|事|事情)?[。？?！!]*$/.test(text))return {intent:'clarification',effects:[]};
  if(/^(?:是什么意思|怎么样|行不行|可行吗)[?？]?$/.test(text))return {intent:'conversation',effects:[]};
  return {intent:'task',effects:['read','navigate'],routing:'inferred'};
}
function requestObjects(text){
  const objects={rawRequest:text};
  const positive=positiveInstruction(text);
  // Quoted names/titles are not message bodies. Actual send/compose parsers
  // below bind exact recipients and content; social effects bind their own body.
  const messageBody=text.match(/(?:发送|发(?:一条|一(?:句|则)|个|条|句)(?:消息|邮件|短信|微信)?|回复)(?:内容为|内容是|[：:])?\s*[“「"]([^”」"]{1,2000})[”」"]/);
  if(messageBody)objects.content=messageBody[1];
  // A quoted classification or title after 给出 is ordinary output. A bound
  // recipient needs an actual communication/call verb, not just 给 + quote.
  const recipient=text.match(/(?:给|告诉|拨打|呼叫)([^，。；：“「"\s]{1,40}?)(?:发(?:送|消息|邮件|短信)|说)/)||text.match(/(?:发送给|发给|告诉|拨打|呼叫)([^，。；：“「"\s]{1,40}?)[“「"]/);
  if(recipient)objects.recipient=recipient[1];
  const dial=positive.match(/(?:拨打|呼叫)(?:号码)?\s*(\+?\d[\d ()-]{3,24}\d)(?=[，。；!！?？]|$)/)||positive.match(/给\s*(\+?\d[\d ()-]{3,24}\d)\s*打电话/);
  if(dial)objects.dialNumber=dial[1].replace(/[ ()-]/g,'');
  const dialContact=positive.match(/给([^，。；\s]{1,40}?)打电话|(?:拨打|呼叫)([^，。；\s\d]{1,40}?)(?:的电话|电话)?(?=[，。；!！?？]|$)/);
  if(dialContact&&!objects.dialNumber)objects.dialRecipient=dialContact[1]||dialContact[2];
  const longPress=text.match(/长按[“「"]([^”」"]{1,120})[”」"]/);if(longPress)objects.longPressTarget=longPress[1];
  const fileRename=text.match(/[“「"]([^”」"]{1,240})[”」"](?:文件)?重命名(?:为|成)[“「"]([^”」"]{1,120})[”」"]/);
  const fileMove=text.match(/[“「"]([^”」"]{1,240})[”」"](?:文件)?移动到[“「"]([^”」"]{1,240})[”」"]/);
  if(fileRename){objects.fileOperation='rename';objects.filePath=fileRename[1];objects.newName=fileRename[2];}
  if(fileMove){objects.fileOperation='move';objects.filePath=fileMove[1];objects.destination=fileMove[2];}
  if(/拍照|拍一张照片|拍张照片/.test(positive)){objects.captureKind='photo';if(/前置|后置/.test(positive))objects.captureCamera=positive.match(/前置|后置/)[0];}
  const account=text.match(/(?:使用|用)?账号[“「"]([^”」"]{1,120})[”」"]/);if(account)objects.account=account[1];
  const audience=text.match(/(?:可见范围|可见性|权限)(?:为|设为|设置为)?[“「"](公开|仅自己可见|好友可见)[”」"]/);if(audience)objects.audience=audience[1];
  const socialBody=text.match(/(发布|评论)[“「"]([^”」"]{1,2000})[”」"]/);if(socialBody){objects.socialOperation=socialBody[1]==='发布'?'publish':'comment';objects.content=socialBody[2];}
  const socialTarget=text.match(/(?:笔记|帖子|视频)[“「"]([^”」"]{1,200})[”」"]/);if(socialTarget)objects.socialTarget=socialTarget[1];
  if(/收藏/.test(positive)&&socialTarget)objects.socialOperation='bookmark';
  const author=text.match(/作者[“「"]([^”」"]{1,120})[”」"]/);if(author)objects.targetAuthor=author[1];
  const orderId=text.match(/订单(?:号)?[“「"]([A-Za-z0-9-]{6,64})[”」"]|订单(?:号)?\s*([A-Za-z0-9-]{6,64})(?=[，。；\s]|$)/);
  if(orderId){objects.orderId=orderId[1]||orderId[2];objects.orderOperation=/取消(?:未付款的|待付款的)?订单/.test(positive)?'cancel':'read';}
  const cancelReason=text.match(/取消原因[“「"]([^”」"]{1,120})[”」"]/);if(cancelReason)objects.cancelReason=cancelReason[1];
  if(/回到桌面|返回桌面|回到主屏幕|返回主屏幕/.test(positive))objects.systemNavigation='home';
  if(/(?:打开|查看|进入)(?:手机)?(?:最近任务|最近应用|多任务)(?:界面|页面)?/.test(positive))objects.systemNavigation='recents';
  if(/亮度/.test(text))objects.field='brightness';else if(/音量/.test(text))objects.field='volume';else if(/蓝牙/.test(text))objects.field='bluetooth';
  if(objects.field&&/修改|更改|调|设(?:置|为)/.test(positive)){if(/一半|半档|50%/.test(positive))objects.value=50;const value=positive.match(/(\d{1,3})\s*%/);if(value)objects.value=Number(value[1]);}
  if(objects.field==='bluetooth'){const value=bluetoothValue(positive);if(value!==undefined)objects.value=value;}
  objects.operation=/删除|清空|移除|取消闹钟/.test(positive)?'delete':/修改|更改|改为|调到|调成/.test(positive)?'update':/新建|创建|添加|设(?:个|置)?.{0,10}(?:闹钟|提醒|日程)/.test(positive)?'create':'read';
  if(objects.field&&objects.value!==undefined)objects.operation='update';
  const times=/(?:今天|明天|后天|明早|今晚|每天|每周.{1,3})?\s*(?:上午|下午|晚上|早上|早晨)?\s*\d{1,2}(?::\d{2}|点(?:半|\d{1,2}分)?)/g;
  for(const time of positive.matchAll(times)){
    const before=positive.slice(0,time.index),after=positive.slice(time.index+time[0].length);
    const labelledReadTime=/(?:读取|抓取|采集|观察|访问|核对)(?:的)?(?:时间|时刻)(?:为|是|[：:=])?\s*(?:\d{4}[-/]\d{1,2}[-/]\d{1,2})?\s*$/.test(before);
    const reportedRead=/^\s*(?:(?:UTC|GMT)(?:[+−-]\d{1,2}(?::?\d{2})?)?\s*)?(?:(?:用|使用|通过|从|在|经)[^，,。；;!！?？\n]{0,48}?)?(?:已(?:经)?读取|读到|读过|查到|查询到|读取完毕|读取成功|抓取成功|采集完成|访问成功|直连成功)/i.test(after);
    const requestedTime=/^(?:明天|明早|后天|今晚|每天|每周)/.test(time[0].trim())||/(?:请|需要|务必|必须|定于|安排在|预约)[^，,。；;!！?？：:\n]{0,40}$/.test(before);
    if(!requestedTime&&(labelledReadTime||reportedRead))continue;
    objects.when=time[0].trim();break;
  }
  return objects;
}
export function taskDeadline(task){
  const value=task.timeline?.deadlineAt||task.deadlineAt;
  return Number.isFinite(Date.parse(value))?Date.parse(value):Infinity;
}
export function remainingTaskMs(task,at=Date.now()){return Math.max(0,taskDeadline(task)-at);}
// Time spent waiting in the queue (other tasks holding the slots) does not use up
// a task's working time: the budget starts when its segment first runs. A fixed
// bound (a routine's window, a phone grant's expiry) still applies, and a task
// that never gets a slot gives up once it has waited as long as its budget (at
// most half an hour more), so a 5-minute meal order is not placed an hour late.
export const QUEUE_GRACE_MS=30*60000;
const unstartedSegment=task=>{const seg=task?.timeline?.segments?.at(-1);return seg&&!seg.runStartedAt&&Number.isFinite(seg.budgetMs)?seg:null;};
export function queuedExpired(task,at=Date.now()){
  const seg=unstartedSegment(task);if(!seg)return remainingTaskMs(task,at)<=0;
  // A deadline tightened below the plain budget (a correction, a revoked grant)
  // counts as a fixed bound too.
  const planned=Date.parse(seg.startedAt)+seg.budgetMs,tightened=taskDeadline(task)<planned?taskDeadline(task):Infinity;
  const bound=Math.min(Number.isFinite(Date.parse(seg.boundAt))?Date.parse(seg.boundAt):Infinity,tightened);
  return Number.isFinite(bound)&&bound<=at||at>Date.parse(seg.startedAt)+seg.budgetMs+Math.min(seg.budgetMs,QUEUE_GRACE_MS);
}
export function beginSegment(task,{at=Date.now()}={}){
  const seg=unstartedSegment(task);if(!seg)return false;
  seg.runStartedAt=new Date(at).toISOString();
  const planned=Date.parse(seg.startedAt)+seg.budgetMs,tightened=taskDeadline(task)<planned?taskDeadline(task):Infinity;
  const bound=Math.min(Number.isFinite(Date.parse(seg.boundAt))?Date.parse(seg.boundAt):Infinity,tightened),next=Math.min(at+seg.budgetMs,bound);
  if(next>taskDeadline(task)){seg.deadlineAt=task.timeline.deadlineAt=task.deadlineAt=new Date(next).toISOString();}
  return true;
}

export function createTaskContract(task,{previous=null,routineAuthorization=null,at=Date.now()}={}){
  const message=textOf(task),raw=String(message?.content||task.prompt||''),originalRequest=stripTopLevelRoleMentions(raw).trim();
  // A literal send body (including unquoted text) is data, not an instruction to
  // strip. The message parser supplies its own instruction-only authority view.
  const messageRequest=parseMessageRequest(originalRequest),parsedRequest=messageRequest?originalRequest:affirmativeInstructions(originalRequest),semanticRequest=messageRequest?.instruction||parsedRequest;
  // Request-type guards are restrictions, not grants. Retain a denied structured
  // operation here so removing its negative clause cannot downgrade it to a
  // broader order-read/navigation grant. Only affirmative content supplies fields.
  const guardedRequest=messageRequest?.instruction||originalRequest;
  const instructionSource=instructionText(semanticRequest);
  const external=message?.externalContent===true||message?.external_content===true||attributedInstruction(instructionSource)||EXTERNAL_REFERENCE.test(instructionSource);
  let {intent,effects,routing}=classifyRequest(semanticRequest),goal=raw,objects={...requestObjects(semanticRequest),rawRequest:raw};
  if(messageRequest){objects.recipient=messageRequest.recipient;objects.content=messageRequest.content;}
  if(!messageRequest&&intent!=='conversation'&&isAttachmentSendRequest(parsedRequest)&&!isMailSendRequest(semanticRequest)&&!isMediaPublishRequest(semanticRequest)){
    objects.attachmentRequested=true;delete objects.content;delete objects.recipient;
    effects=effects.filter(effect=>effect!=='send');
    const attachment=parseAttachmentRequest(parsedRequest);
    if(attachment){objects.attachment=attachment;intent='task';effects=[...new Set(['read','navigate',...effects,'send_attachment'])];}
  }
  if(intent!=='conversation'&&isMailSendRequest(semanticRequest)){objects.mailRequested=true;delete objects.content;delete objects.recipient;effects=effects.filter(e=>!['send','send_attachment'].includes(e));const mail=parseMailRequest(parsedRequest);if(mail){objects.mail=mail;effects=[...new Set(['read','navigate',...effects,'send_mail'])];intent='task';}}
  if(intent!=='conversation'&&isMediaPublishRequest(semanticRequest)){objects.mediaRequested=true;effects=effects.filter(e=>e!=='publish');const media=parseMediaRequest(parsedRequest);if(media){objects.media=media;effects=[...new Set(['read','navigate',...effects,'publish_media'])];intent='task';}}
  if(intent!=='conversation'&&isAfterSalesRequest(guardedRequest)){
    objects.afterSalesRequested=true;
    const afterSales=parseAfterSalesRequest(parsedRequest);
    if(afterSales){objects.afterSales=afterSales;intent='task';effects=[...new Set(['read','navigate',...effects,afterSales.operation==='refund'?'request_refund':'return_goods'])];}
  }
  if(intent!=='conversation'&&isRouteRequest(guardedRequest))objects.routeRequested=true;
  const route=parseRouteRequest(semanticRequest);if(route){objects.route=route;intent='task';effects=[...new Set(['read','navigate',...effects])];}
  const semantic=semanticPurchase(task);
  const purchase=messageRequest?null:semantic?{platform:semantic.platform,query:semantic.query}:hasSemanticPurchaseReview(task)?null:checkoutQueryFromPrompt(parsedRequest);
  if(hasSemanticPurchaseReview(task)&&!semantic)effects=effects.filter(effect=>!['prepare_purchase','submit_order'].includes(effect));
  if(semantic)effects=['read','navigate','prepare_purchase'];
  if(purchase&&(semantic||!CHAT.test(parsedRequest)&&/(?:点|买|购买|订|来|准备|整个|搞个)/.test(positiveInstruction(parsedRequest)))){intent='task';effects=[...new Set(['read','navigate',...effects,'prepare_purchase'])];}
  const referenceAt=message?.at||task.timeline?.segmentStartedAt||task.createdAt||previous?.createdAt||new Date(at).toISOString();
  if(intent!=='conversation'&&isTravelMutationRequest(semanticRequest)){
    objects.travelRequested=true;const travel=parseTravelRequest(parsedRequest,{referenceAt});
    if(travel){objects.travel=travel;intent='task';effects=[...new Set(['read','navigate',...effects,travelEffect(travel)])];}
  }
  if(isTravelPreparationRequest(semanticRequest)){objects.travelPreparationRequested=true;const preparation=parseTravelPreparationRequest(parsedRequest,{referenceAt,timezone:task.timezone||'Asia/Shanghai'});objects.travelPreparation=preparation;intent='task';if(preparation?.status==='ready')effects=[...new Set(['read','navigate',...effects])];}
  const screenshotSchedule=parseScreenshotScheduleRequest(semanticRequest);
  if(screenshotSchedule){objects.screenshotSchedule=screenshotSchedule;intent='task';effects=[...new Set(['read','navigate',...effects,'create_schedule'])];delete objects.content;}
  const schedule=screenshotSchedule?null:parseScheduleRequest(semanticRequest,{referenceAt,timezone:task.timezone||'Asia/Shanghai'});
  if(schedule){objects.schedule=schedule;if(schedule.status==='ready'){objects.operation=schedule.operation;const mutation=schedule.operation==='create'?'create_schedule':schedule.operation==='delete'?'delete':schedule.operation==='check'?'read':'modify';effects=[...new Set(['read','navigate',...effects,mutation])];intent='task';}}
  const instruction=positiveInstruction(semanticRequest);
  // In a local document request, an application name can be the subject of the
  // document (or part of its filename). Require an actual application target,
  // retaining explicit mixed work without treating every topic as phone scope.
  const desktopReference=isDesktopWork(semanticRequest)&&effects.every(effect=>['read','navigate','modify'].includes(effect));
  const appNames=APP_NAMES.filter(name=>mentionsApp(instruction,name)&&(!desktopReference||targetsApp(instruction,name)));
  let allowedApps=messageRequest?[messageRequest.app,...(messageRequest.compose?appNames:[])]:appNames;
  if(purchase&&effects.includes('prepare_purchase'))allowedApps.push(commercePlatform(purchase.platform)?.names[0]);
  if(schedule?.kind==='calendar'&&!allowedApps.includes('日历'))allowedApps.push('日历');
  if(/闹钟/.test(instruction)&&!allowedApps.includes('时钟'))allowedApps.push('时钟');
  if(effects.includes('call')&&!allowedApps.some(name=>['电话','联系人','微信','腾讯QQ','QQ','Telegram','WhatsApp'].includes(name)))allowedApps.push('电话');
  if(effects.includes('capture')&&!allowedApps.includes('相机'))allowedApps.push('相机');
  if(/亮度|音量|蓝牙|Wi.?Fi|电池|存储空间/i.test(instruction)&&!allowedApps.includes('设置'))allowedApps.push('设置');
  const source={kind:task.source||'user',messageId:message?.id||null,contentSha256:requestHash(raw)};
  if(previous&&isTaskContinuation(parsedRequest)&&previous.taskId===task.id&&previous.intent==='task'){
    const originId=previous.source.originMessageId||previous.source.messageId;
    const originHash=previous.source.originContentSha256||previous.source.contentSha256;
    const origin=(task.messages||[]).find(m=>m.id===originId&&requestHash(m.content)===originHash);
    if(origin){const original=createTaskContract({...task,messages:task.messages.slice(0,task.messages.indexOf(origin)+1)},{at,routineAuthorization});intent=original.intent;effects=original.effects;allowedApps=original.allowedApps;objects=original.objects;goal=original.goal;source.originMessageId=origin.id;source.originContentSha256=requestHash(origin.content);}
  }
  if(external){effects=[];intent='clarification';}
  if(source.kind==='delegation'){
    const grant=task.delegationGrant,matching=grant?.schemaVersion===1&&grant.parentTaskId===task.parentId&&grant.childPromptSha256===requestHash(raw);
    effects=matching?effects.filter(effect=>grant.effects?.includes(effect)):[];
    allowedApps=matching?allowedApps.filter(app=>grant.allowedApps?.includes(app)):[];
    if(matching){objects=structuredClone(grant.objects);source.parentTaskId=grant.parentTaskId;source.parentContractId=grant.parentContractId;source.parentContractRevision=grant.parentContractRevision;source.rootSource=structuredClone(grant.rootSource);}
  }
  if(source.kind==='routine'){
    source.routineId=task.routineId||null;source.authorizationId=routineAuthorization?.id||null;
    const auth=routineAuthorization;
    const valid=auth?.source==='routine_configuration'&&!auth.revokedAt&&auth.promptSha256===requestHash(raw)&&auth.cloudConsent===true&&(!auth.expiresAt||Date.parse(auth.expiresAt)>at);
    effects=valid?effects.filter(effect=>auth.effects?.includes(effect)):[];
    allowedApps=valid?allowedApps.filter(app=>auth.allowedApps?.includes(app)):[];
  }
  if(source.kind==='event'){
    const auth=task.eventAuthorization;source.eventRuleId=task.eventRuleId||null;source.eventReceiptId=task.eventReceiptId||null;source.authorizationId=auth?.id||null;
    const valid=auth?.source==='event_rule_configuration'&&!auth.revokedAt&&auth.promptSha256===requestHash(raw)&&auth.cloudConsent===true&&(!auth.expiresAt||Date.parse(auth.expiresAt)>at);
    effects=valid?effects.filter(effect=>auth.effects?.includes(effect)):[];allowedApps=valid?allowedApps.filter(app=>auth.allowedApps?.includes(app)):[];
  }
  if(source.kind==='watch'){
    // 持续跟进 checks are read-only, whatever the goal's wording looks like
    // ("降价提醒" is not a calendar reminder; "到了告诉我" is not a send).
    source.watchId=task.watchId||null;intent='task';routing='watch';effects=['read','navigate'];objects={rawRequest:raw};
  }
  if(source.kind==='router'){
    // The dispatch session only decides where a result goes; it has no phone,
    // browser or file effects and cannot start work.
    intent='task';routing='router';effects=[];allowedApps=[];objects={rawRequest:raw};
  }
  if(task.phoneQuery?.query)objects.query=task.phoneQuery.query;
  const deadline=taskDeadline(task);
  return {schemaVersion:1,id:previous?.id||randomUUID(),revision:(previous?.revision||0)+1,taskId:task.id,source,intent,...(routing&&intent==='task'?{routing}:{}),goal,allowedApps:[...new Set(allowedApps)],effects,objects,constraints:source.kind==='delegation'&&task.delegationGrant?structuredClone(task.delegationGrant.constraints):{payment:'user',...(task.phoneQuery?{query:task.phoneQuery.query}:{}),...(task.checkoutPlan||{})},createdAt:new Date(at).toISOString(),expiresAt:Number.isFinite(deadline)?new Date(deadline).toISOString():null,cloudAllowed:task.cloudConsent===true,memoryAllowed:task.memoryConsent===true&&task.cloudConsent===true};
}

export function validateTaskContract(task,{at=Date.now(),store,seen=new Set()}={}){
  const contract=task?.taskContract,fail=reason=>({valid:false,reason,contract:contract||null});
  if(!contract||contract.schemaVersion!==1||contract.taskId!==task.id||!Array.isArray(contract.effects)||!Array.isArray(contract.allowedApps))return fail('missing_contract');
  const message=(task.messages||[]).find(m=>m.id===contract.source?.messageId&&m.role==='user');
  if(!message||message.externalContent||message.external_content||requestHash(message.content)!==contract.source.contentSha256)return fail('source_changed');
  if(contract.source.kind!==(task.source||'user'))return fail('source_changed');
  if(contract.source.originMessageId&&!task.messages.some(m=>m.id===contract.source.originMessageId&&m.role==='user'&&!m.externalContent&&!m.external_content&&requestHash(m.content)===contract.source.originContentSha256))return fail('origin_changed');
  if(contract.expiresAt&&Date.parse(contract.expiresAt)<=at||remainingTaskMs(task,at)<=0)return fail('deadline_expired');
  if(contract.source.kind==='routine'){
    const auth=task.routineAuthorization;
    if(!auth||auth.revokedAt||auth.source!=='routine_configuration'||auth.id!==contract.source.authorizationId||auth.promptSha256!==contract.source.contentSha256||auth.cloudConsent!==true||auth.expiresAt&&Date.parse(auth.expiresAt)<=at)return fail('routine_authorization_missing');
    if(contract.effects.some(effect=>!auth.effects?.includes(effect)))return fail('effect_not_authorized');
  }
  if(contract.source.kind==='delegation'&&task.delegationGrant){const delegated=validateDelegationGrant(task,store,{at,seen});if(!delegated.valid)return fail(delegated.reason);}
  else if(contract.source.kind==='delegation'&&contract.effects.length)return fail('delegation_not_authorized');
  if(contract.source.kind==='event'){const event=validateEventAuthorization(task,store,{at});if(!event.valid)return fail(event.reason);}
  if(contract.source.kind==='watch'&&store?.data){const watch=(store.data.watches||[]).find(row=>row.id===task.watchId);if(!watch||watch.status!=='active'||store.data.settings?.watchesEnabled===false)return fail('watch_inactive');}
  const expected=createTaskContract(task,{previous:contract,at,routineAuthorization:task.routineAuthorization});
  if(JSON.stringify(contract.source)!==JSON.stringify(expected.source))return fail('source_changed');
  if(contract.intent!==expected.intent||contract.cloudAllowed!==expected.cloudAllowed||contract.memoryAllowed!==expected.memoryAllowed)return fail('scope_changed');
  if(contract.effects.some(effect=>!expected.effects.includes(effect))||contract.allowedApps.some(app=>!expected.allowedApps.includes(app)))return fail('scope_changed');
  if(contract.goal!==expected.goal||JSON.stringify(contract.objects)!==JSON.stringify(expected.objects)||JSON.stringify(contract.constraints)!==JSON.stringify(expected.constraints))return fail('objects_changed');
  return {valid:true,reason:null,contract};
}
export function isConversationOnlyTask(task){return task?.taskContract?.intent==='conversation'&&task.taskContract.effects.length===0&&validateTaskContract(task).valid;}

const deadlineISO=value=>Number.isFinite(value)?new Date(value).toISOString():null;
export function initializeTimeline(task,{at=Date.now(),submittedAt,budgetMs=1200000,deadlineAt}={}){
  const parsed=Date.parse(submittedAt),start=Number.isFinite(parsed)&&parsed<=at+1000?Math.min(parsed,at):at;
  const bound=Date.parse(deadlineAt),deadline=Math.min(start+budgetMs,Number.isFinite(bound)?bound:Infinity);
  const segmentId=randomUUID();
  task.timeline={chainId:task.id,submittedAt:new Date(start).toISOString(),segmentId,segmentStartedAt:new Date(start).toISOString(),deadlineAt:deadlineISO(deadline),segments:[{id:segmentId,startedAt:new Date(start).toISOString(),deadlineAt:deadlineISO(deadline),sourceMessageId:textOf(task)?.id||null,budgetMs:Number.isFinite(budgetMs)?budgetMs:null,boundAt:Number.isFinite(bound)?new Date(bound).toISOString():null}]};
  task.deadlineAt=task.timeline.deadlineAt;return task.timeline;
}
export function advanceTimeline(task,{at=Date.now(),newGoal=false,budgetMs=1200000,submittedAt,deadlineAt:inputDeadline}={}){
  if(!task.timeline)initializeTimeline(task,{at,submittedAt:task.createdAt,budgetMs});
  const parsed=Date.parse(submittedAt),segmentStart=Number.isFinite(parsed)&&parsed<=at+1000?Math.min(parsed,at):at;
  const bound=Date.parse(inputDeadline);
  if(newGoal){
    const segmentId=randomUUID(),startedAt=new Date(segmentStart).toISOString(),deadlineAt=deadlineISO(Math.min(segmentStart+budgetMs,Number.isFinite(bound)?bound:Infinity));
    task.timeline.segments.at(-1).endedAt=new Date(at).toISOString();
    task.timeline={...task.timeline,segmentId,segmentStartedAt:startedAt,deadlineAt,segments:[...task.timeline.segments,{id:segmentId,startedAt,deadlineAt,sourceMessageId:textOf(task)?.id||null,budgetMs:Number.isFinite(budgetMs)?budgetMs:null,boundAt:Number.isFinite(bound)?new Date(bound).toISOString():null}]};
  }else if(!Number.isFinite(budgetMs)){
    const seg=task.timeline.segments.at(-1);const explicit=Date.parse(seg.boundAt);
    task.timeline.deadlineAt=seg.deadlineAt=deadlineISO(Math.min(Number.isFinite(explicit)?explicit:Infinity,Number.isFinite(bound)?bound:Infinity));seg.budgetMs=null;
  }else if(Number.isFinite(budgetMs)){
    // A correction may tighten the original segment; it cannot extend it.
    const base=Date.parse(task.timeline.segments.at(-1)?.runStartedAt||task.timeline.segmentStartedAt);
    task.timeline.deadlineAt=new Date(Math.min(taskDeadline(task),base+budgetMs,Number.isFinite(bound)?bound:Infinity)).toISOString();
    task.timeline.segments.at(-1).deadlineAt=task.timeline.deadlineAt;
  }
  task.deadlineAt=task.timeline.deadlineAt;return task.timeline;
}
