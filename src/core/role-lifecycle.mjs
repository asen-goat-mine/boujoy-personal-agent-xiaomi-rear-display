import {requireValue,now} from './errors.mjs';

export async function removeBotRole({store,engine,eventTriggers},id){
 const existing=store.data.roles.find(r=>r.id===id);requireValue(existing,'助理不存在');requireValue(id!=='concierge','总助理不能删除');
 if(!existing.deletedAt)for(const rule of (store.data.eventRules||[]).filter(r=>r.roleId===id&&!r.deletedAt))await eventTriggers.revokeRule(rule.id);
 // Fence new work immediately; keep history and unknown receipts intact.
 store.transaction(s=>{const r=s.roles.find(r=>r.id===id);r.deletedAt||=now();r.hidden=true;if(r.brief)r.brief.enabled=false;for(const watch of (s.watches||[]).filter(w=>w.roleId===id&&w.status==='active')){watch.status='paused';watch.pausedAt=now();}for(const routine of s.routines.filter(r=>r.roleId===id)){routine.enabled=false;routine.pausedAt=now();routine.cloudConsent=false;routine.memoryConsent=false;routine.authorization=null;}});
 for(const task of store.data.tasks.filter(t=>t.roleId===id&&!['completed','ready_for_user','cancelled','failed','expired'].includes(t.status)))await engine.stop(task.id,{pause:true});
 for(const routine of store.data.routines.filter(r=>r.roleId===id))await engine.revokeRoutineTasks(routine.id);
 return {id:existing.id,name:existing.name,removed:true};
}
