import {semanticPurchase} from '../core/semantic-purchase.mjs';
import {isTaskContinuation} from '../core/task-continuation.mjs';
import {taskCheckoutPlan,hasDirectMealRequest,hasDirectPurchaseRequest,checkoutQueryFromPrompt} from '../core/checkout.mjs';

import {commercePlatform,platformPackageMatches} from '../core/commerce-platforms.mjs';
import {validateTaskContract} from '../core/task-contract.mjs';
import {classifyPddPurchase} from './pdd-purchase.mjs';
const compact=text=>String(text||'').normalize('NFKC').replace(/\s+/g,'');
const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const protectedText=/(?:支付密码|验证码|会员|优惠券|红包|领券|开通|订阅|登录|授权|收货地址|收货信息|确认订单|订单确认|提交订单|确认下单|立即支付|去支付|收银台|订单号|私信|聊天)/;
const prohibitedControl=/(?:支付|付款|提交|下单|购买|抢购|删除|清空|领取|领券|会员|优惠|开通|订阅|地址|授权|同意|登录|客服|发送)/;
const addOne=/^(?:\+|加一份|加1份|加一杯|加1杯|加一件|加1件)$/;
const addSelected=/^(?:加入购物车|确认加入购物车)$/;
const confirmSpec=/^(?:确定|确认规格|选好了)$/;
const checkout=/^(?:去结算|结算)(?:[（(]\d{1,2}[）)])?$/;
const cartRead=/^(?:购物车|查看购物车|已选商品)$/;
const incidentalBenefit=/(?:领券|领取优惠券|优惠券|红包|会员福利|会员活动|会员价|会员专享)/;
const metadata=/^(?:数量[：:]?\d{1,2}(?:份|杯|件)?|[x×✕]\d{1,2}|\d{1,2}|[¥￥]?\d+(?:\.\d+)?|默认|普通|标准|正常|单人份|一人份|不辣|微辣|少辣|中辣|正常辣|小份|中份|大份|中杯|大杯|小杯|冰|热|少冰|去冰|无糖|少糖|标准甜|不另外加糖|规格|选择规格|选规格|数量|口味|温度|杯型|糖度|已选商品|购物车|默认规格|商品详情|商品|详情|[＋+−-])$/;
const merchant=/(?:店|店铺|商家|门店|餐厅)(?:[（(].*[）)])?$/;
function native(observation){
  for(const item of observation?.tree?.content||[])try{const data=JSON.parse(item.text);if(item.type==='text'&&data.ok===true&&typeof data.result?.tree==='string')return data.result;}catch{}
  return null;
}
function itemTerms(query){
  const full=compact(query).replace(/^(?:一杯|1杯|一份|1份)/,'');
  const beverage=/^[冰热].*(?:美式|拿铁|咖啡|茶|可可|牛奶|果汁|奶昔)$/.test(full);
  return {full,base:beverage?full.slice(1):full,temperature:beverage?full[0]:null};
}
// The API passes this task object; model reasons and page text are never inputs.
export function preparationGrant(task,{store}={}){
  if(task?.taskContract){const checked=validateTaskContract(task,{store});if(!checked.valid||checked.contract.intent!=='task'||!checked.contract.effects.includes('prepare_purchase')||checked.contract.effects.some(effect=>!['read','navigate','prepare_purchase','submit_order'].includes(effect)))return null;}
  if(!task||typeof task.id!=='string'||task.source&&task.source!=='user'||task.parentId||(task.depth||0)>0)return null;
  if(!['running','waiting_approval'].includes(task.status))return null;
  const users=(task.messages||[]).filter(item=>item.role==='user');
  const message=users.at(-1),text=compact(message?.content);
  const plan=taskCheckoutPlan(task);
  if(!message||message.externalContent||message.external_content||!text||!plan||plan.goal!=='checkout'||plan.payment!=='user'||!commercePlatform(plan.platform))return null;
  const interpreted=semanticPurchase(task);
  const query=compact(task.phoneQuery?.query);
  if(query.length<1||query.length>80||!interpreted&&(query.length<2||prohibitedControl.test(query)||protectedText.test(query)))return null;
  if(!interpreted&&/(?:只|仅)(?:查|搜|比较|比价)|(?:不要|不用|禁止|别|不允许).{0,5}(?:点|买|准备|加购|加入购物车|结算)|(?:替我|帮我|自动|直接|完成)(?:付|支付)|(?:网页|页面|广告|商家|模型|助理|知识库).{0,12}(?:说|显示|要求|建议|指示)|(?:引用|转述|粘贴)/.test(text))return null;
  const direct=!!interpreted||hasDirectMealRequest(message.content,query)||hasDirectPurchaseRequest(message.content,query);
  let originMessageId=message.id||null;
  if(!direct&&isTaskContinuation(message.content)&&task.taskContract?.source?.originMessageId){
    const origin=users.find(item=>item.id===task.taskContract.source.originMessageId);
    if(!origin||!(hasDirectMealRequest(origin.content,query)||hasDirectPurchaseRequest(origin.content,query)))return null;
    originMessageId=origin.id;
  }else if(!direct){
    if(!new RegExp('(?:换成|改成|改为).{0,20}'+escape(query)).test(text))return null;
    let previous=null;
    for(const prior of [...users.slice(0,-1)].reverse()){
      const source=compact(prior.content);
      if(/(?:取消|停止|不用了|只查|只搜|只比较|仅查|仅比较)/.test(source))break;
      if(prior.externalContent||prior.external_content||/(?:网页|页面|广告|商家|模型|助理|知识库).{0,12}(?:说|显示|要求|建议|指示)|(?:引用|转述|粘贴)|(?:不要|不用|禁止|别|不允许).{0,5}(?:点|买|订|准备|加购|加入购物车|结算)|(?:替我|帮我|自动|直接|完成)(?:付|支付)/.test(source))continue;
      const oldQuery=checkoutQueryFromPrompt(prior.content)?.query;
      const explicitBuy=oldQuery&&hasDirectPurchaseRequest(prior.content,oldQuery);
      if(oldQuery&&(hasDirectMealRequest(prior.content,oldQuery)||explicitBuy)){previous=prior;break;}
    }
    if(!previous)return null;
    originMessageId=previous.id||null;
  }
  const optionSource=isTaskContinuation(message.content)&&originMessageId?compact(users.find(item=>item.id===originMessageId)?.content):text;
  const remaining=optionSource.replaceAll(query,'');
  const requestedOptions=[...new Set([...(remaining.match(/不辣|微辣|少辣|中辣|正常辣|大杯|中杯|小杯|少冰|去冰|无糖|少糖|半糖/g)||[]),...(plan.requestedSpecifications||[])])];
  return {taskId:task.id,sourceMessageId:message.id||null,originMessageId,platform:plan.platform,query:task.phoneQuery.query,
    quantity:plan.quantity,maxTotalFen:plan.maxTotalFen,...(plan.allowTopUp?{allowTopUp:true}:{}),payment:'user',goal:'checkout',authority:'prepare_only',requestedOptions};
}
const centerY=line=>(line.bounds[1]+line.bounds[3])/2;
const amount=text=>{const matches=[...compact(text).matchAll(/[¥￥](\d{1,6}(?:\.\d{1,2})?)(?![\d.])/g)];return matches.map(match=>Math.round(Number(match[1])*100));};
function quantityRows(lines){
  return lines.flatMap(line=>[...compact(line.text).matchAll(/(?:[x×✕]|数量[：:]?)(\d{1,2})(?!\d)(?:份|杯|件)?/gi)].map(match=>({line,value:Number(match[1])})));
}
function quantityNearTarget(lines,target,height){
  const quantities=quantityRows(lines);
  if(quantities.length===1)return quantities[0];
  if(quantities.length)return null;
  // A plain numeric stepper is accepted only when bracketed by +/- on its row.
  const numbers=lines.filter(line=>/^\d{1,2}$/.test(compact(line.text))&&Math.abs(centerY(line)-centerY(target))<height*.035);
  const minus=lines.filter(line=>/^(?:-|−|减一份|减1份)$/.test(compact(line.text))&&Math.abs(centerY(line)-centerY(target))<height*.035);
  if(numbers.length!==1||minus.length!==1||minus[0].bounds[2]>=numbers[0].bounds[0]||numbers[0].bounds[2]>=target.bounds[0])return null;
  return {line:numbers[0],value:Number(compact(numbers[0].text))};
}
function selectedQuantity(lines,height){
  const explicit=quantityRows(lines);
  if(explicit.length===1)return explicit[0];
  if(explicit.length)return null;
  const steppers=lines.filter(line=>/^\+$/.test(compact(line.text))).map(target=>quantityNearTarget(lines,target,height)).filter(Boolean);
  return steppers.length===1?steppers[0]:null;
}
function titleNear(lines,anchor,height,{maxDistance=.1}={}){
  const candidates=lines.filter(line=>line!==anchor&&line.bounds[1]<height*.82&&
    Math.abs(centerY(line)-centerY(anchor))<=height*maxDistance&&!metadata.test(compact(line.text))&&
    !merchant.test(compact(line.text))&&!amount(line.text).length&&!prohibitedControl.test(compact(line.text))&&
    !/^(?:预计|配送|包装|餐具|已选|合计|应付|实付|共\d|购物车为空|尚未选购|未选购商品|暂无商品)/.test(compact(line.text)))
    .sort((a,b)=>Math.abs(centerY(a)-centerY(anchor))-Math.abs(centerY(b)-centerY(anchor)));
  return candidates.length&&(!candidates[1]||Math.abs(centerY(candidates[0])-centerY(anchor))!==Math.abs(centerY(candidates[1])-centerY(anchor)))?candidates[0]:null;
}
function validItem(title,terms,texts){
  const label=compact(title?.text);
  if(!label||!label.includes(terms.base))return false;
  if(terms.temperature&&!label.includes(terms.full)&&!texts.some(text=>new RegExp('^(?:温度|已选温度|规格)[：:]'+terms.temperature+'$|^'+terms.temperature+'[（(](?:已选|已选中)[）)]$').test(text)))return false;
  return true;
}
function within(point,bounds){return point.x>=bounds[0]&&point.x<bounds[2]&&point.y>=bounds[1]&&point.y<bounds[3];}
function nativeTargetSafe(state,target){
  const point=target.center;
  if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y)||!within(point,target.bounds))return false;
  const nodes=state.tree.split('\n').flatMap(line=>{const match=line.match(/bounds=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);return match&&/clickable|editable/.test(line)&&!line.includes('offscreen')?[{line,bounds:match.slice(1).map(Number)}]:[];});
  const hit=nodes.filter(node=>within(point,node.bounds));
  if(hit.some(node=>/password|editable/i.test(node.line)||[...node.line.matchAll(/"([^"\n]+)"/g)].some(match=>prohibitedControl.test(compact(match[1])))))return false;
  const smallest=hit.sort((a,b)=>(a.bounds[2]-a.bounds[0])*(a.bounds[3]-a.bounds[1])-(b.bounds[2]-b.bounds[0])*(b.bounds[3]-b.bounds[1]))[0];
  const labels=smallest?[...smallest.line.matchAll(/"([^"\n]+)"/g)].map(match=>compact(match[1])):[];
  return !labels.length||labels.every(label=>label===compact(target.text));
}
function budgetFits(lines,anchor,grant,height,multiplier=1){
  if(conditionalPriceNear(lines,anchor,height))return false;
  if(grant.maxTotalFen===null||grant.maxTotalFen===undefined)return true;
  const values=lines.filter(line=>Math.abs(centerY(line)-centerY(anchor))<=height*.08).flatMap(line=>amount(line.text));
  return new Set(values).size===1&&values[0]*multiplier<=grant.maxTotalFen;
}

function protectedPage(lines,height){
  const texts=lines.map(line=>compact(line.text));
  if(texts.some(text=>/(?:支付密码|输入密码|验证码|订单号|付款倒计时|支付倒计时)/.test(text)||
    /^(?:收货地址|选择收货地址|管理收货地址|收货信息|登录|验证码登录|账密登录|授权|安全验证|身份验证|私信|聊天|确认订单|订单确认|提交订单|确认下单|立即支付|去支付|确认付款|确认支付|收银台|待付款|订单详情|支付成功|付款成功)(?:[：:]|[¥￥]|$)/.test(text)))return true;
  if(texts.some(text=>/^(?:确认开通|确认订阅|确认领取|同意并开通|同意并订阅|已选会员|已选择会员|已勾选会员|已选付费权益)/.test(text)))return true;
  return lines.some(line=>line.bounds[1]<height*.35&&/^(?:会员中心|我的会员|开通会员|订阅会员|购买会员|选择优惠券|我的优惠券|红包卡券|会员开通|权益确认)$/.test(compact(line.text)));
}
function conditionalPriceNear(lines,anchor,height){
  return lines.some(line=>Math.abs(centerY(line)-centerY(anchor))<=height*.08&&
    /(?:会员价|会员专享|仅会员|需(?:要)?开通|开通.{0,10}(?:享|优惠)|需购买会员|付费权益|付费会员)/.test(compact(line.text)));
}
function usableSpecPrices(lines,terms,texts,height){
  return lines.filter(line=>line.bounds[1]<height*.7&&amount(line.text).length&&
    (!incidentalBenefit.test(compact(line.text))||validItem(titleNear(lines,line,height),terms,texts)));
}

export function classifyPreparationAction(taskId,args,observation,grant){
  if(!grant||grant.taskId!==taskId||grant.authority!=='prepare_only'||grant.goal!=='checkout'||grant.payment!=='user'||!commercePlatform(grant.platform))return null;
  if(observation?.taskId!==taskId||observation.id!==args?.observationId||observation.stability!=='stable'||observation.stabilityScope!=='full'||!Number.isFinite(observation.at)||Date.now()-observation.at>15000||observation.at>Date.now()+1000)return null;
  if(!['tap','back'].includes(args.action)||['x','y','text','inputMode'].some(key=>Object.hasOwn(args,key)))return null;
  if(args.action==='tap'&&typeof args.textTargetId!=='string'||args.action==='back'&&Object.hasOwn(args,'textTargetId'))return null;
  const state=native(observation),ocr=observation.ocr;
  if(!state||state.display!=='main'||!platformPackageMatches(grant.platform,state.windowPkg)||!(state.foreground===state.windowPkg||String(state.foreground).startsWith(state.windowPkg+'/'))||!ocr||!Array.isArray(ocr.lines)||!Number.isFinite(ocr.width)||!Number.isFinite(ocr.height)||ocr.width<=0||ocr.height<=0)return null;
  const PKG=state.windowPkg;
  if(state.tree.split('\n').filter(line=>line.startsWith('window ')).some(line=>{const pkg=line.match(/pkg=(\S+)/)?.[1];return pkg&&![PKG,'com.android.systemui'].includes(pkg);}))return null;
  const lines=ocr.lines.filter(line=>typeof line.text==='string'&&Array.isArray(line.bounds)&&line.bounds.length===4&&line.bounds.every(Number.isFinite));
  if(lines.length!==ocr.lines.length)return null;
  const texts=lines.map(line=>compact(line.text));
  if(protectedPage(lines,ocr.height)||/password/i.test(state.tree))return null;
  const cart=lines.some(line=>compact(line.text)==='已选商品'||compact(line.text)==='购物车'&&line.bounds[1]<ocr.height*.35);
  const quantities=quantityRows(lines);
  if(args.action==='back')return cart?{kind:'prepare_cart_back',phase:'cart',cartItemCount:quantities.length}:null;
  const targets=lines.filter(line=>line.id===args.textTargetId);if(targets.length!==1)return null;
  const target=targets[0],label=compact(target.text),terms=itemTerms(grant.query);
  const pdd=classifyPddPurchase(args,state,ocr,grant);if(pdd)return pdd;
  if(!terms.base||!nativeTargetSafe(state,target))return null;
  if(cartRead.test(label)){
    const food=texts.some(text=>/^(?:闪购|淘宝闪购|闪购外卖|淘宝闪购外卖|外卖|点餐|配送|配送费|预计.*送达)(?:[：:]|[¥￥]|$)/.test(text));
    const item=lines.find(line=>!merchant.test(compact(line.text))&&!protectedText.test(compact(line.text))&&validItem(line,terms,texts));
    return (food||commercePlatform(grant.platform)?.kind==='shopping')&&item?{kind:'prepare_cart_read',phase:cart?'cart':'product',item:item.text}:null;
  }
  if(!Number.isSafeInteger(grant.quantity)||grant.quantity<1||grant.quantity>20)return null;
  const specificationPage=texts.some(text=>/^(?:规格|选择规格|杯型|温度|口味|糖度|颜色|尺码|型号)$/.test(text));
  if(specificationPage&&(grant.requestedOptions||[]).some(option=>compact(option)===label)&&lines.some(line=>validItem(line,terms,texts))&&!prohibitedControl.test(label))return {kind:'prepare_spec_selection',phase:'spec',option:label};
  if((grant.requestedOptions||[]).some(option=>!texts.some(text=>text===option+'(已选中)'||text===option+'（已选中）'||new RegExp('^(?:规格|型号|颜色|尺码|口味|杯型|糖度|温度|已选)[：:]'+escape(option)+'$').test(text))))return null;
  const empty=texts.some(text=>/^(?:购物车为空|尚未选购(?:商品)?|未选购商品|暂无商品|已选0(?:件|份|杯)|共0(?:件|份|杯))$/.test(text));
  const spec=specificationPage;
  if(empty&&!spec&&quantities.length)return null; // contradictory empty/mixed-cart evidence
  if(checkout.test(label)){
    if(!cart||quantities.length!==1||quantities[0].value!==grant.quantity)return null;
    const title=titleNear(lines,quantities[0].line,ocr.height);
    if(!validItem(title,terms,texts))return null;
    const totalLines=lines.filter(line=>line.bounds[1]>ocr.height*.65&&/^(?:合计|应付|实付|总计)/.test(compact(line.text)));
    if(totalLines.some(line=>conditionalPriceNear(lines,line,ocr.height)))return null;
    const totals=totalLines.flatMap(line=>amount(line.text));
    if(grant.maxTotalFen!==null&&(new Set(totals).size!==1||totals[0]>grant.maxTotalFen))return null;
    return {kind:'prepare_checkout',phase:'cart',item:title.text,quantity:grant.quantity};
  }
  if(addOne.test(label)){
    if(cart){
      if(quantities.length!==1||quantities[0].value>=grant.quantity)return null;
      const title=titleNear(lines,quantities[0].line,ocr.height);
      if(!validItem(title,terms,texts)||Math.abs(centerY(target)-centerY(quantities[0].line))>ocr.height*.06||!budgetFits(lines,quantities[0].line,grant,ocr.height,grant.quantity))return null;
      return {kind:'prepare_add_one',phase:'cart',item:title.text,quantityBefore:quantities[0].value,quantityAfter:quantities[0].value+1};
    }
    const count=spec?quantityNearTarget(lines,target,ocr.height):null;
    if(spec&&!count||spec&&(count.value>=grant.quantity||Math.abs(centerY(target)-centerY(count.line))>ocr.height*.035||target.bounds[0]<=count.line.bounds[2])||!spec&&!empty)return null;
    const anchor=spec?usableSpecPrices(lines,terms,texts,ocr.height)[0]:target;
    if(!anchor)return null;
    const title=titleNear(lines,anchor,ocr.height);
    if(!validItem(title,terms,texts)||!budgetFits(lines,anchor,grant,ocr.height,grant.quantity))return null;
    return {kind:'prepare_add_one',phase:spec?'spec':'product',item:title.text,quantityBefore:count?.value||0,quantityAfter:(count?.value||0)+1};
  }
  if(addSelected.test(label)||confirmSpec.test(label)){
    const count=selectedQuantity(lines,ocr.height);
    if(!spec||!empty||!count||count.value!==grant.quantity)return null;
    const prices=usableSpecPrices(lines,terms,texts,ocr.height);
    if(prices.length!==1||amount(prices[0].text).length!==1)return null;
    const title=titleNear(lines,prices[0],ocr.height);
    if(!validItem(title,terms,texts)||!budgetFits(lines,prices[0],grant,ocr.height,grant.quantity))return null;
    return {kind:'prepare_add_selected',phase:'spec',item:title.text,quantity:grant.quantity};
  }
  return null;
}
