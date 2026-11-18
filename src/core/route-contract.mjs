const compact=value=>String(value||'').normalize('NFKC').replace(/\s+/g,'');
export const isRouteRequest=raw=>/高德地图|百度地图/.test(String(raw))&&/路线|路径/.test(String(raw));
export function parseRouteRequest(raw){
 const text=String(raw||''),instruction=text.replace(/[“「"]([^”」"]*)[”」"]/g,'[地点]');
 if(/(?:不|不要|不用|禁止).{0,4}(?:查|规划|查看)/.test(instruction))return null;
 if(!/高德地图|百度地图/.test(instruction)||!/路线|路径/.test(instruction)||!/查询|规划|查看|查一下|查查|查|看看/.test(instruction))return null;
 const positive=instruction.replace(/(?:不|不要|无需|不用)(?:叫车|打车|预约|预订|下单)/g,'');
 if(/叫车|打车|预约|预订|下单|导航开始|开始导航/.test(positive))return null;
 const quoted=text.match(/从\s*[“「"]([^”」"\n]{1,100})[”」"]\s*到\s*[“「"]([^”」"\n]{1,100})[”」"]/);
 const plain=text.match(/从([^，。；;“」”"\n]{1,80}?)到([^，。；;“」”"\n]{1,80}?)(?:的)?(?:步行|驾车|骑行|公交)(?:路线|路径)/);
 const pair=quoted||plain;if(!pair)return null;
 const origin=pair[1].trim(),destination=pair[2].trim();
 const modes=[...new Set(positive.match(/步行|驾车|骑行|公交/g)||[])];
 if(modes.length!==1||!origin||!destination||compact(origin)===compact(destination)||/密码|验证码|指令|请执行/.test(origin+destination))return null;
 if([...text.matchAll(/从\s*[“「"]/g)].length>1)return null;
 return {origin,destination,mode:modes[0]};
}
