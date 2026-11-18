import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {normalizePhoneRecognition,recognizePhoneImage,sameTextTarget} from '../src/adapters/phone-ocr.mjs';
const execute=promisify(execFile);
const raw=()=>({width:1200,height:500,lines:[{text:'关注推荐闪购外卖国补飞猪旅行搜索',bounds:[60,108,732,152]},{text:'合计 ¥12.9 立即支付',bounds:[40,360,700,420]}],words:[
 {text:'闪购',bounds:[230,108,313,152],sourceRow:0,range:{location:4,length:2},geometrySource:'vision_subrange'},
 {text:'外卖',bounds:[313,108,401,152],sourceRow:0,range:{location:6,length:2},geometrySource:'vision_subrange'},
 {text:'搜索',bounds:[648,108,732,152],sourceRow:0,range:{location:14,length:2},geometrySource:'vision_subrange'}
]});
test('precise native word boxes are appended while full header and payment rows remain intact',()=>{
 const data=raw(),result=normalizePhoneRecognition(data);
 assert.equal(result.lines[0].text,data.lines[0].text);assert.equal(result.lines[1].text,data.lines[1].text);
 const word=result.lines.find(n=>n.text==='闪购');assert.equal(word.kind,'word');assert.equal(word.geometrySource,'vision_subrange');assert.deepEqual(word.range,{location:4,length:2});
 assert.deepEqual(word.center,{x:272,y:130});assert.deepEqual(word.bounds,[230,108,313,152]);
 assert.ok(result.lines.find(n=>n.text.includes('¥12.9')).kind==='row');
});
test('word targets reject forged ranges, whole-row boxes, off-row geometry and sensitive parent rows',()=>{
 for(const kind of ['range','whole_row','outside','untrusted_geometry','sensitive','arbitrary_text']){
  const data=raw();
  if(kind==='range')data.words[0].range.location=3;
  if(kind==='whole_row')data.words[0].bounds=data.lines[0].bounds;
  if(kind==='outside')data.words[0].bounds=[900,108,980,152];
  if(kind==='untrusted_geometry')data.words[0].geometrySource='proportional_guess';
  if(kind==='sensitive')data.lines[0].text+=' 支付密码';
  if(kind==='arbitrary_text')data.words[0].text='买';
  const result=normalizePhoneRecognition(data);assert.equal(result.lines.some(n=>n.kind==='word'&&n.text===data.words[0].text),false,kind);
 }
});
test('subrange offsets preserve UTF-16 indexing and duplicate word boxes are omitted',()=>{
 const data={width:500,height:400,lines:[{text:'🧋关注闪购外卖',bounds:[10,50,450,100]}],words:[{text:'闪购',bounds:[180,50,270,100],sourceRow:0,range:{location:4,length:2},geometrySource:'vision_subrange'}]};
 data.words.push(structuredClone(data.words[0]));const result=normalizePhoneRecognition(data);assert.equal(result.lines.filter(n=>n.kind==='word').length,1);
 data.words[0].range.location=3;data.words.pop();assert.equal(normalizePhoneRecognition(data).lines.length,1);
});
test('adding word targets never loosens changed payment amounts or newly exposed payment context',()=>{
 const a=normalizePhoneRecognition(raw()),b=structuredClone(a),pay=a.lines.find(n=>n.text.includes('立即支付'));
 b.lines[1].text='合计 ¥25 立即支付';assert.equal(sameTextTarget(a,b,pay),false);
 const nav=a.lines.find(n=>n.text==='闪购');b.lines.push({text:'支付密码',bounds:[40,300,500,345]});assert.equal(sameTextTarget(a,b,nav),false);
});
const RENDER="ObjC.import('Foundation');ObjC.import('AppKit');\nfunction run(argv){\n const width=1200,height=500,x=60,y=340,text='关注推荐闪购外卖国补飞猪旅行搜索';\n const bitmap=$.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null,width,height,8,4,true,false,$.NSCalibratedRGBColorSpace,0,0);\n $.NSGraphicsContext.saveGraphicsState;$.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(bitmap));\n $.NSColor.whiteColor.setFill;$.NSRectFill($.NSMakeRect(0,0,width,height));\n const font=$.NSFont.fontWithNameSize('PingFangSC-Regular',42),attrs=$.NSMutableDictionary.alloc.init;\n attrs.setObjectForKey(font,$.NSFontAttributeName);attrs.setObjectForKey($.NSColor.blackColor,$.NSForegroundColorAttributeName);\n $(text).drawAtPointWithAttributes($.NSMakePoint(x,y),attrs);\n $('合计 ¥12.9 立即支付').drawAtPointWithAttributes($.NSMakePoint(60,100),attrs);\n $.NSGraphicsContext.restoreGraphicsState;bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG,$({})).writeToFileAtomically(argv[0],true);\n const regions=['闪购','外卖','搜索'].map(term=>{const at=text.indexOf(term),prefix=Number($(text.slice(0,at)).sizeWithAttributes(attrs).width),size=Number($(term).sizeWithAttributes(attrs).width);return {text:term,left:x+prefix,right:x+prefix+size};});\n return JSON.stringify({width,height,text,regions});\n}";
test('real macOS Vision localizes words inside a genuinely merged Chinese header image',{skip:process.platform!=='darwin'},async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'boujoy-vision-word-test-'));
 try{
  const file=path.join(dir,'merged-header.png'),{stdout}=await execute('/usr/bin/osascript',['-l','JavaScript','-e',RENDER,file],{timeout:6000,maxBuffer:500000}),drawing=JSON.parse(stdout);
  const bytes=await fs.readFile(file),result=await recognizePhoneImage({content:[{type:'image',mimeType:'image/png',data:bytes.toString('base64')}]});
  assert.ok(result,'Actual local Vision must be available; run this macOS test outside restricted Vision sandbox');
  const merged=result.lines.find(n=>n.kind==='row'&&n.text.replace(/\s+/g,'')===drawing.text);assert.ok(merged,'Fixture must genuinely recognize header as one merged row');
  for(const region of drawing.regions){
   const word=result.lines.find(n=>n.kind==='word'&&n.text===region.text);assert.ok(word,region.text+' word target missing');
   assert.ok(word.center.x>region.left&&word.center.x<region.right,region.text+' click center must hit independently measured glyph region');
   assert.ok(Math.abs(word.bounds[0]-region.left)<=6&&Math.abs(word.bounds[2]-region.right)<=6,region.text+' box must fit actual drawn glyphs');
   assert.ok(word.bounds[2]-word.bounds[0]<(merged.bounds[2]-merged.bounds[0])/2);
  }
  assert.ok(result.lines.some(n=>n.kind==='row'&&n.text.includes('12.9')&&n.text.includes('支付')),'Payment amount/source row retained');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

