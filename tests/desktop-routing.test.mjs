import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {Broker} from '../src/tools/broker.mjs';
import {readDocumentBuffer} from '../src/tools/documents.mjs';

function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-desktop-route-')),store=new Store(path.join(dir,'data'));
  store.transaction(s=>{s.settings.phoneEnabled=true;});
  let phoneCalls=0,approvals=0;
  const phone={lease:null,release(){},close(){},assertRemoteDataAvailable(){phoneCalls++;throw Object.assign(new Error('phone paused'),{code:'phone_control_paused',dispatchState:'not_sent'});}};
  const broker=new Broker({store,dataDir:path.join(dir,'data'),phone,browser:{close(){}},memory:{},approvals:{cancelTask(){},request(){approvals++;throw Error('unexpected approval');}}});
  const engine=new Engine({store,broker,secrets:{get:async()=>null},memory:{}});engine.pump=async()=>{};
  t.after(()=>{engine.groups.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const create=(prompt,extra={})=>{const task=engine.create({prompt,cloudConsent:true,...extra});store.updateTask(task.id,t=>t.status='running');return store.task(task.id);};
  return {dir,store,broker,engine,create,get phoneCalls(){return phoneCalls;},get approvals(){return approvals;}};
}
const data=result=>JSON.parse(result.content[0].text);
const evidence=result=>result.content.flatMap(part=>{try{return JSON.parse(part.text).finishEvidenceRefs||[];}catch{return [];}});
const pricePrompt='查 iPhone 17 Pro 256G 在京东和苹果中国官网的价格并对比';
const draftPrompt='写封英文邮件给房东说房租晚 3 天交，存成 Word。只保存草稿，不发送；保存到文稿/Boujoy，文件名「上线验收-2026-11-03-房租邮件.docx」，不覆盖已有文件。';

test('ASCII application aliases require word boundaries without losing Chinese adjacency',t=>{
  const f=fixture(t);
  for(const prompt of [pricePrompt,'查询 telephone 和 smartphone 的英文意思','查看 HeadPhone 价格','整理 WhatsAppBackup 的文档']){
    const apps=f.create(prompt).taskContract.allowedApps;
    assert.ok(!apps.includes('Phone'),prompt);assert.ok(!apps.includes('WhatsApp'),prompt);
  }
  assert.ok(f.create('打开Phone').taskContract.allowedApps.includes('Phone'));
  assert.ok(f.create('打开QQ音乐').taskContract.allowedApps.includes('QQ'),'ASCII aliases may remain adjacent to Chinese text');
});

test('a natural desktop comparison can recover from optional phone access and keep using web tools',async t=>{
  const f=fixture(t);
  for(const prompt of [pricePrompt,'看看我下载文件夹里那个「Boujoy 手机端设计稿.html」，三句话讲讲']){
    const task=f.create(prompt);
    assert.notEqual(f.engine.reasoningFor(task),'low');
    await assert.rejects(f.broker.execute(task.id,'phone_use',{action:'read'}),{code:'phone_unavailable',dispatchState:'not_sent'});
    assert.equal(f.store.task(task.id).status,'running');assert.equal(f.store.data.actions.length,0);
    f.broker.web={search:async()=>({results:[{title:'公开资料',url:'https://example.com/',snippet:'工具可继续执行'}]})};
    const result=await f.broker.execute(task.id,'web_search',{query:'公开资料'});
    assert.match(JSON.stringify(result),/工具可继续执行/);assert.equal(evidence(result).length,1);
  }
});

test('explicit phone requests, remote device tasks and actual phone history retain the control pause',async t=>{
  const f=fixture(t);
  for(const kind of ['explicit','remote','scope','action']){
    const task=f.create(kind==='explicit'?'用手机查商品价格':pricePrompt);
    if(kind==='remote')f.store.updateTask(task.id,t=>t.remoteDeviceId='bound-device');
    if(kind==='scope')f.store.updateTask(task.id,t=>t.phoneUseScope={mode:'general'});
    if(kind==='action')f.store.transaction(s=>s.actions.push({id:'phone-proof',taskId:task.id,tool:'phone_use',status:'completed'}));
    await assert.rejects(f.broker.execute(task.id,'phone_use',{action:'read'}),{code:'phone_control_paused',dispatchState:'not_sent'});
    assert.equal(f.store.task(task.id).status,'paused',kind);
  }
});

test('legacy tasks without a contract use the original-user parser only to classify an unavailable phone',async t=>{
  const f=fixture(t);
  for(const [prompt,code,status] of [
    ['打开设置，查看电池用量，再返回设置首页','phone_control_paused','paused'],
    [pricePrompt,'phone_unavailable','running'],
    ['看看我下载文件夹里那个「Boujoy 手机端设计稿.html」，三句话讲讲','phone_unavailable','running'],
    [draftPrompt,'phone_unavailable','running'],
  ]){
    const task=f.create(prompt),deadline=task.deadlineAt;
    f.store.updateTask(task.id,t=>{delete t.taskContract;});
    await assert.rejects(f.broker.execute(task.id,'phone_use',{action:'read'}),{code,dispatchState:'not_sent'});
    const after=f.store.task(task.id);
    assert.equal(after.status,status,prompt);assert.equal(after.deadlineAt,deadline,prompt);
    assert.equal(after.taskContract,undefined,'error classification does not create an execution grant');
    assert.equal(f.store.data.actions.length,0);
  }
});

test('local document topics and filenames do not become phone app authority or message bodies',t=>{
  const f=fixture(t);
  for(const prompt of [draftPrompt,'整理文件清单存成 Excel，文件名「邮件目录.xlsx」','写一份 Phone 和邮件产品的比较文档，保存到文稿/Boujoy']){
    const c=f.create(prompt).taskContract;
    assert.deepEqual(c.allowedApps,[],prompt);assert.ok(!c.effects.includes('send'),prompt);assert.equal(c.objects.content,undefined,prompt);
  }
  for(const prompt of ['在手机邮件App写草稿，不发送','用Gmail写一封邮件草稿，再保存成 Word']){
    const c=f.create(prompt).taskContract;
    assert.ok(c.allowedApps.some(name=>['邮件','Gmail'].includes(name)),prompt);
    assert.ok(!c.effects.includes('send'),prompt);
  }
});

test('a real local Word draft can be created, saved, read and finished without phone effects',async t=>{
  const f=fixture(t),taskHome=path.join(f.dir,'home');fs.mkdirSync(path.join(taskHome,'Documents'),{recursive:true});t.mock.method(os,'homedir',()=>taskHome);
  const task=f.create(draftPrompt),name='上线验收-2026-11-03-房租邮件.docx';
  const created=await f.broker.execute(task.id,'document_create',{format:'docx',name,title:'Rent payment draft',content:{sections:[{paragraphs:['Dear Landlord,','I am writing to ask if I may pay this month’s rent three days late.','Thank you for your understanding.']}]}});
  const artifact=data(created);assert.equal(artifact.name,name);
  const saved=await f.broker.execute(task.id,'mac_files',{action:'save',artifactId:artifact.id,path:name});assert.equal(data(saved).written,true);
  const read=await f.broker.execute(task.id,'artifact_read',{id:artifact.id});assert.match(JSON.stringify(read),/three days late/);
  const actual=fs.readFileSync(path.join(taskHome,'Documents/Boujoy',name));
  assert.match(JSON.stringify(await readDocumentBuffer({format:'docx',buffer:actual})),/three days late/);
  await f.broker.execute(task.id,'finish_task',{outcome:'completed',summary:'英文邮件草稿已保存为 Word，尚未发送。',evidence:[...evidence(saved),...evidence(read)]});
  assert.equal(f.store.task(task.id).status,'completed');assert.equal(f.phoneCalls,0);assert.equal(f.approvals,0);assert.equal(f.store.data.actions.length,0);
});

test('a desktop-worded request does not stop the model from choosing the phone',async t=>{
  // Wording is not a gate for a direct user task: the Harness decides whether the phone helps.
  const f=fixture(t),task=f.create(pricePrompt);let acquired=0;
  f.broker.waitForPhone=async()=>{acquired++;throw Object.assign(Error('phone requested'),{code:'phone_requested'});};
  for(const action of [{action:'open_app',app:'京东'},{action:'tap',target:'搜索'},{action:'type',text:'iPhone 17 Pro'}]){
    await assert.rejects(f.broker.execute(task.id,'phone_use',action),{code:'phone_requested'});
  }
  assert.equal(acquired,3);assert.equal(f.store.data.actions.length,0);assert.equal(task.status,'running');
  const result=await f.broker.execute(task.id,'task_context',{});assert.ok(result.content.length);
});

test('computer website and product requests leave the phone choice to the model',async t=>{
  const f=fixture(t);let acquired=0;f.broker.waitForPhone=async()=>{acquired++;throw Object.assign(Error('phone requested'),{code:'phone_requested'});};
  for(const prompt of [
    '只用电脑查 iPhone 在京东和苹果官网的价格，不要操作手机',
    '在电脑官网查手机价格，不能切换任何手机App',
    '打开京东官网查询手机价格，再整理成 Word',
    '在京东和苹果中国官网查 iPhone 价格并对比',
    '查询手机壳的网页价格，不用手机',
    '读「手机端设计稿.pdf」并总结',
    '把“打开微信查聊天记录”写入 Word 文档，不操作手机',
    '不要打开微信，在电脑官网查商品价格',
    '在电脑上打开微信查看聊天记录并整理成 Word',
    '用浏览器打开京东查询手机价格',
    '在电脑上打开微信给文件传输助手发送“测试正文”',
    '只用电脑打开「微信」查看聊天记录，再整理成 Word',
    '把『打开微信查看聊天记录』这句话写入 Word',
    '不要打开「微信」，只在官网查价格',
    '打开「微信官网」查询信息并生成 Word',
    '回到桌面文件夹，读“报告.txt”',
    '在电脑上打开文件，长按“报告.txt”查看本地文件菜单',
    '在电脑上在文件把“Download/报告.txt”重命名为“总结.txt”',
    '在官网查看手机页面设计文档并整理成 Word',
  ]){
    const task=f.create(prompt);
    const before=acquired;await assert.rejects(f.broker.execute(task.id,'phone_use',{action:'open_app',app:'京东'}),{code:'phone_requested'},prompt);
    assert.equal(acquired,before+1,prompt);assert.equal(f.store.task(task.id).status,'running');assert.equal(f.store.data.actions.length,0);
  }
  assert.equal(f.phoneCalls,0,'nothing reached the phone without a lease');
});

test('affirmative phone and native app work remains available in mixed document or web tasks',async t=>{
  const f=fixture(t);
  for(const prompt of [
    '用手机查看设置里的电池用量，再生成 Word 报告',
    '在手机邮件App写草稿，不发送，再保存成 Word',
    '用Gmail写一封邮件草稿，再保存成 Word',
    '打开「微信」查看聊天记录，再整理成Word',
    '用『Gmail』写草稿并存成Word',
    '打开微信查看聊天记录，然后整理成 Word',
    '在微信里查看文件传输助手消息，再查苹果官网',
    '查苹果官网价格，再在微信给文件传输助手发送“比价完成”',
    '把亮度调到30%，然后记录到 Excel',
    '查看手机淘宝页面，生成本机测试文本',
    '回到桌面',
    '打开最近任务界面',
    '打开文件，长按“报告.txt”',
    '在文件把“Download/报告.txt”重命名为“总结.txt”',
  ]){
    const task=f.create(prompt);
    await assert.rejects(f.broker.execute(task.id,'phone_use',{action:'read'}),{code:'phone_control_paused',dispatchState:'not_sent'},prompt);
    assert.equal(f.store.task(task.id).status,'paused',prompt);
  }
});

test('an existing unknown phone action still prevents a new mutation',async t=>{
  const f=fixture(t),task=f.create(pricePrompt);
  f.store.transaction(s=>s.actions.push({id:'real-unknown',taskId:task.id,tool:'phone_action',status:'unknown',nativeRequestId:'original-request'}));
  f.broker.waitForPhone=async()=>{};f.broker.phone.assertRemoteDataAvailable=()=>{};
  await assert.rejects(f.broker.execute(task.id,'phone_use',{action:'tap',target:'发送'}),{code:'outcome_unknown'});
  assert.equal(f.store.data.actions.length,1);assert.equal(f.store.data.actions[0].status,'unknown');
});


test('cross-end document delivery does not invent a phone mutation from its subject or input device',async t=>{
 const f=fixture(t);
 for(const remote of [false,true]){
  const task=f.create('继续刚才这份排障卡：我现在从 Mac 追问。手机和 Mac 可以通过已绑定的中继跨网络连接，并不要求同一 Wi-Fi；手机目前能保存 Markdown，但没有 Markdown 内置预览。请先核对你上次交付的文件，再让 Codex 据此修正，保存为新版本并回到同一聊天。不要把未验证的产品行为写成事实。',remote?{remoteDeviceId:'b3b94f1b-379a-4f02-a2b4-dc44bcf48ee1',remoteControlEpoch:1}:{});
  const made=await f.broker.execute(task.id,'artifact_write',{name:'排障卡修订.md',content:'两端通过已绑定的中继连接，不需要同一 Wi-Fi。'});
  const artifact=data(made);await f.broker.execute(task.id,'finish_task',{outcome:'completed',summary:'修订文件已交付本聊天',evidence:[artifact.id]});
  assert.equal(f.store.task(task.id).status,'completed');assert.equal(f.phoneCalls,0);
 }
});
