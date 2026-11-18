import {BACKGROUND_SUPPORTED} from '../distribution.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AppError, now } from './errors.mjs';
import {initializeTimeline,createTaskContract} from './task-contract.mjs';

export const DEFAULT_ROLES = [
  {id:'concierge',name:'总助理',icon:'◈',description:'统筹生活与工作，跟进每件事的结果。',instruction:'负责澄清目标、协调角色和核验结果。遇到工具缺失如实说明，不编造已完成。'},
  {id:'life',name:'生活管家',icon:'☀',description:'外卖、预约、快递和日常安排。',instruction:'处理外卖、预约和订单事务。读取结算价、地址标签和送达时间。未经具体授权不能提交交易。'},
  {id:'shopping',name:'采购助理',icon:'◇',description:'同款比价、优惠核算和购买跟进。',instruction:'先核对规格、份量、门店、权益条件，再比较最终应付与配送。绝不编造报价或全网最低。'},
  {id:'travel',name:'出行助理',icon:'↗',description:'交通、住宿、行程与预约。',instruction:'一起比较时间、总费用、退改和地点。准备预订不等于预订成功。'},
  {id:'work',name:'工作伙伴',icon:'▦',description:'资料、文件、项目与日程。',instruction:'按来源完成资料和工作成果，区分用户需求与外部材料。'}
];
export function initialState() {
  return {schemaVersion:1,revision:0,createdAt:now(),roles:DEFAULT_ROLES.map(r=>({...r,hidden:false,createdAt:now()})),tasks:[],groups:[],groupMessages:[],groupHandoffs:[],groupReceipts:[],routines:[],watches:[],eventRules:[],eventReceipts:[],approvals:[],actions:[],artifacts:[],outbox:[],
    settings:{timezone:'Asia/Shanghai',maxConcurrent:2,maxModelRequests:0,maxTaskMinutes:0,modelWatchdogEnabled:true,superagentEnabled:true,model:'deepseek-flash',quiet:true,browserEnabled:true,filesEnabled:true,executionEpochs:{browser:0,files:0,phone:0},phoneEnabled:false,phoneBackend:'phoneuse',phoneExecutionMode:'main',phoneUseDeviceId:null,ponyRelay:'http://127.0.0.1:18792',memoryEnabled:true,chatCloudConsent:false,chatMemoryConsent:false,chatMemoryMode:'default'}, usage:{requests:0,inputTokens:0,outputTokens:0},schedulerPaused:false};
}
export function fenceRecoveredState(state,fence){
  state.recoveryFence={...fence,required:true};state.schedulerPaused=true;
  for(const domain of ['browser','files','phone']){state.settings[domain==='files'?'filesEnabled':domain+'Enabled']=false;(state.settings.executionEpochs||={})[domain]=(state.settings.executionEpochs?.[domain]||0)+1;}state.settings.chatCloudConsent=false;state.settings.chatMemoryConsent=false;
  for(const monitor of state.eventMonitors||[]){
    // Keep only a non-executable receipt: a restored pending envelope may have
    // reached the receiver after the snapshot. Never retry its body or nonce.
    if(monitor.pending){
      const pending=monitor.pending,accepted=(state.eventReceipts||[]).find(row=>row.ruleId===monitor.ruleId&&row.eventId===pending.eventId&&row.bodySha256===pending.bodySha256);
      monitor.recoveryReceipt={fenceId:fence.id,restoredAt:fence.restoredAt||now(),eventId:typeof pending.eventId==='string'?pending.eventId:null,bodySha256:typeof pending.bodySha256==='string'?pending.bodySha256:null,signedAt:/^\d{13}$/.test(String(pending.timestamp))?new Date(Number(pending.timestamp)).toISOString():null,deliveryState:accepted?'accepted':'unknown',receiptId:accepted?.id||null,replayAllowed:false};
    }
    monitor.enabled=false;monitor.pending=null;monitor.recoveryFenceId=fence.id;
  }
  for(const rule of state.eventRules||[]){rule.enabled=false;rule.conditionState=null;rule.recoveryFenceId=fence.id;if(rule.authorization)rule.authorization.revokedAt=now();}
  for(const action of state.actions||[])if(action.status==='executing'){action.status='unknown';action.recoveryInterruptedAt=now();}
  for(const task of state.tasks||[]){
    if(['completed','ready_for_user','cancelled','failed','expired'].includes(task.status))continue;
    task.status=(state.actions||[]).some(a=>a.taskId===task.id&&['unknown','executing'].includes(a.status)&&!a.resolution)?'unknown_result':'paused';
    task.blockedReason='已从备份恢复，尚未重新确认现场状态；不会自动重放。';
    task.recoveryFenceId=fence.id;
  }
  for(const approval of state.approvals||[])if(approval.status==='pending'){approval.status='expired';approval.resolvedAt=now();}
  return state;
}
const OPEN=Buffer.from('['),CLOSE=Buffer.from(']'),COMMA=Buffer.from(',');
// BOUJOY_FREEZE_STATE=1 (tests only) makes any in-place edit of saved state throw, which is
// what the reuse of encoded pieces relies on never happening.
const FREEZE=process.env.BOUJOY_FREEZE_STATE==='1';
function freeze(value){if(value===null||typeof value!=='object'||Object.isFrozen(value))return value;Object.freeze(value);for(const key of Object.keys(value))freeze(value[key]);return value;}
export const PROGRESS_WRITE_DELAY_MS=200;
const PROGRESS_EVENTS=new Set(['tool_timing','model_timing','phone_transport','harness_tool','observation','phone_tool_result','turn','reasoning']);
// Reaping a dead owner's directory is itself exclusive. Re-read the owner
// under this guard so two starters cannot both delete the same stale lock and
// then erase one another's new lock. An abandoned/incomplete guard is left for
// inspection instead of guessing that another startup has died.
function sameLock(file,identity){try{const stat=fs.lstatSync(file);return stat.isDirectory()&&stat.dev===identity.dev&&stat.ino===identity.ino;}catch{return false;}}
function ownedLock(file,identity){try{return sameLock(file,identity)&&fs.readFileSync(path.join(file,'owner'),'utf8')===identity.token;}catch{return false;}}
function acquireServiceLock(file){
  const busy=()=>new AppError('already_running','服务已经运行或启动锁尚未释放，请先检查现有服务',409);
  let guard=null;
  try{
    try{fs.mkdirSync(file,{mode:0o700});}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      const guardPath=file+'.reclaim';
      try{fs.mkdirSync(guardPath,{mode:0o700});guard={file:guardPath,...fs.lstatSync(guardPath)};}
      catch(error){if(error.code==='EEXIST')throw busy();throw error;}
      let exists=true;try{fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')exists=false;else throw error;}
      if(exists){
        let pid;try{const text=fs.readFileSync(path.join(file,'pid'),'utf8');if(/^[1-9][0-9]*$/.test(text))pid=Number(text);}catch{}
        if(!Number.isSafeInteger(pid))throw busy();
        try{process.kill(pid,0);throw busy();}catch(error){if(error.code!=='ESRCH')throw error;}
        fs.rmSync(file,{recursive:true,force:true});
      }
      // A fresh creator may have won between removal and mkdir; never erase it.
      try{fs.mkdirSync(file,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw busy();throw error;}
    }
    const identity={...fs.lstatSync(file),token:randomUUID()};
    try{fs.writeFileSync(path.join(file,'owner'),identity.token,{flag:'wx',mode:0o600});fs.writeFileSync(path.join(file,'pid'),String(process.pid),{flag:'wx',mode:0o600});}
    catch(error){if(ownedLock(file,identity))fs.rmSync(file,{recursive:true,force:true});throw error;}
    return identity;
  }finally{if(guard&&sameLock(guard.file,guard))fs.rmSync(guard.file,{recursive:true,force:true});}
}
export class Store extends EventEmitter {
  constructor(dir,{lock=true}={}) {
    super(); this.dir=dir;fs.mkdirSync(dir,{recursive:true,mode:0o700}); this.file=path.join(dir,'state.json');this.lockPath=path.join(dir,'service.lock');this.closed=false;
    if(lock){this.lockIdentity=acquireServiceLock(this.lockPath);this.ownsLock=true;}
    if(fs.existsSync(this.file)){
      try{this.data=JSON.parse(fs.readFileSync(this.file,'utf8'));if(this.data.schemaVersion!==1)throw Error('schema');}
      catch(e){this.close();throw new AppError('state_corrupt','运行状态无法读取；已保留文件，请恢复备份，禁止自动覆盖。',500);}
    } else {this.data=initialState();this.persist();}
    this.transaction(s=>{
      const marker=path.join(this.dir,'.recovery-fence.json');
      if(fs.existsSync(marker)){
        let fence;try{fence=JSON.parse(fs.readFileSync(marker,'utf8'));if(!fence.id||fence.required!==true)throw Error('invalid fence');}
        catch{this.close();throw new AppError('recovery_fence_corrupt','恢复隔离标记损坏，禁止启动执行。',500);}
        fenceRecoveredState(s,fence);
      }
      if(s.settings.browserEnabled===undefined)s.settings.browserEnabled=true;
      if(s.settings.filesEnabled===undefined)s.settings.filesEnabled=true;
      s.settings.executionEpochs||={browser:0,files:0,phone:0};
      if(s.settings.phoneBackend===undefined)s.settings.phoneBackend='phoneuse';
      if(!BACKGROUND_SUPPORTED)s.settings.phoneExecutionMode='main';
      else if(!['main','background'].includes(s.settings.phoneExecutionMode))s.settings.phoneExecutionMode='main';
      s.eventRules||=[];s.eventReceipts||=[];s.watches||=[];
      s.groups||=[];s.groupMessages||=[];s.groupHandoffs||=[];s.groupReceipts||=[];
      if(s.settings.phoneUseDeviceId===undefined)s.settings.phoneUseDeviceId=null;
      // The old built-in 20-call run cap becomes unlimited once; a value the user picked otherwise stays.
      if(!s.settings.runRequestCapMigrated){if(s.settings.maxModelRequests===20)s.settings.maxModelRequests=0;s.settings.runRequestCapMigrated=true;}
      for(const item of s.outbox)delete item.content; // Receipts never retain a second copy of conversation text.
      for(const t of s.tasks){
        if(!t.timeline)initializeTimeline(t,{submittedAt:t.createdAt,budgetMs:s.settings.maxTaskMinutes===0?Infinity:Math.min((s.settings.maxTaskMinutes||20)*60000,(t.maxRunSeconds||Infinity)*1000)});
        if(!t.taskContract)t.taskContract=createTaskContract(t,{routineAuthorization:t.routineAuthorization});
      }
      for(const a of s.actions)if(a.status==='executing'){a.status='unknown';a.finishedAt=now();}
      for(const t of s.tasks)if(['running','waiting_approval'].includes(t.status)) {
        t.status=s.actions.some(a=>a.taskId===t.id&&a.status==='unknown'&&!a.resolution)?'unknown_result':'interrupted';
        t.blockedReason=t.status==='unknown_result'?'上次执行结果未知，请先核实。':'服务重启，请确认后续接任务。';t.updatedAt=now();
      }
      for(const a of s.approvals)if(a.status==='pending'){a.status='expired';a.resolvedAt=now();}
    });
  }
  // The same bytes as JSON.stringify(this.data). Each task and each top-level section is
  // encoded once and reused while that object is unchanged. Objects in the state are never
  // edited in place (every change works on a copy), so an unchanged object means unchanged bytes.
  serialize(){
    const cache=this.jsonCache||=new WeakMap();
    const bytes=value=>{
      if(value===null||typeof value!=='object')return Buffer.from(JSON.stringify(value)??'null');
      let found=cache.get(value);if(!found){found=Buffer.from(JSON.stringify(value));cache.set(value,found);}return found;
    };
    const out=[];let first=true;
    for(const key of Object.keys(this.data)){
      const value=this.data[key];if(value===undefined||typeof value==='function'||typeof value==='symbol')continue;
      out.push(Buffer.from((first?'{':',')+JSON.stringify(key)+':'));first=false;
      if(key==='tasks'&&Array.isArray(value)){out.push(OPEN);value.forEach((task,index)=>{if(index)out.push(COMMA);out.push(bytes(task));});out.push(CLOSE);}
      else out.push(bytes(value));
    }
    out.push(Buffer.from(first?'{}':'}'));return Buffer.concat(out);
  }
  // `reuse` is set by single-task updates, where almost every piece is already encoded.
  persist({reuse=false}={}){
    if(this.closed)throw new AppError('store_closed','服务状态已经关闭',409);
    if(this.ownsLock&&!ownedLock(this.lockPath,this.lockIdentity))throw new AppError('store_lock_lost','服务状态锁已变化，禁止继续写入',409);
    if(this.persistTimer){clearTimeout(this.persistTimer);this.persistTimer=null;}
    const started=performance.now(),body=reuse?this.serialize():JSON.stringify(this.data);
    const tmp=this.file+'.'+randomUUID()+'.tmp';const fd=fs.openSync(tmp,'wx',0o600);
    try{try{fs.writeFileSync(fd,body);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}catch(error){fs.rmSync(tmp,{force:true});throw error;}
    // How long saving takes, for /api/health: this is time the service cannot do anything else.
    const ms=performance.now()-started,m=this.writeStats||={writes:0,totalMs:0,maxMs:0,lastMs:0,bytes:0};m.writes++;m.totalMs+=ms;m.maxMs=Math.max(m.maxMs,ms);m.lastMs=ms;m.bytes=typeof body==='string'?Buffer.byteLength(body):body.length;
    try{fs.renameSync(tmp,this.file);}catch(error){fs.rmSync(tmp,{force:true});throw error;}
    // Past this point the file on disk is the new state. A failed folder sync only leaves its
    // durability across a power cut unknown; rolling memory back would make the two disagree.
    try{const d=fs.openSync(this.dir,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}this.durability=null;}
    catch(error){this.durability={uncertain:true,at:new Date().toISOString(),code:String(error?.code||'sync_failed').slice(0,40)};}
  }
  // The callback edits a private copy; nothing is visible or saved unless it returns normally.
  // Only the top-level sections it actually opens are copied, so recording an action or a
  // usage count no longer copies and re-encodes every task ever run.
  transaction(fn){
    const old=this.data,draft={...old},opened=new Set();
    const open=key=>{if(!opened.has(key)){opened.add(key);const value=draft[key];if(value!==null&&typeof value==='object')draft[key]=structuredClone(value);}};
    const view=new Proxy(draft,{
      get(target,key){if(typeof key==='string')open(key);return target[key];},
      set(target,key,value){if(typeof key==='string')opened.add(key);target[key]=value;return true;},
      deleteProperty(target,key){if(typeof key==='string')opened.add(key);return delete target[key];},
      getOwnPropertyDescriptor(target,key){if(typeof key==='string'&&Object.hasOwn(target,key))open(key);return Reflect.getOwnPropertyDescriptor(target,key);}
    });
    const result=fn(view);draft.revision=(draft.revision||0)+1;this.data=FREEZE?freeze(draft):draft;
    // When every task was copied anyway, one plain pass is the cheapest way to write them.
    try{this.persist({reuse:!opened.has('tasks')});}catch(e){this.data=old;throw e;}
    this.emit('change',{revision:draft.revision});return result;
  }
  writeSummary(){const m=this.writeStats;return m?{writes:m.writes,averageMs:Math.round(m.totalMs/m.writes*10)/10,maxMs:Math.round(m.maxMs*10)/10,lastMs:Math.round(m.lastMs*10)/10,megabytes:Math.round(m.bytes/1e5)/10,...(this.durability?{durability:this.durability}:{})}:null;}
  task(id){const t=this.data.tasks.find(t=>t.id===id);if(!t)throw new AppError('not_found','任务不存在',404);return t;}
  // A change to one task copies and rewrites only that task. With hundreds of tasks in the
  // state, copying and serializing all of them for every progress event blocked the service
  // for a noticeable moment each time. A callback that also takes the whole state
  // (`(task,state)=>`) still gets the full copy.
  updateTask(id,fn,{defer=false}={}){
    if(fn.length>=2)return this.transaction(s=>{const t=s.tasks.find(t=>t.id===id);if(!t)throw new AppError('not_found','任务不存在',404);fn(t,s);t.updatedAt=now();return structuredClone(t);});
    const old=this.data,index=old.tasks.findIndex(t=>t.id===id);if(index<0)throw new AppError('not_found','任务不存在',404);
    const task=structuredClone(old.tasks[index]);fn(task);task.updatedAt=now();
    const tasks=old.tasks.slice();tasks[index]=task;const next={...old,tasks,revision:old.revision+1};this.data=FREEZE?freeze(next):next;
    if(defer)this.persistSoon();else try{this.persist({reuse:true});}catch(e){this.data=old;throw e;}
    this.emit('change',{revision:this.data.revision,taskId:id});return structuredClone(task);
  }
  // Display-only progress (timings, transport notes, native tool lines) is visible at once
  // but written together a moment later: a busy task no longer rewrites the state file for
  // every such line. Anything that matters after a crash (messages, approvals, actions,
  // status, results) is still written before the call returns, and takes these along.
  persistSoon(){
    if(this.persistTimer||this.closed)return;
    this.persistTimer=setTimeout(()=>{this.persistTimer=null;if(this.closed)return;try{this.persist({reuse:true});}catch{this.persistSoon();}},PROGRESS_WRITE_DELAY_MS);
    this.persistTimer.unref?.();
  }
  flush(){if(this.persistTimer&&!this.closed)this.persist({reuse:true});}
  event(id,type,text,data={}){this.updateTask(id,t=>{t.events.push({id:randomUUID(),at:now(),type,text,...data});if(t.events.length>500)t.events.splice(0,t.events.length-500);},{defer:PROGRESS_EVENTS.has(type)});}
  close(){if(this.closed)return;try{this.flush();}catch{}this.closed=true;if(this.ownsLock&&ownedLock(this.lockPath,this.lockIdentity))fs.rmSync(this.lockPath,{recursive:true,force:true});}
}
