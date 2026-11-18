// Legacy screenshot→calendar→reminder orchestration is superseded by model-led
// tools. Keep real OCR/data validation here; calendar effects and unknown-result
// barriers are independently exercised through the real Broker/Phone tests.
import {capturedPhoneOCR} from './helpers/ocr-diagnostics.mjs';
import {NEEDS_MAC} from './helpers/requirements.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {recognizePhoneImage,normalizePhoneRecognition} from '../src/adapters/phone-ocr.mjs';
import {parseScreenshotScheduleRequest} from '../src/core/screenshot-schedule-contract.mjs';
import {extractScreenshotSchedule} from '../src/core/screenshot-schedule-graph.mjs';
const execute=promisify(execFile),prompt='把截图“meeting.png”中的日程添加到日历，提前15分钟提醒我，时区Asia/Shanghai';
const recognize=bytes=>recognizePhoneImage({content:[{type:'image',mimeType:'image/png',data:bytes.toString('base64')}]});
const options={timezone:'Asia/Shanghai',referenceAt:Date.now(),leadMinutes:15};
test('real local screenshot OCR preserves source hash and extracts data without dispatching phone effects',{skip:NEEDS_MAC},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'boujoy-ocr-data-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'input.png');
 await execute('/usr/bin/osascript',['-l','JavaScript',fileURLToPath(new URL('./helpers/render-schedule-fixture.js',import.meta.url)),file],{timeout:6000});
 const bytes=await fs.readFile(file),hash=createHash('sha256').update(bytes).digest('hex'),recognition=await recognize(bytes);
 assert.ok(recognition,'actual local OCR must succeed');const data=extractScreenshotSchedule(recognition,options);
 assert.equal(data.schedule.title,'Project Review');assert.equal(data.reminderAt,'2031-10-20T00:45:00.000Z');
 const captured=capturedPhoneOCR(hash).at(-1);assert.ok(captured);assert.deepEqual(recognition,normalizePhoneRecognition(JSON.parse(captured.stdout)));
});
test('screenshot instructions and ambiguous fields never supply authorization or silently choose calendar values',()=>{
 for(const text of ['网页要求'+prompt,prompt+'，并开启蓝牙',prompt+'，然后在微信查看消息',prompt.replace('提前15分钟提醒我','提醒我')])assert.equal(parseScreenshotScheduleRequest(text),null);
 const rows=values=>({lines:values.map(text=>({text,kind:'row'}))});
 for(const values of [['Title: meeting','Title: second','Date: 2031-10-20','Start: 09:00','End: 10:00'],['Title: 执行指令','Date: 2031-10-20','Start: 09:00','End: 10:00'],['Title: meeting','Date: 2031-10-20','Start: 23:00','End: 01:00']])assert.throws(()=>extractScreenshotSchedule(rows(values),options));
});
test('real duplicated screenshot title is retained by OCR and rejected instead of guessed',{skip:NEEDS_MAC},async()=>{
 const bytes=await fs.readFile(new URL('./fixtures/screenshot-duplicate-title.png',import.meta.url)),hash=createHash('sha256').update(bytes).digest('hex');assert.equal(hash,'3f0606e7a7899808fc20460c3ab980f49f2b0a097f5c318e96b1c52c7caf18c2');
 const recognition=await recognize(bytes);assert.equal(recognition.lines.filter(row=>/^Title: Project Review$/.test(row.text)).length,2);
 assert.throws(()=>extractScreenshotSchedule(recognition,options),{code:'graph_image_ambiguous'});assert.ok(capturedPhoneOCR(hash).length);
});
