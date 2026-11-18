import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Document,Packer,Paragraph,TextRun,HeadingLevel,Table,TableRow,TableCell,WidthType} from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {DATA} from '../config.mjs';
import {requireValue} from '../core/errors.mjs';

const string={type:'string'},array=items=>({type:'array',items}),object=properties=>({type:'object',properties,additionalProperties:false});
const scalar={type:['string','number','boolean','null']},tableSchema=object({headers:array(string),rows:array(array(scalar))});
export const DOCUMENT_TOOL_DEFINITION={name:'document_create',description:'生成真正可编辑的 DOCX 报告、XLSX 工作簿或 PPTX 幻灯片。只接受结构化正文、表格和工作表；不执行代码/公式，不接收写入路径。文件保存在本任务产物目录，并实际解析回读 OOXML；此校验不等于肉眼验收排版。DOCX content.sections=[{heading,paragraphs,table:{headers,rows}}]；XLSX content.sheets=[{name,headers,rows}]；PPTX content.slides=[{title,body:[正文段落]}]。',inputSchema:{type:'object',properties:{format:{type:'string',enum:['docx','xlsx','pptx']},name:string,title:string,content:object({sections:array(object({heading:string,paragraphs:array(string),table:tableSchema})),sheets:array(object({name:string,headers:array(string),rows:array(array(scalar))})),slides:array(object({title:string,body:array(string)}))})},required:['format','name','title','content'],additionalProperties:false}};
const MIME={docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation'};
const invalidXML=/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;
function text(value,label,max=6000,{empty=false}={}){requireValue(typeof value==='string'&&value.length<=max&&(empty||value.trim())&&value.isWellFormed()&&!invalidXML.test(value),label+' 无效或超出长度限制');return value;}
function keys(value,allowed,label){requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key)),label+' 结构无效');}
function list(value,label,max,min=1){requireValue(Array.isArray(value)&&value.length>=min&&value.length<=max,label+' 数量超出限制');}
function cell(value){requireValue(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||typeof value==='string','表格单元格只支持文字、有限数字、布尔或空值');if(typeof value==='string')text(value,'单元格',2000,{empty:true});return value;}
function grid(value,{maxRows=1000,maxColumns=40,budget}={}){keys(value,['name','headers','rows'],'表格');list(value.headers,'列',maxColumns);value.headers.forEach(v=>text(v,'列标题',120));list(value.rows,'数据行',maxRows,0);value.rows.forEach(row=>{requireValue(Array.isArray(row)&&row.length===value.headers.length,'每行必须与列数一致');row.forEach(cell);});budget.cells+=value.headers.length*(value.rows.length+1);requireValue(budget.cells<=20000,'总表格大小最多 20000 个单元格');}
export function validateDocumentInput(args){
 keys(args,['format','name','title','content'],'文档');requireValue(Object.hasOwn(MIME,args.format),'文档格式无效');text(args.title,'标题',160);text(args.name,'文件名',120);
 requireValue(!/[\\/<>:"|?*\u0000-\u001F]/.test(args.name)&&!args.name.startsWith('.')&&!/\.(?:docx|xlsx|pptx)$/i.test(args.name.replace(new RegExp('\\.'+args.format+'$','i'),'')),'文件名不能包含路径或另一文档扩展名');
 let size;try{size=Buffer.byteLength(JSON.stringify(args));}catch{requireValue(false,'文档结构不能循环引用');}requireValue(size<=600*1024,'文档输入最多 600 KiB');
 const budget={cells:0};
 if(args.format==='docx'){
  keys(args.content,['sections'],'DOCX 正文');list(args.content.sections,'章节',40);
  for(const section of args.content.sections){keys(section,['heading','paragraphs','table'],'章节');if(section.heading!==undefined)text(section.heading,'章节标题',160);if(section.paragraphs!==undefined){list(section.paragraphs,'段落',30,0);section.paragraphs.forEach(v=>text(v,'段落'));}if(section.table!==undefined)grid(section.table,{maxRows:300,maxColumns:12,budget});requireValue(section.heading||section.paragraphs?.length||section.table,'章节不能为空');}
 }else if(args.format==='xlsx'){
  keys(args.content,['sheets'],'XLSX 正文');list(args.content.sheets,'工作表',10);const names=new Set();
  for(const sheet of args.content.sheets){text(sheet.name,'工作表名称',31);requireValue(!/[\\/\[\]:*?]/.test(sheet.name)&&!/^'|'$/.test(sheet.name)&&!names.has(sheet.name.toLocaleLowerCase()),'工作表名称不能重复或包含 Excel 禁止字符');names.add(sheet.name.toLocaleLowerCase());grid(sheet,{budget});}
 }else{
  keys(args.content,['slides'],'PPTX 正文');list(args.content.slides,'幻灯片',30);
  for(const slide of args.content.slides){keys(slide,['title','body'],'幻灯片');text(slide.title,'幻灯片标题',100);list(slide.body,'幻灯片段落',8);slide.body.forEach(v=>text(v,'幻灯片段落',240));requireValue(slide.body.join('').length<=1200,'单页正文最多 1200 字符');}
 }
 return args;
}
// Explicit East Asian faces avoid renderer-dependent Arial CJK fallback.
const OFFICE_FONT='Heiti SC';
const WORD_FONT={ascii:OFFICE_FONT,hAnsi:OFFICE_FONT,eastAsia:OFFICE_FONT,cs:OFFICE_FONT};
const display=value=>value===null?'':String(value);
const textWidth=value=>Array.from(display(value)).reduce((width,char)=>width+(/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/u.test(char)?2:1),0);
async function docxBuffer(input){
 const children=[new Paragraph({text:input.title,heading:HeadingLevel.TITLE,spacing:{after:320}})];
 for(const section of input.content.sections){
  if(section.heading)children.push(new Paragraph({text:section.heading,heading:HeadingLevel.HEADING_1,spacing:{before:280,after:160}}));
  for(const paragraph of section.paragraphs||[])children.push(new Paragraph({children:[new TextRun({text:paragraph,font:WORD_FONT,size:24})],spacing:{after:180,line:320}}));
  if(section.table){const rows=[section.table.headers,...section.table.rows];children.push(new Table({width:{size:100,type:WidthType.PERCENTAGE},rows:rows.map((row,index)=>new TableRow({tableHeader:index===0,children:row.map(value=>new TableCell({shading:index===0?{fill:'EEE9FF'}:undefined,children:[new Paragraph({children:[new TextRun({text:display(value),font:WORD_FONT,bold:index===0,size:21})]})]}))}))}));children.push(new Paragraph(''));}
 }
 const doc=new Document({creator:'Boujoy Personal Agent',title:input.title,description:'Editable task document',styles:{default:{document:{run:{font:WORD_FONT,size:24}}}},sections:[{properties:{page:{margin:{top:1134,right:1134,bottom:1134,left:1134}}},children}]});
 return Packer.toBuffer(doc);
}
async function xlsxBuffer(input){
 const workbook=new ExcelJS.Workbook();workbook.creator='Boujoy Personal Agent';workbook.title=input.title;
 for(const spec of input.content.sheets){
  const sheet=workbook.addWorksheet(spec.name,{views:[{state:'frozen',ySplit:1}],pageSetup:{paperSize:9,fitToPage:true,fitToWidth:1,fitToHeight:0,margins:{left:0.5,right:0.5,top:0.6,bottom:0.6,header:0.2,footer:0.2}}});sheet.addRow(spec.headers);sheet.addRows(spec.rows);
  sheet.eachRow(row=>{row.font={name:OFFICE_FONT,size:11};});
  sheet.getRow(1).font={name:OFFICE_FONT,size:11,bold:true,color:{argb:'FF392964'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFEEE9FF'}};sheet.getRow(1).height=24;
  sheet.columns.forEach((column,index)=>{column.width=Math.min(48,Math.max(14,Math.max(...[spec.headers,...spec.rows.slice(0,100)].map(row=>textWidth(row[index])))+3));column.alignment={vertical:'top',wrapText:true};});
  sheet.eachRow(row=>{row.height=Math.min(409,Math.max(24,...row.values.slice(1).map((value,index)=>Math.ceil(textWidth(value)/Math.max(1,sheet.getColumn(index+1).width-3))*16+8)));});
  sheet.pageSetup.orientation=sheet.columns.reduce((sum,column)=>sum+column.width,0)>90?'landscape':'portrait';sheet.pageSetup.printTitlesRow='1:1';
  sheet.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,spec.rows.length+1),column:spec.headers.length}};
 }
 return Buffer.from(await workbook.xlsx.writeBuffer());
}
async function pptxBuffer(input){
 const presentation=new PptxGenJS();presentation.layout='LAYOUT_WIDE';presentation.author='Boujoy Personal Agent';presentation.subject='Editable task presentation';presentation.title=input.title;presentation.company='Boujoy';presentation.lang='zh-CN';presentation.theme={headFontFace:OFFICE_FONT,bodyFontFace:OFFICE_FONT,lang:'zh-CN'};
 for(const [index,spec] of input.content.slides.entries()){
  const slide=presentation.addSlide();slide.background={color:'FAFAFD'};
  slide.addText(spec.title,{x:0.65,y:0.5,w:12,h:0.85,fontFace:OFFICE_FONT,fontSize:30,bold:true,color:'251D38',breakLine:false,margin:0,fit:'shrink'});
  // Dense slides use two native editable columns so paragraphs keep visible separation.
  const dense=spec.body.reduce((total,value)=>total+textWidth(value),0)>1100&&spec.body.length>3;
  const columns=dense?[spec.body.slice(0,Math.ceil(spec.body.length/2)),spec.body.slice(Math.ceil(spec.body.length/2))]:[spec.body];
  for(const [column,body] of columns.entries())slide.addText(body.map(value=>({text:value,options:{breakLine:true,bullet:{indent:dense?12:20},hanging:3}})),{x:0.8+column*6.05,y:1.6,w:dense?5.65:11.7,h:4.9,fontFace:OFFICE_FONT,fontSize:dense?14:23,color:'3E3A48',margin:0,paraSpaceAfter:dense?7:18,lineSpacingMultiple:1.12,fit:'shrink',valign:'top'});
  slide.addText(`${index+1} / ${input.content.slides.length}`,{x:11.5,y:6.9,w:1.1,h:0.25,fontSize:10,color:'8C849B',align:'right',margin:0});
 }
 return Buffer.from(await presentation.write({outputType:'nodebuffer',compression:true}));
}
function xmlText(value,key){const found=[];function visit(node){if(!node||typeof node!=='object')return;for(const [name,item] of Object.entries(node)){if(name===key){for(const value of Array.isArray(item)?item:[item])found.push(typeof value==='object'?String(value['#text']??''):String(value));}else if(Array.isArray(item))item.forEach(visit);else visit(item);}}visit(value);return found;}
export async function readDocumentBuffer({format,buffer,allowExternalRelationships=false}){
 requireValue(Object.hasOwn(MIME,format)&&Buffer.isBuffer(buffer)&&buffer.length<=16*1024*1024,'生成的文档超出校验范围');
 const zip=await JSZip.loadAsync(buffer,{checkCRC32:true});requireValue(zip.file('[Content_Types].xml'),'文档缺少 OOXML 类型清单');
 const parser=new XMLParser({ignoreAttributes:false,parseTagValue:false,trimValues:false}),parsed=new Map();
 for(const entry of Object.values(zip.files).filter(e=>!e.dir&&(/\.xml$|\.rels$/.test(e.name)))){const xml=await entry.async('string');requireValue(xml.length<=12*1024*1024&&XMLValidator.validate(xml)===true,'生成的 XML 无效');requireValue(!/<!DOCTYPE|<!ENTITY/i.test(xml),'不读取含 XML 实体声明的文档');if(!allowExternalRelationships)requireValue(!/TargetMode=["']External["']/.test(xml),'生成的文档不能包含外部关系');parsed.set(entry.name,parser.parse(xml));}
 let result;
 if(format==='docx'){requireValue(parsed.has('word/document.xml'),'DOCX 缺少正文');result={paragraphText:xmlText(parsed.get('word/document.xml'),'w:t')};}
 else if(format==='pptx'){const names=[...parsed.keys()].filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a,b)=>Number(a.match(/slide(\d+)/)[1])-Number(b.match(/slide(\d+)/)[1]));requireValue(names.length>0,'PPTX 缺少幻灯片');result={slides:names.map(name=>xmlText(parsed.get(name),'a:t'))};}
 else{const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(buffer);result={sheets:workbook.worksheets.map(sheet=>({name:sheet.name,rows:Array.from({length:sheet.rowCount},(_,index)=>Array.from({length:sheet.columnCount},(_,column)=>sheet.getRow(index+1).getCell(column+1).value??null))}))};}
 return {format,parsedXmlParts:parsed.size,...result};
}
function assertRoundTrip(input,result){
 if(input.format==='docx'){const expected=[input.title,...input.content.sections.flatMap(s=>[...(s.heading?[s.heading]:[]),...(s.paragraphs||[]),...(s.table?[...s.table.headers,...s.table.rows.flat()].map(display):[])])].filter(Boolean);requireValue(expected.every(value=>result.paragraphText.includes(value)),'DOCX 回读正文与输入不一致');}
 else if(input.format==='pptx'){requireValue(result.slides.length===input.content.slides.length&&input.content.slides.every((slide,i)=>[slide.title,...slide.body].every(value=>result.slides[i].includes(value))),'PPTX 回读正文与输入不一致');}
 else requireValue(input.content.sheets.length===result.sheets.length&&input.content.sheets.every((sheet,index)=>{const actual=result.sheets[index];return actual.name===sheet.name&&JSON.stringify(actual.rows)===JSON.stringify([sheet.headers,...sheet.rows]);}),'XLSX 回读数据与输入不一致');
}
export async function createDocumentArtifact({taskId,args,dataDir=DATA}){
 requireValue(typeof taskId==='string'&&/^[a-z0-9_-]{1,80}$/i.test(taskId),'任务编号无效');const input=validateDocumentInput(args);
 const buffer=await ({docx:docxBuffer,xlsx:xlsxBuffer,pptx:pptxBuffer}[input.format])(input),readback=await readDocumentBuffer({format:input.format,buffer});assertRoundTrip(input,readback);
 const dataRoot=await fs.realpath(dataDir),root=path.join(dataRoot,'artifacts');await fs.mkdir(root,{recursive:true,mode:0o700});requireValue(await fs.realpath(root)===root,'产物根目录不能是符号链接');
 const taskRoot=path.join(root,taskId);await fs.mkdir(taskRoot,{recursive:true,mode:0o700});requireValue(await fs.realpath(taskRoot)===taskRoot,'任务产物目录不能是符号链接');
 const id=randomUUID(),name=input.name.toLowerCase().endsWith('.'+input.format)?input.name:input.name+'.'+input.format,relative=taskId+'/'+id+'-'+name,file=path.join(root,relative),handle=await fs.open(file,'wx',0o600);
 try{await handle.writeFile(buffer);await handle.sync();}finally{await handle.close();}
 const saved=await fs.readFile(file),sha256=createHash('sha256').update(saved).digest('hex');requireValue(saved.equals(buffer),'文件保存后校验不一致');
 return {id,taskId,name,path:relative,mime:MIME[input.format],size:saved.length,sha256,kind:'document',createdAt:new Date().toISOString(),verification:{method:'ooxml_parse_roundtrip',format:input.format,parsedXmlParts:readback.parsedXmlParts,rendered:false}};
}
