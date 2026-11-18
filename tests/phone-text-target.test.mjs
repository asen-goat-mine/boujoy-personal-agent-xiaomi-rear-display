import test from 'node:test';
import assert from 'node:assert/strict';
import {Phone} from '../src/adapters/phone.mjs';
import {sameTextScreen,sameTextTarget} from '../src/adapters/phone-ocr.mjs';
const screen=()=>({width:968,height:2376,lines:[{id:'text-1',text:'12:00',bounds:[30,30,130,70],center:{x:80,y:50}},{id:'text-2',text:'选规格',bounds:[808,700,932,748],center:{x:870,y:724}},{id:'text-3',text:'¥24',bounds:[300,600,450,650],center:{x:375,y:625}}]});
function fixture(){
 let ocr=screen();const calls=[];
 const phone=new Phone({data:{settings:{phoneEnabled:true}}},{recognize:async()=>structuredClone(ocr)});
 phone.call=async(name,args)=>{calls.push({name,args});return name==='ui_tree'?{content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:'shop',windowPkg:'shop',window:'0,0,968,2376',tree:'window pkg=shop layer=0 bounds=0,0,968,2376'}})}]}:{content:[]};};
 return {phone,calls,setScreen(s){ocr=s;}};
}
test('recognized text targets drive physical coordinates without model scaling',async()=>{
 const {phone,calls,setScreen}=fixture();const result=await phone.observe('task');const meta=JSON.parse(result.content[0].text);
 assert.deepEqual(meta.screenSize,{width:968,height:2376});assert.equal(meta.textTargets[1].text,'选规格');
 const fresh=screen();fresh.lines[0].text='12:01';setScreen(fresh);
 await phone.act('task',{observationId:meta.observationId,action:'tap',textTargetId:'text-2'});
 assert.deepEqual(calls.at(-1),{name:'tap',args:{x:870,y:724,display:'main'}});
});
test('text-target taps reject a changed price beside the label, moving controls, added overlays and OCR failure',async()=>{
 for(const change of ['price','move','overlay','ocr-failed']){
  const {phone,calls,setScreen}=fixture();const beside=screen();beside.lines[2].bounds=[700,690,790,740];setScreen(beside);
  const meta=JSON.parse((await phone.observe('task')).content[0].text);const next=structuredClone(beside);
  if(change==='price')next.lines[2].text='¥50';if(change==='move')next.lines[1].bounds=[800,800,940,860];if(change==='overlay')next.lines.push({text:'确认支付',bounds:[200,900,800,1000]});
  setScreen(change==='ocr-failed'?null:next);
  await assert.rejects(phone.act('task',{observationId:meta.observationId,action:'tap',textTargetId:'text-2'}));assert.equal(calls.some(c=>c.name==='tap'),false);
 }
});
test('text targets are bound to the current observation and screen size',async()=>{
 const {phone,calls}=fixture();const first=JSON.parse((await phone.observe('task')).content[0].text);const second=JSON.parse((await phone.observe('task')).content[0].text);
 await assert.rejects(phone.act('task',{observationId:first.observationId,action:'tap',textTargetId:'text-2'}));
 await assert.rejects(phone.act('task',{observationId:second.observationId,action:'tap',textTargetId:'text-999'}));
 assert.equal(calls.some(c=>c.name==='tap'),false);assert.equal(sameTextScreen(screen(),{...screen(),width:800}),false);
});

test('OCR search targets tolerate unrelated updates only with an unchanged semantic native control',async()=>{
 const {phone,calls,setScreen}=fixture();const originalCall=phone.call;
 phone.call=async(name,args)=>name==='ui_tree'?{content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:'shop',windowPkg:'shop',window:'0,0,968,2376',tree:'window pkg=shop layer=0 bounds=0,0,968,2376\n  Button "搜索" clickable bounds=800,690,940,760'}})}]}:originalCall(name,args);
 const before=screen();before.lines[1].text='搜索';setScreen(before);const meta=JSON.parse((await phone.observe('task')).content[0].text);
 const after=screen();after.lines[1].text='搜索';after.lines[2].text='新广告';setScreen(after);
 await phone.act('task',{observationId:meta.observationId,action:'tap',textTargetId:'text-2'});assert.equal(calls.at(-1).name,'tap');
});

