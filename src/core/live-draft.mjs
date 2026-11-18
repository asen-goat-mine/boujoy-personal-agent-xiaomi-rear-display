// Live reply drafts. The Harness SDK only reports whole assistant messages, but
// every model request already streams through Boujoy's model proxy. This reads
// the Anthropic-format SSE text deltas passing through so the chat can show the
// answer as it is written. Drafts are display-only: never stored in the task,
// never sent back to the model, never evidence of anything.
import {StringDecoder} from 'node:string_decoder';

const MAX_DRAFT=60000,MAX_THINKING=40000;
export class DraftStream {
  constructor(onText,onThinking){this.onText=onText;this.onThinking=onThinking;this.thinkingBlocks=new Set();this.decoder=new StringDecoder('utf8');this.buffer='';this.text='';this.textBlocks=new Set();this.finishBlocks=new Map();}
  push(chunk){
    this.buffer+=this.decoder.write(Buffer.from(chunk));let boundary;
    while((boundary=this.buffer.match(/\r\n\r\n|\n\n|\r\r/))){const frame=this.buffer.slice(0,boundary.index);this.buffer=this.buffer.slice(boundary.index+boundary[0].length);this.frame(frame);}
    if(this.buffer.length>1_000_000)this.buffer='';
  }
  frame(frame){
    const data=frame.split(/\r\n|\n|\r/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');if(!data||data==='[DONE]')return;
    let value;try{value=JSON.parse(data);}catch{return;}
    if(value.type==='message_start'){const had=this.text.length>0;this.text='';this.textBlocks.clear();this.finishBlocks.clear();this.thinkingBlocks.clear();if(had)this.onText?.('');return;}
    // DeepSeek's reasoning arrives as thinking blocks; it is shown as the reply's
    // thinking chain (display only, like the draft) and never fed back as evidence.
    if(value.type==='content_block_start'&&value.content_block?.type==='thinking'){this.thinkingBlocks.add(value.index);this.onThinking?.(String(value.content_block.thinking||''),true);return;}
    if(value.type==='content_block_delta'&&value.delta?.type==='thinking_delta'&&(this.thinkingBlocks.has(value.index)||value.index===undefined)){const piece=String(value.delta.thinking||'');if(piece)this.onThinking?.(piece,false);return;}
    // The final answer is usually finish_task's summary (a tool argument): stream it too.
    if(value.type==='content_block_start'&&value.content_block?.type==='tool_use'&&/(?:^|__)finish_task$/.test(String(value.content_block.name||''))){this.finishBlocks.set(value.index,{json:'',shown:0,base:this.text});return;}
    if(value.type==='content_block_delta'&&value.delta?.type==='input_json_delta'&&this.finishBlocks.has(value.index)){this.summary(this.finishBlocks.get(value.index),String(value.delta.partial_json||''));return;}
    if(value.type==='content_block_start'&&value.content_block?.type==='text'){this.textBlocks.add(value.index);if(value.content_block.text)this.append(value.content_block.text);return;}
    if(value.type==='content_block_delta'&&value.delta?.type==='text_delta'&&(this.textBlocks.has(value.index)||value.index===undefined))this.append(value.delta.text);
  }
  summary(block,piece){
    block.json+=piece;const value=partialString(block.json,'summary');if(value===null||value.length<=block.shown)return;
    block.shown=value.length;const text=(block.base?block.base+'\n\n':'')+value;
    if(text.length>MAX_DRAFT)return;this.text=text;this.onText?.(this.text);
  }
  append(text){if(typeof text!=='string'||!text||this.text.length>=MAX_DRAFT)return;this.text=(this.text+text).slice(0,MAX_DRAFT);this.onText?.(this.text);}
}

// The (possibly unfinished) string value of `key` in a JSON object still being
// streamed; null until the value has started. Escapes are decoded as they complete.
export function partialString(json,key){
  const m=new RegExp('"'+key+'"\\s*:\\s*"').exec(json);if(!m)return null;
  let out='';for(let i=m.index+m[0].length;i<json.length;i++){
    const c=json[i];if(c==='"')return out;
    if(c!=='\\'){out+=c;continue;}
    const n=json[i+1];if(n===undefined)return out;
    if(n==='u'){const hex=json.slice(i+2,i+6);if(hex.length<4||!/^[0-9a-f]{4}$/i.test(hex))return out;out+=String.fromCharCode(parseInt(hex,16));i+=5;continue;}
    out+=({n:'\n',t:'\t',r:'',b:'',f:'','"':'"','\\':'\\','/':'/'})[n]??n;i++;
  }
  return out;
}

// One draft per task, throttled so a fast stream does not flood the SSE clients.
export class LiveDrafts {
  constructor({publish,intervalMs=120,clock=Date.now}={}){this.publish=publish;this.intervalMs=intervalMs;this.clock=clock;this.drafts=new Map();this.timers=new Map();}
  stream(taskId){return new DraftStream(text=>this.update(taskId,text),(piece,start)=>this.think(taskId,piece,start));}
  update(taskId,text){
    const previous=this.drafts.get(taskId);
    const row={taskId,text,thinking:previous?.thinking||'',at:new Date(this.clock()).toISOString()};this.drafts.set(taskId,row);
    this.schedule(taskId);
  }
  // The whole run's thinking accumulates (each model step adds a block), capped from the front.
  think(taskId,piece,start){
    const previous=this.drafts.get(taskId)||{taskId,text:'',thinking:''};let thinking=previous.thinking||'';
    if(start&&thinking&&!thinking.endsWith('\n\n'))thinking+='\n\n';thinking+=piece;if(thinking.length>MAX_THINKING)thinking=thinking.slice(-MAX_THINKING);
    this.drafts.set(taskId,{...previous,thinking,at:new Date(this.clock()).toISOString()});if(piece||start)this.schedule(taskId);
  }
  schedule(taskId){
    if(this.timers.has(taskId))return;
    this.timers.set(taskId,setTimeout(()=>{this.timers.delete(taskId);const current=this.drafts.get(taskId);if(current)this.publish?.({type:'draft',taskId,text:current.text,thinking:current.thinking||''});},this.intervalMs));
  }
  get(taskId){return this.drafts.get(taskId)||null;}
  clear(taskId){
    const timer=this.timers.get(taskId);if(timer){clearTimeout(timer);this.timers.delete(taskId);}
    if(this.drafts.delete(taskId))this.publish?.({type:'draft',taskId,text:'',thinking:''});
  }
  close(){for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();this.drafts.clear();}
}
