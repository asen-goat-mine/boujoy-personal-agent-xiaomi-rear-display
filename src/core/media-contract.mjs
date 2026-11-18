import {stripTopLevelRoleMentions} from './role-mentions.mjs';
const instruction=raw=>stripTopLevelRoleMentions(raw).replace(/“[^”]*”|「[^」]*」|"[^"]*"/g,'[数据]');
const quoted=(raw,label)=>{const rows=[...raw.matchAll(new RegExp('(?:'+label+')[：:]?[“「"]([^”」"\\n]{1,4000})[”」"]','g'))];return rows.length===1?rows[0][1]:null;};
export function isMediaPublishRequest(raw){const text=instruction(raw);return /发布|发帖/.test(text)&&/图片|照片|视频|素材/.test(text);}
export function parseMediaRequest(raw){
 raw=stripTopLevelRoleMentions(raw).trim();const text=instruction(raw);if(!isMediaPublishRequest(raw)||/^(?:如何|怎么|解释)|(?:不要|不用|别|禁止).{0,10}(?:发布|发帖)|(?:页面|网页|模型|助理).{0,12}(?:说|要求|指示)|忽略.*授权|直播|定时发布|批量/.test(text))return null;
 const apps=['小红书','抖音','哔哩哔哩'].filter(a=>text.includes(a));if(apps.length!==1)return null;
 const account=quoted(raw,'账号|账户'),audience=quoted(raw,'可见范围'),content=quoted(raw,'正文|文案'),name=quoted(raw,'图片|照片|视频|素材');
 if(!account||account.length>100||!['公开','仅自己','好友可见'].includes(audience)||!content||!name||name.length>160||/[\\/\x00-\x1f]/.test(name))return null;
 const mediaType=/\.(?:png|jpe?g|webp)$/i.test(name)?'image':/\.(?:mp4|mov|webm)$/i.test(name)?'video':null;if(!mediaType||/发布视频/.test(text)&&mediaType!=='video')return null;
 return {kind:'publish_media',app:apps[0],account,audience,content,mediaType,fileName:name,artifactId:null};
}
