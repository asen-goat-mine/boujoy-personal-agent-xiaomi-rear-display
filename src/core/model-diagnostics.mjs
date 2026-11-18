// Structural telemetry only. Provider errors can echo user text and credentials;
// never persist raw response bodies, headers, request text or image bytes.
const bytes=value=>Buffer.byteLength(JSON.stringify(value??null));
export function modelRequestStats(data,serialized=JSON.stringify(data)){
  let images=0,imageBytes=0,toolResults=0,toolResultBytes=0;
  function visit(value){
    if(!value||typeof value!=='object')return;
    if(value.type==='image'){images++;imageBytes+=bytes(value);}
    if(value.type==='tool_result'){toolResults++;toolResultBytes+=bytes(value);}
    for(const child of Object.values(value))if(child&&typeof child==='object')Array.isArray(child)?child.forEach(visit):visit(child);
  }
  visit(data.messages);
  return {requestBytes:Buffer.byteLength(serialized),messages:Array.isArray(data.messages)?data.messages.length:0,tools:Array.isArray(data.tools)?data.tools.length:0,systemBytes:bytes(data.system),toolsBytes:bytes(data.tools),messagesBytes:bytes(data.messages),hasImage:images>0,images,imageBytes,toolResults,toolResultBytes,maxTokens:data.max_tokens};
}
const safeWords=new Set(('error type code message invalid_request_error context_length_exceeded context_window_exceeded request_too_large authentication_error permission_error rate_limit_error api_error overloaded_error invalid request context window maximum max length exceeded exceeds exceed limit input output tokens token messages message tools tool system content text image images bytes size total requested completion reduce please your this model supports however you resulted in the of and a an is are was were must be less than greater at most too long many max_tokens tool_use tool_result tool_use_id thinking signature expected found missing assistant user roles consecutive').split(' '));
export function modelErrorPreview(prefix){
  // Only inspect the first 2 KiB, including for malformed/non-JSON responses.
  const raw=Buffer.from(prefix).subarray(0,2048).toString('utf8');
  let error;try{const body=JSON.parse(raw);error=body?.error??body;}catch{error={message:raw};}
  const clean=value=>String(value??'').replace(/https?:\/\/\S+|(?:sk-|Bearer\s+)[\w.-]+/gi,'[redacted]').replace(/[^\x20-\x7e]+/g,'[redacted]').replace(/[A-Za-z0-9_-]+/g,word=>safeWords.has(word.toLowerCase())||/^\d{1,7}$/.test(word)?word:'[redacted]').replace(/(?:\[redacted\]\s*)+/g,'[redacted] ').slice(0,2048);
  return {type:clean(error?.type),code:clean(error?.code),message:clean(error?.message)};
}
