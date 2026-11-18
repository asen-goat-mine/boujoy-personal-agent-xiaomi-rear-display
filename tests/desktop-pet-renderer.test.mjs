import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../desktop/pet/pet.js',import.meta.url),'utf8');
function fixture(){
 const paints=[],events={},nodes=new Map();let frame,onStatus,onFed,now=100;
 const ctx={fillStyle:'',clearRect(){},drawImage(){},save(){},restore(){},translate(){},fillRect(...args){paints.push({color:this.fillStyle,args});}};
 for(const key of ['#pet','#face','#robot','#status'])nodes.set(key,{style:{},dataset:{},classList:{add(){},remove(){}},setAttribute(){},addEventListener(n,f){events[key+':'+n]=f;},getContext:()=>ctx,getBoundingClientRect:()=>({x:0,y:0,width:88,height:88})});
 const api={status:async()=>({mode:'idle',online:true,feedReadyAt:0}),onStatus:f=>onStatus=f,onFed:f=>onFed=f};
 const c={window:{boujoyPet:api},document:{hidden:false,querySelector:k=>nodes.get(k),addEventListener(){}},matchMedia:()=>({matches:false}),Image:class{set src(v){this.onload();}},performance:{now:()=>now},Date,Math,setInterval(){},requestAnimationFrame:f=>frame=f};
 vm.runInNewContext(source,c);
 return {nodes,paints,push:x=>onStatus(x),feed:x=>onFed(x),tick:t=>{now=t;paints.length=0;frame(t);}};
}
test('an immediate working update paints terminal face and completion restores normal face',()=>{
 const f=fixture();f.push({mode:'working',online:true});f.tick(100);assert.equal(f.nodes.get('#pet').dataset.mode,'working');assert.ok(f.paints.some(p=>p.color==='#102b27'),'terminal background must be visible');
 f.push({mode:'idle',online:true});f.tick(200);assert.equal(f.nodes.get('#pet').dataset.mode,'idle');assert.ok(!f.paints.some(p=>p.color==='#102b27'));assert.ok(f.paints.some(p=>p.color==='#7952f1'),'normal eyes must return');
});
test('feeding temporarily shows a mouth, then restores ongoing task code instead of pretending task finished',()=>{
 const f=fixture();f.push({mode:'working',online:true});f.feed({mode:'working',online:true,accepted:true,feedReadyAt:Date.now()+60000});f.tick(600);assert.ok(f.paints.some(p=>p.color==='#39283f'));f.tick(2600);assert.ok(f.paints.some(p=>p.color==='#102b27'));assert.equal(f.nodes.get('#pet').dataset.mode,'working');
});
test('idle poses vary over time while maintaining finite transforms',()=>{const f=fixture(),poses=new Set();for(const t of [100,3600,4600,7200,12000,12800]){f.tick(t);const transform=f.nodes.get('#face').style.transform;assert.ok(!transform.includes('NaN'));poses.add(transform);}assert.equal(poses.size,6);});

test('working terminal rows visibly move between adjacent frames',()=>{const f=fixture();f.push({mode:'working',online:true});f.tick(900);const first=JSON.stringify(f.paints);f.tick(990);assert.notEqual(JSON.stringify(f.paints),first);});
