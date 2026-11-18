// PDD has no conventional cart in many flows. The two ambiguous purchase
// controls are usable only when native accessibility explicitly exposes their
// next step. Their labels alone are never a promise that no order is created.
const compact=v=>String(v??'').normalize('NFKC').replace(/\s+/g,'');
const money=v=>{const m=compact(v).match(/^(?:单独购买价|单买价)[：:]?[¥￥](\d+(?:\.\d{1,2})?)$/);return m?Math.round(Number(m[1])*100):null;};
function nodes(tree){return String(tree).split('\n').flatMap(line=>{const b=line.match(/bounds=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);return !b||/offscreen|disabled|password/.test(line)?[]:[{line,bounds:b.slice(1).map(Number),labels:[...line.matchAll(/"([^"\n]*)"/g)].map(m=>m[1]),clickable:/\bclickable\b/.test(line.replace(/"[^"\n]*"/g,''))}];});}
export function classifyPddPurchase(args,state,ocr,grant){
 if(grant.platform!=='pinduoduo'||state.windowPkg!=='com.xunmeng.pinduoduo'||args.action!=='tap')return null;
 const rows=nodes(state.tree),values=rows.flatMap(n=>n.labels).map(compact),refs=ocr.lines.filter(l=>l.id===args.textTargetId);if(refs.length!==1)return null;
 const point=refs[0].center,label=compact(refs[0].text),hit=rows.filter(n=>n.clickable&&point.x>=n.bounds[0]&&point.x<n.bounds[2]&&point.y>=n.bounds[1]&&point.y<n.bounds[3]).sort((a,b)=>(a.bounds[2]-a.bounds[0])*(a.bounds[3]-a.bounds[1])-(b.bounds[2]-b.bounds[0])*(b.bounds[3]-b.bounds[1]))[0];
 if(!hit?.labels.some(v=>compact(v)===label)||values.some(v=>/免密|先用后付|自动支付|自动扣款|一键付款|确认订单|订单号|待付款|支付密码|确认下单|提交订单|参团|发起拼单/.test(v)&&!/^下一步[：:]确认订单$/.test(v)))return null;
 const titles=rows.filter(n=>n.labels.some(v=>compact(v)===compact(grant.query)));if(titles.length!==1)return null;
 const prices=values.map(money).filter(v=>v!==null);if(prices.length!==1||prices[0]<=0||grant.maxTotalFen!==null&&prices[0]*grant.quantity>grant.maxTotalFen)return null;
 if(label==='单独购买'&&values.includes('商品详情')&&hit.labels.some(v=>/^(?:选择规格|先选规格|单独购买，选择规格)$/.test(v))&&!values.includes('确认规格'))return {kind:'prepare_pdd_choose_sku',phase:'product',item:grant.query,quantity:grant.quantity,unitPriceFen:prices[0],expectedPage:'sku'};
 if(!['确定','确认规格','下一步'].includes(label)||!values.includes('确认规格')||!values.includes('购买方式:单独购买')||!values.includes('下一步:确认订单'))return null;
 const quantity=values.filter(v=>/^数量[：:]\d{1,2}$/.test(v));if(quantity.length!==1||Number(quantity[0].split(/[:：]/)[1])!==grant.quantity)return null;
 const selected=rows.filter(n=>/\bselected\b|\bchecked\b/.test(n.line.replace(/"[^"\n]*"/g,''))).flatMap(n=>n.labels).map(compact);
 const desired=(grant.requestedOptions||[]).map(compact);if(!desired.length||desired.some(v=>selected.filter(x=>x===v).length!==1)||selected.some(v=>!desired.includes(v)))return null;
 return {kind:'prepare_pdd_confirm_sku',phase:'spec',item:grant.query,quantity:grant.quantity,unitPriceFen:prices[0],specifications:desired,expectedPage:'checkout'};
}
