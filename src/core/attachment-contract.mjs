import {stripTopLevelRoleMentions} from './role-mentions.mjs';
import {assertExecutionPermission} from './execution-permissions.mjs';
import {parseMailRequest} from './mail-contract.mjs';
import {parseMediaRequest} from './media-contract.mjs';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validateTaskContract,taskDeadline,requestHash} from './task-contract.mjs';
import {requireValue} from './errors.mjs';
import {DATA} from '../config.mjs';

const APPS=['微信','腾讯QQ','QQ','Telegram','WhatsApp'];
const PACKAGES={'微信':['com.tencent.mm'],'腾讯QQ':['com.tencent.mobileqq'],QQ:['com.tencent.mobileqq'],Telegram:['org.telegram.messenger'],WhatsApp:['com.whatsapp'],Gmail:['com.google.android.gm'],Outlook:['com.microsoft.office.outlook'],'三星邮件':['com.samsung.android.email.provider'],'小红书':['com.xingin.xhs'],'抖音':['com.ss.android.ugc.aweme'],'哔哩哔哩':['tv.danmaku.bili']};
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const QUOTE='[“「"]([^”」"\\n]{1,160})[”」"]';
const instruction=raw=>stripTopLevelRoleMentions(raw).replace(/“[^”]*”|「[^」]*」|"[^"]*"/g,'[数据]');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const MAX=8*1024*1024;
export function isAttachmentSendRequest(raw){const text=instruction(raw).replace(/文件传输助手|文件助手/g,'[收件人]');return /发送|发给|传给|分享给/.test(text)&&(/文件|附件|文档|报告|表格|图片|照片|录音|音频|视频/.test(text)||/[“「"][^”」"]+\.(?:pdf|docx|xlsx|pptx|txt|md|csv|png|jpe?g|webp|wav|m4a|mp3|mp4)[”」"]/i.test(String(raw)));}
export function parseAttachmentRequest(raw){
 raw=stripTopLevelRoleMentions(raw).trim();
 const text=String(raw||''),command=instruction(text);if(!isAttachmentSendRequest(raw))return null;
 if(/^(?:如何|怎么|怎样|解释|介绍)|(?:不要|不用|别|禁止|不允许|无需).{0,12}(?:发|传|分享)|(?:网页|页面|模型|助理|知识库|广告).{0,12}(?:说|要求|指示)|(?:忽略|绕过).{0,12}(?:权限|授权|规则)/.test(command))return null;
 const apps=APPS.filter(app=>command.toLowerCase().includes(app.toLowerCase())).filter(app=>app!=='QQ'||!command.includes('腾讯QQ'));if(apps.length!==1)return null;
 const idMatch=text.match(new RegExp('(?:附件|文件|产物)(?:\\s*ID|编号)\\s*[:：]?\\s*(?:'+QUOTE+'|([a-f0-9-]{36}))','i'));
 const files=[...text.matchAll(/[“「"]([^”」"\n]{1,160}\.[A-Za-z0-9]{1,10})[”」"]/g)].map(m=>m[1]);
 const names=[...new Set(files)];const artifactId=idMatch?(idMatch[1]||idMatch[2]):null;
 if(artifactId&&!ID.test(artifactId)||!artifactId&&names.length!==1||names.length>1)return null;
 const fileName=names[0]||null;if(fileName&&(/[\\/\x00-\x1f]/.test(fileName)||fileName==='.'||fileName==='..'||fileName.length>160))return null;
 const after=text.match(new RegExp('(?:发送给|发给|传给|分享给)\\s*(?:'+QUOTE+'|([^，。；!！?？\\s]{1,80}))(?=[，。；!！?？\\s]|$)'));
 const before=text.match(new RegExp('给\\s*(?:'+QUOTE+'|([^，。；!！?？\\s]{1,80}?))\\s*(?:发送|传送|分享)(?:文件|附件|文档|报告|表格|图片|照片|录音|音频|视频)?'));
 const match=after||before;if(!match)return null;const recipient=String(match[1]||match[2]||'').trim();
 if(!recipient||recipient.length>80||/[<>\x00-\x1f]|密码|验证码|忽略|授权/.test(recipient)||!match[1]&&/[、和及]|以及/.test(recipient))return null;
 if([...command.matchAll(/发送给|发给|传给|分享给|(?:发送|传送|分享)(?:文件|附件)/g)].length>1)return null;
 const body=text.match(/(?:附言|随附正文|留言)[“「"]([^”」"\n]{1,2000})[”」"]/);if((text.match(/(?:附言|随附正文|留言)[“「"]/g)||[]).length>1)return null;
 return {schemaVersion:1,kind:'send_attachment',app:apps[0],recipient,artifactId,fileName,...(body?{content:body[1]}:{})};
}
export function attachmentPlan(task,{store,artifactId,at=Date.now()}={}){
 const live=store?.data?.tasks?.find(t=>t.id===task?.id);
 requireValue(live&&same(live.taskContract,task.taskContract)&&live.status===task.status&&live.cloudConsent===task.cloudConsent&&same(live.messages,task.messages),'附件发送需要当前任务的实时授权','attachment_not_authorized');task=live;
 const checked=validateTaskContract(task,{store,at}),contract=checked.contract;
 requireValue(checked.valid&&['running','waiting_approval'].includes(task?.status)&&task.cloudConsent===true&&!store?.data?.recoveryFence?.required,'附件发送的任务授权已失效','attachment_not_authorized');
 requireValue((task.source||'user')==='user','附件发送需要本轮用户明确授权','attachment_not_authorized');
 const mail=contract.effects.includes('send_mail')&&parseMailRequest(contract.goal),media=contract.effects.includes('publish_media')&&parseMediaRequest(contract.goal),im=contract.effects.includes('send_attachment')&&parseAttachmentRequest(contract.goal);
 const request=mail?.attachment?{...mail,...mail.attachment}:media||im;
 requireValue(request&&(mail?same(mail,contract.objects.mail):media?same(media,contract.objects.media):same(im,contract.objects.attachment))&&contract.allowedApps.includes(request.app),'文件、应用或收件人尚未完整绑定','attachment_not_authorized');
 const candidates=(store?.data?.artifacts||[]).filter(a=>a.taskId===task.id&&(!request.artifactId||a.id===request.artifactId)&&(!request.fileName||a.name===request.fileName));
 requireValue(candidates.length===1,'当前任务没有唯一匹配的已生成或已上传文件，请明确文件编号','attachment_ambiguous');const artifact=candidates[0];
 requireValue(!artifactId||artifactId===artifact.id,'不能替换用户指定的附件','attachment_not_authorized');
 requireValue(ID.test(artifact.id)&&HASH.test(artifact.sha256||'')&&Number.isSafeInteger(artifact.size)&&artifact.size>0&&artifact.size<=MAX&&typeof artifact.name==='string'&&artifact.name.length<=160&&!/[\\/\x00-\x1f]/.test(artifact.name)&&typeof artifact.mime==='string'&&/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(artifact.mime),'附件记录不完整或超过 8 MiB','attachment_invalid');
 if(request.kind==='publish_media')requireValue(artifact.mime.startsWith(request.mediaType+'/'),'素材文件类型与原始请求不一致','attachment_invalid');
 const sourceMessageId=contract.source.originMessageId||contract.source.messageId,sourceSha256=contract.source.originContentSha256||contract.source.contentSha256;
 const source=task.messages.find(m=>m.id===sourceMessageId&&m.role==='user');requireValue(source&&requestHash(source.content)===sourceSha256,'附件授权来源已变化','attachment_not_authorized');
 requireValue(!store.data.roles?.find(r=>r.id===task.roleId)?.deletedAt,'助理已删除，不能发送附件','attachment_not_authorized');
 requireValue(Number.isFinite(taskDeadline(task)),'附件发送需要明确截止时间','attachment_not_authorized');
 return {...request,kind:request.kind,sourceMessageId,sourceSha256,contractId:contract.id,contractRevision:contract.revision,artifact:Object.fromEntries(['id','taskId','name','mime','size','sha256'].map(key=>[key,artifact[key]])),app:request.app,recipient:request.recipient,...(request.content?{content:request.content}:{}),expiresAt:Number.isFinite(taskDeadline(task))?new Date(taskDeadline(task)).toISOString():null};
}
export function validateAttachmentAuthorization({task,store,artifactId,targetPackage,authorization,at=Date.now()}){
 assertExecutionPermission(store,['phone','files']);
 const plan=attachmentPlan(task,{store,artifactId,at});
 requireValue(PACKAGES[plan.app]?.includes(targetPackage)&&same(plan,authorization),'附件传输的文件、应用、收件人或原始授权已变化','attachment_not_authorized');
 return plan;
}
export async function readAttachmentPayload(task,{store,artifactId,dataDir=DATA,at=Date.now()}={}){
 assertExecutionPermission(store,['files']);
 const plan=attachmentPlan(task,{store,artifactId,at}),artifact=store.data.artifacts.find(a=>a.id===plan.artifact.id&&a.taskId===task.id);
 requireValue(typeof artifact.path==='string'&&!path.isAbsolute(artifact.path)&&!artifact.path.includes('\\'),'附件路径无效','artifact_path_invalid');
 const root=path.join(await fs.realpath(dataDir),'artifacts');requireValue(await fs.realpath(root)===root,'附件根目录不能是链接','artifact_path_invalid');
 const file=path.resolve(root,artifact.path);requireValue(file.startsWith(root+path.sep),'附件路径越界','artifact_path_invalid');
 let current=root;for(const part of path.relative(root,file).split(path.sep)){current=path.join(current,part);requireValue(!(await fs.lstat(current)).isSymbolicLink(),'附件路径不能包含链接','artifact_path_invalid');}
 const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let bytes;
 try{const before=await handle.stat();requireValue(before.isFile()&&before.nlink===1&&before.size===plan.artifact.size&&before.size<=MAX,'附件文件状态已改变','artifact_changed');bytes=await handle.readFile();const after=await handle.stat();requireValue(bytes.length===before.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs&&createHash('sha256').update(bytes).digest('hex')===plan.artifact.sha256,'附件内容校验失败','artifact_changed');}finally{await handle.close();}
 const live=store.task?store.task(task.id):store.data.tasks?.find(t=>t.id===task.id)||task;
 assertExecutionPermission(store,['files']);
 requireValue(same(plan,attachmentPlan(live,{store,artifactId:plan.artifact.id,at:Date.now()})),'读取期间附件授权已变化','attachment_not_authorized');
 return {plan,bytes};
}
