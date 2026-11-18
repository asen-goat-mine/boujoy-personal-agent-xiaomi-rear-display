import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {XMLParser} from 'fast-xml-parser';
import {createDocumentArtifact} from '../src/tools/documents.mjs';

const run=promisify(execFile),root=path.resolve(import.meta.dirname,'..');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-office-render-')),output=path.join(root,'dist/verification/office');
fs.mkdirSync(output,{recursive:true});
const table={headers:['检查项目','状态','金额 / 元'],rows:[['冰美式，标准杯，冰','已核实',12.5],['牛肉面，不另加配菜','待核实',18],['配送和包装费用','单独核对',3.5]]};
const samples=[
 {format:'docx',name:'报告排版验证',title:'个人助理 · 实际文件验收',content:{sections:[{heading:'检查结论',paragraphs:['本文件用于验证中文、数字和表格排版。内容全部为合成测试数据，不代表实际购买或已完成的手机操作。','报告可编辑，正文、章节和表格通过生成后结构回读。'],table},{heading:'下一步',paragraphs:['核实目标对象及来源；结果不明时保留记录，不重复提交。']}]}},
 {format:'xlsx',name:'表格排版验证',title:'价格核对',content:{sheets:[{name:'核对表',...table}]}},
 {format:'pptx',name:'幻灯片排版验证',title:'个人助理执行检查',content:{slides:[{title:'Mac 与手机各自负责什么',body:['Mac 负责任务、模型调用与专用记忆。','手机提供实际页面与操作回执。','云中继仅负责端点之间的数据传输。']},{title:'完成不等于点击过',body:['核对对象、数量、金额和当前页面。','结果未知时查询原操作，不重复提交。','需要输入密码或支付时交给用户。']},{title:'较长正文与中文换行',body:Array.from({length:8},(_,i)=>`${i+1}. `+'这一页用于检查中文换行、长正文缩放和页码是否被遮挡。'.repeat(5))}]}}
];
const all=value=>value===undefined?[]:Array.isArray(value)?value:[value];
const normalized=value=>String(value).normalize('NFKC').replace(/[\s•]/gu,'');
const xml=value=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
function tool(name){
 for(const bin of (process.env.PATH||'').split(path.delimiter))for(const candidate of [path.join(bin,name),path.resolve(bin,'../../native/poppler/poppler/bin',name),path.resolve(bin,'../../native/poppler/bin',name)]){
  try{fs.accessSync(candidate,fs.constants.X_OK);return candidate;}catch{}
 }
 throw new Error(`Local ${name} is unavailable; no packages are installed by this verifier.`);
}
function expectedText(args){
 if(args.format==='pptx')return args.content.slides.flatMap(slide=>[slide.title,...slide.body]);
 if(args.format==='xlsx')return args.content.sheets.flatMap(sheet=>[...sheet.headers,...sheet.rows.flat()]).map(String);
 return [args.title,...args.content.sections.flatMap(section=>[...(section.heading?[section.heading]:[]),...(section.paragraphs||[]),...(section.table?[...section.table.headers,...section.table.rows.flat()].map(String):[])])];
}
function inspectBounds(bbox,format){
 const parsed=new XMLParser({ignoreAttributes:false,parseTagValue:false}).parse(bbox),pages=all(parsed.html.body.doc.page),details=[];
 for(const [index,page] of pages.entries()){
  const width=Number(page['@_width']),height=Number(page['@_height']);
  const words=all(page.flow).flatMap(flow=>all(flow.block)).flatMap(block=>all(block.line)).flatMap(line=>all(line.word));
  assert.ok(words.length,`${format} page ${index+1} has no text`);
  for(const word of words){const x1=Number(word['@_xMin']),y1=Number(word['@_yMin']),x2=Number(word['@_xMax']),y2=Number(word['@_yMax']);assert.ok(x1>=0&&y1>=0&&x2<=width+0.5&&y2<=height+0.5,`${format} page ${index+1}: text outside page`);}
  if(format==='pptx'){
   const footer=words.filter(word=>Number(word['@_yMin'])>480);
   assert.equal(normalized(footer.map(word=>word['#text']).join('')),`${index+1}/${pages.length}`,'Only the page number may occupy the footer area');
   const body=words.filter(word=>Number(word['@_yMin'])>=110&&Number(word['@_yMin'])<480);
   assert.ok(body.every(word=>Number(word['@_yMax'])<470),'Slide body intrudes on the footer');
  }
  details.push({page:index+1,width,height,wordCount:words.length,textWithinPage:true});
 }
 return details;
}
try{
 // A per-invocation Fontconfig file avoids the bundled headless renderer's broken
 // default font discovery. It changes no system/user font settings or font files.
 const fontDirs=['/System/Library/Fonts','/Library/Fonts'].filter(candidate=>fs.existsSync(candidate));
 assert.ok(fontDirs.length&&fs.existsSync('/System/Library/Fonts/STHeiti Medium.ttc'),'This visual verification requires the Mac system Heiti SC font');
 const fontConfig=path.join(dir,'fonts.conf');
 fs.writeFileSync(fontConfig,`<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig>${fontDirs.map(value=>`<dir>${xml(value)}</dir>`).join('')}<cachedir>${xml(path.join(dir,'font-cache'))}</cachedir></fontconfig>`);
 const env={...process.env,FONTCONFIG_FILE:fontConfig,FONTCONFIG_PATH:dir};
 const converted=path.join(dir,'rendered');fs.mkdirSync(converted);
 const results=[];
 for(const args of samples){
  const artifact=await createDocumentArtifact({taskId:'office-render',args,dataDir:dir});
  const target=path.join(output,args.name+'.'+args.format);fs.copyFileSync(path.join(dir,'artifacts',artifact.path),target);
  await run(tool('soffice'),[`-env:UserInstallation=${pathToFileURL(path.join(dir,'profile-'+args.format)).href}`,'--headless','--convert-to','pdf','--outdir',converted,target],{env,timeout:60000,maxBuffer:1024*1024});
  const freshPdf=path.join(converted,args.name+'.pdf');assert.ok(fs.existsSync(freshPdf),'LibreOffice did not render '+args.format);
  const pdf=path.join(output,args.name+'.pdf');fs.copyFileSync(freshPdf,pdf);
  const {stdout:info}=await run(tool('pdfinfo'),[pdf]),pages=Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
  assert.equal(pages,args.format==='pptx'?args.content.slides.length:1,'Unexpected page count');
  const {stdout:pdfText}=await run(tool('pdftotext'),['-raw',pdf,'-']);
  const flattened=normalized(pdfText);
  for(const value of expectedText(args))assert.ok(flattened.includes(normalized(value)),`${args.format} rendered PDF lost text: ${String(value).slice(0,70)}`);
  const {stdout:fonts}=await run(tool('pdffonts'),[pdf]);assert.match(fonts,/STHeitiSC/,'CJK text extraction alone is insufficient: the PDF must embed Heiti SC glyphs');
  assert.ok(fonts.split('\n').filter(line=>/STHeitiSC/.test(line)).every(line=>/\byes\s+yes\s+yes\b/.test(line)),'CJK fonts must be embedded with Unicode mapping');
  const {stdout:bbox}=await run(tool('pdftotext'),['-bbox-layout',pdf,'-']);const pageChecks=inspectBounds(bbox,args.format);
  for(const name of fs.readdirSync(output))if(new RegExp(`^${args.format}-\\d+\\.png$`).test(name))fs.rmSync(path.join(output,name));
  await run(tool('pdftoppm'),['-png','-scale-to','1400',pdf,path.join(output,args.format)],{env,timeout:60000,maxBuffer:1024*1024});
  fs.writeFileSync(path.join(output,args.format+'-rendered.txt'),pdfText);
  results.push({format:args.format,file:target,pdf,pages,sourceSha256:artifact.sha256,renderedWith:'local LibreOffice',synthetic:true,cjkFontEmbedded:true,allSourceTextPresent:true,pageChecks});
 }
 assert.equal(results.reduce((count,result)=>count+result.pages,0),5);
 fs.writeFileSync(path.join(output,'render-report.json'),JSON.stringify({at:new Date().toISOString(),font:'Heiti SC',fontConfiguration:'temporary process-local; no global settings modified',visualReview:'PNG inspection still required',results},null,2));
 console.log(JSON.stringify({rendered:true,output,results}));
}finally{fs.rmSync(dir,{recursive:true,force:true});}
