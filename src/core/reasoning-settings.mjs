import {requireValue} from './errors.mjs';
export const REASONING_OPTIONS=Object.freeze([
 {value:'auto',label:'自动',description:'按任务选择：常规任务深入思考，复杂任务最大思考'},
 {value:'off',label:'关闭思考',description:'减少推理等待，复杂任务可能需要更多尝试'},
 {value:'low',label:'少量思考',description:'较少推理，响应通常更快'},
 {value:'high',label:'深入思考',description:'更充分地分析，可能增加等待与用量'},
 {value:'max',label:'最大思考',description:'使用最大思考档位，适合需要充分分析的任务'}
]);
export function reasoningSettings(settings){return {modelReasoning:settings.modelReasoning||'auto',options:REASONING_OPTIONS,scope:'shared',appliesTo:'next_task'};}
export function setReasoning(store,value){requireValue(REASONING_OPTIONS.some(o=>o.value===value),'思考档位无效');store.transaction(s=>{s.settings.modelReasoning=value;});return reasoningSettings(store.data.settings);}
