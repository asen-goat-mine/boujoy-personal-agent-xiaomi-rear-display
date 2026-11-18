import {createHash} from 'node:crypto';
const NAVIGATION=/^(?:闪购|淘宝闪购|外卖|搜索|搜索栏|搜索框|搜索设置|返回|向上导航|取消)(?:[,，](?:未选中|已选中))?$/;
function screen(result){
  for(const c of result?.content||[]){if(c.type!=='text')continue;try{const d=JSON.parse(c.text);if(d.ok&&typeof d.result?.tree==='string')return d.result;}catch{}}
  return null;
}
function parts(s){
  let chrome=false;const lines=[],windows=[];
  for(const line of s.tree.split('\n')){
    if(line.startsWith('window ')){windows.push(line);const pkg=line.match(/pkg=(\S+)/)?.[1];chrome=pkg==='com.android.systemui'&&pkg!==s.windowPkg;}
    if(!chrome)lines.push(line);
  }
  return {windows,lines};
}
function context(s){return JSON.stringify([s.display,s.foreground,s.windowPkg,s.window,parts(s).windows]);}
export function phoneFingerprint(result){const s=screen(result);return createHash('sha256').update(JSON.stringify(s?[context(s),parts(s).lines]:result)).digest('hex');}
function nodes(s){
  const lines=parts(s).lines,out=[];let pkg='';
  for(let i=0;i<lines.length;i++){
    const line=lines[i];if(line.startsWith('window ')){pkg=line.match(/pkg=(\S+)/)?.[1];continue;}
    const b=line.match(/bounds=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);if(!b||pkg!==s.windowPkg||line.includes('offscreen'))continue;
    const bounds=b.slice(1).map(Number),depth=line.length-line.trimStart().length;
    let end=i+1;while(end<lines.length&&!lines[end].startsWith('window ')&&lines[end].length-lines[end].trimStart().length>depth)end++;
    const subtree=lines.slice(i,end).map(x=>x.trim()).join('\n');
    out.push({line,bounds,subtree,area:(bounds[2]-bounds[0])*(bounds[3]-bounds[1])});
  }
  return out;
}
function navigationTarget(s,x,y){
  const candidates=nodes(s).filter(n=>n.line.includes('clickable')&&n.area>0&&x>=n.bounds[0]&&x<n.bounds[2]&&y>=n.bounds[1]&&y<n.bounds[3]).sort((a,b)=>a.area-b.area);
  const target=candidates[0];if(!target)return null;
  const labels=[...target.subtree.matchAll(/"([^"\n]+)"/g)].map(m=>m[1]);
  return labels.length&&labels.every(label=>NAVIGATION.test(label))?target.subtree:null;
}
export function samePhoneContext(before,after){const a=screen(before),b=screen(after);return !!a&&!!b&&context(a)===context(b);}
export function sameNavigationTarget(before,after,args){
  const a=screen(before),b=screen(after);if(!a||!b||context(a)!==context(b))return false;
  const first=navigationTarget(a,args.x,args.y),next=navigationTarget(b,args.x,args.y);
  return first!==null&&first===next;
}
export function samePhoneTarget(before,after,args){
  if(phoneFingerprint(before)===phoneFingerprint(after))return true;
  const a=screen(before),b=screen(after);if(!a||!b||context(a)!==context(b))return false;
  // Only semantic navigation controls may survive unrelated page animations.
  // Purchase, payment, product and other arbitrary taps retain the whole-page check.
  if(args.action==='tap'){
    const first=navigationTarget(a,args.x,args.y),next=navigationTarget(b,args.x,args.y);
    return first!==null&&first===next;
  }
  if(args.action==='type'){
    const focused=s=>nodes(s).filter(n=>n.line.includes('editable')&&n.line.includes('focused')&&!/password/i.test(n.line));
    const old=focused(a),current=focused(b);
    return old.length===1&&current.length===1&&old[0].subtree===current[0].subtree;
  }
  return false;
}
