import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync,crc32} from 'node:zlib';
import {prepareModelImages,pruneOldImages} from '../src/core/model-context.mjs';

const opts={keep:4,keepAllScreenshots:false};
const session={sessionId:'ae00567d-17ca-4d5a-bafa-15a93eb30f5e',generation:4,displayId:9};
const bg={display:'background',backend:'display',displayId:9,displaySession:session};
const text=text=>({type:'text',text}), json=value=>text(JSON.stringify(value));
const handle=id=>text('Image attachment '+id+'; request preview 64x64px. It may be resized or re-encoded; source dimensions, format, and byte size may differ.');
// Entirely synthetic RGB screenshots; incompressible enough that replacing one with a note has a net benefit.
function png(seed){
 const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
 const chunk=(type,bytes)=>{const value=Buffer.concat([Buffer.from(type),bytes]);return Buffer.concat([u32(bytes.length),value,u32(crc32(value))]);};
 const pixels=Buffer.alloc(64*(1+64*3));let state=seed;
 for(let i=0;i<pixels.length;i++)if(i%193!==0){state=(Math.imul(state,1664525)+1013904223)>>>0;pixels[i]=state>>>24;}
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',Buffer.concat([u32(64),u32(64),Buffer.from([8,2,0,0,0])])),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
const a=png(1),b=png(2),inline=(data=a,media_type='image/png')=>({type:'image',source:{type:'base64',media_type,data}});
const tool='mcp__personal__phone_use';
// Keep the split-block fixture as coverage for older/non-coalescing renderers.
function turn(n,{name=tool,callId='toolu_'+n,resultId=callId,blocks,metadata={},source=inline(),error=false,extra=[]}={}){
 const observationId='screen-'+n.toString(16).padStart(8,'0');
 return [{role:'assistant',content:[{type:'tool_use',id:callId,name,input:{action:'observe'}}]},
 {role:'user',content:[{type:'tool_result',tool_use_id:resultId,...error&&{is_error:true},
 content:blocks??[json({finishEvidenceRefs:[observationId]}),json({observationId,untrustedContent:true,display:'main',...metadata}),handle(n),source]},...extra]}];
}
const resultOf=(data,index)=>data.messages[index*2+1].content[0];
const images=blocks=>blocks.filter(x=>x.type==='image');
function run(messages,options=opts){
 const before=structuredClone(messages),unchanged={frozen:'other fields'},data={messages,other:unchanged};
 const stats=prepareModelImages(data,options);
 assert.deepEqual(messages,before,'never mutate source history, image bytes, input arguments or earlier refs');
 assert.strictEqual(data.other,unchanged);
 return {data,stats};
}
for(const [name,metadata] of [[tool,{}],['mcp__personal__phone_observe',bg],['mcp__personal__phone_action',bg]]){
 test('nonadjacent duplicate in '+name+' retains latest pixels and both original observation texts and image handles',()=>{
  const messages=[...turn(1,{name,metadata}),...turn(2,{name,metadata,source:inline(b)}),...turn(3,{name,metadata})];
  const {data,stats}=run(messages);
  assert.equal(stats.deduplicatedImages,1);assert.equal(stats.prunedImages,0);assert.ok(stats.deduplicatedImageBytes>0);assert.equal(stats.treeBytesSaved,0);
  assert.deepEqual(images(resultOf(data,0).content),[]);assert.deepEqual(images(resultOf(data,1).content),[inline(b)]);assert.deepEqual(images(resultOf(data,2).content),[inline()]);
  for(let i=0;i<3;i++){const prior=resultOf({messages},i),now=resultOf(data,i);assert.equal(now.tool_use_id,prior.tool_use_id);for(const block of prior.content.filter(x=>x.type==='text'))assert.ok(now.content.some(x=>x.type==='text'&&x.text===block.text));assert.deepEqual(data.messages[i*2],messages[i*2]);}
  assert.ok(Buffer.byteLength(JSON.stringify(data.messages))<Buffer.byteLength(JSON.stringify(messages)));
 });
}
// Actual dsh-mcp-client coalesces consecutive MCP text with LF. The DeepSeek
// serializer emits a separate attachment handle immediately before the image.
test('deployed LF-coalesced MCP envelopes retain receipt, page text and user image-handle semantics',()=>{
 const wire=(n,kind='ok')=>{
  const observation={observationId:'screen-'+n.toString(16).padStart(8,'0'),untrustedContent:true,...bg,stability:'fresh'};
  const receipt=JSON.stringify({accepted:true,requiresVerification:true}),ref=JSON.stringify({finishEvidenceRefs:[observation.observationId]});
  const tree=JSON.stringify({ok:true,result:{display:'background',displaySession:session,tree:'window id=7\n TextView "合成文字"'}});
  let metadata=JSON.stringify(observation);
  if(kind==='tampered')metadata=JSON.stringify({...observation,untrustedContent:false});
  if(kind==='insideTree')metadata=JSON.stringify({ok:true,result:{tree:metadata}});
  if(kind==='sameLine')metadata='page label contains '+metadata;
  if(kind==='joinedObjects')metadata=JSON.stringify({accepted:true})+' '+metadata;
  return turn(n,{blocks:[text([receipt,ref,metadata,tree].join('\n')),handle(n),inline()]});
 };
 const earlier=wire(1),latest=wire(2);const {data,stats}=run([...earlier,...latest]);
 assert.equal(stats.deduplicatedImages,1);assert.deepEqual(images(resultOf(data,0).content),[]);assert.deepEqual(images(resultOf(data,1).content),[inline()]);
 assert.ok(resultOf(data,0).content.some(block=>block.text===earlier[1].content[0].content[0].text));assert.ok(resultOf(data,0).content.some(block=>block.text===handle(1).text));
 for(const k of ['tampered','insideTree','sameLine','joinedObjects']){
  const messages=[...wire(1,k),...wire(2)];const out=run(messages);
  assert.equal(out.stats.deduplicatedImages,0,k);assert.deepEqual(out.data.messages,messages,k);
 }
});
test('unaligned, ambiguous or non-screen images pass through without being used as duplicate evidence',()=>{
 const fakeUser=inline(),multi=turn(1);multi[1].content[0].content.push(inline());
 const badCases=[
  turn(1,{source:inline(b)}),turn(1,{source:inline(a,'image/jpeg')}),turn(1,{source:{type:'image',source:{type:'file',file_id:'file_fixture'}}}),
  turn(1,{blocks:[handle(1),inline()]}),multi,turn(1,{error:true}),turn(1,{resultId:'toolu_unbound'}),
  turn(1,{name:'mcp__other__phone_use'}),turn(1,{name:'phone_use'}),turn(1,{metadata:{observationId:'decorative'}}),turn(1,{metadata:{untrustedContent:false}}),
  turn(1,{callId:'toolu_2'}),
  [{role:'user',content:[fakeUser]}],
 ];
 for(const [index,earlier] of badCases.entries()){
  const messages=[...earlier,...turn(2)];
  const {data,stats}=run(messages);assert.equal(stats.deduplicatedImages,0,'ineligible fixture '+index);assert.deepEqual(data.messages,messages);
 }
});
test('identical JPEG frames in one session are compacted; separate displays or generations keep both originals',()=>{
 const jpeg=inline('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCABAAEABAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APFqKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK//9k=','image/jpeg');
 for(const [older,newer,count] of [[bg,bg,1],[{},bg,0],[bg,{...bg,displaySession:{...session,generation:session.generation+1}},0]]){
  const {data,stats}=run([...turn(1,{metadata:older,source:jpeg}),...turn(2,{metadata:newer,source:jpeg})]);
  assert.equal(stats.deduplicatedImages,count);assert.equal(images(resultOf(data,0).content).length,1-count);assert.deepEqual(images(resultOf(data,1).content),[jpeg]);
 }
});
test('top-level user upload next to a matching tool result stays byte-for-byte intact',()=>{
 const mixed=turn(1,{extra:[text('保留我的参考图'),inline()]});
 const {data,stats}=run([...mixed,...turn(2)]);
 assert.equal(stats.deduplicatedImages,1);assert.deepEqual(images(resultOf(data,0).content),[]);assert.deepEqual(data.messages[1].content.slice(1),mixed[1].content.slice(1));
});
test('legacy last-four-image-turn boundary remains independent of eligible-frame dedup; keep-all bypasses both',()=>{
 const messages=[...turn(1),...turn(2,{source:inline(b)}),...turn(3),...turn(4,{source:inline(png(4))}),...turn(5)];
 const legacy={messages:structuredClone(messages)};assert.equal(pruneOldImages(legacy,{keep:4}),1);
 const {data,stats}=run(messages);
 assert.equal(stats.prunedImages,1);assert.equal(stats.deduplicatedImages,1);
 assert.deepEqual(resultOf(data,0),resultOf(legacy,0));assert.deepEqual(images(resultOf(data,1).content),[inline(b)]);assert.deepEqual(images(resultOf(data,2).content),[]);assert.deepEqual(images(resultOf(data,4).content),[inline()]);
 const bypass=run(messages,{keep:4,keepAllScreenshots:true});assert.deepEqual(bypass.data.messages,messages);
 assert.deepEqual(bypass.stats,{prunedImages:0,deduplicatedImages:0,deduplicatedImageBytes:0,treeBytesSaved:0});
});
