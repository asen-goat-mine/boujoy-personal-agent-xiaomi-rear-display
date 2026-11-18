import {fullHarnessPatches} from './harness-full-profile.mjs';
import {harnessRoleContext} from '../core/harness-context.mjs';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LineRPC } from './rpc.mjs';
import { ROOT, HARNESS, DATA, MODEL } from '../config.mjs';
import { AppError } from '../core/errors.mjs';
import { createRequire } from 'node:module';

export function harnessVersion(){try{return JSON.parse(fs.readFileSync(path.join(HARNESS,'node_modules/@deepseek-ai/dsh/package.json'),'utf8')).version;}catch{return null;}}
import {systemPromptForTools} from '../core/agent-instructions.mjs';
export {SYSTEM,CORE_SYSTEM,systemPromptForTools} from '../core/agent-instructions.mjs';

// 4096 cut long answers, tables and documents short.
export const MAX_OUTPUT_TOKENS=8192;
// The Harness defaults to high reasoning; Boujoy used to force it off, which made
// the agent act like a script. Low thinks before each step at modest latency.
export const REASONING=['off','low','high','max'];export const DEFAULT_REASONING='low';// 'auto' is resolved per task by the engine
let extrasBroken=null;
// The Harness refuses a child tool filter that names a tool this run does not have,
// so the safe list in harness-extras.yml is narrowed to this task's tools. With
// none left, the subagent tool is not mounted at all (never an unfiltered child).
export function childToolFilter(extras,toolNames){
  const have=new Set((toolNames||[]).map(name=>'mcp__personal__'+name));
  return extras.map(layer=>{
    if(!layer.insert)return layer;
    const insert=[];
    for(const entry of layer.insert){
      const allow=entry.config?.toolFilter?.allow;
      if(!allow){insert.push(entry);continue;}
      const inherited=allow.includes('boujoy:inherit-task-tools');
      const kept=inherited?[...have,'subagent','send_message','interrupt_agent']:allow.filter(name=>have.has(name));
      if(kept.length)insert.push({...entry,config:{...entry.config,toolFilter:{allow:kept}}});
    }
    const filtered=insert.some(entry=>entry.config?.toolFilter);
    return {...layer,insert:filtered?insert:insert.filter(entry=>!/subagent/.test(entry.id))};
  });
}
export const harnessExtrasStatus=()=>({broken:extrasBroken});
const SUBAGENT_GUIDE='\n子智能体：可按任务需要并行分工、继续拆分，并用 send_message 和 interrupt_agent 管理。子智能体继承本轮已授权工具，手机操作会串行。完整传递用户目标、约束和证据；子任务完成仅结束自己，不结束主任务。等结果回来核对后由主任务汇总。';
export class HarnessRun {
  constructor({task,role,prompt,toolNames,systemToolNames,token,origin,onEvent,onLog,reasoningEffort,extras=true,profile='sdk-minimal'}){this.profile=profile;this.extras=extras;this.reasoningEffort=REASONING.includes(reasoningEffort)?reasoningEffort:DEFAULT_REASONING;this.toolNames=toolNames;this.systemToolNames=systemToolNames||toolNames;this.sessionId=task.id;this.task=task;this.role=role;this.prompt=prompt;this.token=token;this.origin=origin;this.onEvent=onEvent;this.onLog=onLog;}
  // MCP list_changed updates the parent catalog, but the child allowlist is
  // frozen in runtime.patch.json. Rebuild a warm run when file access changes.
  canReuseToolCatalog(toolNames){
    if(this.extras===false)return true;
    const before=new Set(this.toolNames||[]),after=new Set(toolNames||[]);
    return before.size===after.size&&[...before].every(name=>after.has(name));
  }
  // Compaction and subagents (config/harness-extras.yml). A failure to load them
  // never stops work: the same start is retried on the plain kernel, and they stay
  // off until the service restarts.
  usesExtras(){return this.extras!==false&&!extrasBroken;}
  async start({probe=false}={}){
    let result;
    if(!this.usesExtras())result=await this.startOnce({probe:true,extras:false});
    else try{
      result=await this.startOnce({probe:true,extras:true});
      if(/entr(?:y|ies) did not activate/.test(this.startupLog||''))throw new AppError('harness_config','extras did not activate',503);
    }catch(error){
      if(error?.code==='cancelled'||this.cancelled)throw error;
      extrasBroken={at:new Date().toISOString(),reason:String(error?.message||error).slice(0,200),log:String(this.startupLog||'').slice(-600)};
      this.onLog?.(`harness extras disabled: ${extrasBroken.reason}`);
      try{this.rpc?.close();}catch{}this.rpc=null;this.startupLog='';
      result=await this.startOnce({probe:true,extras:false});
    }
    // Once a prompt was dispatched, never replay it as component recovery.
    if(!probe)await this.send(this.prompt);
    return result;
  }
  async startOnce({probe=false,extras=false}={}){
    if(harnessVersion()!=='0.2.1-alpha.2')throw new AppError('harness_unavailable','未找到 DeepSeek Harness 0.2.1-alpha.2。从源码运行时请先执行 npm run setup',503);
    const home=path.join(DATA,'harness',this.task.id);fs.mkdirSync(home,{recursive:true,mode:0o700});
    const require=createRequire(path.join(HARNESS,'node_modules/@deepseek-ai/dsh/package.json'));
    let patches=require('js-yaml').load(fs.readFileSync(path.join(ROOT,'config/personal.patch.yml'),'utf8'));
    patches.find(p=>p.id==='llm-deepseek').config.baseURL=`${this.origin}/internal/model/${this.token}`;
    if(extras&&this.profile!=='sdk'){
      patches.push(...childToolFilter(require('js-yaml').load(fs.readFileSync(path.join(ROOT,'config/harness-extras.yml'),'utf8')),this.toolNames));
      // Subagents need session storage. A fresh folder per process, removed on
      // dispose, so a new process never resumes an old session on its own.
      for(const name of fs.readdirSync(home))if(name.startsWith('sessions-'))fs.rmSync(path.join(home,name),{recursive:true,force:true});
      this.sessionRoot=path.join(home,'sessions-'+randomUUID());
      patches.push({id:'sessions',disabled:false,config:{root:this.sessionRoot,compression:'none'}});
    }
    if(extras&&this.profile!=='sdk')patches.push({insert:[{id:'boujoy-child-tools',name:path.join(ROOT,'src/adapters/harness-child-tools.mjs'),config:{rootSessionId:this.sessionId}}]});
    this.extrasActive=extras;
    const mcp=patches.find(p=>p.insert).insert.find(p=>p.id==='personal-tools');
    Object.assign(mcp.config,{command:process.execPath,args:[path.join(ROOT,'src/adapters/mcp-bridge.mjs')],env:{BOUJOY_INTERNAL_URL:this.origin+'/internal',BOUJOY_RUNTIME_TOKEN:this.token}});
    if(this.profile==='sdk'){
      // A task that continues after a pause or restart starts a new process with
      // the same session id. Its earlier session cannot be resumed by a new
      // process (and creating it again fails with "already exists"), so each
      // process gets its own session folder, removed on dispose; the history
      // reaches the new process through the prompt, as in the minimal profile.
      for(const name of fs.readdirSync(home))if(name==='full-sessions'||name.startsWith('full-sessions-'))fs.rmSync(path.join(home,name),{recursive:true,force:true});
      this.sessionRoot=path.join(home,'full-sessions-'+randomUUID());
    }
    if(this.profile==='sdk')patches=fullHarnessPatches({root:ROOT,home,sessionId:this.sessionId,sessionRoot:this.sessionRoot,personal:patches,systemPrompt:systemPromptForTools(this.systemToolNames,{task:this.task})+'\n'+harnessRoleContext(this.task,this.role)});
    this.patchFile=path.join(home,'runtime.patch.json');fs.writeFileSync(this.patchFile,JSON.stringify(patches),{mode:0o600});
    const cleanEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/(KEY|PASSWORD|SECRET|TOKEN|DSH_|DEEPSEEK)/i.test(k)));
    this.rpc=new LineRPC(process.execPath,[path.join(HARNESS,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile',this.profile,'--patch',this.patchFile],{
      cwd:path.join(DATA,'artifacts'),env:{...cleanEnv,DSH_HOME:home,DEEPSEEK_API_KEY:'local-proxy-credential',DSH_SYSTEM_PROMPT:systemPromptForTools(this.systemToolNames,{task:this.task})+(extras?SUBAGENT_GUIDE:'')+'\n'+harnessRoleContext(this.task,this.role),BOUJOY_MODEL_PROXY:`${this.origin}/internal/model/${this.token}`,BOUJOY_INTERNAL_URL:this.origin+'/internal',BOUJOY_RUNTIME_TOKEN:this.token,BOUJOY_MCP_BRIDGE:path.join(ROOT,'src/adapters/mcp-bridge.mjs')},stderr:text=>{this.startupLog=((this.startupLog||'')+text).slice(-10000);this.onLog?.(text);}
    });
    this.rpc.on('notification',m=>this.receiveNotification(m));
    const result=await this.rpc.request('initialize',{cwd:path.join(DATA,'artifacts'),provider:'deepseek-official',model:MODEL,reasoningEffort:this.reasoningEffort,...(this.profile==='sdk'?{}:{maxTokens:MAX_OUTPUT_TOKENS})},90000);
    if(/entr(?:y|ies) did not activate/.test(this.startupLog||''))throw new AppError('harness_config','引擎组件未能加载，请查看运行诊断。',503);
    if(probe)return result;
    await this.send(this.prompt);
    return result;
  }
  receiveNotification(message){
    if(message.method!=='session.event'||!message.params?.event)return;
    const {sessionId,event}=message.params;
    // The SDK streams every session, including children. Keep their messages
    // and turn endings out of the parent chat and parent retry decisions.
    if(sessionId&&sessionId!==this.sessionId){
      this.onEvent?.({type:'harness/child',data:{sessionId,event}});return;
    }
    this.onEvent?.(event);
  }
  // A conversation keeps one Harness session: later tasks are further prompts in
  // the same session, so the model keeps its own memory of what it saw and did,
  // and no process start-up is paid per message.
  async send(prompt){
    if(!this.alive())throw new AppError('runtime_exited','执行引擎不可用',502);
    await this.rpc.request('session/prompt',{sessionId:this.sessionId,contentBlocks:[{type:'text',text:prompt}]},20000);
    this.waiting=true;
    try{await this.rpc.request('session/wait',{sessionId:this.sessionId},this.task?.deadlineAt?Math.max(60000,Date.parse(this.task.deadlineAt)-Date.now()+60000):Infinity);}
    finally{this.waiting=false;}
  }
  // What the user adds while a turn is running goes straight into the session: the
  // Harness queues it as steering and the model sees it at its next step, whichever
  // tool it is using. Only while a turn is being waited on, so it never starts a
  // turn nobody is watching. Returns false when it could not be handed over.
  async steer(text){
    if(!this.alive()||!this.waiting||this.cancelled)return false;
    try{await this.rpc.request('session/prompt',{sessionId:this.sessionId,contentBlocks:[{type:'text',text}]},20000);return true;}
    catch{return false;}
  }
  alive(){return !!this.rpc&&!this.rpc.dead&&!this.rpc.closing;}
  // Stopping asks the Harness to shut down first, so it ends its own subagents, shell
  // jobs and session files in order; the process is closed either way within two seconds.
  async stop(){
    this.cancelled=true;const rpc=this.rpc;
    if(rpc&&!rpc.dead&&!rpc.closing){try{await rpc.request('shutdown',{},2000);}catch{}}
    if(this.sessionRoot)fs.rmSync(this.sessionRoot,{recursive:true,force:true});
    if(rpc)rpc.close();
  }
  async dispose(){this.cancelled=true;if(this.rpc){try{await this.rpc.request('shutdown',{},5000);}catch{}this.rpc.close();}if(this.patchFile)fs.rmSync(this.patchFile,{force:true});if(this.sessionRoot)fs.rmSync(this.sessionRoot,{recursive:true,force:true});}
}
