import {stripTopLevelRoleMentions} from './role-mentions.mjs';
// Literal message bodies are data, including when the user omits quotation marks.
export function parseMessageRequest(value){
 const text=stripTopLevelRoleMentions(value).trim();
 const match=text.match(/^(?:请)?(?:帮我|替我)?(?:在|用)?(微信|腾讯QQ|QQ|Telegram|WhatsApp)\s*(?:里|上)?\s*(?:给\s*((?:“[^”\n]{1,40}”|「[^」\n]{1,40}」|"[^"\n]{1,40}"|[^，。；：“”「」"\s]{1,40}?))\s*|((?:“[^”\n]{1,40}”|「[^」\n]{1,40}」|"[^"\n]{1,40}"|[^，。；：“”「」"\s]{1,40}?))里\s*)(发送|发一句|发句|发一条消息|发条消息|发消息|发一条|回复|发)\s*(?:[:：]\s*)?([\s\S]+)$/i);
 if(!match){
  const cross=text.match(/(?:发到|发给|发送到)(微信|腾讯QQ|QQ|Telegram|WhatsApp)(?:的|里)?([^，。；\s]{1,40})[。！!]?$/i);
  if(cross){let recipient=cross[2];if(cross[1]==='微信'&&['文件助手','自己'].includes(recipient))recipient='文件传输助手';return {app:cross[1],recipient,content:text.slice(0,cross.index),compose:true,instruction:text};}
  return null;
 }
 let recipient=match[2]||match[3],content=match[5].trim();
 // Quoted recipients are identifiers; their quotation marks are not the body.
 if(/^(?:“.*”|「.*」|".*")$/.test(recipient))recipient=recipient.slice(1,-1).trim();
 const quoted=content.match(/^(?:“([^”]*)”|「([^」]*)」|"([^"]*)")\s*[。！!]?$/);
 if(quoted)content=quoted[1]??quoted[2]??quoted[3];
 if(quoted&&/^[^\n]{1,160}\.(?:pdf|docx|xlsx|pptx|txt|md|csv|png|jpe?g|webp|wav|m4a|mp3|mp4)$/i.test(content))return null;
 if(!recipient||!content||content.length>2000||/^[，。；]/.test(content)||/[、和及]|以及|密码|验证码|授权/.test(recipient))return null;
 // Attachment requests must still take the artifact transfer route.
 if(!quoted&&/^(?:文件|附件|文档|报告|表格|图片|照片|录音|音频|视频)(?:\s|[“「"]|$)/.test(content))return null;
 if(match[1]==='微信'&&['文件助手','自己'].includes(recipient))recipient='文件传输助手';
 const compose=!quoted&&/^(?:一段|一条|一份|一篇|段)?(?:约|大概|左右)?\d{1,4}字|^(?:一段|一份|一篇).*(?:计划|总结|文案|祝福|介绍)/.test(content);
 return {app:match[1],recipient,content,...(compose?{compose:true}:{}),instruction:`在${match[1]}给${recipient}发送[正文]`};
}
