const compact=v=>String(v??'').normalize('NFKC').replace(/\s+/g,'');
const has=(nodes,value)=>nodes.some(n=>!n.editable&&n.values.includes(value));
const contexts=(nodes,label)=>nodes.filter(n=>!n.editable&&n.values.some(v=>v===label||v.startsWith(label+'：')||v.startsWith(label+':')));
const context=(nodes,label,value)=>{const rows=contexts(nodes,label);return rows.length===1&&rows[0].values.some(v=>v===value||v===label+'：'+value||v===label+':'+value||v===label+': '+value);};
const cents=value=>{const match=compact(value).match(/^(?:[¥￥])?(\d{1,6}(?:\.\d{1,2})?)(?:元)?$/);return match?Math.round(Number(match[1])*100):null;};
function amount(nodes,label,wanted,{editable=false}={}){
 const rows=nodes.filter(n=>(editable||!n.editable)&&n.values.some(v=>v===label||v.startsWith(label+'：')||v.startsWith(label+':')));
 if(rows.length!==1)return false;
 const vals=rows[0].values.map(v=>cents(v.replace(new RegExp('^'+label+'[：:]\\s*'),''))).filter(v=>v!==null);
 return vals.length===1&&vals[0]===wanted;
}
function bound(nodes,p){return context(nodes,'订单号',p.orderId)&&context(nodes,'商品',p.item)&&context(nodes,'数量',String(p.quantity));}
function safe(nodes,p){
 const values=nodes.flatMap(n=>n.values);
 if(values.some(v=>/免密|自动扣款|先用后付|保证金|违约金|授权扣款|同意.*(?:条款|协议)|银行卡|密码|验证码|预约取件/.test(v)))return false;
 const fees=contexts(nodes,'费用');return fees.length===1&&amount(nodes,'费用',p.maxFeeFen)&&!values.some(v=>/(?:手续费|服务费|运费)[：:]?\s*[¥￥]?[1-9]\d*/.test(v));
}
const matchingForm=(nodes,p)=>bound(nodes,p)&&context(nodes,'售后类型',p.operation==='refund'?'仅退款':'退货退款')&&context(nodes,'货物状态',p.goodsStatus)&&context(nodes,'退款原因',p.reason)&&amount(nodes,'退款金额',p.amountFen,{editable:true})&&context(nodes,'退款方式',p.refundMethod)&&(p.operation!=='return_refund'||context(nodes,'退货方式',p.returnMethod));
export function afterSalesPlan(contract){const p=contract?.objects?.afterSales;return p?.kind==='after_sales'&&contract.effects.includes(p.operation==='refund'?'request_refund':'return_goods')?p:null;}
export function afterSalesDialogAllowed(label,p){return p?.kind==='after_sales'&&/^(?:申请售后|申请退款|退款申请|退货申请|仅退款|退货退款|退款原因|退款金额|货物状态|退款方式|退货方式|提交申请|取消)$/.test(label);}
export function classifyAfterSalesAction(args,state,ocr,grant,nodes,hit){
 const p=grant.effectPlan;if(p.kind!=='after_sales'||nodes.some(n=>n.secret))return null;
 const decision=(kind,witness={})=>({kind,witness});
 if(args.action==='type'){
  const fields=nodes.filter(n=>n.editable&&n.focused);if(fields.length!==1||args.inputMode!=='replace'||args.textTargetId)return null;
  const f=fields[0];
  if(f.values.includes('搜索订单')&&args.text===p.orderId)return decision('effect_after_sales_order_search');
  if(!bound(nodes,p)||!safe(nodes,p))return null;
  if(f.values.includes('退款原因')&&args.text===p.reason&&f.values.every(v=>!v||v==='退款原因'||v===p.reason))return decision('effect_after_sales_reason_input');
  if(f.values.includes('退款金额')&&cents(args.text)===p.amountFen&&f.values.every(v=>!v||v==='退款金额'||cents(v)!==null))return decision('effect_after_sales_amount_input');
  return null;
 }
 if(args.action!=='tap'||!hit)return null;const {node,label}=hit;
 if(label===p.orderId&&nodes.filter(n=>n.values.includes(label)).length===1)return decision('effect_after_sales_order_open');
 if(!bound(nodes,p))return null;
 if(['申请售后','申请退款'].includes(label)&&['待发货','待收货','已完成','已收货'].filter(value=>has(nodes,value)).length===1&&!nodes.some(n=>n.values.some(v=>/退款中|售后处理中|退款成功|交易关闭/.test(v))))return decision('effect_after_sales_open');
 if(!safe(nodes,p))return null;
 if(node.editable&&node.values.some(v=>['退款金额','退款原因'].includes(v)))return decision('effect_after_sales_field_focus');
 const roles={'售后类型':p.operation==='refund'?'仅退款':'退货退款','退款原因':p.reason,'货物状态':p.goodsStatus,'退款方式':p.refundMethod,...(p.returnMethod?{'退货方式':p.returnMethod}:{})};
 for(const [role,value] of Object.entries(roles)){
  if(label===role)return decision('effect_after_sales_select_open',{field:role});
  if(label===value&&has(nodes,role)&&nodes.filter(n=>n.values.includes(value)).length===1)return decision('effect_after_sales_select',{field:role,value});
 }
 if(label==='提交申请'&&matchingForm(nodes,p)&&!has(nodes,'申请已提交'))return decision('effect_after_sales_submit',{orderId:p.orderId,item:p.item,quantity:p.quantity,amountFen:p.amountFen,operation:p.operation});
 return null;
}
export function verifyAfterSalesResult(nodes,grant,matches){
 const p=grant.effectPlan,submitted=matches.some(a=>a.phoneEffect?.kind==='effect_after_sales_submit');
 const refs=contexts(nodes,'售后单号'),reference=refs.length===1?refs[0].values.map(v=>v.replace(/^售后单号[：:]\s*/,'' )).find(v=>/^[A-Za-z0-9-]{6,64}$/.test(v)):null;
 const status=['等待商家处理','等待商家审核','待寄回'].filter(v=>has(nodes,v));
 const verified=!!submitted&&matchingForm(nodes,p)&&safe(nodes,p)&&!!reference&&has(nodes,'申请已提交')&&status.length===1&&!nodes.some(n=>n.values.some(v=>/提交中|提交失败|申请失败|金额已变更|已撤销/.test(v)));
 return {verified,kind:'after_sales_submitted',facts:verified?{orderId:p.orderId,item:p.item,quantity:p.quantity,requestedAmountFen:p.amountFen,operation:p.operation,applicationStatus:status[0],refundCompleted:false,goodsReturned:false,feeFen:0}:null,reason:'requires_exact_application_receipt_not_refund_completion'};
}
export function afterSalesSummary(facts){return `订单 ${facts.orderId} 的${facts.operation==='refund'?'仅退款':'退货退款'}申请已提交，申请金额 ¥${(facts.requestedAmountFen/100).toFixed(2)}，状态：${facts.applicationStatus}。退款尚未到账${facts.operation==='return_refund'?'，商品尚未寄回':''}。`;}
