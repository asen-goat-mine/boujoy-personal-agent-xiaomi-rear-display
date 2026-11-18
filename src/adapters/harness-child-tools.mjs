// Boujoy lifecycle/phone adaptation for official Harness native subagents.
// Children inherit the task's tools; their finish_task concludes only their turn.
export const name='boujoy-harness-child-tools';
export const inject=['tools'];
export function apply(ctx,config){let phoneTail=Promise.resolve();ctx.on('tools/execute',async(exec,next)=>{
 const child=exec.agent?.session?.id&&exec.agent.session.id!==config.rootSessionId;
 if(child&&exec.name==='mcp__personal__finish_task'){
  const summary=String(exec.arguments?.summary||'');const value={outcome:exec.arguments?.outcome||'completed',summary,childSessionId:exec.agent.session.id,parentUnchanged:true};
  return {isError:false,value,meta:{boujoyChildCompletion:true,summary,outcome:value.outcome},content:[{type:'text',text:summary||JSON.stringify(value)}],concludesTurn:true};
 }
 if(!exec.name.startsWith('mcp__personal__phone_')){const result=await next();
  if(config.nativeGuidance===true&&!child&&!exec.name.startsWith('mcp__personal__')&&process.env.BOUJOY_INTERNAL_URL&&process.env.BOUJOY_RUNTIME_TOKEN){try{const response=await fetch(process.env.BOUJOY_INTERNAL_URL+'/harness/guidance',{method:'POST',headers:{Authorization:'Bearer '+process.env.BOUJOY_RUNTIME_TOKEN,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.any([exec.signal,AbortSignal.timeout(3000)])});if(response.ok){const guidance=await response.json();if(Object.keys(guidance).length)return {...result,content:[...result.content,{type:'text',text:JSON.stringify(guidance)}]};}}catch{}}return result;}
 const before=phoneTail;let release;phoneTail=new Promise(resolve=>{release=resolve;});try{await before;exec.signal.throwIfAborted();return await next();}finally{release();}
});}
