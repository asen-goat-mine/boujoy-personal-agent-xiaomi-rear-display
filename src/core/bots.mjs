// Bots: a role becomes a standing bot with its own notes about the user, a daily
// brief, and a workbench view of what it is doing. Notes come only from the
// user's own tasks; the brief is compiled from records, with no model call.
import {randomUUID} from 'node:crypto';
import {requireValue,shortText,now} from './errors.mjs';
import {nextScheduled} from './scheduler.mjs';
import {groupTaskContext} from './groups.mjs';

export const MAX_NOTES=60;
const NEEDS_YOU=['ready_for_user','needs_input','blocked','unknown_result','waiting_approval','waiting_consent','needs_review'];
const LIVE=['queued','running','waiting_approval','waiting_children'];

// ---- Notes (bot memory) ----
const REMEMBER_WORDS=/记住|记一下|记得|别忘|以后|下次|偏好|习惯|喜欢|不喜欢|讨厌|总是|一般都|忘掉|忘记|不用记|remember|forget|prefer/i;
export function userTalksAboutMemory(task){return (task?.messages||[]).some(m=>m.role==='user'&&!m.externalContent&&!m.external_content&&!m.interjection&&REMEMBER_WORDS.test(String(m.content||'')));}
export function addNote(role,text,{taskId=null,at=now()}={}){
  const value=shortText(text,'要记住的内容',200).replace(/\s+/g,' ').trim();
  const notes=role.notes||[];
  const same=notes.find(n=>n.text===value);if(same)return {note:same,added:false};
  requireValue(notes.length<MAX_NOTES,`这个助理已记住 ${MAX_NOTES} 条，请先删掉不需要的`,'bot_notes_full');
  const note={id:randomUUID(),text:value,at,taskId};role.notes=[...notes,note];return {note,added:true};
}
export function removeNote(role,id){const before=(role.notes||[]).length;role.notes=(role.notes||[]).filter(n=>n.id!==id);return before!==role.notes.length;}
export function notesForPrompt(role){
  const notes=(role?.notes||[]).slice(-MAX_NOTES);
  return notes.length?notes.map(n=>'- '+n.text).join('\n'):'（还没有）';
}
// A bot's notes are things the user told that bot to keep; they are listed and
// deletable on the bot's card. They follow the global memory switch and the
// turn's "don't remember" mode, not the separate auto-learning toggle.
export function botNotesAllowed(task,settings){
  return settings?.memoryEnabled!==false&&task?.cloudConsent===true&&task?.memoryMode!=='do_not_remember';
}
export function botIdentity(role){
  if(!role)return '';
  return `你是「${role.name}」${role.description?'，负责：'+role.description:''}。`;
}

// What this bot is responsible for over time, so it can answer "你最近在帮我盯什么".
export function standingJobs(store,role){
  const watches=(store.data.watches||[]).filter(w=>w.roleId===role.id&&['active','paused'].includes(w.status));
  const routines=(store.data.routines||[]).filter(r=>r.roleId===role.id&&r.enabled);
  const parts=[];
  if(watches.length)parts.push('你正在跟进：'+watches.slice(0,8).map(w=>`${w.goal}${w.status==='paused'?'（已暂停）':''}`).join('；'));
  if(routines.length)parts.push('你的例行事务：'+routines.slice(0,8).map(r=>`${r.name}（${r.kind==='daily'?'每天 '+r.time:r.kind==='weekly'?'每周 '+r.time:'一次'}）`).join('；'));
  if(role.brief?.enabled)parts.push(`你每天 ${role.brief.time} 给用户发简报。`);
  return parts.length?parts.join('\n'):'你目前没有挂着的跟进或例行事务。';
}

