// Offline: serialized request sizes only. No user conversations, model or device.
// node scripts/bench-model-frame-context.mjs <original-52-repo> <synthetic-vision-fixtures-dir>
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {prepareModelImages} from '../src/core/model-context.mjs';
import {modelRequestStats} from '../src/core/model-diagnostics.mjs';

const [baselineDir,fixturesDir]=process.argv.slice(2);
assert.ok(baselineDir&&fixturesDir&&process.argv.length===4,'Usage: node scripts/bench-model-frame-context.mjs <original-52-repo> <synthetic-vision-fixtures-dir>');
const {pruneOldImages}=await import(pathToFileURL(path.resolve(baselineDir,'src/core/model-context.mjs')));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fixtures={};
for(const [key,name] of Object.entries({A:'ALPHA',B:'BRAVO',C:'DELTA'})){
  const buf=await readFile(path.resolve(fixturesDir,`${name}.png`));
  assert.equal(buf.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  fixtures[key]={bytes:buf.length,sha256:sha(buf),width:buf.readUInt32BE(16),height:buf.readUInt32BE(20),block:{type:'image',source:{type:'base64',media_type:'image/png',data:buf.toString('base64')}}};
}
assert.equal(new Set(Object.values(fixtures).map(f=>f.sha256)).size,3);
const phone='mcp__personal__phone_use',other='synthetic_document_preview';
const schema={type:'object',properties:{action:{type:'string',enum:['read']}},required:['action']};
const fixturePrices=['$18.41','$29.72'];
const display={display:'background',backend:'display',displayId:7,displaySession:{sessionId:'8d0ee641-c52f-413b-b36d-837d24a60c11',generation:1,displayId:7}};
function makeTree(i){
  const pkg='dev.example.synthetic',win=42,rows=Array.from({length:180},(_,n)=>`  TextView "Synthetic row ${n+1}" bounds=24,${n*8+12},900,${n*8+20}`);
  rows.splice(90,0,`  TextView "Price ${fixturePrices[i]}" bounds=64,720,600,750`);
  return {ok:true,result:{...display,foreground:pkg,windowPkg:pkg,window:win,tree:[`window pkg=${pkg} id=${win}`,...rows].join('\n')}};
}
function request(keys,{uploads=false,foreignTool=false,changingTree=false}={}){
  const tools=[{name:phone,description:'Read the current phone screen.',input_schema:schema}];
  if(foreignTool)tools.push({name:other,description:'Read a synthetic document preview.',input_schema:schema});
  const messages=[{role:'user',content:[{type:'text',text:'Inspect the synthetic screens.'},...(uploads?[fixtures.A.block,fixtures.A.block]:[])]}];
  for(const [index,key] of [...keys].entries()){
    const id=`toolu_synthetic_${index+1}`,name=foreignTool?other:phone,f=fixtures[key];
    messages.push({role:'assistant',content:[{type:'tool_use',id,name,input:{action:'read'}}]});
    // Even the non-phone control gets convincing observation-shaped text: it must stay untouched.
    const meta={observationId:'screen-'+(index+1).toString(16).padStart(8,'0'),untrustedContent:true,...display,screenSize:{width:f.width,height:f.height},textTargets:[],stability:'fresh',stabilityScope:'general'};
    const records=[{finishEvidenceRefs:[meta.observationId]},meta,...(changingTree?[makeTree(index)]:[])];
    // The SDK joins all MCP text fragments with LF, then adds the handle as a separate block.
    const text=records.map(record=>JSON.stringify(record)).join('\n');
    const handle=`Image attachment img_${index+1}; request preview ${f.width}x${f.height}px. It may be resized or re-encoded; source dimensions, format, and byte size may differ.`;
    messages.push({role:'user',content:[{type:'tool_result',tool_use_id:id,content:[{type:'text',text},{type:'text',text:handle},f.block]}]});
  }
  return {model:'synthetic-vision',max_tokens:128,stream:true,system:'Synthetic benchmark.',tools,messages};
}
const totals=data=>{const {requestBytes,images,imageBytes}=modelRequestStats(data,JSON.stringify(data));return {requestBytes,images,imageBlockBytes:imageBytes};};
function assertPreservesMessages(before,after,changingTree){
  assert.equal(before.messages.length,after.messages.length);
  for(const [i,msg] of before.messages.entries()){
    const got=after.messages[i];assert.equal(got.role,msg.role);
    if(msg.role==='assistant'||i===0){assert.deepEqual(got,msg);continue;}
    const a=msg.content[0],b=got.content[0];assert.equal(a.type,b.type);assert.equal(a.tool_use_id,b.tool_use_id);
    const text=b.content.filter(v=>v.type==='text').map(v=>v.text);
    for(const block of a.content.filter(v=>v.type==='text')){
      if(text.includes(block.text))continue;
      assert.ok(changingTree&&i===2,'Original observation metadata and every attachment handle must remain present');
      const oldLines=block.text.split('\n'),replaced=text[0].split('\n');assert.equal(replaced.length,oldLines.length);assert.deepEqual(replaced.slice(0,-1),oldLines.slice(0,-1));
      const oldEnvelope=JSON.parse(oldLines.at(-1)),changed=JSON.parse(replaced.at(-1)),delta=changed.result.tree;
      const ref=after.messages.at(-1).content[0];assert.equal(delta.baseToolUseId,ref.tool_use_id);
      const base=JSON.parse(ref.content[0].text.split('\n').at(-1)).result.tree.split('\n');
      const range=bounds=>!bounds?[]:base.slice(bounds[0]-1,bounds[1]);
      const restored=[...range(delta.prefixLines1BasedInclusive),...delta.literalLines,...range(delta.suffixLines1BasedInclusive)].join('\n');
      assert.ok(delta.literalLines.some(line=>line.includes(fixturePrices[0])));assert.ok(base.some(line=>line.includes(fixturePrices[1])));
      assert.deepEqual({...changed,result:{...changed.result,tree:restored}},oldEnvelope);
    }
  }
  if(before.messages.length>1){const last=m=>m.messages.at(-1).content[0].content;assert.deepEqual(last(before),last(after),'Newest observation must retain its image');}
}
const cases=[
  {name:'repeated',keys:'AAAA',want:1},
  {name:'partly-repeated',keys:'AABB',want:2},
  {name:'all-different',keys:'ABC',unchanged:true},
  {name:'different-images-and-prices-same-window',keys:'AB',changingTree:true},
  {name:'six-frames-four-message-boundary',keys:'ABCCBB',want:2},
  {name:'keep-all-opt-out',keys:'ABCCBB',keepAll:true,unchanged:true},
  {name:'user-upload-with-matching-phone-image',keys:'A',uploads:true,unchanged:true},
  {name:'other-tool-with-observation-shaped-text',keys:'AAAA',foreignTool:true,unchanged:true}
];
const results=[];
for(const scenario of cases){
  const raw=request(scenario.keys,scenario),before=structuredClone(raw),after=structuredClone(raw);
  if(!scenario.keepAll)pruneOldImages(before,{keep:4});
  const changes=prepareModelImages(after,{keep:4,keepAllScreenshots:scenario.keepAll===true});
  assertPreservesMessages(before,after,scenario.changingTree);
  const old=totals(before),updated=totals(after);
  if(scenario.unchanged)assert.deepEqual(after,before,'Unexpected change: '+scenario.name);
  if(scenario.want!==undefined){assert.equal(updated.images,scenario.want,scenario.name);assert.ok(updated.requestBytes<old.requestBytes);}
  if(scenario.name==='six-frames-four-message-boundary')assert.equal(old.images,4);
  if(scenario.changingTree){assert.deepEqual(after.messages.flatMap(m=>m.content.flatMap(b=>b.content?.filter(c=>c.type==='image')??[])),[fixtures.A.block,fixtures.B.block]);assert.ok(changes.treeBytesSaved>0&&updated.requestBytes<old.requestBytes);assert.equal(updated.images,2);}
  results.push({scenario:scenario.name,sequence:scenario.keys,raw:totals(raw),original52:old,candidate52:updated,savedRequestBytes:old.requestBytes-updated.requestBytes,treeBytesSaved:changes.treeBytesSaved});
}
console.log(JSON.stringify({measurement:'UTF-8 bytes of JSON.stringify(request) prior to transport; imageBlockBytes includes JSON/base64 envelope. Synthetic data only; not token, network, latency or end-to-end measurements.',fixtures:Object.fromEntries(Object.entries(fixtures).map(([k,{block,...meta}])=>[k,meta])),results},null,2));
