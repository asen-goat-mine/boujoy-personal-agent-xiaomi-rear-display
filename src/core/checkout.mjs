import {semanticPurchase,hasSemanticPurchaseReview} from './semantic-purchase.mjs';
import {nativeState} from '../adapters/phone-purchase-navigation.mjs';
import {PHONE_APP_NAMES} from '../adapters/phone-apps.mjs';
import {isTaskContinuation} from './task-continuation.mjs';
import {stripTopLevelRoleMentions} from './role-mentions.mjs';
import {AppError,requireValue} from './errors.mjs';
import {COMMERCE_NAMES,DEFAULT_COMMERCE_PLATFORM,commercePlatform,requestedCommercePlatform,platformPackageMatches,requestedSpecifications} from './commerce-platforms.mjs';
const platformNames=[...COMMERCE_NAMES].sort((a,b)=>b.length-a.length);
const withoutPlatform=value=>platformNames.reduce((text,name)=>text.split(name).join(''),value).replace(/(?:在|用)(?=(?:点|买|订|来|准备|整个|搞个))/g,'');
const compact=text=>String(text||'').normalize('NFKC').replace(/\s+/g,'');
export function hasDirectMealRequest(prompt,requestedQuery){
  const text=withoutPlatform(compact(stripTopLevelRoleMentions(prompt)));
  const query=compact(requestedQuery);
  if(query.length<2)return false;
  const escaped=query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const directOrder=new RegExp('(?:^|[,，。;；:：!！?？]|帮我|给我|请|我要|想)(?:最后|然后|接着|现在)?(?:只|先)?(?:点|订|来|准备|整个|搞个)(?:一下)?(?:\\d{1,2}|一|两|二|三|四|五|六|七|八|九|十)?(?:份|碗|杯|件|个|包|袋|支|套)?'+escaped);
  return directOrder.test(text)&&!/(?:只|仅)(?:查|搜|比较|比价)|(?:不要|别|不用|不想|不需要|禁止|不允许).{0,8}(?:点|买|订|准备)|(?:网页|页面|广告|商家|模型|助理|知识库).{0,12}(?:说|显示|要求|建议|指示)|(?:引用|转述|粘贴)/.test(text);
}
export function hasDirectPurchaseRequest(prompt,requestedQuery){
  const text=withoutPlatform(compact(stripTopLevelRoleMentions(prompt))),query=compact(requestedQuery);if(query.length<2)return false;
  const escaped=query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const direct=new RegExp('(?:^|[,，。;；:：!！?？]|帮我|给我|请|我要|我想)(?:最后|然后|接着|现在)?(?:只|先)?(?:买|购买)(?:一下)?(?:\\d{1,2}|一|两|二|三|四|五|六|七|八|九|十)?(?:份|碗|杯|件|个|台|盒|瓶|包|袋|支|套)?[“「"]?'+escaped);
  return direct.test(text)&&!/(?:只|仅)(?:查|搜|比较|比价)|(?:不要|别|不用|不想|不需要|禁止|不允许).{0,8}(?:点|买|订|准备|购买)|(?:网页|页面|广告|商家|模型|助理|知识库).{0,12}(?:说|显示|要求|建议|指示)|引用|转述|粘贴/.test(text);
}
function requestedQuantity(text){
  return text.match(/(?:点|买|要|来|准备|数量[：:]?)?(?:一共)?(\d{1,2}|一|两|二|三|四|五|六|七|八|九|十)(?:份|碗|杯|件|个|台|盒|瓶|包|袋|支|套)/);
}
function requestedBudget(text){
  return text.match(/预算(?:总共|合计|总额|是|为)?[¥￥]?(\d{1,6}(?:\.\d{1,2})?)(?:元)?/)||text.match(/(?:不超过|别超过|最多|上限(?:是|为)?)(?:[¥￥](\d{1,6}(?:\.\d{1,2})?)|(\d{1,6}(?:\.\d{1,2})?)元)/)||text.match(/(\d{1,6}(?:\.\d{1,2})?)(?:元|块)(?:以内|以下)/);
}
// This plan describes the stopping point; it grants no shopping or payment actions.
export function checkoutPlan(prompt,grant){
  prompt=stripTopLevelRoleMentions(prompt);
  if(!grant||!commercePlatform(grant.platform)||!grant.query)return null;
  const named=requestedCommercePlatform(prompt);if(named&&named!==grant.platform)return null;
  const text=withoutPlatform(compact(stripTopLevelRoleMentions(prompt)));
  const explicitMeal=hasDirectMealRequest(prompt,grant.query)||hasDirectPurchaseRequest(prompt,grant.query);
  if(!explicitMeal&&!/(?:到|停在|进入|跳到|准备到|推进到|走到).{0,12}(?:结算|付款|支付)(?:页|页面|界面)?|(?:我|用户|人工|自己).{0,8}(?:付|支付|输密码)|(?:只|仅).{0,8}准备.{0,8}(?:订单|下单)/.test(text))return null;
  if(/(?:不要|别|不用).{0,3}(?:进入|到|跳到|打开)(?:结算|付款|支付)/.test(text))return null;
  const count=requestedQuantity(text);
  const chinese={一:1,两:2,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
  const quantity=count?(chinese[count[1]]||Number(count[1])):1;
  if(quantity<1||quantity>20)return null;
  const budget=requestedBudget(text);
  const maxTotalFen=budget?Math.round(Number(budget[1]||budget[2])*100):null;
  const purchaseChannel=/(?:普通商品|非闪购|非外卖|快递|商品页|天猫|网购)/.test(text)?'retail':/(?:闪购|外卖)/.test(text)||hasDirectMealRequest(prompt,grant.query)?'delivery':hasDirectPurchaseRequest(prompt,grant.query)?'retail':'auto';
  return {platform:grant.platform,query:grant.query,quantity,maxTotalFen,purchaseChannel,goal:'checkout',payment:'user',actionAuthority:'task app navigation until checkout',requestedSpecifications:requestedSpecifications(prompt)};
}
// Only current-task human messages can permit topping up a purchase. Continue
// messages retain it; a different product/platform or an explicit refusal ends it.
export function taskAllowsTopUp(task){
 const current=task?.phoneQuery;if(!current)return false;
 for(const message of [...(task.messages||[])].reverse()){
  if(message.role!=='user'||message.externalContent||message.external_content)continue;
  const text=compact(message.content);
  if(/(?:取消|停止|不用了|不要继续)|(?:不要|不许|不允许|不可以|禁止|别|不能|不)(?:再|自动|帮我)?(?:凑单|加购)/.test(text))return false;
  const query=checkoutQueryFromPrompt(message.content);
  if(query&&(query.platform!==current.platform||compact(query.query)!==compact(current.query)))return false;
  if(/(?:可以|允许|同意|接受|你看着|自行|自己|直接|可)(?:.{0,8})(?:凑单|加购)|(?:凑单|加购)(?:到|至).{0,8}(?:配送|起送)/.test(text))return true;
 }
 return false;
}
export function taskCheckoutPlan(task){
  const interpreted=semanticPurchase(task);if(interpreted)return interpreted;if(hasSemanticPurchaseReview(task))return null;
  const users=(task.messages||[]).filter(m=>m.role==='user');const current=users.at(-1)?.content;
  if(task.phoneQuery&&isTaskContinuation(current)){
    for(const message of [...users.slice(0,-1)].reverse()){
      if(message.externalContent||message.external_content)continue;
      if(/取消|停止|不用了|不要继续|只查|只搜|只比较/.test(compact(message.content)))return null;
      const query=checkoutQueryFromPrompt(message.content);
      if(query&&query.platform!==task.phoneQuery.platform)return null;
      const prior=checkoutPlan(message.content,task.phoneQuery);
      if(prior){
        const count=/^(?:换成|改成|改为)/.test(compact(current))?requestedQuantity(compact(current)):null;const numbers={一:1,两:2,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
        const specification=compact(current).match(/^(?:改成|换成|改为)(冰|热|常温|少冰|去冰|无糖|少糖)(?:的)?$/)?.[1];
        return {...prior,...(count?{quantity:numbers[count[1]]||Number(count[1])}:{}),...(specification?{requestedSpecifications:[specification]}:{}),...(taskAllowsTopUp(task)?{allowTopUp:true}:{})};
      }
    }
    return null;
  }
  const direct=checkoutPlan(current,task.phoneQuery);
  if(direct){
    // A short continuation must not reset a user's count or spending ceiling.
    if(/(?:继续|接着)/.test(current||'')){
      let needQuantity=!requestedQuantity(compact(current)),needBudget=!requestedBudget(compact(current));
      for(const message of [...users.slice(0,-1)].reverse()){
        if(message.externalContent||message.external_content)continue;
        const query=checkoutQueryFromPrompt(message.content);
        if(query&&(query.platform!==task.phoneQuery.platform||compact(query.query)!==compact(task.phoneQuery.query)))break;
        if(/(?:取消|停止|不用了|不要继续)/.test(compact(message.content)))break;
        const prior=checkoutPlan(message.content,task.phoneQuery);if(!prior)continue;
        if(needQuantity&&requestedQuantity(compact(message.content))){direct.quantity=prior.quantity;needQuantity=false;}
        if(needBudget&&requestedBudget(compact(message.content))){direct.maxTotalFen=prior.maxTotalFen;needBudget=false;}
        if(!needQuantity&&!needBudget)break;
      }
    }
    return {...direct,...(taskAllowsTopUp(task)?{allowTopUp:true}:{})};
  }
  if(!task.phoneQuery||!(/(?:这次|换成|改成|改为|换|继续|接着)/.test(current||'')||isTaskContinuation(current))||/(?:只查|只比较|只搜索|不进入|不要.{0,8}(?:结算|付款))/.test(current||''))return null;
  // A meal correction keeps the prior stopping rule, never the old search authority.
  const previous=[...users.slice(0,-1)].reverse().map(m=>checkoutPlan(m.content,checkoutQueryFromPrompt(m.content)||task.phoneQuery)).find(Boolean);
  if(!previous)return null;
  const plan=checkoutPlan((current||'')+`，数量${previous.quantity}份，到结算页`+(previous.maxTotalFen===null?'':`，预算${previous.maxTotalFen/100}元`),task.phoneQuery);return plan?{...plan,...(taskAllowsTopUp(task)?{allowTopUp:true}:{})}:null;
}
// Unnamed purchases use the registered default; explicit apps are resolved from their live catalog.
export function checkoutQueryFromPrompt(prompt){
  const text=compact(stripTopLevelRoleMentions(prompt));
  if(PHONE_APP_NAMES.some(name=>text.includes(name)&&!COMMERCE_NAMES.includes(name)))return null;
  const platform=requestedCommercePlatform(text,{defaultPlatform:DEFAULT_COMMERCE_PLATFORM});if(!platform)return null;
  const match=withoutPlatform(text).match(/(?:^|[,，。;；:：!！?？]|帮我|给我|我要|我想|请)(?:最后|然后|接着|现在)?(?:只|先)?(?:点|买|购买|订(?!单|阅)|来|准备|整个|搞个)(?:一下)?(?:\d{1,2}|一|两|二|三|四|五|六|七|八|九|十)?(?:份|碗|杯|件|个|台|盒|瓶|包|袋|支|套)?[“「"]?([^,，。;；!！?？\n”」"]{2,60})/);
  if(!match)return null;
  const query=match[1].replace(/(?:送到|送达|到结算|到付款|到支付|我自己|我来付|我来买单|我付|自己付|付钱|买单|你看着|看着凑|凑单|规格|型号|预算|不超过|最多|不要|别加|不加|随便选|随便挑).*/, '').replace(/[：:]/g,'').replace(/(?:给我(?:吃|喝|用)?)$/,'').replace(/(?:喝喝|吃吃|喝|吃)$/,'').trim();
  if(query.length<2||query.length>40||/^(?:开|击|赞|进去|进入|打开|关闭|设置|返回)/.test(query)||/^(?:外卖|饭|吃的|订单|结算|付款|东西|喝的)$/.test(query)||/(?:支付|付款|下单|提交|购买|加购|会员|登录|密码|验证码|地址)/.test(query))return null;
  const grant={platform,query};
  return checkoutPlan(text,grant)?grant:null;
}
// A changed meal is a new current-user scope within an existing meal goal.
export function checkoutQueryFromContinuation(prompt,task){
  if(!task?.phoneQuery||!taskCheckoutPlan(task))return null;
  const text=compact(stripTopLevelRoleMentions(prompt));
  if(/(?:只查|只比较|只搜索|不要|不用|禁止|引用|转述|粘贴|页面|广告|商家|模型|助理|知识库)/.test(text))return null;
  if(/^(?:换成|改成|改为)?(?:[一两二三四五六七八九十\d]+(?:份|杯|瓶|件|个)|(?:冰|热|常温|少冰|去冰|无糖|少糖)(?:的)?)$/.test(text))return task.phoneQuery;
  const changed=text.match(/(?:这次(?:是|点)?|换成|改成|改为)(?:\d{1,2}|一|两|二|三|四|五|六|七|八|九|十)?(?:份|碗|杯|件|个|包|袋|支|套)?([^,，。;；!！?？]{2,60})/);
  if(!changed)return null;
  return checkoutQueryFromPrompt((commercePlatform(task.phoneQuery.platform)?.names[0]||'')+'点'+changed[1]);
}
function amount(text){const match=compact(text).match(/[¥￥](\d{1,6}(?:\.\d{1,2})?)(?![\d.])/);return match?Math.round(Number(match[1])*100):null;}
export function inspectCheckout(ocr,plan){
  if(!ocr||!plan||!commercePlatform(plan.platform)||!Array.isArray(ocr.lines)||!ocr.width||!ocr.height)return null;
  const lines=ocr.lines.filter(n=>typeof n.text==='string'&&Array.isArray(n.bounds));
  const text=lines.map(n=>compact(n.text));
  if(text.some(t=>/(?:支付密码|输入密码|验证码|支付成功|付款成功|订单已提交|收银台|待付款|订单编号|订单号|订单详情|取消订单|付款倒计时|支付倒计时)/.test(t)))return null;
  const buttons=lines.filter(n=>n.bounds[1]>ocr.height*.55&&/^(?:立即支付|去支付|提交订单|确认下单)/.test(compact(n.text)));
  if(!buttons.length)return null;
  if(!text.some(t=>/^(?:订单确认|确认订单|结算|填写订单)$/.test(t)))return null;
  if((plan.requestedSpecifications||[]).some(spec=>!text.some(value=>value===compact(spec)||value==='规格:'+compact(spec)||value==='已选:'+compact(spec)||value==='型号:'+compact(spec))))return null;
  const query=compact(plan.query).replace(/^(?:一份|1份|一杯|1杯)/,'');
  const quantities=lines.flatMap(n=>[...compact(n.text).matchAll(/(?:[x×✕]|数量[:：]?)(\d{1,2})(?!\d)|共(\d{1,2})(?:件|份|杯|个)/gi)].map(m=>({line:n,value:Number(m[1]||m[2])})));
  const itemQuantities=plan.allowTopUp?quantities.filter(row=>!/^共\d/.test(compact(row.line.text))):quantities;
  const qty=itemQuantities.find(row=>lines.some(line=>compact(line.text).includes(query)&&Math.abs(line.bounds[1]-row.line.bounds[1])<=ocr.height*.12))||itemQuantities[0];
  const metadata=/^(?:[x×✕]\d+|数量[:：]?\d+|共\d+(?:件|份|杯|个)|[¥￥]?\d+(?:\.\d+)?|默认|普通|标准|正常|单人份|一人份|不辣|微辣|少辣|中辣|正常辣|小份|中份|大份|中杯|大杯|小杯|冰|热|少冰|去冰|无糖|少糖|标准甜|不另外加糖|规格[:：].*|口味[:：].*|温度[:：].*)$/;
  const candidates=qty?lines.filter(n=>n.bounds[1]<ocr.height*.82&&Math.abs((n.bounds[1]+n.bounds[3]-qty.line.bounds[1]-qty.line.bounds[3])/2)<=ocr.height*.12&&!metadata.test(compact(n.text))&&!/(?:店|店铺|商家|门店|餐厅)(?:[（(].*[）)])?$/.test(compact(n.text))).sort((a,b)=>Math.abs(a.bounds[1]-qty.line.bounds[1])-Math.abs(b.bounds[1]-qty.line.bounds[1])):[];
  const item=candidates[0];
  if(!item||!compact(item.text).includes(query))return null;
  // More than one line item is ambiguous; never silently hand off a polluted cart.
  if(!plan.allowTopUp&&(quantities.length!==1||quantities[0].value!==plan.quantity))return null;
  let cartItems=null;
  if(plan.allowTopUp){
    if(!itemQuantities.length||itemQuantities.length>20)return null;
    cartItems=itemQuantities.map(row=>{
      const candidates=lines.filter(n=>n.bounds[1]<ocr.height*.82&&Math.abs(n.bounds[1]-row.line.bounds[1])<=ocr.height*.1&&!metadata.test(compact(n.text))&&!/(?:店|店铺|商家|门店|餐厅)$/.test(compact(n.text))&&!/^(?:实付|应付|合计|总计|配送|包装|优惠|商品金额|运费)/.test(compact(n.text))&&!/^[¥￥]/.test(compact(n.text)))
        .sort((a,b)=>Math.abs(a.bounds[1]-row.line.bounds[1])-Math.abs(b.bounds[1]-row.line.bounds[1]));
      const title=candidates[0];return title?{item:title.text.replace(/[x×✕]\s*\d{1,2}\s*$/i,''),quantity:row.value}:null;
    });
    if(cartItems.some(row=>!row||!Number.isSafeInteger(row.quantity)||row.quantity<1||row.quantity>20))return null;
    if(cartItems.filter(row=>compact(row.item).includes(query)).reduce((sum,row)=>sum+row.quantity,0)<plan.quantity)return null;
  }
  const rowAmount=n=>{const direct=amount(n.text);if(direct!==null)return direct;const y=(n.bounds[1]+n.bounds[3])/2;const nearby=lines.filter(m=>Math.abs((m.bounds[1]+m.bounds[3])/2-y)<Math.max(24,n.bounds[3]-n.bounds[1])&&m.bounds[1]>ocr.height*.55).map(m=>amount(m.text)).filter(v=>v!==null);return new Set(nearby).size===1?nearby[0]:null;};
  const paid=buttons.map(rowAmount).filter(n=>n!==null&&n!==undefined);
  const totals=lines.filter(n=>n.bounds[1]>ocr.height*.55&&/^(?:实付|应付|合计|总计)/.test(compact(n.text))).map(rowAmount).filter(n=>n!==null&&n!==undefined);
  const values=[...paid,...totals];
  if(!values.length||new Set(values).size!==1||plan.maxTotalFen!==null&&plan.maxTotalFen!==undefined&&values[0]>plan.maxTotalFen)return null;
  return {platform:plan.platform,item:item.text,quantity:cartItems?cartItems.filter(row=>compact(row.item).includes(query)).reduce((sum,row)=>sum+row.quantity,0):plan.quantity,totalFen:values[0],paymentStatus:'not_submitted',...(cartItems?{items:cartItems}:{})};
}
// Recognizing the handoff page is sufficient. Parsed line items are advisory.
export function checkoutHandoff(observation,plan){
 const ocr=observation?.ocr;if(!ocr?.lines?.length)return null;
 const age=Date.now()-observation.at,state=nativeState(observation);
 if(!Number.isFinite(age)||age< -1000||age>45000||!['stable','fresh'].includes(observation.stability)||observation.stabilityScope==='navigation'||!state||state.display!=='main'||!(state.foreground===state.windowPkg||state.foreground?.startsWith(state.windowPkg+'/'))||plan&&!platformPackageMatches(plan.platform,state.windowPkg))return null;
 const lines=ocr.lines.filter(line=>typeof line.text==='string'),text=lines.map(line=>compact(line.text));
 if(text.some(value=>/收银台|支付密码|输入密码|验证码|指纹|人脸验证|支付成功|付款成功/.test(value)))return null;
 if(!lines.some(line=>line.bounds?.[1]>ocr.height*.5&&/^(?:提交订单|立即支付|去支付|确认下单)/.test(compact(line.text))))return null;
 const strict=plan?inspectCheckout(ocr,plan):null;
 const total=lines.filter(line=>/^(?:实付|应付|合计|总计)/.test(compact(line.text))).map(line=>amount(line.text)).find(value=>value!==null);
 return {...(strict||{}),page:'checkout',paymentStatus:'not_submitted',verified:!!strict,
   totalFen:strict?.totalFen??total??null,item:strict?.item??null,quantity:strict?.quantity??null,
   warning:strict?null:'商品、数量和金额未全部自动核实，请以手机确认订单页为准。',
   evidenceId:observation.id,verifiedAt:new Date(observation.at).toISOString()};
}
export function verifyCheckout({observation,taskId,evidence,plan}){
 requireValue(observation?.taskId===taskId&&evidence.includes(observation.id)&&Number.isFinite(observation.at)&&Date.now()-observation.at>=-1000&&Date.now()-observation.at<45000,'请使用最新手机观察核验结算页');
 requireValue(!plan||platformPackageMatches(plan.platform,nativeState(observation)?.windowPkg),'结算前台应用与本任务不一致');
 const facts=checkoutHandoff(observation,plan);
 if(!facts)throw new AppError('checkout_unverified','尚未到确认订单页',409);
 return facts;
}
