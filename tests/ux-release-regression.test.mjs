import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {Broker} from '../src/tools/broker.mjs';
import {groupTaskContext} from '../src/core/groups.mjs';
import {workbench} from '../src/core/bots.mjs';
import {removeBotRole} from '../src/core/role-lifecycle.mjs';
import {imagePreview} from '../src/remote/image-preview.mjs';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-ux-regression-')),store=new Store(dir);
 const broker=new Broker({store,dataDir:dir,memory:{},phone:{release(){},close(){}},browser:{close(){}},approvals:{cancelTask(){}}});
 const engine=new Engine({store,broker,secrets:{get:async()=>null},memory:{}});engine.pump=async()=>{};
 store.transaction(s=>s.roles.push({id:'helper',name:'帮手',description:'整理文件',instruction:'核对结果'}));
 t.after(async()=>{await engine.shutdown();store.close();fs.rmSync(dir,{recursive:true,force:true});});return {dir,store,engine,broker};
}
test('private conversation remains private after creating a group and handing off work',async t=>{
 const f=fixture(t),root=f.engine.create({prompt:'建个群，让帮手报到，别做其他操作',cloudConsent:true});f.store.updateTask(root.id,t=>t.status='running');
 const group=f.engine.groups.create({name:'协作测试',memberRoleIds:['concierge','helper']},{taskId:root.id});
 const receipt=f.engine.groups.handoff(root.id,{groupId:group.id,roleId:'helper',prompt:'在群里报到，不做其他操作'});
 assert.equal(groupTaskContext(root,f.store),null);
 const child=f.store.data.tasks.find(t=>t.parentId===root.id);assert.ok(child);assert.equal(groupTaskContext(child,f.store).groupId,group.id);
 f.store.updateTask(root.id,t=>{t.status='completed';t.result='已交班';});
 const follow=await f.engine.message(root.id,{message:'收到，接下来只和我私聊，回复测试完成',cloudConsent:true,clientRequestId:'12345678-1234-4234-8234-123456789abc'});assert.ok(follow.id);assert.equal(groupTaskContext(follow,f.store),null);
 await assert.rejects(f.engine.message(child.id,{message:'不能混入私聊',cloudConsent:true,clientRequestId:'22345678-1234-4234-8234-123456789abc'}),/群消息/);
 const summary=workbench(f.store).find(r=>r.id==='helper');assert.equal(summary.lastActivity,null);
});
test('role removal fences work, keeps history, stops schedules, and protects concierge',async t=>{
 const f=fixture(t),task=f.engine.create({prompt:'删除流程测试任务',roleId:'helper',cloudConsent:false});f.store.transaction(s=>{s.watches.push({id:'w',roleId:'helper',status:'active'});s.routines.push({id:'r',roleId:'helper',enabled:true,authorization:{id:'auth'}});s.roles.find(r=>r.id==='helper').brief={enabled:true};});
 await assert.rejects(removeBotRole({...f,eventTriggers:{}},'concierge'),/不能删除/);
 const result=await removeBotRole({...f,eventTriggers:{}},'helper');assert.equal(result.removed,true);assert.ok(f.store.data.roles.find(r=>r.id==='helper').deletedAt);assert.ok(f.store.task(task.id));assert.equal(f.store.task(task.id).status,'paused');assert.equal(f.store.data.watches[0].status,'paused');assert.equal(f.store.data.routines[0].enabled,false);assert.equal(f.store.data.routines[0].authorization,null);assert.equal(f.store.data.roles.find(r=>r.id==='helper').brief.enabled,false);
 assert.equal((await removeBotRole({...f,eventTriggers:{}},'helper')).removed,true);
});
test('saved group selection cannot become the private composer target',()=>{
 const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
 const c={state:{tasks:[{id:'private',roleId:'concierge',updatedAt:'1'},{id:'group',roleId:'concierge',groupId:'g',updatedAt:'2'}],roles:[{id:'concierge'}]},selections:{concierge:'group'},selectedRole:'concierge',selectedId:'group',location:{hash:'#role/concierge'},rememberSelection(){}};vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('const role=id=>'),source.indexOf('const clock='))+source.slice(source.indexOf('function parseRoute('),source.indexOf('function renderSidebar(')),c);c.parseRoute();assert.equal(c.selectedId,'private');
 c.state.tasks=c.state.tasks.filter(t=>t.id==='group');c.parseRoute();assert.equal(c.selectedId,null);
});
test('image previews are bounded JPEG bytes and never modify the source', {skip:process.platform!=='darwin'},async t=>{
 const f=fixture(t),file=path.join(f.dir,'test.png'),bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFuoAAAAASUVORK5CYII=','base64');fs.writeFileSync(file,bytes);
 const result=await imagePreview(file,'fixture');assert.equal(result[0],255);assert.equal(result[1],216);assert.ok(result.length<2*1024*1024);assert.deepEqual(fs.readFileSync(file),bytes);
});