// ---- Daily brief ----
export function briefSettings(input,{timezone='Asia/Shanghai',at=Date.now()}={}){
  requireValue(input&&typeof input==='object','简报设置无效');
  const enabled=input.enabled===true,time=String(input.time||'08:30');
  requireValue(/^([01]\d|2[0-3]):[0-5]\d$/.test(time),'简报时间格式为 HH:mm');
  return {enabled,time,timezone,nextAt:enabled?nextScheduled({time,timezone,kind:'daily'},new Date(at)):null};
}
const fmt=(iso,timezone)=>{try{return new Intl.DateTimeFormat('zh-CN',{timeZone:timezone,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(iso));}catch{return iso;}};
export function composeBrief(store,role,{since,at=Date.now(),timezone='Asia/Shanghai'}={}){
  const data=store.data,roleId=role.id,sinceIso=since||new Date(at-86400000).toISOString(),dayEnd=at+86400000;
  const mine=t=>t.roleId===roleId&&!t.parentId&&(t.source||'user')!=='watch'&&(t.source||'user')!=='router';
  const lines=[];
  const watches=(data.watches||[]).filter(w=>w.roleId===roleId&&['active','paused'].includes(w.status));
  const changed=(data.watches||[]).filter(w=>w.roleId===roleId).flatMap(w=>(w.history||[]).filter(h=>h.at>=sinceIso&&['changed','met','changed_quiet'].includes(h.outcome)).map(h=>({w,h})));
  const routines=(data.routines||[]).filter(r=>r.roleId===roleId&&r.enabled);
  const upcoming=routines.filter(r=>r.nextAt&&Date.parse(r.nextAt)<=dayEnd).sort((a,b)=>a.nextAt.localeCompare(b.nextAt));
  const routineRuns=data.tasks.filter(t=>t.roleId===roleId&&t.source==='routine'&&(t.completedAt||t.updatedAt)>=sinceIso);
  const waiting=data.tasks.filter(t=>mine(t)&&!t.archived&&!t.watchNotice&&NEEDS_YOU.includes(t.status)&&t.updatedAt>=new Date(at-3*86400000).toISOString());
  const running=data.tasks.filter(t=>mine(t)&&LIVE.includes(t.status));
  const done=data.tasks.filter(t=>mine(t)&&!t.watchNotice&&t.status==='completed'&&(t.completedAt||t.updatedAt)>=sinceIso&&t.source!=='routine');
  lines.push(`早上好，这是「${role.name}」的简报（${fmt(new Date(at).toISOString(),timezone)}）。`);
  if(waiting.length)lines.push(`\n**等你处理（${waiting.length}）**\n`+waiting.slice(0,6).map(t=>`- ${t.title}：${String(t.blockedReason||t.result||'').slice(0,60)||t.status}`).join('\n'));
  if(changed.length)lines.push(`\n**跟进有动静（${changed.length}）**\n`+changed.slice(0,6).map(({w,h})=>`- ${w.goal}：${String(h.digest||w.lastSummary||'').slice(0,60)}${h.outcome==='met'?'（已达成）':''}`).join('\n'));
  if(watches.length)lines.push(`\n**正在跟进（${watches.length}）**\n`+watches.slice(0,6).map(w=>`- ${w.goal}${w.status==='paused'?'（已暂停）':''}：${String(w.lastSummary||'还没检查').slice(0,50)}`).join('\n'));
  if(routineRuns.length)lines.push(`\n**例行事务结果（${routineRuns.length}）**\n`+routineRuns.slice(-6).map(t=>`- ${t.title}：${String(t.result||t.blockedReason||t.status).slice(0,60)}`).join('\n'));
  if(upcoming.length)lines.push(`\n**接下来 24 小时**\n`+upcoming.slice(0,6).map(r=>`- ${fmt(r.nextAt,r.timezone||timezone)} ${r.name}`).join('\n'));
  if(running.length)lines.push(`\n**正在做（${running.length}）**\n`+running.slice(0,4).map(t=>`- ${t.title}`).join('\n'));
  if(done.length)lines.push(`\n**昨天以来完成（${done.length}）**\n`+done.slice(-5).map(t=>`- ${t.title}`).join('\n'));
  if(lines.length===1)lines.push('\n昨天以来没有新动静，也没有等你处理的事。');
  return lines.join('\n');
}

// ---- Workbench ----
export function workbench(store,{at=Date.now()}={}){
  const data=store.data;
  return data.roles.filter(r=>!r.hidden&&!r.deletedAt).map(role=>{
    const mine=t=>t.roleId===role.id&&!t.parentId&&!groupTaskContext(t,store)&&!['watch','router'].includes(t.source||'user');
    const running=data.tasks.filter(t=>mine(t)&&LIVE.includes(t.status));
    const waiting=data.tasks.filter(t=>mine(t)&&!t.archived&&!t.watchNotice&&NEEDS_YOU.includes(t.status)&&t.updatedAt>=new Date(at-3*86400000).toISOString());
    const last=data.tasks.filter(t=>mine(t)&&!t.watchNotice).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    return {id:role.id,name:role.name,description:role.description,botColor:role.botColor,
      state:running.length?'busy':waiting.length?'waiting':'idle',
      running:running.map(t=>({id:t.id,title:t.title,status:t.status})),
      waiting:waiting.slice(0,5).map(t=>({id:t.id,title:t.title,status:t.status})),
      watches:(data.watches||[]).filter(w=>w.roleId===role.id&&w.status==='active').length,
      routines:(data.routines||[]).filter(r=>r.roleId===role.id&&r.enabled).length,
      notes:(role.notes||[]).length,
      brief:role.brief?{enabled:role.brief.enabled,time:role.brief.time,nextAt:role.brief.nextAt,lastAt:role.brief.lastAt||null}:null,
      lastActivity:last?{id:last.id,title:last.title,status:last.status,at:last.updatedAt}:null};
  });
}