test('non-transaction text targets ignore distant OCR punctuation noise but retain nearby prices',async()=>{
 const {phone,calls,setScreen}=fixture();const before=screen();before.lines.push({id:'edge',text:'半截，',bounds:[0,1300,150,1350]});setScreen(before);
 const meta=JSON.parse((await phone.observe('task')).content[0].text);const after=structuredClone(before);after.lines.at(-1).text='半截。';setScreen(after);
 await phone.act('task',{observationId:meta.observationId,action:'tap',textTargetId:'text-2'});assert.equal(calls.at(-1).name,'tap');
});
test('transaction text targets retain whole-screen checks',async()=>{
 const {phone,calls,setScreen}=fixture();const before=screen();before.lines[1].text='确认付款';before.lines.push({id:'edge',text:'总额 ¥24',bounds:[0,1300,150,1350]});setScreen(before);
 const meta=JSON.parse((await phone.observe('task')).content[0].text);const after=structuredClone(before);after.lines.at(-1).text='总额 ¥50';setScreen(after);
 await assert.rejects(phone.act('task',{observationId:meta.observationId,action:'tap',textTargetId:'text-2'}));assert.equal(calls.some(c=>c.name==='tap'),false);
});


test('labels on a live page tolerate distant changing offer prices',async()=>{
 for(const label of ['搜索','返回','闪购','选规格','黄焖鸡米饭']){
  const {phone,calls,setScreen}=fixture();const before=screen();before.lines[1].text=label;before.lines[2].bounds=[100,1300,250,1350];setScreen(before);
  const meta=JSON.parse((await phone.observe('task')).content[0].text);const after=structuredClone(before);after.lines[2].text='¥50';setScreen(after);
  await phone.act('task',{observationId:meta.observationId,action:'tap',textTargetId:'text-2'});assert.equal(calls.at(-1).name,'tap');
 }
});

test('safe navigation still rejects nearby amounts and newly exposed payment/account context',()=>{
 const before=screen();before.lines[1].text='搜索';const target=before.lines[1];
 const nearby=structuredClone(before);nearby.lines.push({text:'¥1',bounds:[700,700,780,730]});assert.equal(sameTextTarget(before,nearby,target),false);
 for(const text of ['确认支付','收货地址','验证码','安全验证','登录','授权']){
  const after=structuredClone(before);after.lines.push({text,bounds:[100,1300,700,1360]});assert.equal(sameTextTarget(before,after,target),false,text);
 }
 const moved=structuredClone(before);moved.lines[1].bounds=[808,800,932,848];assert.equal(sameTextTarget(before,moved,target),false);
});


test('old-keyword search fields tolerate distant prices only with the unchanged search header',()=>{
 const target={text:'全部 冰美式',bounds:[155,128,448,173]};
 const before={width:968,height:2376,lines:[target,{text:'搜索',bounds:[823,128,896,169]},{text:'¥12',bounds:[100,1300,250,1350]}]};
 const after=structuredClone(before);after.lines[2].text='¥15';assert.equal(sameTextTarget(before,after,target),true);
 after.lines[1].text='付款';assert.equal(sameTextTarget(before,after,target),false);
 after.lines[1].text='搜索';after.lines[1].bounds=[823,328,896,369];assert.equal(sameTextTarget(before,after,target),false);
});

test('general OCR taps cannot hit a replacement page after the observed label disappears',async()=>{
 for(const changed of [true,false]){
  const {phone,calls,setScreen}=fixture();
  const before=screen();before.lines[1].text='临时入口 4';setScreen(before);
  const meta=JSON.parse((await phone.observe('task')).content[0].text);
  const after=structuredClone(before);if(changed)after.lines[1].text='公开详情';setScreen(after);
  const pending=phone.actGeneral('task',{observationId:meta.observationId,action:'tap',textTargetId:'text-2'});
  if(changed){
   await assert.rejects(pending,error=>error.code==='action_cancelled'&&error.phoneuseCode==='STALE_ELEMENT'&&error.dispatchState==='not_sent');
   assert.equal(calls.some(call=>call.name==='tap'),false);
  }else{await pending;assert.equal(calls.filter(call=>call.name==='tap').length,1);}
 }
 const {phone,calls}=fixture(),meta=JSON.parse((await phone.observe('task')).content[0].text);
 phone.captureStableFrame=async()=>{throw Object.assign(Error('read timed out'),{code:'rpc_timeout'});};
 await assert.rejects(phone.actGeneral('task',{observationId:meta.observationId,action:'tap',textTargetId:'text-2'}),error=>error.code==='rpc_timeout'&&error.dispatchState==='not_sent');
 assert.equal(calls.some(call=>call.name==='tap'),false);
});
