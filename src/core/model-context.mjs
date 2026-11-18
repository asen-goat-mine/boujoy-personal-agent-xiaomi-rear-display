import {compactPriorTree} from './model-tree-delta.mjs';
// A persistent conversation session keeps every earlier screenshot in its
// history; by the third phone task each model request was 3–5 MB. The model
// only needs the latest screens: images in all but the last `keep` messages
// that carry images are replaced by a short note. Older text, tool calls and
// results stay intact, and the stripped prefix is stable across steps.
const NOTE='[较早的手机截图已省略，以最新截图为准]';
function hasImage(content){return Array.isArray(content)&&content.some(block=>block?.type==='image'||block?.type==='tool_result'&&hasImage(block.content));}
function strip(content){
  if(!Array.isArray(content))return {content,removed:0};
  let removed=0;const out=[];
  for(const block of content){
    if(block?.type==='image'){removed++;if(!out.some(b=>b?.type==='text'&&b.text===NOTE))out.push({type:'text',text:NOTE});continue;}
    if(block?.type==='tool_result'&&Array.isArray(block.content)){const inner=strip(block.content);removed+=inner.removed;out.push(inner.removed?{...block,content:inner.content.length?inner.content:[{type:'text',text:NOTE}]}:block);continue;}
    out.push(block);
  }
  return {content:out,removed};
}
export function pruneOldImages(data,{keep=2}={}){
  if(!Array.isArray(data?.messages))return 0;
  const withImages=data.messages.map((message,index)=>hasImage(message?.content)?index:-1).filter(index=>index>=0);
  const kept=new Set(withImages.slice(-keep));let removed=0;
  data.messages=data.messages.map((message,index)=>{if(kept.has(index)||!hasImage(message?.content))return message;const result=strip(message.content);removed+=result.removed;return {...message,content:result.content};});
  return removed;
}

