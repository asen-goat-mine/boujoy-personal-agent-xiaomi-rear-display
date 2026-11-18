import {afterSalesPlan,afterSalesDialogAllowed,classifyAfterSalesAction,verifyAfterSalesResult} from './phone-after-sales.mjs';
// Business adapters consume only contract-bound objects and current native
// controls. They never infer an object, account or visibility from model text.
const compact=value=>String(value??'').normalize('NFKC').replace(/\s+/g,'');
const same=(a,b)=>a===b;
const pathParts=value=>{if(typeof value!=='string'||!value.includes('/')||value.includes('..')||value.endsWith('/'))return null;const split=value.lastIndexOf('/');return {directory:value.slice(0,split)||'/',name:value.slice(split+1)};};
const CREDENTIAL=/密码|验证码|PIN|OTP|passcode|password/i;
const FILE_PACKAGES=new Set(['com.sec.android.app.myfiles','com.google.android.apps.nbu.files','com.android.documentsui','com.google.android.documentsui']);
const CAMERA_PACKAGES=new Set(['com.sec.android.app.camera','com.android.camera','com.google.android.GoogleCamera']);
const SOCIAL_PACKAGES=new Set(['com.xingin.xhs','com.ss.android.ugc.aweme','tv.danmaku.bili','com.tencent.mm']);
const ORDER_PACKAGES=new Set(['com.taobao.taobao','com.sankuai.meituan','com.sankuai.meituan.takeoutnew','com.jingdong.app.mall','com.xunmeng.pinduoduo']);
export const BUSINESS_COMMIT_KINDS=new Set(['effect_mail_send','effect_media_publish','effect_attachment_send','effect_file_rename','effect_file_move','effect_photo_capture','effect_social_publish','effect_social_comment','effect_social_bookmark','effect_order_cancel_open','effect_order_cancel','effect_after_sales_submit','effect_navigation_start','effect_ride_submit','effect_booking_submit','effect_booking_reschedule']);
export function businessPlan(contract){
 const afterSales=afterSalesPlan(contract);if(afterSales)return afterSales;
 const o=contract?.objects||{},effects=contract?.effects||[];
 if(effects.includes('modify')&&o.fileOperation==='rename'){
  const source=pathParts(o.filePath);if(source&&typeof o.newName==='string'&&o.newName&&!/[\/\\]|^\.{1,2}$/.test(o.newName)&&o.newName!==source.name)return {kind:'file_rename',...source,newName:o.newName};
 }
 if(effects.includes('modify')&&o.fileOperation==='move'){
  const source=pathParts(o.filePath);if(source&&typeof o.destination==='string'&&o.destination&&!o.destination.includes('..')&&o.destination!==source.directory)return {kind:'file_move',...source,destination:o.destination};
 }
 if(effects.includes('capture')&&o.captureKind==='photo')return {kind:'photo_capture',camera:o.captureCamera||null};
 if(effects.includes('publish')&&o.socialOperation==='publish'&&o.account&&o.content&&['公开','仅自己可见','好友可见'].includes(o.audience))return {kind:'social_publish',account:o.account,content:o.content,audience:o.audience};
 if(effects.includes('publish')&&o.socialOperation==='comment'&&o.account&&o.content&&o.socialTarget)return {kind:'social_comment',account:o.account,content:o.content,target:o.socialTarget,author:o.targetAuthor||null};
 if(effects.includes('publish')&&o.socialOperation==='bookmark'&&o.socialTarget&&o.account)return {kind:'social_bookmark',account:o.account,target:o.socialTarget,author:o.targetAuthor||null};
 if(o.orderId&&/^[A-Za-z0-9-]{6,64}$/.test(o.orderId)){
  if(effects.includes('cancel_order'))return {kind:'order_cancel',orderId:o.orderId,reason:o.cancelReason||null};
  if(effects.includes('read')&&o.orderOperation==='read')return {kind:'order_read',orderId:o.orderId};
 }
 return null;
}
export function businessPackageAllowed(plan,packageName){
 if(plan.kind==='after_sales')return ORDER_PACKAGES.has(packageName);
 if(plan.kind.startsWith('file_'))return FILE_PACKAGES.has(packageName);
 if(plan.kind==='photo_capture')return CAMERA_PACKAGES.has(packageName);
 if(plan.kind.startsWith('social_'))return SOCIAL_PACKAGES.has(packageName);
 if(plan.kind.startsWith('order_'))return ORDER_PACKAGES.has(packageName);
 return true;
}
export function businessDialogLabelAllowed(label,plan){
 if(!plan)return false;
 if(afterSalesDialogAllowed(label,plan))return true;
 if(plan.kind==='file_rename')return /^(?:重命名|修改名称|保存|确定|取消)$/.test(label);
 if(plan.kind==='file_move')return /^(?:移动|移动到此处|移至此处|取消)$/.test(label);
 if(plan.kind==='social_publish')return /^(?:发布|确认发布|发布确认|可见范围|公开|仅自己可见|好友可见|取消)$/.test(label);
 if(plan.kind==='social_comment')return /^(?:评论|发表评论|发送|取消)$/.test(label);
 if(plan.kind.startsWith('order_'))return /^(?:待付款|订单详情)$/.test(label)||plan.kind==='order_cancel'&&/^(?:取消订单|确认取消|取消原因|取消)$/.test(label);
 return false;
}
const has=(nodes,value)=>nodes.some(node=>!node.editable&&node.values.includes(value));
const exact=(nodes,value)=>nodes.filter(node=>!node.editable&&node.values.includes(value));
function context(nodes,name,value){return nodes.some(node=>!node.editable&&(node.values.includes(`${name}：${value}`)||node.values.includes(`${name}: ${value}`)||node.values.includes(name)&&node.values.includes(value)));}
function target(nodes,args,ocr){
 const refs=args.textTargetId?(ocr?.lines||[]).filter(line=>line.id===args.textTargetId):[];if(args.textTargetId&&refs.length!==1)return null;
 const ref=refs[0],p=ref?.center||{x:args.x,y:args.y};
 const hits=nodes.filter(node=>(node.clickable||node.editable||args.action==='long_press'&&/\blong_clickable\b/.test(node.raw))&&p.x>=node.bounds[0]&&p.x<node.bounds[2]&&p.y>=node.bounds[1]&&p.y<node.bounds[3]);
 if(hits.some(node=>node.secret||node.values.some(value=>CREDENTIAL.test(value))))return null;
 const node=hits.sort((a,b)=>(a.bounds[2]-a.bounds[0])*(a.bounds[3]-a.bounds[1])-(b.bounds[2]-b.bounds[0])*(b.bounds[3]-b.bounds[1]))[0];if(!node)return null;
 const label=ref?.text||(node.values.length===1?node.values[0]:null);return label&&node.values.includes(label)?{node,label}:null;
}
function focused(nodes){const fields=nodes.filter(node=>node.editable&&node.focused&&!node.secret);return fields.length===1?fields[0]:null;}
const draftSafe=(node,wanted,hints)=>node.values.every(value=>!value||value===wanted||hints.includes(value));
const fileContext=(nodes,plan)=>context(nodes,'位置',plan.directory)||context(nodes,'路径',plan.directory)||has(nodes,plan.directory);
const selectedFile=(nodes,plan)=>context(nodes,'选中文件',plan.name)||context(nodes,'原名称',plan.name);
const destinationCollision=(nodes,plan)=>nodes.some(node=>!node.editable&&node.values.includes(plan.name)&&!node.values.includes('选中文件')&&!node.values.includes('原名称'));
const accountBound=(nodes,plan)=>context(nodes,'当前账号',plan.account)||context(nodes,'发布账号',plan.account);
const postBound=(nodes,plan)=>exact(nodes,plan.target).length===1&&(!plan.author||context(nodes,'作者',plan.author));
const orderBound=(nodes,plan)=>context(nodes,'订单号',plan.orderId)&&nodes.filter(node=>node.values.some(value=>/^订单号[：:]/.test(value)||value==='订单号')).length===1;
const savedImages=nodes=>nodes.flatMap(node=>node.values).filter(value=>/^(?:content:\/\/media\/[^\s]+|[^\s\/]+\.(?:jpe?g|heic|png))$/i.test(value));
const sizeMetadata=node=>node?.values.find(value=>/^\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|字节)$/i.test(value))||null;
export function classifyBusinessAction(args,state,ocr,grant,nodes){
 const plan=grant.effectPlan;if(!plan||nodes.some(node=>node.secret||node.editable&&node.values.some(value=>CREDENTIAL.test(value))))return null;
 if(plan.kind==='after_sales')return classifyAfterSalesAction(args,state,ocr,grant,nodes,args.action==='tap'?target(nodes,args,ocr):null);
 const decision=(kind,witness={})=>({kind,witness});
 if(args.action==='type'){
  const field=focused(nodes);if(!field||args.inputMode!=='replace'||args.textTargetId)return null;
  if(plan.kind==='file_rename'&&selectedFile(nodes,plan)&&fileContext(nodes,plan)&&field.values.some(value=>['名称','文件名',plan.name].includes(value))&&draftSafe(field,args.text,['名称','文件名',plan.name])&&same(args.text,plan.newName))return decision('effect_file_name_input');
  if(['social_publish','social_comment'].includes(plan.kind)&&accountBound(nodes,plan)&&(plan.kind==='social_publish'?context(nodes,'可见范围',plan.audience):postBound(nodes,plan))&&field.values.some(value=>['正文','内容','评论','说点什么'].includes(value))&&draftSafe(field,plan.content,['正文','内容','评论','说点什么'])&&same(args.text,plan.content))return decision('effect_social_input');
  if(plan.kind.startsWith('order_')&&field.values.some(value=>['搜索订单','订单号'].includes(value))&&same(args.text,plan.orderId))return decision('effect_order_search');
  return null;
 }
 if(!['tap','long_press'].includes(args.action))return null;
 const hit=target(nodes,args,ocr);if(!hit)return null;const {node,label}=hit;
 if(plan.kind.startsWith('file_')){
  if(args.action==='long_press'&&label===plan.name&&fileContext(nodes,plan)&&exact(nodes,plan.name).length===1&&/\blong_clickable\b/.test(node.raw))return decision('effect_file_select',{sourcePath:plan.directory+'/'+plan.name,size:sizeMetadata(node)});
  if(args.action!=='tap')return null;
  if(plan.kind==='file_rename'&&selectedFile(nodes,plan)&&fileContext(nodes,plan)){
   if(label==='重命名')return decision('effect_file_rename_open');
   if(node.editable&&node.values.some(value=>['名称','文件名',plan.name].includes(value)))return decision('effect_file_name_focus');
   if(['保存','确定'].includes(label)&&nodes.filter(row=>row.editable&&row.values.includes(plan.newName)).length===1&&!has(nodes,plan.newName))return decision('effect_file_rename',{sourcePath:plan.directory+'/'+plan.name,targetPath:plan.directory+'/'+plan.newName});
  }
  if(plan.kind==='file_move'&&selectedFile(nodes,plan)){
   if(label==='移动'&&fileContext(nodes,plan))return decision('effect_file_move_open');
   if(label===plan.destination)return decision('effect_file_destination');
   if(['移动到此处','移至此处'].includes(label)&&context(nodes,'目标位置',plan.destination)&&!destinationCollision(nodes,plan))return decision('effect_file_move',{sourcePath:plan.directory+'/'+plan.name,targetPath:plan.destination+'/'+plan.name});
  }
 }
 if(args.action!=='tap')return null;
 if(plan.kind==='photo_capture'&&label==='拍照'&&has(nodes,'照片')&&(!plan.camera||context(nodes,'摄像头',plan.camera))&&!has(nodes,'录像中'))return decision('effect_photo_capture',{previousMedia:[...new Set(savedImages(nodes))]});
 if(plan.kind==='social_publish'&&accountBound(nodes,plan)&&context(nodes,'可见范围',plan.audience)){
  if(label==='发布文字')return decision('effect_social_compose');
  if(label==='发布'&&nodes.filter(row=>row.editable&&row.values.includes(plan.content)).length===1)return decision('effect_social_publish',{beforeCount:exact(nodes,plan.content).length});
 }
 if(plan.kind==='social_comment'&&accountBound(nodes,plan)&&postBound(nodes,plan)){
  if(node.editable&&node.values.some(value=>['评论','说点什么'].includes(value)))return decision('effect_social_focus');
  if(['发送','发表评论'].includes(label)&&nodes.filter(row=>row.editable&&row.values.includes(plan.content)).length===1)return decision('effect_social_comment',{beforeCount:exact(nodes,plan.content).length});
 }
 if(plan.kind==='social_bookmark'&&accountBound(nodes,plan)&&postBound(nodes,plan)&&label==='收藏'&&!has(nodes,'已收藏'))return decision('effect_social_bookmark');
 if(plan.kind.startsWith('order_')){
  if(label===plan.orderId)return decision('effect_order_open');
  if(!orderBound(nodes,plan))return null;
  if(plan.kind==='order_cancel'&&has(nodes,'待付款')&&!nodes.some(row=>row.values.some(value=>/已付款|已支付|退款|取消费|违约金/.test(value)))){
   if(label==='取消订单')return decision('effect_order_cancel_open');
   if(plan.reason&&label===plan.reason)return decision('effect_order_cancel_reason');
   if(label==='确认取消'&&(!plan.reason?!has(nodes,'取消原因'):context(nodes,'取消原因',plan.reason)))return decision('effect_order_cancel',{orderId:plan.orderId,priorStatus:'待付款'});
  }
 }
 return null;
}
export function verifyBusinessResult(nodes,grant,matches){
 const plan=grant.effectPlan,final=kind=>matches.filter(action=>action.phoneEffect?.kind===kind).at(-1);
 if(plan.kind==='after_sales')return verifyAfterSalesResult(nodes,grant,matches);
 if(plan.kind==='file_rename'){
  const action=final('effect_file_rename'),rows=exact(nodes,plan.newName),selection=final('effect_file_select'),size=selection?.phoneEffect.witness.size;
  return {verified:!!action&&fileContext(nodes,plan)&&rows.length===1&&!has(nodes,plan.name)&&(!size||sizeMetadata(rows[0])===size),kind:'file_renamed',verificationMethod:'native_directory_listing'};
 }
 if(plan.kind==='file_move')return {verified:!!final('effect_file_move')&&(context(nodes,'位置',plan.destination)||context(nodes,'路径',plan.destination)||has(nodes,plan.destination))&&exact(nodes,plan.name).length===1&&has(nodes,'移动成功'),kind:'file_moved',verificationMethod:'native_move_status_and_destination'};
 if(plan.kind==='photo_capture'){
  const action=final('effect_photo_capture'),media=[...new Set(savedImages(nodes))].filter(value=>!action?.phoneEffect.witness.previousMedia.includes(value));
  return {verified:!!action&&has(nodes,'已保存')&&media.length===1,kind:'photo_saved',verificationMethod:'native_saved_media_reference'};
 }
 if(plan.kind==='social_publish'){
  const action=final('effect_social_publish');return {verified:!!action&&accountBound(nodes,plan)&&context(nodes,'可见范围',plan.audience)&&has(nodes,'发布成功')&&exact(nodes,plan.content).length===action.phoneEffect.witness.beforeCount+1&&!nodes.some(node=>node.editable&&node.values.includes(plan.content)),kind:'post_published'};
 }
 if(plan.kind==='social_comment'){
  const action=final('effect_social_comment');return {verified:!!action&&postBound(nodes,plan)&&context(nodes,'评论账号',plan.account)&&exact(nodes,plan.content).length===action.phoneEffect.witness.beforeCount+1&&!nodes.some(node=>node.editable&&node.values.includes(plan.content))&&!has(nodes,'发送失败')&&!has(nodes,'发送中'),kind:'comment_sent'};
 }
 if(plan.kind==='social_bookmark')return {verified:!!final('effect_social_bookmark')&&accountBound(nodes,plan)&&postBound(nodes,plan)&&has(nodes,'已收藏'),kind:'post_bookmarked'};
 if(plan.kind==='order_cancel')return {verified:!!(final('effect_order_cancel')||final('effect_order_cancel_open'))&&orderBound(nodes,plan)&&has(nodes,'已取消')&&!has(nodes,'取消处理中'),kind:'order_cancelled'};
 if(plan.kind==='order_read')return {verified:orderBound(nodes,plan)&&['待付款','待发货','待收货','已完成','已取消','交易关闭'].filter(status=>has(nodes,status)).length===1,kind:'order_status_read'};
 return {verified:false,reason:'business_result_not_supported'};
}
