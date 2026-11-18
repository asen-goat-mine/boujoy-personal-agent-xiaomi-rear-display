// Recognized launcher surfaces are explicit native adapters, not inferred from
// screenshots, a successful Android global-action receipt, or package alone.
const LAUNCHERS=new Set(['com.sec.android.app.launcher','com.android.launcher3','com.google.android.apps.nexuslauncher']);
export function systemSurface(native,action){
 const pkg=native?.packageName,nodes=(native?.elements||[]).filter(node=>node.visible===true&&node.enabled===true&&!node.password);
 const suffixes=nodes.map(node=>typeof node.view_id==='string'?node.view_id.split(':id/').at(-1):'');
 const overview=suffixes.some(value=>/^(?:overview_panel|recents_view|recent_apps|recent_apps_container)$/.test(value));
 if(action==='home')return LAUNCHERS.has(pkg)&&suffixes.includes('workspace')&&!overview;
 if(action==='recents')return (LAUNCHERS.has(pkg)||pkg==='com.android.systemui')&&overview;
 return false;
}
export function rangeControl(native,field){
 const expected=field==='brightness'?'亮度':field==='volume'?'音量':null;if(!expected)return null;
 const candidates=(native?.elements||[]).filter(node=>node.visible===true&&node.enabled===true&&!node.password&&[node.text,node.description,node.hint].some(label=>label===expected)&&Array.isArray(node.range)&&node.range.length===4&&node.range.every(Number.isFinite)&&node.range[2]>node.range[1]&&node.range[3]>=node.range[1]&&node.range[3]<=node.range[2]);
 return candidates.length===1?candidates[0]:null;
}
export function rangePercent(node){return node?Math.round(100*(node.range[3]-node.range[1])/(node.range[2]-node.range[1])):null;}
