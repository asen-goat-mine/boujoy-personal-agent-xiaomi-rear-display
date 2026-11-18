import {requireValue} from './errors.mjs';
export function normalizeEventCondition(value){
 if(value===undefined||value===null)return null;
 requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>['field','operator','value','fireOnFirst'].includes(k)),'事件条件格式无效');
 requireValue(typeof value.field==='string'&&/^[a-zA-Z][\w]{0,39}$/.test(value.field)&&['changed','decreased','below','equals'].includes(value.operator),'事件条件字段或操作无效');
 requireValue(value.fireOnFirst===undefined||typeof value.fireOnFirst==='boolean','首次事件策略无效');
 if(['below','equals'].includes(value.operator))requireValue(value.value!==undefined&&value.value!==null&&(typeof value.value==='boolean'||typeof value.value==='number'&&Number.isFinite(value.value)||typeof value.value==='string'&&value.value.length<=256),'事件条件需要具体有限阈值');
 else requireValue(value.value===undefined,'变化条件不能指定阈值');
 if(value.operator==='below')requireValue(typeof value.value==='number','价格阈值必须为数字');
 return {field:value.field,operator:value.operator,...(['below','equals'].includes(value.operator)?{value:value.value}:{}),fireOnFirst:value.fireOnFirst===true};
}
export function evaluateEventCondition(condition,previous,payload,{at=Date.now(),eventId}={}){
 if(!condition)return {trigger:true,reason:'unconditional',state:null};
 requireValue(Object.hasOwn(payload||{},condition.field),'事件未包含批准监控的字段','event_condition_missing');const value=payload[condition.field];
 requireValue(value!==null&&(typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&value.length<=256&&!/[\u0000-\u001f]/.test(value)),'事件条件值必须是有限标量','event_condition_invalid');
 if(['decreased','below'].includes(condition.operator))requireValue(typeof value==='number','价格条件需要数字值','event_condition_invalid');
 const initialized=previous?.initialized===true,same=initialized&&Object.is(previous.value,value),satisfied=condition.operator==='equals'?Object.is(value,condition.value):condition.operator==='below'?value<condition.value:condition.operator==='decreased'?initialized&&value<previous.value:initialized&&!same;
 const trigger=!initialized?condition.fireOnFirst&&(['changed','decreased'].includes(condition.operator)||satisfied):!same&&satisfied;
 return {trigger,reason:trigger?'condition_matched':!initialized?'baseline_initialized':same?'unchanged':'condition_not_met',state:{initialized:true,value,lastEventId:eventId,observedAt:new Date(at).toISOString(),lastTriggeredAt:trigger?new Date(at).toISOString():previous?.lastTriggeredAt||null}};
}
