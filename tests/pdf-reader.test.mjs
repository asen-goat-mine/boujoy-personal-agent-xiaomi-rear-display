import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {readPdfBuffer} from '../src/tools/pdf-reader.mjs';
function pdf({text='Task receipt 123',pages=1,action=''}={}){
 const objects=['<< /Type /Catalog /Pages 2 0 R '+action+' >>','<< /Type /Pages /Kids ['+Array.from({length:pages},(_,i)=>(4+i*2)+' 0 R').join(' ')+'] /Count '+pages+' >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 for(let n=0;n<pages;n++){const content=text?'BT /F1 12 Tf 20 50 Td ('+text.replace(/[()\\]/g,'\\$&')+') Tj ET':'';objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 3 0 R >> >> /Contents '+(5+n*2)+' 0 R >>','<< /Length '+Buffer.byteLength(content)+' >>\nstream\n'+content+'\nendstream');}
 let source='%PDF-1.4\n',offsets=[0];for(const [i,obj]of objects.entries()){offsets.push(Buffer.byteLength(source));source+=(i+1)+' 0 obj\n'+obj+'\nendobj\n';}const offset=Buffer.byteLength(source);source+='xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size '+(objects.length+1)+' /Root 1 0 R >>\nstartxref\n'+offset+'\n%%EOF';return Buffer.from(source);
}
test('real PDF text extraction records page provenance and never executes embedded actions',async t=>{
 let calls=0;const server=http.createServer((_req,res)=>{calls++;res.end('should not happen');});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 const result=await readPdfBuffer(pdf({action:'/OpenAction << /S /URI /URI (http://127.0.0.1:'+server.address().port+'/never) >>'}));
 assert.equal(result.readable,true,JSON.stringify(result));assert.equal(result.pages[0].text,'Task receipt 123');assert.equal(result.pages[0].page,1);assert.equal(result.pageCount,1);assert.equal(result.truncated,false);assert.equal(result.rendered,false);assert.equal(calls,0);
});
test('PDF parser bounds pages and identifies empty text layers, invalid and oversized files honestly',async()=>{
 const many=await readPdfBuffer(pdf({pages:65}));assert.equal(many.readPages,64);assert.equal(many.pageCount,65);assert.equal(many.truncated,true);
 const scan=await readPdfBuffer(pdf({text:''}));assert.equal(scan.readable,false);assert.equal(scan.reason,'pdf_has_no_text_layer');assert.equal(scan.ocr,false);
 assert.equal((await readPdfBuffer(Buffer.from('%PDF-1.7 invalid'))).reason,'unsupported_or_invalid_pdf');assert.equal((await readPdfBuffer(Buffer.alloc(8*1024*1024+1))).reason,'pdf_exceeds_8_mib');
});
