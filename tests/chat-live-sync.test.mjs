import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const privateTaskSource=source.slice(source.indexOf('const privateTask='),source.indexOf('const latest='));
function setup(){
 const timers=[],intervals=[],events={},c={online:true,detail:{status:'running'},ACTIVE:['running','queued','waiting_children','waiting_approval'],eventSource:null,Date,document:{hidden:false,addEventListener:(n,f)=>events[n]=f},window:{addEventListener:(n,f)=>events[n]=f},setTimeout:f=>(timers.push(f),timers.length),setInterval:f=>intervals.push(f),renderSidebar(){},renderHeader(){},renderTimeline(){},refresh:async()=>{c.online=true;c.detail.status='needs_review';c.reads++;},reads:0,EventSource:class{close(){}}};
 vm.createContext(c);vm.runInContext(privateTaskSource,c);vm.runInContext(source.slice(source.indexOf('function startLiveUpdates('),source.indexOf('async function boot(')),c);c.startLiveUpdates();return {c,timers,intervals,events};
}
const flush=()=>new Promise(setImmediate);
test('silent push stall reconciles a finished response without sending another message',async()=>{const {c,intervals}=setup();intervals[0]();await flush();assert.equal(c.reads,1);assert.equal(c.detail.status,'needs_review');assert.equal(c.online,true);});
test('failed refresh clears stale thinking and later polling recovers',async()=>{const {c,intervals}=setup();const refresh=c.refresh;c.refresh=async()=>{throw Error('offline');};intervals[0]();await flush();assert.equal(c.online,false);c.refresh=refresh;intervals[0]();await flush();assert.equal(c.online,true);assert.equal(c.reads,1);});
test('overlapping updates are serialized and a pending event gets a follow-up read',async()=>{const {c,timers,intervals}=setup();let resolve,count=0;c.refresh=()=>{count++;return new Promise(r=>resolve=r);};intervals[0]();intervals[0]();assert.equal(count,1);resolve();await flush();assert.equal(timers.length,1);timers.shift()();assert.equal(count,2);resolve();await flush();});
test('hidden window skips polling and foreground resumes synchronization',async()=>{const {c,timers,intervals,events}=setup();c.document.hidden=true;intervals[0]();await flush();assert.equal(c.reads,0);c.document.hidden=false;events.visibilitychange();timers.shift()();await flush();assert.equal(c.reads,1);});

function routing(){
 const state={tasks:[{id:'a',roleId:'concierge'},{id:'b',roleId:'work'}],roles:[{id:'concierge'},{id:'work'}]},requests=[],renders=[];
 const c={state,detail:{id:'a'},selectedId:'a',selectedRole:'concierge',selections:{},navigationVersion:0,refreshVersion:0,online:true,location:{hash:'#task/a'},updateSend(){},rememberSelection(){},render(){renders.push(c.detail?.id);},api(url){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});requests.push({url,resolve,reject});return promise;}};c.role=id=>state.roles.find(r=>r.id===id);c.latest=id=>state.tasks.find(t=>t.roleId===id);
 vm.createContext(c);vm.runInContext(privateTaskSource,c);vm.runInContext(source.slice(source.indexOf('function parseRoute('),source.indexOf('function renderSidebar(')),c);vm.runInContext(source.slice(source.indexOf('async function refresh('),source.indexOf('function openSheet(')),c);return {c,state,requests,renders};
}
test('a stale detail response cannot overwrite the task selected by a later navigation',async()=>{
 const {c,state,requests,renders}=routing();const old=c.refresh();requests[0].resolve(state);await flush();assert.equal(requests[1].url,'/tasks/a');
 c.location.hash='#task/b';c.navigationVersion++;const latest=c.refresh(true);requests[2].resolve(state);await flush();requests[3].resolve({id:'b'});await latest;requests[1].resolve({id:'a'});await old;
 assert.equal(c.detail.id,'b');assert.equal(c.selectedId,'b');assert.deepEqual(renders,['b']);
});
test('stale network failures are ignored after newer navigation succeeds, while current failures still reject',async()=>{
 const {c,state,requests}=routing();const old=c.refresh();requests[0].resolve(state);await flush();c.location.hash='#task/b';c.navigationVersion++;const latest=c.refresh(true);requests[2].resolve(state);await flush();requests[3].resolve({id:'b'});await latest;requests[1].reject(Error('old connection failed'));await old;assert.equal(c.online,true);assert.equal(c.detail.id,'b');
 const current=c.refresh();requests[4].reject(Error('current failure'));await assert.rejects(current,/current failure/);
});
test('a hash change before its event invalidates an earlier state response before it changes selection',async()=>{
 const {c,state,requests,renders}=routing();const old=c.refresh();c.location.hash='#task/b';requests[0].resolve(state);await old;assert.equal(requests.length,1);assert.equal(c.selectedId,'a');assert.deepEqual(renders,[]);
});
