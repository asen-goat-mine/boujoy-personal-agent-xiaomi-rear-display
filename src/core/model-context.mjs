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
