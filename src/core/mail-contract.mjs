import {stripTopLevelRoleMentions} from './role-mentions.mjs';
const quote=(raw,labels)=>{const rows=[...raw.matchAll(new RegExp('(?:'+labels+')[：:]?[“「"]([^”」"\\n]{1,4000})[”」"]','g'))];return rows.length===1?rows[0][1]:null;};
const instruction=raw=>stripTopLevelRoleMentions(raw).replace(/“[^”]*”|「[^」]*」|"[^"]*"/g,'[数据]');
const APPS=['Gmail','Outlook','三星邮件'];
const email=v=>typeof v==='string'&&/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(v)&&v.length<=254;
export function isMailSendRequest(raw){const text=instruction(raw);return /发送|发给/.test(text)&&/邮件|邮箱|Gmail|Outlook/i.test(text);}
export function parseMailRequest(raw){
 raw=stripTopLevelRoleMentions(raw).trim();const text=instruction(raw);if(!isMailSendRequest(raw)||/^(?:如何|怎么|解释)|(?:不要|别|禁止|不用).{0,8}(?:发|传)|(?:网页|页面|模型|助理).{0,12}(?:说|要求|指示)|抄送|密送|转发|批量|忽略.*授权/.test(text))return null;
 const apps=APPS.filter(a=>text.toLowerCase().includes(a.toLowerCase()));if(apps.length!==1)return null;
 const account=quote(raw,'账户|账号|发件人'),recipient=quote(raw,'给|收件人'),subject=quote(raw,'主题'),content=quote(raw,'正文');if(!email(account)||!email(recipient)||!subject||subject.length>200||!content)return null;
 const selectors=[...raw.matchAll(/(?:附件|文件)[“「"]([^”」"\n]{1,160}\.[A-Za-z0-9]{1,10})[”」"]/g)].map(m=>m[1]);if(selectors.length>1||selectors.some(v=>/[\\/\x00-\x1f]/.test(v)))return null;
 if(/附件|文件/.test(text)&&selectors.length!==1)return null;
 return {kind:'send_mail',app:apps[0],account,recipient,subject,content,...(selectors.length?{attachment:{fileName:selectors[0],artifactId:null}}:{})};
}
