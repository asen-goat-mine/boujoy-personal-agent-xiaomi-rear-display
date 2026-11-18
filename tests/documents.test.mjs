import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createDocumentArtifact,readDocumentBuffer,validateDocumentInput} from '../src/tools/documents.mjs';
import JSZip from 'jszip';
const samples={
 docx:{format:'docx',name:'项目报告',title:'Personal Agent 验收',content:{sections:[{heading:'结论',paragraphs:['该文档保留可编辑文字。','价格与数据需要实际证据。'],table:{headers:['项目','结果'],rows:[['通信',true],['金额',12.5],['待核实',null]]}}]}},
 xlsx:{format:'xlsx',name:'比价表',title:'真实报价',content:{sheets:[{name:'价格',headers:['商品','金额','确认','备注'],rows:[['冰美式',12.5,true,null],['牛肉面',18,false,'=HYPERLINK("https://example.com","文字不是公式")']]},{name:'空清单',headers:['名称'],rows:[]}]}},
 pptx:{format:'pptx',name:'执行方向',title:'个人助理',content:{slides:[{title:'目标与范围',body:['Mac 负责推理与记忆。','手机执行实际操作。']},{title:'验收',body:['真实回执可以追溯。','未验收的能力不计成功。']}]}}
};
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'boujoy-documents-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
for(const format of Object.keys(samples))test(`${format} is a real editable OOXML artifact with exact structured data roundtrip`,async t=>{
 const dataDir=await fixture(t),artifact=await createDocumentArtifact({taskId:'task-123',args:samples[format],dataDir});assert.ok(artifact.name.endsWith('.'+format));assert.equal(artifact.verification.rendered,false);assert.equal(artifact.verification.method,'ooxml_parse_roundtrip');
 const file=path.join(dataDir,'artifacts',artifact.path),bytes=await fs.readFile(file);assert.equal(bytes.length,artifact.size);assert.equal((await fs.stat(file)).mode&0o777,0o600);assert.equal(bytes.subarray(0,2).toString(),'PK');
 const parsed=await readDocumentBuffer({format,buffer:bytes});assert.ok(parsed.parsedXmlParts>3);
 if(format==='docx'){assert.ok(parsed.paragraphText.includes('Personal Agent 验收'));assert.ok(parsed.paragraphText.includes('12.5'));}
 if(format==='xlsx'){assert.equal(parsed.sheets[0].rows[2][3],samples.xlsx.content.sheets[0].rows[1][3]);assert.equal(parsed.sheets[0].rows[1][1],12.5);assert.equal(parsed.sheets[0].rows[1][2],true);assert.deepEqual(parsed.sheets[1].rows,[['名称']]);const zip=await JSZip.loadAsync(bytes),xml=await zip.file('xl/worksheets/sheet1.xml').async('string');assert.equal(/<f[ >]/.test(xml),false);}
 if(format==='pptx'){assert.equal(parsed.slides.length,2);assert.ok(parsed.slides[0].includes('手机执行实际操作。'));assert.ok(parsed.slides[1].includes('真实回执可以追溯。'));}
});
test('structured input rejects arbitrary paths, code, formula objects, oversized and malformed tables',()=>{
 for(const change of [{name:'../escape'},{name:'/tmp/escape'},{name:'report.xlsx'},{format:'html'},{content:{sections:[{paragraphs:['text'],code:'run()'}]}}])assert.throws(()=>validateDocumentInput({...samples.docx,...change}));
 assert.throws(()=>validateDocumentInput({...samples.xlsx,content:{sheets:[{name:'data',headers:['a'],rows:[[{formula:'SUM(A1)'}]]}]}}));
 assert.throws(()=>validateDocumentInput({...samples.xlsx,content:{sheets:[{name:'data',headers:['a'],rows:[[1,2]]}]}}));
 assert.throws(()=>validateDocumentInput({...samples.pptx,content:{slides:Array.from({length:31},()=>({title:'t',body:['x']}))}}));
 assert.throws(()=>validateDocumentInput({...samples.docx,content:{sections:[{paragraphs:['\u0000']} ]}}));
});
test('output directory cannot escape the actual task via symlink or task identifier',async t=>{
 const dataDir=await fixture(t),outside=await fixture(t);await fs.mkdir(path.join(dataDir,'artifacts'));await fs.symlink(outside,path.join(dataDir,'artifacts','task-123'));
 await assert.rejects(createDocumentArtifact({taskId:'../escape',args:samples.docx,dataDir}));await assert.rejects(createDocumentArtifact({taskId:'task-123',args:samples.docx,dataDir}));assert.deepEqual(await fs.readdir(outside),[]);
});
