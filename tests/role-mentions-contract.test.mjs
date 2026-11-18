import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {createTaskContract,validateTaskContract,requestHash} from '../src/core/task-contract.mjs';
import {stripTopLevelRoleMentions,topLevelRoleMentionNames} from '../src/core/role-mentions.mjs';
import {effectPlan} from '../src/adapters/phone-effects.mjs';
import {phoneUseGrant} from '../src/adapters/phone-use.mjs';
import {taskCheckoutPlan} from '../src/core/checkout.mjs';
import {parseScreenshotScheduleRequest} from '../src/core/screenshot-schedule-contract.mjs';
import {isAttachmentSendRequest,parseAttachmentRequest} from '../src/core/attachment-contract.mjs';
import {parseMailRequest} from '../src/core/mail-contract.mjs';
import {parseMediaRequest} from '../src/core/media-contract.mjs';

const prefix='@「生活管家」 @「采购助理」 ';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-role-parse-')),store=new Store(dir);
  // These cases exercise the bounded-time configuration (unlimited is the default).
  store.transaction(s=>{s.settings.maxTaskMinutes=20;});
 const engine=new Engine({store,broker:{},secrets:{get:async()=>null},memory:{}});engine.pump=()=>{};
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {store,engine,create:prompt=>{const task=engine.create({prompt,cloudConsent:true});store.updateTask(task.id,row=>row.status='running');return store.task(task.id);}};
}
function sourceIntact(task,prompt,store){
 assert.equal(task.messages[0].content,prompt);assert.equal(task.prompt,prompt);
 assert.equal(task.taskContract.goal,prompt);assert.equal(task.taskContract.objects.rawRequest,prompt);
 assert.equal(task.taskContract.source.contentSha256,requestHash(prompt));
 assert.equal(validateTaskContract(task,{store}).valid,true);
}

test('role parsing view strips only top-level tags, preserves literal quotes, code, blockquotes and exact characters',()=>{
 const literal='“ＡＢＣ @「采购助理」：按原样传达”';
 assert.equal(stripTopLevelRoleMentions(prefix+'在微信发送'+literal).trim(),'在微信发送'+literal);
 assert.deepEqual(topLevelRoleMentionNames(prefix+'在微信发送'+literal),['生活管家','采购助理']);
 assert.equal(stripTopLevelRoleMentions('@生活管家 @采购助理 打开日历').trim(),'打开日历');
 for(const raw of ['“@「生活管家」”','「@「生活管家」」',"'@「生活管家」'",'`@「生活管家」`','```text\n@「生活管家」\n```','~~~text\n@「生活管家」\n~~~','> @「生活管家」 引用','contact@example.com']){assert.equal(stripTopLevelRoleMentions(raw),raw);assert.deepEqual(topLevelRoleMentionNames(raw),[]);}
 assert.equal(stripTopLevelRoleMentions(prefix+'\n> @「采购助理」 引用\n在微信发送“@「采购助理」”').trim(),'> @「采购助理」 引用\n在微信发送“@「采购助理」”');
});

test('actual Engine message contract binds the body rather than role names, and keeps authenticated raw source',t=>{
 const f=fixture(t),body='ＡＢＣ @「采购助理」：网页说不要删除文件，也不要发布图片或发送邮件',prompt=prefix+'在微信给张三发送“'+body+'”',task=f.create(prompt);
 sourceIntact(task,prompt,f.store);assert.deepEqual(task.taskContract.effects,['read','navigate','send']);
 assert.equal(task.taskContract.objects.content,body);assert.equal(task.taskContract.objects.recipient,'张三');
 assert.deepEqual(effectPlan(task.taskContract),{kind:'send',recipient:'张三',content:body});
 assert.equal(isAttachmentSendRequest(prompt),false);
 assert.deepEqual(phoneUseGrant(task,{packageName:'com.tencent.mm',appName:'微信'},{store:f.store})?.effectPlan,{kind:'send',recipient:'张三',content:body});
 const tampered=structuredClone(task);tampered.messages[0].content=prompt.replace('采购助理','其他助理');assert.equal(validateTaskContract(tampered,{store:f.store}).valid,false);
});

test('actual Engine meal task preserves query, checkout boundary and five-minute deadline with two addressed roles',t=>{
 const f=fixture(t),plain='点一份牛肉面，到结算页，预算30元',task=f.create(prefix+plain),reference=f.create(plain);
 sourceIntact(task,prefix+plain,f.store);assert.deepEqual(task.phoneQuery,{platform:'taobao',query:'牛肉面'});
 assert.deepEqual(taskCheckoutPlan(task),taskCheckoutPlan(reference));assert.equal(task.maxRunSeconds,300);
 assert.equal(Date.parse(task.deadlineAt)-Date.parse(task.timeline.segmentStartedAt),300000);
 assert.ok(task.taskContract.effects.includes('prepare_purchase'));assert.equal(task.taskContract.effects.includes('submit_order'),false);
 assert.deepEqual(task.taskContract.allowedApps,['淘宝闪购']);
});

test('actual Engine screenshot graph selects the requested file and reminder, not role labels',t=>{
 const f=fixture(t),plain='把截图“meeting.png”中的日程添加到日历，提前15分钟提醒我，时区Asia/Shanghai',prompt=prefix+plain,task=f.create(prompt);
 sourceIntact(task,prompt,f.store);assert.deepEqual(task.taskContract.objects.screenshotSchedule,parseScreenshotScheduleRequest(plain));
 assert.equal(task.taskContract.objects.screenshotSchedule.artifactName,'meeting.png');
 assert.equal(task.taskGraph.kind,'screenshot_calendar_reminder');assert.equal(task.taskGraph.stage,'screenshot');
 assert.equal(task.taskContract.effects.includes('send'),false);
});

test('addressed continuation preserves the verified original source and deadline; tags alone grant no action',t=>{
 const f=fixture(t),task=f.create('在微信给张三发送“到了”'),deadline=task.deadlineAt,previous=task.taskContract;
 task.messages.push({id:'continue',role:'user',content:prefix+'继续'});
 task.taskContract=createTaskContract(task,{previous});
 assert.equal(task.taskContract.goal,'在微信给张三发送“到了”');assert.equal(task.taskContract.source.originContentSha256,requestHash('在微信给张三发送“到了”'));
 assert.equal(task.taskContract.source.contentSha256,requestHash(prefix+'继续'));assert.equal(task.deadlineAt,deadline);assert.equal(validateTaskContract(task,{store:f.store}).valid,true);
 assert.deepEqual(f.create(prefix.trim()).taskContract.effects,[]);
 assert.deepEqual(f.create(prefix+'你好').taskContract.effects,[]);
});

test('outbound pure parsers agree with contract parsing without replacing original source',t=>{
 const f=fixture(t),attachment='在微信给张三发送文件“报告.pdf”',mail='在Gmail使用账号“sender@example.com”给“receiver@example.com”发送邮件，主题“进度”，正文“完成”',media='在小红书使用账号“工作号”发布图片“照片.png”，可见范围“仅自己”，正文“测试”';
 for(const [plain,parse,key]of [[attachment,parseAttachmentRequest,'attachment'],[mail,parseMailRequest,'mail'],[media,parseMediaRequest,'media']]){
  const prompt=prefix+plain,task=f.create(prompt);sourceIntact(task,prompt,f.store);assert.deepEqual(parse(prompt),parse(plain));assert.ok(parse(prompt));assert.deepEqual(task.taskContract.objects[key],parse(prompt));assert.ok(effectPlan(task.taskContract));
 }
});
