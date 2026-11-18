// Geometry proves a search/navigation control, never task authority or typing focus.
const compact=text=>String(text||'').replace(/\s+/g,'');
const unsafe=/(支付|付款|下单|提交|购买|抢购|加购|加入|结算|确认|订阅|开通|领取|删除|发送|预订|红包|领券|密码|验证码|登录|地址|授权|同意|自取|购物车|客服|聊天)/;
const nav=/^(?:闪购|淘宝闪购|闪购外卖|淘宝闪购外卖|外卖|搜索|搜索栏|搜索框|返回|取消)$/;
const plain=text=>compact(text).replace(/[［］\[\]【】、·•]/g,'');
const centerY=line=>(line.bounds[1]+line.bounds[3])/2;
function unique(lines,score=()=>0){
 const groups=[],overlap=(a,b)=>Math.min(a.bounds[2],b.bounds[2])>Math.max(a.bounds[0],b.bounds[0])&&Math.min(a.bounds[3],b.bounds[3])>Math.max(a.bounds[1],b.bounds[1]);
 for(const line of lines){const touching=groups.filter(group=>group.some(other=>overlap(line,other)));if(!touching.length)groups.push([line]);else{for(const group of touching)groups.splice(groups.indexOf(group),1);groups.push([line,...touching.flat()]);}}
 return groups.length===1?groups[0].sort((a,b)=>score(b)-score(a))[0]:null;
}
export function sameSearchHeaderLine(a,b,tolerance=4){return !!a&&!!b&&compact(a.text)===compact(b.text)&&a.bounds.every((value,index)=>Math.abs(value-b.bounds[index])<=tolerance);}
export function taobaoSearchHeader(ocr){
 const empty={button:null,inputField:null,resultField:null,stripField:null,focusFields:[]};
 if(!ocr||!Number.isFinite(ocr.width)||!Number.isFinite(ocr.height)||!Array.isArray(ocr.lines))return empty;
 const top=ocr.lines.filter(line=>typeof line?.text==='string'&&Array.isArray(line.bounds)&&line.bounds.length===4&&line.bounds.every(Number.isFinite)&&line.bounds[0]>=0&&line.bounds[1]>=ocr.height*.04&&line.bounds[3]<=ocr.height*.12&&line.bounds[2]<=ocr.width&&line.bounds[2]>line.bounds[0]&&line.bounds[3]>line.bounds[1]&&!unsafe.test(compact(line.text)));
 const button=unique(top.filter(line=>compact(line.text)==='搜索'&&line.bounds[0]>ocr.width*.7));
 const field=unique(top.filter(line=>/^(?:全部|商品|商家|店铺)/.test(compact(line.text))&&line.bounds[0]<ocr.width*.65&&(!button||line.bounds[0]<button.bounds[0]&&Math.abs(centerY(line)-centerY(button))<32)),line=>compact(line.text).length);
 let stripField=null;
 if(button&&!field){
  const scopes=top.filter(line=>/^(?:闪购|淘宝闪购|闪购外卖|淘宝闪购外卖|外卖)$/.test(plain(line.text))&&line.bounds[0]<ocr.width*.45&&Math.abs(centerY(line)-centerY(button))<32);
  const flashes=scopes.filter(line=>plain(line.text)!=='外卖'),pool=flashes.length?flashes:scopes;
  const left=pool.length?Math.min(...pool.map(line=>line.bounds[0])):null;
  const scope=unique(pool.filter(line=>line.bounds[0]<=left+4),line=>1000-(line.bounds[2]-line.bounds[0]));
  if(scope)stripField=unique(top.filter(line=>!nav.test(plain(line.text))&&compact(line.text).length>=2&&line.bounds[0]>=scope.bounds[2]-4&&line.bounds[2]<button.bounds[0]-16&&Math.abs(centerY(line)-centerY(button))<32),line=>compact(line.text).length);
 }
 const discovery=ocr.lines.some(line=>typeof line?.text==='string'&&/^(?:搜索发现|搜索历史|历史搜索|猜你想搜|热门搜索|搜索建议)/.test(compact(line.text))&&Array.isArray(line.bounds)&&line.bounds[1]>=ocr.height*.1&&line.bounds[3]<ocr.height*.6);
 const plainField=button&&!field&&!stripField&&discovery?unique(top.filter(line=>!nav.test(plain(line.text))&&compact(line.text).length>=1&&line.bounds[0]>=ocr.width*.1&&line.bounds[2]<button.bounds[0]-16&&Math.abs(centerY(line)-centerY(button))<32),line=>compact(line.text).length):null;
 const inputField=field||plainField;
 return {button,inputField:button?inputField:null,resultField:button?null:field,stripField,plainField,focusFields:[field,stripField,plainField].filter(Boolean)};
}
export function searchHeaderTarget(ocr,target){return taobaoSearchHeader(ocr).focusFields.some(line=>sameSearchHeaderLine(line,target));}
