import {reserveModelBudget} from './model-budget.mjs';
import {randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';

const FIELDS={input_tokens:'inputTokens',output_tokens:'outputTokens',cache_read_input_tokens:'cacheReadInputTokens',cache_creation_input_tokens:'cacheCreationInputTokens'};
const validCount=value=>Number.isSafeInteger(value)&&value>=0;
// Anthropic message_delta usage is cumulative, never an increment. Keep only
// numeric provider counters; do not infer tokens from text length or cache data.
// https://platform.claude.com/docs/en/build-with-claude/streaming
export class AnthropicUsageMeter {
  constructor({contentType='application/json',maxBytes=2*1024*1024}={}){
    this.stream=/text\/event-stream/i.test(contentType);this.maxBytes=maxBytes;this.decoder=new StringDecoder('utf8');this.buffer='';this.counters={};this.messageId=null;this.stop=false;this.invalid=false;this.overflow=false;this.closed=false;
  }
  usage(value){if(!value||typeof value!=='object'||Array.isArray(value))return;for(const [field,name]of Object.entries(FIELDS))if(Object.hasOwn(value,field)){if(!validCount(value[field])){this.invalid=true;continue;}this.counters[name]=Math.max(this.counters[name]??0,value[field]);}}
  event(frame){
    const lines=frame.split(/\r\n|\n|\r/),data=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');if(!data||data==='[DONE]')return;
    let value;try{value=JSON.parse(data);}catch{this.invalid=true;return;}
    if(value.type==='message_start'){
      const id=value.message?.id;if(this.messageId&&id&&this.messageId!==id){this.invalid=true;return;}if(typeof id==='string')this.messageId=id;
      this.usage(value.message?.usage);
    }else if(value.type==='message_delta')this.usage(value.usage);
    else if(value.type==='message_stop')this.stop=true;
    else if(value.type==='error')this.invalid=true;
  }
  push(chunk){
    if(this.closed||this.overflow)return;this.buffer+=this.decoder.write(Buffer.from(chunk));
    if(this.stream){let boundary;while((boundary=this.buffer.match(/\r\n\r\n|\n\n|\r\r/))){const frame=this.buffer.slice(0,boundary.index);this.buffer=this.buffer.slice(boundary.index+boundary[0].length);if(Buffer.byteLength(frame)>this.maxBytes){this.overflow=true;this.buffer='';return;}this.event(frame);}}
    if(Buffer.byteLength(this.buffer)>this.maxBytes){this.overflow=true;this.buffer='';}
  }
  finish({transportComplete=false}={}){
    if(!this.closed){this.buffer+=this.decoder.end();if(!this.stream&&!this.overflow){try{const message=JSON.parse(this.buffer);if(message.type==='message'){this.usage(message.usage);this.stop=true;}}catch{this.invalid=true;}}this.buffer='';this.closed=true;}
    const reported=Object.keys(this.counters).length>0,complete=reported&&Object.hasOwn(this.counters,'inputTokens')&&Object.hasOwn(this.counters,'outputTokens')&&this.stop&&transportComplete&&!this.invalid&&!this.overflow;
    return {...this.counters,status:complete?'reported':reported?'partial':'unavailable',transportComplete,provider:'deepseek',format:'anthropic',...(this.overflow?{reason:'usage_frame_too_large'}:this.invalid?{reason:'usage_invalid_or_interrupted'}:!reported?{reason:'provider_usage_missing'}:!complete?{reason:'incomplete_response'}:{})};
  }
}
export function accumulateUsage(aggregate,result){
 for(const name of Object.values(FIELDS))if(validCount(result[name]))aggregate[name]=(aggregate[name]||0)+result[name];
 aggregate.measuredRequests=(aggregate.measuredRequests||0)+(result.status==='reported'?1:0);aggregate.partialUsageRequests=(aggregate.partialUsageRequests||0)+(result.status==='partial'?1:0);aggregate.unavailableUsageRequests=(aggregate.unavailableUsageRequests||0)+(result.status==='unavailable'?1:0);
}
export function commitModelUsage(store,taskId,requestId,result){
 return store.updateTask(taskId,(task,state)=>{
  const receipt=task.modelUsageReceipts?.find(row=>row.id===requestId);if(!receipt)throw Error('Model request usage reservation missing');
  if(receipt.finishedAt)return;
  receipt.finishedAt=new Date().toISOString();receipt.usage=result;receipt.status=result.status;
  task.usage||={};state.usage||={};accumulateUsage(task.usage,result);accumulateUsage(state.usage,result);
 });
}
export function reserveMemoryUsage(store,{at=Date.now()}={}){
 const id=randomUUID();store.transaction(state=>{reserveModelBudget(state,{id,source:'memory',at});state.memoryUsageReceipts||=[];state.memoryUsageReceipts.push({id,status:'pending',startedAt:new Date(at).toISOString()});state.usage.requests++;state.usage.memoryRequests=(state.usage.memoryRequests||0)+1;});return id;
}
export function commitMemoryUsage(store,requestId,result){
 return store.transaction(state=>{const receipt=state.memoryUsageReceipts?.find(row=>row.id===requestId);if(!receipt)throw Error('Memory request usage reservation missing');if(receipt.finishedAt)return;receipt.finishedAt=new Date().toISOString();receipt.usage=result;receipt.status=result.status;accumulateUsage(state.usage,result);state.usage.memory||={};accumulateUsage(state.usage.memory,result);});
}
