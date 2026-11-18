// Package identities are checked locally against the live foreground, never supplied by a page.
export const COMMERCE_PLATFORMS=Object.freeze({
 taobao:{id:'taobao',names:['淘宝闪购','淘宝','闪购'],packages:['com.taobao.taobao'],kind:'food'},
 meituan:{id:'meituan',names:['美团外卖','美团'],packages:['com.sankuai.meituan','com.sankuai.meituan.takeoutnew'],kind:'food'},
 jd:{id:'jd',names:['京东'],packages:['com.jingdong.app.mall'],kind:'shopping'},
 pinduoduo:{id:'pinduoduo',names:['拼多多'],packages:['com.xunmeng.pinduoduo'],kind:'shopping'}
});
export const commercePlatform=id=>COMMERCE_PLATFORMS[id]||null;
export function requestedCommercePlatform(text,{defaultPlatform=null}={}){
 const matches=Object.values(COMMERCE_PLATFORMS).filter(profile=>profile.names.some(name=>String(text).includes(name)));
 return matches.length===1?matches[0].id:matches.length?null:defaultPlatform;
}
export const platformPackageMatches=(platform,pkg)=>commercePlatform(platform)?.packages.includes(pkg)===true;
export function requestedSpecifications(prompt){
 const match=String(prompt).match(/(?:规格|型号)[：:\s]*[“「"]([^”」"\n]{1,100})[”」"]/);
 return match?[...new Set(match[1].normalize('NFKC').split(/[，,、;；]/).map(value=>value.trim()).filter(Boolean))]:[];
}

export const COMMERCE_NAMES=Object.values(COMMERCE_PLATFORMS).flatMap(profile=>profile.names);
export const DEFAULT_COMMERCE_PLATFORM=Object.keys(COMMERCE_PLATFORMS)[0];
