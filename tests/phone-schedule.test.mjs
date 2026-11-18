import test from 'node:test';import assert from 'node:assert/strict';
import {createTaskContract} from '../src/core/task-contract.mjs';import {phoneUseGrant,classifyPhoneUseAction,effectGoalStatus} from '../src/adapters/phone-use.mjs';import {Phone} from '../src/adapters/phone.mjs';import {Broker} from '../src/tools/broker.mjs';
const app={packageName:'com.samsung.android.calendar',appName:'日历',label:'日历',aliases:['日历']};
function task(prompt){const task={id:'t',source:'user',status:'running',kind:'general',timezone:'Asia/Shanghai',cloudConsent:true,phoneQuery:null,phoneUseScope:null,quotes:[],children:[],events:[],messages:[{id:'u',role:'user',content:prompt,at:new Date().toISOString()}]};task.taskContract=createTaskContract(task);return task;}
function observe(body,{timezone='Asia/Shanghai',dialog=false}={}){return {taskId:'t',id:'o',at:Date.now(),stability:'fresh',stabilityScope:'phone_use',tree:{content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',timezone,foreground:app.packageName+'/Activity',windowPkg:app.packageName,tree:`window pkg=${app.packageName} bounds=0,0,1000,2000\n${dialog?'AlertDialog\n':''}${body}`}})}]},ocr:{width:1000,height:2000,lines:[]}};}
const row=(record,extra='')=>`TextView "${record.title}" "${record.date}" "${record.time}" "不重复" clickable ${extra} bounds=100,400,700,600`;
const button=(label)=>`Button "${label}" clickable bounds=750,1600,950,1700`;
const tap={action:'tap',observationId:'o',x:850,y:1650};
const receipt=decision=>({status:'completed',phoneEffect:decision});
const listed=body=>`RecyclerView bounds=0,300,1000,1800\n${body}`;
function update(){const t=task('把日历明天9点日程“项目会议”改到后天10点'),grant=phoneUseGrant(t,app);return {t,grant,plan:grant.effectPlan};}
test('schedule update binds an exact unique original entry before edits and verifies the final new identity',()=>{
 const {grant,plan}=update(),original=observe(row(plan.target)),open=classifyPhoneUseAction('t',{...tap,x:300,y:450},original,grant);assert.equal(open?.kind,'effect_schedule_open');
 assert.equal(classifyPhoneUseAction('t',{...tap,x:300,y:450},observe(row(plan.target)+'\n'+row(plan.target)),grant),null,'duplicate old entries need disambiguation');
 const form=observe(`TextView "${plan.target.title}" "${plan.target.date}" bounds=100,400,700,600\nEditText "开始时间" "09:00" editable focused bounds=100,800,700,900`),input={action:'type',observationId:'o',inputMode:'replace',text:'10:00'};
 assert.equal(classifyPhoneUseAction('t',input,form,grant),null);assert.equal(classifyPhoneUseAction('t',input,form,grant,[receipt(open)])?.kind,'effect_schedule_input');assert.equal(classifyPhoneUseAction('t',{...input,text:'11:00'},form,grant,[receipt(open)]),null);
 const ready=observe(row(plan.desired)+'\n'+button('保存')),save=classifyPhoneUseAction('t',tap,ready,grant,[receipt(open)]);assert.equal(save?.kind,'effect_schedule_save');
 assert.equal(effectGoalStatus(observe(row(plan.desired)),grant,[receipt(open),receipt(save)]).verified,false,'a save receipt and current page do not prove reopening');
 const reopen=classifyPhoneUseAction('t',{...tap,x:300,y:450},observe(listed(row(plan.desired))),grant,[receipt(open),receipt(save)]);assert.equal(reopen?.kind,'effect_schedule_reopen');
 assert.equal(effectGoalStatus(observe(row(plan.desired)),grant,[receipt(open),receipt(save),receipt(reopen)]).verified,true);assert.equal(effectGoalStatus(observe(row(plan.target)),grant,[receipt(save),receipt(reopen)]).verified,false);assert.equal(effectGoalStatus(observe(row(plan.desired)+'\n'+row(plan.target)),grant,[receipt(save),receipt(reopen)]).verified,false);
});
test('cancellation requires original entry binding and exact native acknowledgement, not absence or generic success',()=>{
 const t=task('删除日历明天9点日程“项目会议”'),grant=phoneUseGrant(t,app),plan=grant.effectPlan;
 const open=classifyPhoneUseAction('t',{...tap,x:300,y:450},observe(row(plan.target)),grant),actions=[receipt(open)];assert.equal(open.kind,'effect_schedule_open');
 const dialog=observe(row(plan.target)+'\n'+button('删除'),{dialog:true});assert.equal(classifyPhoneUseAction('t',tap,dialog,grant),null);const deletion=classifyPhoneUseAction('t',tap,dialog,grant,actions);assert.equal(deletion?.kind,'effect_schedule_delete');
 const completed=[...actions,receipt(deletion)];assert.equal(effectGoalStatus(observe('TextView "日程已删除" bounds=100,500,700,600'),grant,completed).verified,false);assert.equal(effectGoalStatus(observe(''),grant,completed).verified,false);
 const tombstone=`TextView "日程已删除" "${plan.target.title}" "${plan.target.date}" "${plan.target.time}" bounds=100,500,700,600`;
 assert.equal(effectGoalStatus(observe(tombstone),grant,completed).verified,true);assert.equal(effectGoalStatus(observe(tombstone.replace(plan.target.title,'其他会议')),grant,completed).verified,false);
});
test('schedule save and verification require current timezone evidence and reject displayed conflicts',()=>{
 const t=task('在日历创建明天9点日程“项目会议”'),grant=phoneUseGrant(t,app),plan=grant.effectPlan,ready=row(plan.desired)+'\n'+button('保存');
 assert.equal(classifyPhoneUseAction('t',tap,observe(ready,{timezone:null}),grant),null);assert.equal(classifyPhoneUseAction('t',tap,observe(ready,{timezone:'America/New_York'}),grant),null);
 assert.equal(classifyPhoneUseAction('t',tap,observe(ready+'\nTextView "存在日程冲突" bounds=100,900,700,1000'),grant),null);
 const evidence=observe(ready,{timezone:null});evidence.connectorTelemetry={timezone:'Asia/Shanghai',source:'boujoy_android_authenticated',deviceId:'bound-device',receivedAt:new Date().toISOString(),ageMs:0,fresh:true};const save=classifyPhoneUseAction('t',tap,evidence,grant);assert.equal(save?.kind,'effect_schedule_save');evidence.connectorTelemetry.receivedAt=new Date(Date.now()-31000).toISOString();assert.equal(classifyPhoneUseAction('t',tap,evidence,grant),null);
 assert.equal(effectGoalStatus(observe(row(plan.desired),{timezone:null}),grant,[receipt(save)]).verified,false);
});
function brokerFixture(t){
 const data={tasks:[t],actions:[],artifacts:[],settings:{phoneEnabled:true,memoryEnabled:false}},store={data,task:()=>t,transaction:fn=>fn(data),updateTask(id,fn){fn(t,data);return t;},event(){}};let current,queue=[],approvals=0;const calls=[];
 const phone=new Phone(store,{wait:async()=>{},recognize:async image=>JSON.parse(Buffer.from(image.content[0].data,'base64').toString()).ocr});phone.apps={resolve:async()=>({...app,source:'fixture',cached:false})};
 phone.call=async(name,args)=>{calls.push(name);if(name==='ui_tree')return current.tree;if(name==='screenshot')return {content:[{type:'image',mimeType:'image/png',data:Buffer.from(JSON.stringify(current)).toString('base64')}]};if(['tap','type','key'].includes(name)){if(queue.length)current=queue.shift();return {content:[{type:'text',text:'{"ok":true}'}]};}throw Error('unexpected '+name);};
 const broker=new Broker({store,phone,approvals:{request:async()=>{approvals++;throw Error('Unexpected manual approval');}}});broker.engine={finishReport(){t.status='completed';},blockToolFailure(){}};return {data,phone,broker,calls,set(s,next=[]){current=s;queue=next;},approvals:()=>approvals};
}
const meta=result=>result.content.filter(block=>block.type==='text').map(block=>{try{return JSON.parse(block.text);}catch{return {};}}).find(value=>value.observationId);
test('schedule entry navigation never clicks a checked control, including an overlapping child switch',()=>{
 const clock={packageName:'com.sec.android.app.clockpackage',appName:'时钟',label:'时钟',aliases:['时钟']};
 const t=task('把明早8点闹钟改到明早9点'),grant=phoneUseGrant(t,clock),p=grant.effectPlan;
 const observation=body=>JSON.parse(JSON.stringify(observe(body)).replaceAll(app.packageName,clock.packageName));
 for(const raw of ['Switch','CheckBox','ToggleButton','RadioButton','TextView checkable']){
  const tree=`${raw} "${p.target.time}" "${p.target.date}" clickable checked bounds=100,400,700,600`;
  assert.equal(classifyPhoneUseAction('t',{...tap,x:300,y:450},observation(tree),grant),null,raw);
 }
 const overlapping=`TextView "${p.target.time}" "${p.target.date}" clickable bounds=100,400,700,600\nSwitch "启用闹钟" clickable checked bounds=100,400,700,600`;
 assert.equal(classifyPhoneUseAction('t',{...tap,x:300,y:450},observation(overlapping),grant),null);
});
test('changing only an alarm time preserves observed disabled state and recurrence through save and result',()=>{
 const clock={packageName:'com.sec.android.app.clockpackage',appName:'时钟',label:'时钟',aliases:['时钟']};
 const t=task('把每天8点闹钟整个系列改到9点'),grant=phoneUseGrant(t,clock),p=grant.effectPlan;
 const observation=body=>JSON.parse(JSON.stringify(observe(body)).replaceAll(app.packageName,clock.packageName));
 const original=observation('TextView "08:00" "每天" clickable bounds=100,400,700,600'),open=classifyPhoneUseAction('t',{...tap,x:300,y:450},original,grant);assert.equal(open?.kind,'effect_schedule_open');
 const form=time=>`EditText "闹钟时间" "${time}" editable focused bounds=100,400,700,600\nTextView "每天" "整个系列" bounds=100,650,700,750\nSwitch "启用闹钟" clickable unchecked bounds=100,900,700,1000\n${button('保存')}`;
 const input=classifyPhoneUseAction('t',{action:'type',observationId:'o',inputMode:'replace',text:'09:00'},observation(form('08:00')),grant,[receipt(open)]);assert.equal(input?.kind,'effect_schedule_input');assert.deepEqual(input.witness.preserved,{repeatRule:{kind:'daily',weekdays:[]},enabled:false});
 const actions=[receipt(open),receipt(input)],ready=observation(form('09:00')),save=classifyPhoneUseAction('t',tap,ready,grant,actions);assert.equal(save?.kind,'effect_schedule_save');
 assert.equal(classifyPhoneUseAction('t',tap,observation(form('09:00').replace('unchecked','checked')),grant,actions),null,'saving may not enable an untouched disabled alarm');
 assert.equal(classifyPhoneUseAction('t',tap,observation(form('09:00').replace('每天','不重复')),grant,actions),null,'saving may not silently replace recurrence');
 const after='Switch "09:00" "每天" unchecked bounds=100,400,700,600';
 const list=listed('View "09:00" "每天" clickable bounds=100,400,700,650\n  Switch "启用闹钟" unchecked bounds=600,500,690,600');
 const reopen=classifyPhoneUseAction('t',{...tap,x:300,y:450},observation(list),grant,[...actions,receipt(save)]);assert.equal(reopen?.kind,'effect_schedule_reopen');
 assert.equal(effectGoalStatus(observation(after),grant,[...actions,receipt(save),receipt(reopen)]).verified,true);
 assert.equal(effectGoalStatus(observation(after.replace('unchecked','checked')),grant,[...actions,receipt(save)]).verified,false);
 assert.equal(effectGoalStatus(observation(after.replace('每天','不重复')),grant,[...actions,receipt(save)]).verified,false);
 assert.equal(classifyPhoneUseAction('t',{action:'type',observationId:'o',inputMode:'replace',text:'09:00'},observation(form('08:00').replace('unchecked','')),grant,[receipt(open)]),null,'unknown original enabled state must be read before mutation');
});
const intervalFields=[['title','标题'],['date','开始日期'],['time','开始时间'],['endDate','结束日期'],['endTime','结束时间']];
function intervalForm(values,focus=null){return observe(intervalFields.map(([key,label],i)=>`EditText "${label}" "${values[key]||''}" editable clickable ${focus===key?'focused':''} bounds=100,${350+i*150},700,${450+i*150}`).join('\n')+'\nTextView "不重复" bounds=100,1200,700,1250\n'+button('保存'));}
function intervalRow(record,{list=false}={}){return observe((list?'RecyclerView bounds=0,300,1000,1800\n':'')+`View "${record.title}" clickable bounds=100,400,700,1400\n`+intervalFields.filter(([key])=>key!=='title').map(([key,label],i)=>`  TextView "${label}" "${record[key]}" bounds=120,${550+i*130},650,${630+i*130}`).join('\n')+'\n  TextView "不重复" bounds=120,1100,650,1180');}
function agenda(date,events=[],nextDate=null,{count=events.length,more=false}={}){
 return observe(`TextView "${date}" "共${count}个日程" bounds=100,150,800,220\nRecyclerView bounds=0,300,1000,1450\n`+events.map((event,i)=>`  View bounds=100,${350+i*400},800,${700+i*400}\n    TextView "标题:${event.title}" bounds=100,${360+i*400},700,${410+i*400}\n    TextView "开始时间:${event.time}" "结束时间:${event.endTime}" bounds=100,${430+i*400},700,${480+i*400}\n    TextView "开始日期:${event.date||date}" "结束日期:${event.endDate||date}" bounds=100,${500+i*400},700,${550+i*400}`).join('\n')+(nextDate?`\nButton "${nextDate}" clickable bounds=100,1500,700,1570`:'')+'\n'+button('新建日程')+(more?'\nTextView "加载更多" bounds=100,1400,700,1450':''));
}
test('read-only conflict search reports real overlaps and rejects incomplete or clipped day coverage',async()=>{
 const t=task('检查日历明天9点到10点是否有冲突'),p=phoneUseGrant(t,app).effectPlan,f=brokerFixture(t);
 f.set(agenda(p.date,[{title:'已有会议',time:'09:30',endTime:'10:30'}]));const current=meta(await f.broker.execute('t','phone_open_app',{packageName:app.packageName}));const proof=await f.broker.execute('t','phone_schedule',{action:'check_conflicts'});assert.equal(JSON.parse(proof.content[0].text).facts.hasConflict,true);
 await f.broker.execute('t','finish_task',{outcome:'completed',summary:'已有会议与指定时间重叠。',evidence:[current.observationId]});assert.match(t.report.summary,/已有会议/);assert.doesNotMatch(t.report.summary,/未发现|没有冲突/);assert.equal(f.calls.filter(name=>['tap','type','key'].includes(name)).length,0);
 for(const options of [{count:2},{more:true}]){const other=task('检查日历明天9点到10点是否有冲突'),g=brokerFixture(other);g.set(agenda(p.date,[{title:'已有会议',time:'09:30',endTime:'10:30'}],null,options));await g.broker.execute('t','phone_open_app',{packageName:app.packageName});await assert.rejects(g.broker.execute('t','phone_schedule',{action:'check_conflicts'}));}
});