// The wire role "user" carries both actual user uploads and MCP replies. A
// screenshot must belong to a successful result of a uniquely matched phone call.
const PHONE_CALLS=new Set(['mcp__personal__phone_use','mcp__personal__phone_observe','mcp__personal__phone_action']);
const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
const keysOnly=(obj,names)=>!!obj&&Object.keys(obj).every(key=>names.includes(key));
function frameScope(content){
  let scope=null;
  for(const block of content){
    if(block?.type!=='text'||typeof block.text!=='string'||!block.text.includes('"observationId"'))continue;
    // dsh-mcp-client coalesces consecutive text blocks with LF. Native JSON
    // envelopes occupy one line; literal newlines in page contents are escaped.
    for(const line of block.text.split('\n')){
      if(!line.startsWith('{')||!line.includes('"observationId"'))continue;
      let o;try{o=JSON.parse(line);}catch{continue;}
      if(!o||!Object.hasOwn(o,'observationId'))continue;
      if(scope!==null||typeof o.observationId!=='string'||!/^screen-[0-9a-f]{8}$/.test(o.observationId)||o.untrustedContent!==true)return null;
      if(o.display==='main')scope='main';
      else if(o.display==='background'){
        const s=o.displaySession;
        if(o.backend!=='display'||!s||!safeId(s.sessionId)||!Number.isSafeInteger(s.generation)||s.generation<0||
          !Number.isSafeInteger(s.displayId)||s.displayId<=0||s.displayId!==o.displayId)return null;
        scope=JSON.stringify([s.sessionId,s.generation,s.displayId]);
      }else return null;
    }
  }
  return scope;
}
function recentPhoneFrames(messages){
  const count=new Map(),results=new Map(),add=(m,id)=>m.set(id,(m.get(id)||0)+1);
  for(const m of messages)if(Array.isArray(m?.content))for(const b of m.content){
    if(m.role==='assistant'&&b?.type==='tool_use')add(count,b.id);
    if(m.role==='user'&&b?.type==='tool_result')add(results,b.tool_use_id);
  }
  const frames=[];
  for(let mi=1;mi<messages.length;mi++){
    const m=messages[mi],prev=messages[mi-1];
    if(m?.role!=='user'||prev?.role!=='assistant'||!Array.isArray(prev.content)||!Array.isArray(m.content)||m.cache_control||!hasImage(m.content))continue;
    const phone=new Set(prev.content.filter(b=>b?.type==='tool_use'&&PHONE_CALLS.has(b.name)).map(b=>b.id));
    for(const [bi,r] of m.content.entries()){
      if(r?.type!=='tool_result'||!phone.has(r.tool_use_id)||!safeId(r.tool_use_id)||count.get(r.tool_use_id)!==1||
        results.get(r.tool_use_id)!==1||(r.is_error!==undefined&&r.is_error!==false)||!keysOnly(r,['type','content','tool_use_id','is_error'])||!Array.isArray(r.content))continue;
      const ri=r.content.findIndex(b=>b?.type==='image');
      if(ri<0||r.content.some((b,i)=>i!==ri&&b?.type!=='text')||r.content.some(b=>b?.cache_control||b?.type==='text'&&typeof b.text==='string'&&b.text.includes('[... tool result middle pruned ...]')))continue;
      const img=r.content[ri],src=img.source;
      if(!keysOnly(img,['type','source'])||!keysOnly(src,['type','media_type','data'])||src.type!=='base64'||
        !['image/png','image/jpeg'].includes(src.media_type)||typeof src.data!=='string'||!src.data.length)continue;
      const scope=frameScope(r.content);if(scope===null)continue;
      frames.push({mi,bi,ri,scope,id:r.tool_use_id,src,content:r.content,solo:m.content.length===1&&prev.content.filter(b=>b?.type==='tool_use').length===1});
    }
  }
  return frames;
}
export function prepareModelImages(data,{keep=4,keepAllScreenshots=false}={}){
  const stats={prunedImages:0,deduplicatedImages:0,deduplicatedImageBytes:0,treeBytesSaved:0};
  if(keepAllScreenshots||!Array.isArray(data?.messages))return stats;
  // Retain the old window boundary before replacing any duplicates. It is a
  // message window, not a quota of distinct images.
  stats.prunedImages=pruneOldImages(data,{keep});
  const frames=recentPhoneFrames(data.messages),latest=new Map();
  let next=null;
  for(let i=frames.length-1;i>=0;i--){
    const f=frames[i],group=f.scope+'|'+f.src.media_type;
    let seen=latest.get(group);if(!seen)latest.set(group,seen=new Map());
    let content=f.content,treeDelta=false;
    if(f.solo&&next?.solo&&next.mi===f.mi+2&&f.scope===next.scope&&next.fullTree){
      const d=compactPriorTree(content,next.content,next.id);
      if(d.bytesSaved>0){content=d.content;stats.treeBytesSaved+=d.bytesSaved;treeDelta=true;}
    }
    // The full base64 string is the map key: never compare perceptual hashes or
    // crop screenshots. References always target the newest retained original.
    const ref=seen.get(f.src.data);
    if(!ref)seen.set(f.src.data,f.id);
    else{
      const note={type:'text',text:'[此处截图与后续工具结果 '+ref+' 中的原图完全相同；此步的观察和回执仍以本条为准。]'};
      const saved=Buffer.byteLength(JSON.stringify(f.content[f.ri]))-Buffer.byteLength(JSON.stringify(note));
      if(saved>0){content=content.slice();content[f.ri]=note;stats.deduplicatedImages++;stats.deduplicatedImageBytes+=saved;}
    }
    if(content!==f.content){
      const m=data.messages[f.mi],blocks=m.content.slice();
      blocks[f.bi]={...blocks[f.bi],content};data.messages[f.mi]={...m,content:blocks};
    }
    next={...f,fullTree:!treeDelta};
  }
  return stats;
}
