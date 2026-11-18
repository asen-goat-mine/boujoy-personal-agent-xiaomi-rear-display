import {AppError} from '../core/errors.mjs';
import {queryGrant} from './phone-query.mjs';
export function modelSearchObservation(observation){
 const search={needsModel:true,actions:0,actionAttempts:0,reason:'model_driven_search'};
 return {...observation,search,content:[{type:'text',text:JSON.stringify({search,instruction:'只读取了当前页面，没有点击或输入。请根据用户目标与当前画面选择下一步 phone_use 动作，不假定固定搜索入口，也不要把本次观察当作已完成搜索。'})},...(observation?.content||[])]};
}
// Kept for callers from older releases; an optional act callback is deliberately
// never invoked. All search/navigation decisions return to the model.
export async function searchPhone(phone,{taskId,grant,signal}={}){
 const scope=queryGrant(grant);if(!scope)throw new AppError('invalid_input','缺少本任务的手机查询范围');
 if(signal?.aborted)throw new AppError('cancelled','任务已停止',409);
 const observation=await (phone.observeQuery?phone.observeQuery(taskId,scope,{signal}):phone.observeStable(taskId,{signal}));
 if(signal?.aborted)throw new AppError('cancelled','任务已停止',409);
 return modelSearchObservation(observation);
}
