const compact=v=>String(v||'').normalize('NFKC').replace(/\s+/g,'');
// A dismiss-only path for the Samsung warning seen during real tests. It
// grants one Back navigation, never the button that changes USB settings.
export function usbDebugWarning(ocr){
 const lines=(ocr?.lines||[]).filter(l=>typeof l.text==='string'&&Array.isArray(l.bounds)),h=ocr?.height;if(!h)return false;
 const texts=lines.map(l=>compact(l.text));
 return texts.includes('支付安全')&&texts.some(t=>/^关闭USB调试来提升支付安全性[。.]?$/.test(t))&&['忽略','关闭'].every(t=>lines.some(l=>compact(l.text)===t&&l.bounds[1]>h*.55));
}
