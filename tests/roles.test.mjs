import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

// Exercise the real HTTP boundary and on-disk persistence without the model or personal vault.
test('Bot colors are assigned automatically, validated, copied and persisted across restart', {timeout:30000}, async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pa-roles-'));
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));
  const port=socket.address().port;await new Promise(r=>socket.close(r));
  const origin=`http://127.0.0.1:${port}`;let child,cookie,csrf;
  const stop=async()=>{if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}};
  t.after(async()=>{await stop();fs.rmSync(dir,{recursive:true,force:true});});
  async function start(){
    child=spawn(process.execPath,['src/server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,BOUJOY_PORT:String(port),BOUJOY_DATA:dir,BOUJOY_MEMORY_VAULT:path.join(dir,'no-personal-memory')},stdio:'ignore'});
    for(let i=0;i<100;i++){try{const r=await fetch(origin+'/api/session');if(r.ok){cookie=r.headers.get('set-cookie').split(';')[0];csrf=(await r.json()).csrf;return;}}catch{}await new Promise(r=>setTimeout(r,50));}
    throw Error('Test server did not start');
  }
  async function api(route,data){const r=await fetch(origin+'/api'+route,{method:data?'POST':'GET',headers:{Cookie:cookie,Origin:origin,'X-Boujoy-CSRF':csrf,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});return {status:r.status,data:await r.json()};}
  const colors=['violet','amber','green','blue','pink','coral','teal','silver','gold','sky','orchid','lime'];await start();
  const input={name:'Test Bot',description:'Synthetic QA only',instruction:'Do not call external services.'};
  const created=await api('/roles',input);assert.equal(created.status,201);assert.ok(colors.includes(created.data.botColor));
  const id=created.data.id,color=created.data.botColor;
  assert.equal((await api('/roles',{...input,botColor:'invalid'})).status,400);
  await stop();await start();assert.equal((await api('/state')).data.roles.find(r=>r.id===id).botColor,color);
  const edited=await api('/roles/'+id,{botColor:'coral'});assert.equal(edited.data.botColor,'coral');
  assert.equal((await api('/roles/'+id,{botColor:'invalid'})).status,400);
  const copied=await api('/roles/'+id,{copy:true});assert.notEqual(copied.data.id,id);assert.ok(colors.includes(copied.data.botColor));
  assert.equal((await api('/state')).data.roles.find(r=>r.id===id).botColor,'coral');
  const task=(await api('/tasks',{prompt:'只留在本机的角色历史',roleId:id,clientRequestId:crypto.randomUUID(),cloudConsent:false})).data;
  const rule=(await api('/routines',{name:'暂停规则',prompt:'本地提醒',roleId:id,taskKind:'reminder',kind:'daily',time:'23:59'})).data;
  assert.equal((await api('/roles/concierge',{remove:true})).status,400);
  assert.equal((await api('/roles/'+id,{remove:true})).status,200);
  const deleted=(await api('/state')).data;assert.ok(deleted.roles.find(r=>r.id===id).deletedAt);assert.equal(deleted.tasks.find(t=>t.id===task.id).status,'paused');assert.equal(deleted.routines.find(r=>r.id===rule.id).enabled,false);
  assert.equal((await api('/tasks',{prompt:'不可派发',roleId:id,cloudConsent:false})).status,400);
  await api('/roles/'+id,{restore:true});const restored=(await api('/state')).data;assert.equal(restored.roles.find(r=>r.id===id).hidden,false);assert.equal(restored.tasks.find(t=>t.id===task.id).status,'paused');assert.equal(restored.routines.find(r=>r.id===rule.id).enabled,false);
  for(const route of ['/robot-motion.js','/robot-head-base.png','/robot-eyes-atlas.png']){const r=await fetch(origin+route);assert.equal(r.status,200);if(route.endsWith('.png'))assert.equal(r.headers.get('content-type'),'image/png');}
});

test('bots get colors no other visible bot uses, and a one-time pass separates bots that shared one',async()=>{
  const {BOT_COLORS,chooseBotColor,distinctBotColors,createRole}=await import('../src/core/roles.mjs');
  assert.equal(new Set(BOT_COLORS).size,12);
  const roles=[{id:'concierge'},{id:'a',botColor:'amber'},{id:'b',botColor:'amber'},{id:'c',botColor:'violet'},{id:'gone',botColor:'green',deletedAt:'x',hidden:true},{id:'d',botColor:'nonsense'}];
  const changed=distinctBotColors(roles);
  assert.equal(roles[0].botColor,'violet','a default bot keeps its default color');assert.equal(roles[1].botColor,'amber','the first holder keeps its color');
  const visible=roles.filter(r=>!r.hidden);assert.equal(new Set(visible.map(r=>r.botColor)).size,visible.length);
  assert.equal(roles[4].botColor,'green','a deleted bot is left alone');assert.deepEqual(changed.sort(),['b','c','concierge','d'].filter(id=>roles.find(r=>r.id===id).botColor!==({b:'amber',c:'violet',d:'nonsense'})[id]).sort());
  assert.equal(distinctBotColors(roles).length,0,'running it again changes nothing');
  const used=new Set(visible.map(r=>r.botColor));assert.equal(used.has(chooseBotColor(undefined,roles)),false);
  assert.equal(used.has(createRole({name:'新助理',description:'x',instruction:'x'},roles).botColor),false);
  assert.equal(chooseBotColor('coral',roles),'coral','an explicit choice is kept even if taken');
});
