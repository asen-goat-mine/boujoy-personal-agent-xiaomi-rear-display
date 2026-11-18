// Legacy warm-session compatibility. Never choose or execute a business path here.
export async function runShopFlow(broker,taskId,args){
 const task=broker.store.task(taskId);
 return {content:[{type:'text',text:JSON.stringify({shopFlow:{stage:'model_driven',legacyPhase:task.shopFlow?.phase||null,requestedAction:args.action,needsModel:true,actions:0,accepted:false},instruction:'购物自动脚本已停用，本次未操作手机。请根据当前画面用 phone_use 自行选择一个动作；没有新画面时先 read。商品、规格、数量、路线与停止位置遵守用户目标，提交订单和付款交给用户。'})}]};
}
