import test from 'node:test';
import assert from 'node:assert/strict';
import {Phone} from '../../src/adapters/phone.mjs';
import {Broker} from '../../src/tools/broker.mjs';
import {Engine} from '../../src/core/engine.mjs';
import {createTaskContract} from '../../src/core/task-contract.mjs';
const WEATHER={packageName:'com.example.weather',label:'天气',aliases:['天气','Weather']};
const SETTINGS={packageName:'com.android.settings',label:'设置',aliases:['设置','Settings']};
const WECHAT={packageName:'com.tencent.mm',label:'微信',aliases:['微信','WeChat']};
const line=(id,text,y=200,x=100,width=500)=>({id,text,bounds:[x,y,x+width,y+60],center:{x:x+width/2,y:y+30}});
function tree(pkg,body='',{foreground=pkg+'/Activity',display='main'}={}){
 return {content:[{type:'text',text:JSON.stringify({ok:true,result:{display,foreground,windowPkg:pkg,window:'main',tree:'window pkg='+pkg+' bounds=0,0,1000,2000\n'+body}})}]};
}
const frame=(pkg,lines=[],body='',extra)=>({tree:tree(pkg,body,extra),ocr:{width:1000,height:2000,lines}});
const weatherHome=()=>frame(WEATHER.packageName,[line('search','搜索')],'Button "搜索" clickable bounds=100,200,600,260');
const weatherInput=(value='')=>frame(WEATHER.packageName,[line('input',value||'搜索城市',200,100,650),line('search','搜索',200,820,150)],
 'EditText "搜索城市" editable focused clickable bounds=100,200,750,260\n Button "搜索" clickable bounds=820,200,970,260');
const weatherResult=()=>frame(WEATHER.packageName,[line('city','上海',200),line('temp','当前温度 18°C',500),line('details','详情',800)],
 'Button "详情" clickable bounds=100,800,600,860');
const settingHome=()=>frame(SETTINGS.packageName,[line('battery','电池')],'Button "电池" clickable bounds=100,200,600,260');
const battery=()=>frame(SETTINGS.packageName,[line('title','电池用量'),line('level','当前电量80%',500)]);
const contacts=()=>frame(WECHAT.packageName,[line('contacts','通讯录'),line('chat','聊天',500)],'Button "通讯录" clickable bounds=100,200,600,260\n Text "聊天" bounds=100,500,600,560');
export function fixture({prompt='打开天气，搜索上海',app=WEATHER,current=weatherHome(),opened=current,next=[]}={}){
 const task={id:'t',source:'user',status:'running',kind:'general',depth:0,parentId:null,phoneQuery:null,phoneUseScope:null,prompt,messages:[{id:'human-current',role:'user',content:prompt}],quotes:[],children:[],events:[]};
 const data={tasks:[task],actions:[],artifacts:[],roles:[{id:'concierge',hidden:false}],settings:{phoneEnabled:true,phoneUseDeviceId:'fixture-device',memoryEnabled:false}};
 let state=current,queue=[...next],approvalCount=0,finished=0;const calls=[],directoryCalls=[];
 const store={data,task(id){assert.equal(id,'t');return task;},event(){},transaction(fn){return fn(data);},updateTask(id,fn){assert.equal(id,'t');fn(task,data);return task;}};
 const phone=new Phone(store,{wait:async()=>{},recognize:async image=>JSON.parse(Buffer.from(image.content[0].data,'base64').toString()).ocr});
 // This synthetic phone has its own empty in-memory journal; never open the operator's device ledger.
 phone.phoneUse.client.loaded=true;
 phone.apps={list:async query=>{directoryCalls.push({method:'list',query});return {source:'adb',cached:false,apps:[{...app}],totalMatched:1};},resolve:async packageName=>{directoryCalls.push({method:'resolve',packageName});assert.equal(packageName,app.packageName);return {...app,source:'adb',cached:false};}};
 phone.call=async(name,args)=>{
  calls.push({name,args});assert.equal(args.display,'main');
  if(name==='ui_tree')return state.tree;
  if(name==='screenshot')return {content:[{type:'image',mimeType:'image/png',data:Buffer.from(JSON.stringify(state)).toString('base64')}]};
  if(name==='open_app'){assert.equal(args.packageName,app.packageName);state=opened;return {content:[{type:'text',text:'{"ok":true}'}]};}
  if(['tap','long_press','type','key','swipe'].includes(name)){if(queue.length)state=queue.shift();return {content:[{type:'text',text:'{"ok":true}'}]};}
  if(name==='wait_idle')return {content:[{type:'text',text:'{"ok":true,"result":{"settled":true,"waitedMs":0}}'}]};
  throw Error('Unexpected '+name);
 };
 const approvals={request:async()=>{approvalCount++;},cancelTask(){}};
 const broker=new Broker({store,phone,approvals});broker.engine={finishReport(){finished++;task.status='completed';task.result=task.report.summary;},blockToolFailure(){}};
 return {task,data,store,phone,broker,calls,directoryCalls,approvals,counts:()=>({approvals:approvalCount,finished}),setState(s){state=s;}};
}
const object=r=>r.content.filter(c=>c.type==='text').map(c=>{try{return JSON.parse(c.text);}catch{return null;}}).filter(Boolean);
const observation=r=>object(r).find(o=>o.observationId||o.stability);
const action=(id,target)=>({observationId:id,action:'tap',textTargetId:target,reason:'Only current app navigation'});

