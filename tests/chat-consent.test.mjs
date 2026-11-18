import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
function setup(){
 const calls=[],c={state:{settings:{chatCloudConsent:false,chatMemoryConsent:false}},prefs:new Map(),composerKey:'task',detail:null,selectedRole:'work',currentKey:()=> 'new-work',toast(){},api:async(url,body)=>{calls.push({url,body:JSON.parse(JSON.stringify(body))});}};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('async function grantModelConsent('),source.indexOf('async function action(')),c);
 vm.runInContext(source.slice(source.indexOf('function chatPreferences('),source.indexOf('function renderComposer(')),c);return {c,calls};
}
test('one-time permission does not persist or authorize later new chats',async()=>{
 const {c,calls}=setup();await c.grantModelConsent('one');assert.deepEqual(calls,[{url:'/tasks/one/continue',body:{cloudConsent:true}}]);assert.equal(c.chatPreferences().cloudConsent,false);
});
test('remember persists only cloud permission and new chats inherit it',async()=>{
 const {c,calls}=setup();await c.grantModelConsent('one',true);assert.deepEqual(calls,[{url:'/settings',body:{chatCloudConsent:true}},{url:'/tasks/one/continue',body:{cloudConsent:true}}]);assert.equal(c.chatPreferences().cloudConsent,true);assert.equal(c.chatPreferences().memoryConsent,false);
});
test('saved default does not retroactively authorize waiting tasks and can be disabled',async()=>{
 const {c}=setup();await c.grantModelConsent('one',true);c.detail={cloudConsent:false,memoryConsent:false};assert.equal(c.chatPreferences().cloudConsent,false);c.detail=null;c.state.settings.chatCloudConsent=false;assert.equal(c.chatPreferences().cloudConsent,false);
});
test('failed persistence does not start a task or change local consent',async()=>{
 const {c}=setup();let count=0;c.api=async()=>{count++;throw Error('offline');};await assert.rejects(c.grantModelConsent('one',true),/offline/);assert.equal(count,1);assert.equal(c.state.settings.chatCloudConsent,false);
});
