import {randomUUID} from 'node:crypto';
import {initializeTimeline,createTaskContract} from '../src/core/task-contract.mjs';
import {toolsForTask} from '../src/tools/broker.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMailRequest} from '../src/core/mail-contract.mjs';
import {parseMediaRequest} from '../src/core/media-contract.mjs';
import {phoneUseGrant,classifyPhoneUseAction,effectGoalStatus} from '../src/adapters/phone-use.mjs';
import {nativeNode as n,nativeButton as b,nativePage as page,nativeTask as task,nativeTap as tap,nativeBrokerFixture as fixture} from './helpers/phone-native-fixture.mjs';
const APP={packageName:'com.google.android.gm',label:'Gmail',appName:'Gmail'};
const prompt='用Gmail账户“sender@example.com”给“receiver@example.com”发送邮件，主题“明天会议”，正文“会议改到十点。”';
const field=(label,text,y,edit=false)=>n(text,y,{description:label,...(edit?{class:'android.widget.EditText',editable:true,focused:label==='正文',actions:['set_text','tap']}:{})});
function draft(changes={},sent=false){const values={发件人:'sender@example.com',收件人:'receiver@example.com',主题:'明天会议',正文:'会议改到十点。',...changes};return page(APP,[...Object.entries(values).map(([k,v],i)=>field(k,v,100+i*250,!sent&&k!=='发件人')),...(sent?[n('已发送',1300),field('邮件ID','message-123456@example.com',1400),field('发送时间',new Date(Date.now()+10).toISOString(),1500)]:[b('发送',2100)])]);}
test('mail and media require original exact account, destination/body/subject or audience and named material',()=>{
 assert.equal(parseMailRequest(prompt).subject,'明天会议');assert.equal(phoneUseGrant(task(prompt),APP).effectPlan.kind,'send_mail');
 for(const raw of [prompt.replace('账户“sender@example.com”',''),prompt.replace('，主题“明天会议”',''),prompt+'，抄送“someone@example.com”'])assert.equal(parseMailRequest(raw),null);
 const media='在小红书账号“test-user”发布图片“photo.png”，正文“今天的照片”，可见范围“仅自己”';assert.equal(parseMediaRequest(media).mediaType,'image');for(const raw of [media.replace('账号“test-user”',''),media.replace('，可见范围“仅自己”',''),media.replace('photo.png','../photo.png')])assert.equal(parseMediaRequest(raw),null);
 assert.equal(phoneUseGrant(task(prompt.replace('账户“sender@example.com”','')),APP),null);
});
test('wrong sender, subject, recipient or body refuses send; old mail receipts and acceptance alone refuse success',()=>{
 const grant=phoneUseGrant(task(prompt),APP),initial=draft(),decision=classifyPhoneUseAction('t',tap(initial,'发送'),initial,grant);assert.equal(decision.kind,'effect_mail_send');
 for(const changes of [{发件人:'other@example.com'},{收件人:'other@example.com'},{主题:'wrong'},{正文:'wrong'}]){const bad=draft(changes);assert.equal(classifyPhoneUseAction('t',tap(bad,'发送'),bad,grant),null);}
 const sent=draft({},true);assert.equal(effectGoalStatus(sent,grant,[]).verified,false);assert.equal(effectGoalStatus(sent,grant,[{status:'completed',phoneEffect:decision,startedAt:new Date(Date.now()+10000).toISOString()}]).verified,false);
});
test('unknown mail send cannot be repeated even when the draft remains visible',async()=>{
 const f=fixture(prompt,APP,draft(),[new Error('lost response')]);await f.broker.execute('t','phone_use',{action:'open_app',app:'Gmail'});await assert.rejects(f.broker.execute('t','phone_use',{action:'tap',target:'发送'}));assert.equal(f.data.actions[0].status,'unknown');await assert.rejects(f.broker.execute('t','phone_use',{action:'tap',target:'发送'}));assert.equal(f.calls.filter(c=>c.name==='tap').length,1);
});

test('all supported outbound app routes expose only bound semantic tools and refuse impersonated packages',()=>{
 const apps=[['Gmail','com.google.android.gm'],['Outlook','com.microsoft.office.outlook'],['三星邮件','com.samsung.android.email.provider'],['小红书','com.xingin.xhs'],['抖音','com.ss.android.ugc.aweme'],['哔哩哔哩','tv.danmaku.bili']];
 for(const [app,packageName]of apps){const mail=['Gmail','Outlook','三星邮件'].includes(app),raw=mail?prompt.replace('Gmail',app)+'，附件“报告.txt”':`在${app}账号“test-user”发布图片“photo.png”，正文“今天的照片”，可见范围“仅自己”`,t=task(raw,{cloudConsent:true});initializeTimeline(t,{budgetMs:60000});t.taskContract=createTaskContract(t);const artifact={id:randomUUID(),taskId:t.id,name:mail?'报告.txt':'photo.png',mime:mail?'text/plain':'image/png',size:20,sha256:'a'.repeat(64)},store={data:{tasks:[t],artifacts:[artifact],settings:{memoryEnabled:false}}};const grant=phoneUseGrant(t,{appName:app,packageName},{store});assert.equal(grant?.effectPlan.kind,mail?'send_mail':'publish_media',app);assert.equal(phoneUseGrant(t,{appName:app,packageName:'com.fake.app'},{store}),null,app);const tools=toolsForTask(t,{store}).map(d=>d.name);assert.ok(tools.includes('phone_prepare_attachment'));assert.ok(tools.includes('phone_use'));assert.equal(tools.includes('phone_action'),false);assert.equal(tools.includes('phone_prepare_payment'),false);}
});

test('pausing the live task before mail dispatch cannot send',async()=>{
 const f=fixture(prompt,APP,draft(),[draft({},true)]);await f.broker.execute('t','phone_use',{action:'open_app',app:'Gmail'});f.t.status='paused';
 await assert.rejects(f.broker.execute('t','phone_use',{action:'tap',target:'发送'}));assert.equal(f.calls.filter(c=>c.name==='tap').length,0);assert.equal(f.data.actions.length,0);
});
