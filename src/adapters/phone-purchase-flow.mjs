// These are hints from the current visible frame, never new action authority.
const compact=v=>String(v||'').normalize('NFKC').replace(/\s+/g,'');
export function purchaseFlow(ocr){
 const lines=(ocr?.lines||[]).filter(l=>typeof l.text==='string'&&Array.isArray(l.bounds)),h=ocr?.height;if(!h)return null;
 const texts=lines.map(l=>compact(l.text));
 const footer=re=>lines.filter(l=>l.bounds[1]>h*.6&&re.test(compact(l.text))).map(l=>({targetId:l.id,text:l.text}));
 if(texts.some(t=>/^(?:确认订单|订单确认|填写订单)$/.test(t)))return {stage:'checkout',next:'read_full_then_handoff',instruction:'核对商品、数量与总价后交还用户，不点击提交订单或支付。'};
 const buy=footer(/^(?:立即购买|领券购买|立即买|马上购买)$/),add=footer(/^(?:加入购物车|确认加入购物车)$/);
 const spec=texts.some(t=>/^(?:规格|选择规格|购买数量|数量|颜色分类|颜色|尺码|型号|温度|杯型|口味)$/.test(t));
 if(spec)return {stage:'specification',next:'select_options_and_confirm',visibleBuyTargets:buy,instruction:'这是规格或数量选择阶段；选择匹配规格和数量后使用当前面板确认按钮，不能把打开面板当成已经加购或结算。'};
 if(buy.length)return {stage:'product',next:'buy_now',visibleBuyTargets:buy,instruction:'普通商品详情优先使用当前购买入口，再选规格到确认订单。不要只加购物车后结束，也不在本页反复请求full观察。'};
 if(texts.some(t=>/购物车/.test(t))&&footer(/^(?:去结算|结算)(?:[（(]\d+[）)])?$/).length)return {stage:'cart',next:'select_requested_item_and_checkout',instruction:'只核对并选中本次商品、数量后去结算；不要重复加购或清空原购物车。'};
 return {stage:add.length?'delivery_or_product':'browsing',next:'continue_from_visible_controls'};
}
