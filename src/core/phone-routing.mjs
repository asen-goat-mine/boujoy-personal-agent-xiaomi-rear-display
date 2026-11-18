import {createTaskContract} from './task-contract.mjs';
import {affirmativeInstructions} from './instruction-scope.mjs';
import {isDesktopWork,isFileLiteral} from './work-kind.mjs';
import {effectPlan} from '../adapters/phone-effects.mjs';

const quoted=/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'|`[^`]*`/g;
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function appTargets(instruction,app){
  let phone=false,desktop=false;
  const suffix=/^[\x00-\x7f]+$/.test(app)?'(?![a-z0-9_])':'';
  const target=new RegExp('(打开|开启|进入|启动|切换到|切到|在|用|使用|通过)(?:手机(?:上|里|中的|的)?|应用|APP)?\\s*'+escape(app)+suffix,'gi');
  for(const match of instruction.matchAll(target)){
    const after=instruction.slice(match.index+match[0].length),before=instruction.slice(0,match.index).split(/[，,。；;\n]/).at(-1);
    if(/(?:在|用|使用|通过)(?:电脑|Mac|浏览器)(?:上|里|中|端|的)?[^，,。；;\n]{0,16}$/i.test(before)){desktop=true;continue;}
    // A website destination can contain an app name, including joined sites
    // such as “在京东和苹果中国官网”. It does not select a native app.
    if(/^\s*(?:的)?(?:中国|官方)?(?:官网|网站|网页|网页版)/i.test(after)||/^\s*(?:和|与|、|及)[^，,。；;\n]{0,30}(?:官网|网站|网页)/i.test(after)){desktop=true;continue;}
    if(/^\s*(?:APP|应用)(?![a-z])/i.test(after)){phone=true;continue;}
    if(/^(?:打开|开启|进入|启动|切换到|切到)$/.test(match[1])){phone=true;continue;}
    if(/^\s*(?:里|中|上|内)?\s*(?:查看|查|读取|读|看看|看|写|编辑|保存|搜索|搜|找|发|回复|设置|创建|新建|打开|浏览|整理)/.test(after))phone=true;
  }
  return {phone,desktop};
}
// A launcher workspace, native file selection, and a live handset screen are
// distinct from a Mac Desktop directory, a quoted filename, or a design mockup.
function hasNativeSurfaceTarget(instruction,contract,plan){
  if(/(?:只用|仅用|仅限|只能在)(?:电脑|Mac|浏览器)/i.test(instruction))return false;
  const objects=contract.objects||{};
  const nativeFileAction=objects.longPressTarget&&instruction.includes('长按')||['file_rename','file_move'].includes(plan?.kind);
  const fileApp=(contract.allowedApps||[]).includes('文件');
  const appNames=(contract.allowedApps||[]).map(escape).join('|');
  const app=appNames?`(?:${appNames})?`:'';
  const screen=new RegExp('(?:查看|读取|看看|看下|观察|截取|截下)(?:当前|我的|这台)?手机(?:上的?|里的?|当前|的)?'+app+'(?:当前)?(?:屏幕|画面|页面|界面|桌面|截图)(?=$|上|里|中|并|再|然后|\\s)','i');
  return instruction.split(/[，,。；;！!？?\n]/).some(clause=>{
    if(/电脑|Mac\b|Finder|浏览器|官网|网站|网页/i.test(clause))return false;
    if(objects.systemNavigation==='home'&&/(?:回到|返回)(?:手机)?(?:桌面|主屏幕)(?=$|\s|并|再|然后)/.test(clause))return true;
    if(objects.systemNavigation==='recents'&&/(?:打开|查看|进入)(?:手机)?(?:最近任务|最近应用|多任务)(?:界面|页面)?(?=$|\s|并|再|然后)/.test(clause))return true;
    if(fileApp&&nativeFileAction&&/(?:打开|进入|使用|用|在)(?:手机(?:上|里|的)?)?(?:我的)?文件(?:管理器?|应用|APP)?(?=$|\s|把|将|里|中|内|长按)/i.test(clause))return true;
    return screen.test(clause);
  });
}
export function phoneRoutingScope(current,store){
  // Classification only: no new authority, persisted state, or deadline change.
  const contract=current.taskContract||createTaskContract(current,{routineAuthorization:current.routineAuthorization});
  const goal=String(contract.goal||current.prompt||'');
  const apps=(contract.allowedApps||[]).filter(app=>!['浏览器','文件'].includes(app));
  const instruction=affirmativeInstructions(goal.replace(quoted,(part,offset)=>{
    const literal=part.slice(1,-1).trim();
    if(isFileLiteral(literal))return '[本机文档]';
    if(/^https?:\/\//i.test(literal))return '[网页]';
    const target=/(?:打开|开启|进入|启动|切换到|切到|在|用|使用|通过)(?:手机(?:上|里|中的|的)?|应用|APP)?\s*$/i.test(goal.slice(0,offset));
    return target&&apps.some(app=>app.toLowerCase()===literal.toLowerCase())?literal:'[引用]';
  }));
  // “手机” can be a product/topic or occur in a negated instruction. Determine
  // computer context independently, then retain affirmative phone/app targets.
  const desktopWork=isDesktopWork(instruction.replace(/手机/g,''));
  const explicitDevice=/(?:用|使用|通过|操作|控制|切换到|切到)(?:我的?|这部|这台)?手机(?!价格|报价|型号|品牌|商品|产品|设计|文档)/.test(instruction)||/在(?:我的?|这部|这台)?手机(?:上|里|端|中|的)/.test(instruction)||/在(?:我的?)?手机(?:APP|应用)/i.test(instruction)||apps.some(app=>new RegExp('在(?:我的?)?手机\\s*'+escape(app),'i').test(instruction));
  const plan=effectPlan(contract);
  const nativeTarget=hasNativeSurfaceTarget(instruction,contract,plan);
  const scopedEffect=!!plan||contract.effects?.some(effect=>!['read','navigate','modify'].includes(effect));
  const targets=apps.map(app=>appTargets(instruction,app));
  const phoneTask=nativeTarget||explicitDevice||targets.some(target=>target.phone)||apps.length>0&&(!desktopWork||scopedEffect&&targets.some(target=>!target.desktop))||!desktopWork&&/手机/.test(instruction);
  const usedPhone=!!current.phoneUseScope||(store?.data?.actions||[]).some(action=>action.taskId===current.id&&action.tool?.startsWith('phone_'));
  // Receiving a command on the phone does not make its delivery require a phone action.
  return {desktopWork,required:usedPhone||!!current.remoteDeviceId||phoneTask,executionRequired:usedPhone||phoneTask};
}
