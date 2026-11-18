import {PhoneUseClient} from '../src/adapters/phoneuse-client.mjs';
import fs from 'node:fs';import {DATA} from '../src/config.mjs';
const deviceId=JSON.parse(fs.readFileSync(DATA+'/state.json','utf8')).settings.phoneUseDeviceId;
const c=new PhoneUseClient();await c.setRemoteTransport({dataPort:28443,controlPort:28444});
try{const r=await c.call(deviceId,'get_capabilities',{},{timeout:8000});console.log((r.content||[]).map(b=>b.text).join('\n').slice(0,6000));}finally{await c.close();}
