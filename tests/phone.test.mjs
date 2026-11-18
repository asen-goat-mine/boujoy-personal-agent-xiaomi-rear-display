import test from 'node:test';
import assert from 'node:assert/strict';
import {Phone} from '../src/adapters/phone.mjs';

function fixture(){
  const phone=new Phone({data:{settings:{phoneEnabled:true}}});
  const calls=[];
  let tree='window pkg=test bounds=0,0,968,2376\nEditText editable focused bounds=40,400,900,500';
  phone.call=async(name,args)=>{
    calls.push({name,args});
    // Pony defaults to a separate, possibly empty display when display is omitted.
    if(args?.display!=='main')throw new Error('background_empty');
    if(name==='ui_tree')return {content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',tree}})}]};
    return {content:[{type:'text',text:'{"ok":true}'}]};
  };
  return {phone,calls,changePage(){tree+='\nDialog bounds=0,0,968,1000';}};
}

test('phone observes and acts on the same main display when Pony defaults to background',async()=>{
  const {phone,calls}=fixture();
  const observation=await phone.observe('test');
  const {observationId,display}=JSON.parse(observation.content[0].text);
  assert.equal(display,'main');
  await phone.act('test',{observationId,action:'type',text:'本机测试'});
  assert.deepEqual(calls.map(c=>c.name),['ui_tree','screenshot','ui_tree','type']);
  assert.deepEqual(calls.at(-1).args,{text:'本机测试',mode:'insert',display:'main'});
  await assert.rejects(phone.act('test',{observationId,action:'back'}),/重新观察/);
  phone.release('test');
  phone.listApps=async()=>({source:'fixture',apps:[{packageName:'com.sankuai.meituan',label:'美团'}]});
  await phone.openApp('next','meituan');
  assert.equal(calls.at(-1).name,'open_app');
  assert.equal(calls.at(-1).args.display,'main');
});

test('a changed phone page still blocks actions after main display routing is fixed',async()=>{
  const {phone,calls,changePage}=fixture();
  const observation=await phone.observe('test');
  const {observationId}=JSON.parse(observation.content[0].text);
  changePage();
  await assert.rejects(phone.act('test',{observationId,action:'tap',x:100,y:450}),/发生变化/);
  assert.equal(calls.some(c=>c.name==='tap'),false);
});


test('replace input overwrites the focused field through Pony without clear-button taps',async()=>{
 const {phone,calls}=fixture();
 const observation=await phone.observe('test');const {observationId}=JSON.parse(observation.content[0].text);
 await phone.act('test',{observationId,action:'type',text:'猪脚饭',inputMode:'replace'});
 assert.deepEqual(calls.at(-1),{name:'type',args:{text:'猪脚饭',mode:'replace',display:'main'}});
 assert.equal(calls.some(c=>c.name==='tap'),false);
});
