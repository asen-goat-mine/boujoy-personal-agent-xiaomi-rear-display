// Diagnostic only: one read-only Phone Use observe over an adb-forwarded port,
// reporting which completeness field fails. Never sends an action.
import {PhoneUseClient} from '../src/adapters/phoneuse-client.mjs';
import {normalizePhoneUseObservation} from '../src/adapters/phoneuse-state.mjs';
import fs from 'node:fs';
import {DATA} from '../src/config.mjs';

const port=Number(process.argv[2]),deviceId=JSON.parse(fs.readFileSync(DATA+'/state.json','utf8')).settings.phoneUseDeviceId;
const client=new PhoneUseClient();
await client.setRemoteTransport({dataPort:port,controlPort:port+1});
try{
 const raw=await client.call(deviceId,'observe',{mode:'both',output:'legacy',compact:false,include_details:true,diagnostics:true,max_dimension:1440,stable_wait_ms:0,max_attempts:2,timeout_ms:8000},{timeout:12000}).catch(error=>({thrown:error.message,code:error.phoneuseCode||error.code}));
 if(raw.thrown){console.log('THROWN',raw.code,raw.thrown);process.exit(0);}
 const text=raw.content.find(block=>block.type==='text')?.text||'{}',value=JSON.parse(text),tree=value.tree||{};
 console.log(JSON.stringify({isError:raw.isError,package:value.package_name,observation_status:value.observation_status,error:value.error,condition:value.condition,stale:value.stale,degraded:value.degraded,
  tree:{available:tree.available,reason:tree.reason,output:tree.output,compact:tree.compact,scope_clipped:tree.scope_clipped,collection_complete:tree.collection_complete,collection_truncated:tree.collection_truncated,truncated:tree.truncated,output_nodes:tree.output_nodes,collected_nodes:tree.collected_nodes,merged_nodes:tree.merged_nodes,elements:tree.elements?.length,limits:tree.limits||tree.max_nodes},
  screenshot:{available:value.screenshot?.available,reason:value.screenshot?.reason,width:value.screenshot?.width,height:value.screenshot?.height},images:raw.content.filter(block=>block.type==='image').length},null,1));
 const {elements,...treeRest}=tree;console.log('TREE META',JSON.stringify(treeRest).slice(0,1500));console.log('DIAG',JSON.stringify(value.diagnostics||null).slice(0,1500));
 for(const node of elements||[])if(node.editable||node.focused||/Edit/i.test(node.class||''))console.log('EDITABLE?',JSON.stringify({id:node.element_id,cls:node.class,text:node.text,hint:node.hint,desc:node.description,editable:node.editable,focused:node.focused,visible:node.visible,enabled:node.enabled,password:node.password,actions:node.actions,bounds:node.bounds}));
 for(const n of elements||[])console.log('EL',JSON.stringify({id:n.element_id,cls:n.class,text:n.text,hint:n.hint,desc:n.description,vid:n.view_id,ed:n.editable,fo:n.focused,vis:n.visible,act:n.actions,b:n.bounds}));console.log('ELEMENT KEYS',Object.keys((elements||[])[0]||{}).join(','));
 try{normalizePhoneUseObservation(raw);console.log('NORMALIZE OK');}catch(error){console.log('NORMALIZE FAIL',error.code,error.message);}
}finally{await client.close();}
