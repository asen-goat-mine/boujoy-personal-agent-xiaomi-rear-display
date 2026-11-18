import {groundedLines} from './deepseek-tools.mjs';
import {normalizePhoneRecognition,recognizePhoneImage} from './phone-ocr.mjs';

// Phone screenshot text recognition through DeepSeek's official OCR. Grounded
// lines carry boxes normalized to 0..1000; they are scaled to the screenshot's
// own pixels. When the official service is unavailable, slow, or returns no
// grounded text, the local macOS recognizer is used instead. Recognized text is
// an observation only: never proof that a target is clickable or allowed.
export function jpegSize(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<4||bytes[0]!==0xff||bytes[1]!==0xd8)return null;
 for(let at=2;at+9<bytes.length;){
  if(bytes[at]!==0xff){at++;continue;}
  const marker=bytes[at+1];
  if(marker===0xd8||marker===0x01||(marker>=0xd0&&marker<=0xd7)){at+=2;continue;}
  const length=bytes.readUInt16BE(at+2);
  if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker))return {height:bytes.readUInt16BE(at+5),width:bytes.readUInt16BE(at+7)};
  at+=2+length;
 }
 return null;
}
export function pngSize(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<24||bytes.toString('ascii',1,4)!=='PNG')return null;
 return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
}

export function deepseekPhoneRecognizer({tools,local=recognizePhoneImage,timeoutMs=4000,onResult}={}){
 return async function recognize(result){
  const image=result?.content?.find(block=>block.type==='image');
  if(!image||!tools)return local(result);
  let source='local',reason=null;
  try{
   const bytes=Buffer.from(image.data,'base64'),size=jpegSize(bytes)||pngSize(bytes);
   if(!size||!size.width||!size.height){reason='image_size_unknown';throw Error(reason);}
   const ocr=await tools.ocr({bytes,filename:image.mimeType==='image/png'?'screen.png':'screen.jpg',purpose:'text_recognition'},{timeoutMs,signal:AbortSignal.timeout(timeoutMs)});
   const lines=ocr.pages.flatMap(page=>groundedLines(page.text,size.width,size.height));
   const recognized=lines.length?normalizePhoneRecognition({width:size.width,height:size.height,lines,words:[]}):null;
   if(recognized?.lines?.length){source='deepseek';onResult?.({source,lines:recognized.lines.length});return recognized;}
   reason='no_grounded_text';
  }catch(error){reason=reason||error?.code||'deepseek_unavailable';}
  const fallback=await local(result);
  onResult?.({source,reason,lines:fallback?.lines?.length||0});
  return fallback;
 };
}
