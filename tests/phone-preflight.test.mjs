import test from 'node:test';
import assert from 'node:assert/strict';
import {Phone} from '../src/adapters/phone.mjs';
import {preflightPhone} from '../src/adapters/phone-preflight.mjs';

const PRIVATE='private fixture address / customer token / 654321';
const line=(id,text,y)=>({id,text,bounds:[40,y,600,y+40],center:{x:320,y:y+20}});
const native=(pkg='com.taobao.taobao',extra={})=>({content:[{type:'text',text:JSON.stringify({ok:true,result:{
  display:'main',foreground:pkg,windowPkg:pkg,tree:'window pkg='+pkg+' bounds=0,0,1000,2000\n'+PRIVATE,...extra
}})}]});
const fullFrame=(text='商品列表',pkg='com.taobao.taobao')=>({tree:native(pkg),ocr:{width:1000,height:2000,lines:[line('item',text,600),line('private',PRIVATE,800)]}});
const homeFrame=ad=>({tree:native(),ocr:{width:1000,height:2000,lines:[line('flash','闪购',160),line('search','搜索',160),line('ad',ad,1000)]}});
function fixture({frames=[fullFrame()],status={},enabled=true,error=null}={}){
  let cursor=0,time=0,screenshots=0,releases=0,acquires=0;const calls=[];
  const phone=new Phone({data:{settings:{phoneEnabled:enabled}}},{
    clock:()=>time,wait:async ms=>{time+=ms;},recognize:async image=>JSON.parse(Buffer.from(image.content[0].data,'base64').toString()).ocr
  });
  phone.call=async(name,args={})=>{
    calls.push(name);
    if(error)throw error;
    if(name==='status')return {content:[{type:'text',text:JSON.stringify({connected:true,link:'ready',listening:true,
      token:PRIVATE,safetyCode:PRIVATE,pairingLink:PRIVATE,log:[PRIVATE],...status})}]};
    assert.equal(args.display,'main');
    const frame=frames[Math.min(cursor,frames.length-1)];
    if(name==='ui_tree')return frame.tree;
    if(name==='screenshot'){
      screenshots++;cursor++;
      return {content:[{type:'image',mimeType:'image/png',data:Buffer.from(JSON.stringify({ocr:frame.ocr})).toString('base64')}]};
    }
    throw Error('A diagnostic tried to mutate the phone: '+name);
  };
  const acquire=phone.acquire.bind(phone),release=phone.release.bind(phone);
  phone.acquire=id=>{acquires++;return acquire(id);};
  phone.release=id=>{releases++;return release(id);};
  return {phone,calls,counts:()=>({screenshots,releases,acquires})};
}
function assertFiltered(result){
  assert.deepEqual(Object.keys(result).sort(),['ready','connected','foreground','stabilityScope','stableTargetCount','elapsedMs','reason','modelRequests','actions'].sort());
  assert.ok(Number.isFinite(result.elapsedMs)&&result.elapsedMs>=0);
  assert.equal(result.modelRequests,0);assert.equal(result.actions,0);
  assert.ok(!JSON.stringify(result).includes(PRIVATE));
  for(const name of ['tree','textTargets','content','token','safetyCode','pairingLink','observationId'])assert.ok(!Object.hasOwn(result,name));
}
test('preflight verifies a full local observation, strips all private data and releases its lease',async()=>{
  const f=fixture();const result=await preflightPhone(f.phone);assertFiltered(result);
  assert.equal(result.ready,true);assert.equal(result.connected,true);assert.equal(result.foreground,'com.taobao.taobao');
  assert.equal(result.stabilityScope,'full');assert.equal(result.stableTargetCount,2);
  assert.deepEqual(f.calls,['status','ui_tree','ui_tree','screenshot','ui_tree','screenshot']);
  assert.deepEqual(f.counts(),{screenshots:2,releases:1,acquires:2});
  assert.equal(f.phone.lease,null);assert.equal(f.phone.observation,null);
});
test('moving homepage ads accept only the verified header navigation scope',async()=>{
  const f=fixture({frames:[homeFrame('活动一 '+PRIVATE),homeFrame('活动二 '+PRIVATE)]});
  const result=await preflightPhone(f.phone);assertFiltered(result);
  assert.equal(result.ready,true);assert.equal(result.reason,'navigation_ready');
  assert.equal(result.stabilityScope,'navigation');assert.equal(result.stableTargetCount,1);assert.equal(f.phone.lease,null);
});
test('foreign apps, mismatched windows and background display are rejected before any screenshot',async()=>{
  for(const tree of [native('com.tencent.mm'),native('com.taobao.taobao',{windowPkg:'private.foreign.pkg'}),native('com.taobao.taobao',{display:'background'}),native('com.taobao.taobao.fake')]){
    const f=fixture({frames:[{...fullFrame(),tree}]});const result=await preflightPhone(f.phone);assertFiltered(result);
    assert.equal(result.ready,false);assert.equal(result.reason,'foreground_mismatch');assert.equal(result.foreground,'other');
    assert.equal(f.counts().screenshots,0);assert.equal(f.counts().releases,1);assert.equal(f.phone.lease,null);
    assert.deepEqual(f.calls,['status','ui_tree']);
  }
});
test('an app switch between the initial check and stability sampling cannot capture the foreign screen',async()=>{
  for(const switchAt of [2,3]){
    const f=fixture();let nativeReads=0;
    const call=f.phone.call;
    f.phone.call=async(name,args,timeout)=>{if(name==='ui_tree'&&++nativeReads===switchAt)return native('com.tencent.mm');return call(name,args,timeout);};
    const result=await preflightPhone(f.phone);assertFiltered(result);
    assert.equal(result.ready,false);assert.equal(result.reason,'foreground_mismatch');assert.equal(f.counts().screenshots,switchAt-2);
    assert.equal(f.counts().releases,1);assert.equal(f.phone.lease,null);
  }
});
test('disconnected, reconnecting and non-listening states do not read or photograph the phone',async()=>{
  for(const options of [{status:{connected:false}},{status:{link:'reconnecting'}},{status:{listening:false}}]){
    const f=fixture(options);const result=await preflightPhone(f.phone);assertFiltered(result);
    assert.equal(result.ready,false);assert.equal(f.counts().screenshots,0);assert.equal(f.counts().releases,1);assert.equal(f.phone.lease,null);
    assert.deepEqual(f.calls,['status']);
  }
});
test('disabled phone execution refuses the lease before any status or screen request',async()=>{
  const f=fixture({enabled:false});const result=await preflightPhone(f.phone);assertFiltered(result);
  assert.equal(result.ready,false);assert.deepEqual(f.calls,[]);assert.deepEqual(f.counts(),{screenshots:0,releases:0,acquires:1});assert.equal(f.phone.lease,null);assert.equal(f.phone.observation,null);
});
test('unstable pages produce a filtered failure without an actionable observation',async()=>{
  const f=fixture({frames:Array.from({length:5},(_,i)=>fullFrame('不断变化 '+i))});
  const result=await preflightPhone(f.phone);assertFiltered(result);assert.equal(result.ready,false);
  assert.equal(result.reason,'screen_unstable');assert.equal(result.stabilityScope,null);assert.equal(result.stableTargetCount,0);
  assert.equal(f.counts().releases,1);assert.equal(f.phone.lease,null);assert.equal(f.phone.observation,null);
});
test('raw MCP errors and error codes cannot leak through the public diagnostic',async()=>{
  const f=fixture({error:Object.assign(new Error(PRIVATE),{code:PRIVATE})});
  const result=await preflightPhone(f.phone);assertFiltered(result);assert.equal(result.ready,false);
  assert.equal(result.reason,'phone_not_connected');assert.equal(f.counts().releases,1);assert.equal(f.phone.lease,null);
});
test('a busy phone retains the existing lease and does not perform diagnostics',async()=>{
  const f=fixture();f.phone.lease='existing-task';const result=await preflightPhone(f.phone);assertFiltered(result);
  assert.equal(result.ready,false);assert.equal(result.reason,'phone_busy');assert.equal(f.phone.lease,'existing-task');
  assert.deepEqual(f.calls,[]);assert.equal(f.counts().screenshots,0);assert.equal(f.counts().releases,0);
});
test('malformed native responses and unsupported platforms fail before screenshots',async()=>{
  const f=fixture({frames:[{...fullFrame(),tree:{content:[{type:'text',text:PRIVATE}]}}]});
  const result=await preflightPhone(f.phone);assertFiltered(result);assert.equal(result.reason,'native_unavailable');assert.equal(f.counts().screenshots,0);assert.equal(f.phone.lease,null);
  const untouched=fixture();const unknown=await preflightPhone(untouched.phone,{platform:PRIVATE});assertFiltered(unknown);
  assert.equal(unknown.reason,'unsupported_platform');assert.deepEqual(untouched.calls,[]);assert.equal(untouched.counts().acquires,0);
});
