import {stripTopLevelRoleMentions} from './role-mentions.mjs';
// Only the user's request authorizes the two effects. The image supplies data.
export function parseScreenshotScheduleRequest(raw){
 const text=stripTopLevelRoleMentions(raw),instruction=text.replace(/[“「"]([^”」"]*)[”」"]/g,'[文件]');
 if(!/截图/.test(instruction)||!/日历/.test(instruction)||!/(?:添加|新建|创建|安排|写入)/.test(instruction)||!/提醒我/.test(instruction))return null;
 if(/^(?:怎么|如何|解释)|(?:不要|不用|别|禁止).{0,20}(?:日历|提醒|添加)|(?:网页|页面|模型).{0,10}(?:要求|说)|发送|发布|删除|付款|支付|邀请|参会人|(?:并|然后|同时|再).{0,8}(?:打开|查看|开启|关闭|修改|查询|搜索|点餐)/.test(instruction))return null;
 const files=[...text.matchAll(/截图\s*[“「"]([^”」"\n]{1,180})[”」"]/g)],offsets=[...instruction.matchAll(/提前\s*(\d{1,4})\s*分钟提醒我/g)],zones=[...instruction.matchAll(/(?:[A-Za-z_+-]+\/)+[A-Za-z_+-]+/g)];
 if(files.length!==1||offsets.length!==1||zones.length>1||!/^\d{1,4}$/.test(offsets[0][1]))return null;
 const leadMinutes=Number(offsets[0][1]);if(leadMinutes<1||leadMinutes>10080||!/^.{1,160}\.(?:png|jpg|jpeg|webp)$/i.test(files[0][1])||/[\\/\0]/.test(files[0][1]))return null;
 return {schemaVersion:1,kind:'screenshot_calendar_reminder',artifactName:files[0][1],calendarApp:'日历',leadMinutes,timezone:zones[0]?.[0]||null};
}
