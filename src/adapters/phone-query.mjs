import {authorizedSearchText} from './phone-search-terms.mjs';
import {stripTopLevelRoleMentions} from '../core/role-mentions.mjs';
// A task-scoped query grant comes from the authenticated user API, never model arguments.
// Classification is based on the latest local screen, not the model's reason string.
import {AppError} from '../core/errors.mjs';
import {taobaoSearchHeader,sameSearchHeaderLine} from './phone-search-layout.mjs';
import {commercePlatform,platformPackageMatches,requestedCommercePlatform} from '../core/commerce-platforms.mjs';
const dangerous=/(支付|付款|下单|提交|购买|抢购|加购|加入|结算|选好了|确认|订阅|开通|领取|删除|发送|预订|红包|领券|授权|同意|登录|地址|自取|购物车)/;
const nav=/^(闪购|淘宝闪购|闪购外卖|淘宝闪购外卖|外卖|搜索|返回|取消|商品|商家|综合|销量|距离|价格)$/;
const options=/^(冰|热|少冰|去冰|常温|标准冰|大杯|中杯|小杯|超大杯|标准甜|不另外加糖|无糖|少糖|半糖|正常糖|无奶|默认浓度|意式拼配|默认|普通|标准|正常|单人份|一人份|不辣|微辣|少辣|中辣|正常辣)$/;
export function queryGrant(input){
 if(input==null)return null;
 if(!commercePlatform(input.platform)||typeof input.query!=='string'||!input.query.trim()||input.query.length>80)throw new AppError('invalid_input','查询范围无效');
 return {platform:input.platform,query:input.query.trim()};
}
function screen(observation){for(const c of observation?.tree?.content||[])try{const d=JSON.parse(c.text);if(d.ok&&d.result?.tree)return d.result;}catch{}return null;}
function nativeNodes(s){return s.tree.split('\n').flatMap(line=>{const b=line.match(/bounds=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);return b&&!line.includes('offscreen')?[{line,b:b.slice(1).map(Number)}]:[];});}
const within=(p,b)=>p.x>=b[0]&&p.x<b[2]&&p.y>=b[1]&&p.y<b[3];
export function classifyQueryAction(taskId,args,observation,grant){
 if(!grant||!commercePlatform(grant.platform)||!grant.query||observation?.taskId!==taskId||observation.id!==args.observationId||Date.now()-observation.at>180000)return null;
 const s=screen(observation),ocr=observation.ocr;if(!s||!platformPackageMatches(grant.platform,s.windowPkg)||!(s.foreground===s.windowPkg||String(s.foreground).startsWith(s.windowPkg+'/'))||!ocr)return null;
 const PKG=s.windowPkg;
 const windows=s.tree.split('\n').filter(l=>l.startsWith('window '));
 if(windows.some(l=>{const pkg=l.match(/pkg=(\S+)/)?.[1];return pkg&&![PKG,'com.android.systemui','com.samsung.android.honeyboard','com.google.android.inputmethod.latin','com.sohu.inputmethod.sogou'].includes(pkg);}))return null;
 const texts=ocr.lines.map(n=>n.text.replace(/\s+/g,''));
 // Transaction/account/contact pages are never a query surface, even for typing or swipes.
 if(texts.some(t=>/^(确认订单|提交订单|收银台|收货地址|选择收货地址|管理收货地址|我的地址|收货信息|支付方式|支付密码|设置支付密码|安全验证|身份验证|登录|验证码|输入验证码|短信验证码|验证码登录|账密登录|联系客服|聊天)$/.test(t)))return null;
 if(ocr.lines.some(n=>n.bounds?.[1]<ocr.height*.2&&/^购物车$/.test(n.text.replace(/\s+/g,''))))return null;
 const term=grant.query.replace(/\s+/g,'').replace(/^(一杯|1杯|一份|1份)/,'');if(term.length<2)return null;
 // A temperature can be omitted from a beverage title. Food names keep their full prefix
 // (for example 冰粉、热狗、热干面); no dish or merchant mapping is needed.
 const beverage=/^[冰热].*(?:美式|拿铁|咖啡|茶|可可|牛奶|果汁|奶昔)$/.test(term)&&term.slice(1).length>=2?term.slice(1):null;
 const matchesTerm=label=>label.includes(term)||!!beverage&&label.includes(beverage);
 const product=texts.some(matchesTerm);const nodes=nativeNodes(s);
 // Custom Taobao inputs expose the old keyword through OCR, rather than an EditText.
 // The search header identifies the input independently of the next task's food.
 const header=grant.platform==='taobao'?taobaoSearchHeader(ocr):{focusFields:[]},searchButton=header.button,searchField=header.inputField;
 const visualSearch=!!searchField;
 const isSearch=n=>/editable/.test(n.line)&&!/password/i.test(n.line)&&(/搜索|search/i.test(n.line)||visualSearch);
 if(args.action==='type'){
  const focus=nodes.filter(n=>/focused/.test(n.line)&&isSearch(n));
  return (focus.length===1||visualSearch)&&authorizedSearchText(args.text,grant.query)?{kind:'search_input'}:null;
 }
 if(args.action==='back')return {kind:'query_back'};
 if(args.action==='swipe')return [args.x1,args.x2].every(x=>x>=ocr.width*.15&&x<=ocr.width*.85)&&[args.y1,args.y2].every(y=>y>=ocr.height*.2&&y<=ocr.height*.8)&&Math.abs(args.x1-args.x2)<ocr.width*.15?{kind:'query_scroll'}:null;
 if(args.action!=='tap')return null;
 const target=args.textTargetId?ocr.lines.find(n=>n.id===args.textTargetId):null;
 const point=target?.center||{x:args.x,y:args.y};if(!Number.isFinite(point.x)||!Number.isFinite(point.y))return null;
 if(target&&dangerous.test(target.text.replace(/\s+/g,'')))return null;
 const hit=nodes.filter(n=>within(point,n.b));
 // OCR can read a short label inside a larger purchase button. Check the native hit area too.
 if(hit.some(n=>/clickable|editable/.test(n.line)&&[...n.line.matchAll(/"([^"\n]+)"/g)].some(m=>dangerous.test(m[1]))))return null;
 if(hit.some(n=>/clickable/.test(n.line)&&/"(?:搜索栏|搜索框|搜索商品|搜索商家商品|搜索美食)"/.test(n.line)))return {kind:'search_focus'};
 if(target&&header.focusFields.some(field=>sameSearchHeaderLine(field,target)))return {kind:'search_focus'};
 if(visualSearch&&point.x>=searchField.bounds[0]&&point.x<searchButton.bounds[0]-16&&point.y>=searchField.bounds[1]-12&&point.y<=searchField.bounds[3]+12)return {kind:'search_focus'};
 if(!target)return hit.some(isSearch)?{kind:'search_focus'}:null;
 const label=target.text.replace(/\s+/g,'');if(dangerous.test(label))return null;
 if(nav.test(label.replace(/[［］\[\]【】、·•]/g,'')))return {kind:'query_navigation',label};
 if(hit.some(isSearch))return {kind:'search_focus'};
 if(matchesTerm(label)&&label.length<=70)return {kind:'product_detail',label};
 const specification=product&&texts.some(t=>/杯型|温度|糖|规格/.test(t));
 if(specification&&grant.platform==='taobao'&&(options.test(label)||/^(选规格|规格|杯型|温度|糖)$/.test(label)||/^(杯型|温度|糖)[：:]?/.test(label)))return {kind:'product_spec',label};
 return null;
}

// Deterministic, narrow routing of an explicit user query; page text cannot create grants.
export function queryGrantFromPrompt(prompt){
 if(typeof prompt!=='string')return null;
 prompt=stripTopLevelRoleMentions(prompt);
 const platform=requestedCommercePlatform(prompt);if(!platform)return null;
 // Prohibitions such as “不下单不付款” constrain a query; they do not request a transaction.
 // Remove only explicit negated verbs, then refuse every remaining transaction/account verb.
 const verbs='下单|购买|抢购|付款|支付|加购|加入|提交|结算|发送|删除|开通|订阅|预订|确认订单|登录|授权|领取|领券|同意';
 const prohibitions=new RegExp('(?<![不没非能要是])(?:不要|不用|无需|禁止|别|不(?:需要|允许)?)(?:进行|实际|直接|立即|自动|替我|帮我)?(?:'+verbs+')','g');
 const request=prompt.replace(prohibitions,' ');
 if(new RegExp(verbs).test(request))return null;
 const match=request.match(/(?:搜索|搜一下|查一下|查询|查|搜)(?:一下|下)?[：:「“\"\s]*(.{2,60}?)(?:的价格|多少钱|价格|[」”\"，。；！？!?]|(?:并|然后|只)(?:查|比较|查看)|$)/);
 if(!match)return null;
 const query=match[1].trim().replace(/^(一杯|1杯|一份|1份)/,'');
 if(query.length<2||dangerous.test(query)||/(淘宝|闪购|帮我|怎么)/.test(query))return null;
 return queryGrant({platform,query});
}
