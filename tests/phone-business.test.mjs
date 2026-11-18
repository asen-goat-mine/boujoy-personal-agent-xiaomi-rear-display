import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskContract} from '../src/core/task-contract.mjs';
import {phoneUseGrant,phoneUseCanObserve,classifyPhoneUseAction,effectGoalStatus} from '../src/adapters/phone-use.mjs';
import {normalizePhoneUseObservation} from '../src/adapters/phoneuse-state.mjs';

const files={packageName:'com.sec.android.app.myfiles',appName:'文件'},social={packageName:'com.xingin.xhs',appName:'小红书'},camera={packageName:'com.sec.android.app.camera',appName:'相机'},shop={packageName:'com.taobao.taobao',appName:'淘宝'};
const states={enabled:true,visible:true,editable:false,password:false,focused:false,checkable:false,checked:false,selected:false,content_invalid:false};
const node=(text,description=null,extra={})=>({class:'android.widget.TextView',text,description,hint:null,bounds:[100,300,600,400],actions:[],...states,...extra});
const button=text=>node(text,null,{class:'android.widget.Button',actions:['tap'],bounds:[750,1600,950,1700]});
const field=value=>node(value,'正文',{class:'android.widget.EditText',actions:['tap','set_text'],editable:true,focused:true,bounds:[100,900,700,1100]});
function setup(prompt,app){const task={id:'t',source:'user',status:'running',cloudConsent:true,messages:[{id:'u',role:'user',content:prompt}]};task.taskContract=createTaskContract(task);return {task,grant:phoneUseGrant(task,app)};}
function observation(app,rows){
 const at=Date.now(),elements=[node(null,null,{element_id:'0',parent_id:null,class:'android.widget.FrameLayout',bounds:[0,0,1000,2000]}),...rows.map((row,index)=>({...row,element_id:'0.'+index,parent_id:'0'}))];
 const raw={device_id:'fixture-device',service_instance_id:'fixture-service',observation_id:'fixture-service:1',window_id:2,package_name:app.packageName,ui_version:1,captured_at_ms:at,
  display:{id:0,width:1000,height:2000,rotation:0,coordinates:'physical_pixels',origin:'top_left',includes_system_bars_and_ime:true},
  tree:{output:'legacy',available:true,compact:false,scope_clipped:false,collected_nodes:elements.length,output_nodes:elements.length,merged_nodes:0,elements,collection_complete:true,collection_truncated:false,truncated:false,reason:null,started_at_ms:at-2,finished_at_ms:at-1},
  screenshot:null,windows:[{window_id:2,display_id:0,type:1,layer:0,active:true,focused:true,bounds:[0,0,1000,2000]}],observation_status:'complete',collection_attempts:1,inconsistency_detected:false};
 const normalized=normalizePhoneUseObservation(raw,{requireScreenshot:false,now:at});
 return {taskId:'t',id:'o',at,stability:'fresh',stabilityScope:'phone_use',tree:normalized.tree,native:normalized.native,ocr:{width:1000,height:2000,lines:[]}};
}
const tap={action:'tap',observationId:'o',x:850,y:1650};
const act=(app,rows,grant,args=tap)=>classifyPhoneUseAction('t',args,observation(app,rows),grant);
const receipt=decision=>({status:'completed',phoneEffect:decision});
const renamePrompt='在文件把“Download/报告.txt”重命名为“总结.txt”';
test('file rename binds source directory and exact new name, with a native result rather than a click receipt',()=>{
 const {grant}=setup(renamePrompt,files);assert.equal(grant.effectPlan.kind,'file_rename');
 const context=[node('位置','Download'),node('选中文件','报告.txt')];
 const edit=node('报告.txt','文件名',{editable:true,focused:true,actions:['tap','set_text']});
 assert.equal(act(files,[...context,edit],grant,{action:'type',observationId:'o',text:'总结.txt',inputMode:'replace'})?.kind,'effect_file_name_input');
 assert.equal(act(files,[node('位置','Documents'),context[1],edit],grant,{action:'type',observationId:'o',text:'总结.txt',inputMode:'replace'}),null);
 const decision=act(files,[...context,{...edit,text:'总结.txt'},button('保存')],grant);assert.equal(decision?.kind,'effect_file_rename');
 assert.equal(effectGoalStatus(observation(files,[node('位置','Download'),node('总结.txt')]),grant,[receipt(decision)]).verified,true);
 assert.equal(effectGoalStatus(observation(files,[node('位置','Documents'),node('总结.txt')]),grant,[receipt(decision)]).verified,false);
 assert.equal(effectGoalStatus(observation(files,[node('位置','Download'),node('总结.txt'),node('报告.txt')]),grant,[receipt(decision)]).verified,false);
 assert.equal(effectGoalStatus(observation(files,[node('位置','Download'),node('总结.txt')]),grant,[]).verified,false);
});
test('file rename never overwrites an observed existing target or accepts a filename without a path',()=>{
 const {grant}=setup(renamePrompt,files),rows=[node('位置','Download'),node('选中文件','报告.txt'),field('总结.txt'),node('总结.txt'),button('保存')];
 assert.equal(act(files,rows,grant),null);
 assert.equal(setup('在文件把“报告.txt”重命名为“总结.txt”',files).grant,null);
 assert.equal(setup('在文件把“Download/报告.txt”重命名为“../别的.txt”',files).grant,null);
 assert.equal(phoneUseGrant(setup(renamePrompt,files).task,{...files,packageName:'com.example.fakefiles'}),null);
});
test('move requires explicit selected file and target, then observed move success in that destination',()=>{
 const {grant}=setup('在文件把“Download/报告.txt”移动到“Documents”',files),rows=[node('选中文件','报告.txt'),node('目标位置','Documents'),button('移动到此处')];
 const decision=act(files,rows,grant);assert.equal(decision?.kind,'effect_file_move');
 assert.equal(act(files,[rows[0],node('目标位置','Other'),rows[2]],grant),null);
 assert.equal(act(files,[...rows,node('报告.txt')],grant),null,'an existing destination file cannot be silently overwritten');
 const after=[node('位置','Documents'),node('报告.txt'),node('移动成功')];assert.equal(effectGoalStatus(observation(files,after),grant,[receipt(decision)]).verified,true);
 assert.equal(effectGoalStatus(observation(files,after.slice(0,2)),grant,[receipt(decision)]).verified,false,'a visible copied filename is not a verified move');
});
test('camera captures only explicit still photo request and needs a new saved media reference',()=>{
 const {grant}=setup('在相机用后置拍一张照片',camera);assert.equal(grant.effectPlan.kind,'photo_capture');
 const rows=[node('照片'),node('摄像头','后置'),node('old.jpg'),button('拍照')],decision=act(camera,rows,grant);assert.equal(decision?.kind,'effect_photo_capture');
 assert.equal(act(camera,[node('视频'),...rows.slice(1)],grant),null);assert.equal(act(camera,[rows[0],node('摄像头','前置'),...rows.slice(2)],grant),null);
 const saved=[node('已保存'),node('new.jpg')];assert.equal(effectGoalStatus(observation(camera,saved),grant,[receipt(decision)]).verified,true);
 for(const after of [[node('已保存'),node('old.jpg')],[node('new.jpg')],[node('已保存'),node('a.jpg'),node('b.jpg')]])assert.equal(effectGoalStatus(observation(camera,after),grant,[receipt(decision)]).verified,false);
 assert.equal(setup('打开相机看看',camera).task.taskContract.effects.includes('capture'),false);
});
test('publish requires exact account, text and audience before committing and exact success proof afterwards',()=>{
 const {grant}=setup('在小红书用账号“boujoy”发布“今天完成了项目”，可见范围“仅自己可见”',social);assert.equal(grant.effectPlan.kind,'social_publish');
 const context=[node('当前账号','boujoy'),node('可见范围','仅自己可见')],decision=act(social,[...context,field('今天完成了项目'),button('发布')],grant);assert.equal(decision?.kind,'effect_social_publish');
 for(const rows of [[node('当前账号','other'),context[1],field('今天完成了项目'),button('发布')],[context[0],node('可见范围','公开'),field('今天完成了项目'),button('发布')],[...context,field('不同内容'),button('发布')]])assert.equal(act(social,rows,grant),null);
 const after=[...context,node('今天完成了项目'),node('发布成功')];assert.equal(effectGoalStatus(observation(social,after),grant,[receipt(decision)]).verified,true);
 assert.equal(effectGoalStatus(observation(social,after.slice(0,-1)),grant,[receipt(decision)]).verified,false);
 assert.equal(setup('在小红书发布“今天完成了项目”',social).grant,null,'missing account/visibility is not guessed');
});
test('comment target and account cannot be replaced by another post or a duplicate message',()=>{
 const {grant}=setup('在小红书用账号“boujoy”在笔记“旅行计划”评论“谢谢分享”',social);assert.equal(grant.effectPlan.kind,'social_comment');
 const context=[node('当前账号','boujoy'),node('旅行计划')],decision=act(social,[...context,field('谢谢分享'),button('发表评论')],grant);assert.equal(decision?.kind,'effect_social_comment');
 assert.equal(act(social,[context[0],node('别的笔记'),field('谢谢分享'),button('发表评论')],grant),null);
 const after=[node('评论账号','boujoy'),node('旅行计划'),node('谢谢分享')];assert.equal(effectGoalStatus(observation(social,after),grant,[receipt(decision)]).verified,true);
 assert.equal(effectGoalStatus(observation(social,[...after,node('发送中')]),grant,[receipt(decision)]).verified,false);
});
test('bookmark changes only exact post under specified account and checks selected state without toggling it off',()=>{
 const {grant}=setup('在小红书用账号“boujoy”收藏笔记“旅行计划”',social),context=[node('当前账号','boujoy'),node('旅行计划')];
 const decision=act(social,[...context,button('收藏')],grant);assert.equal(decision?.kind,'effect_social_bookmark');
 assert.equal(act(social,[node('当前账号','other'),context[1],button('收藏')],grant),null);
 const after=[...context,button('已收藏')];assert.equal(effectGoalStatus(observation(social,after),grant,[receipt(decision)]).verified,true);assert.equal(act(social,after,grant),null);
 assert.equal(effectGoalStatus(observation(social,[node('当前账号','other'),context[1],button('已收藏')]),grant,[receipt(decision)]).verified,false);
});
test('order query verifies one exact order and status but grants no cancellation',()=>{
 const {grant,task}=setup('在淘宝查询订单“1234567890”',shop);assert.equal(grant.effectPlan.kind,'order_read');assert.equal(task.taskContract.effects.includes('cancel_order'),false);
 const rows=[node('订单号','1234567890'),node('待付款')],obs=observation(shop,rows);assert.equal(phoneUseCanObserve('t',obs.tree,grant),true);assert.equal(effectGoalStatus(obs,grant).verified,true);
 assert.equal(act(shop,[...rows,button('取消订单')],grant),null);
 assert.equal(effectGoalStatus(observation(shop,[node('订单号','9876543210'),node('待付款')]),grant).verified,false);
});
test('cancel is limited to specified unpaid order, requested reason and final cancelled status',()=>{
 const {grant}=setup('在淘宝取消订单“1234567890”，取消原因“不想买了”',shop);assert.equal(grant.effectPlan.kind,'order_cancel');
 const context=[node('订单号','1234567890'),node('待付款'),node('取消原因','不想买了')],decision=act(shop,[...context,button('确认取消')],grant);assert.equal(decision?.kind,'effect_order_cancel');
 for(const rows of [[node('订单号','9876543210'),...context.slice(1),button('确认取消')],[context[0],node('已支付'),context[2],button('确认取消')],[...context,node('取消费 ¥10'),button('确认取消')],[...context.slice(0,2),node('取消原因','商家缺货'),button('确认取消')]])assert.equal(act(shop,rows,grant),null);
 const after=[node('订单号','1234567890'),node('已取消')];assert.equal(effectGoalStatus(observation(shop,after),grant,[receipt(decision)]).verified,true);
 assert.equal(effectGoalStatus(observation(shop,[...after,node('取消处理中')]),grant,[receipt(decision)]).verified,false);
});
test('business effects reject stale observation, credentials, foreign app and altered contract',()=>{
 const {grant,task}=setup('在小红书用账号“boujoy”收藏笔记“旅行计划”',social),rows=[node('当前账号','boujoy'),node('旅行计划'),button('收藏')],obs=observation(social,rows);
 assert.equal(classifyPhoneUseAction('t',tap,{...obs,at:Date.now()-20000},grant),null);
 assert.equal(act(social,[...rows,node('secret',null,{editable:true,password:true})],grant),null);
 assert.equal(act(files,rows,grant),null);
 task.taskContract.objects.socialTarget='另一个帖子';assert.equal(phoneUseGrant(task,social),null);
});
test('a supported partial effect cannot complete a compound or unsupported order mutation',()=>{
 for(const prompt of ['在淘宝修改订单“1234567890”的地址','在小红书用账号“boujoy”收藏笔记“旅行计划”，然后删除文件','在小红书用账号“boujoy”发布“一”，可见范围“仅自己可见”，再发布“二”','在小红书用账号“boujoy”收藏笔记“一”和笔记“二”']){
  const {grant}=setup(prompt,prompt.includes('淘宝')?shop:social);assert.equal(grant,null,prompt);
 }
});
