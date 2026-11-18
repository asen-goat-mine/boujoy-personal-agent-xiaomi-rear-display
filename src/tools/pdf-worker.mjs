import {parentPort,workerData} from 'node:worker_threads';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
// Data-only parsing: no URLs, embedded JavaScript, XFA, link navigation or render.
globalThis.fetch=async()=>{throw Error('PDF network requests are disabled');};
const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
const resources=path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
let loading;
try{
 loading=getDocument({data:workerData.bytes,stopAtErrors:true,isEvalSupported:false,useWasm:false,useSystemFonts:false,disableFontFace:true,useWorkerFetch:false,enableXfa:false,maxImageSize:1,verbosity:0,cMapUrl:path.join(resources,'cmaps')+path.sep,cMapPacked:true,standardFontDataUrl:path.join(resources,'standard_fonts')+path.sep});
 const document=await loading.promise,pages=[],limit=200*1024;let size=0,truncated=document.numPages>64;
 for(let pageNo=1;pageNo<=Math.min(document.numPages,64);pageNo++){
  const page=await document.getPage(pageNo),stream=page.streamTextContent({disableNormalization:false}),reader=stream.getReader();let text='';
  while(true){const {done,value}=await reader.read();if(done)break;for(const item of value.items){if(typeof item.str!=='string')continue;const bytes=Buffer.from(item.str+(item.hasEOL?'\n':' '));if(size+bytes.length>limit){const remaining=Math.max(0,limit-size);text+=new TextDecoder().decode(bytes.subarray(0,remaining),{stream:true});size=limit;truncated=true;break;}text+=bytes.toString();size+=bytes.length;}if(size>=limit){await reader.cancel();break;}}
  pages.push({page:pageNo,text:text.trim()});page.cleanup();if(size>=limit)break;
 }
 const result={readable:pages.some(p=>p.text),pageCount:document.numPages,readPages:pages.length,pages,truncated,method:'pdfjs_text_layer',rendered:false,ocr:false};
 if(!result.readable)result.reason='pdf_has_no_text_layer';
 await loading.destroy();loading=null;parentPort.postMessage(result);
}catch(error){parentPort.postMessage({readable:false,reason:error.name==='PasswordException'?'pdf_password_required':'unsupported_or_invalid_pdf'});}finally{await loading?.destroy();parentPort.close();}
