import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
function Drafts(){const c={};vm.createContext(c);vm.runInContext(source.slice(source.indexOf('class LocalDrafts'),source.indexOf('const drafts='))+';this.Drafts=LocalDrafts',c);return c.Drafts;}
test('unsent drafts survive reload independently; clearing a sent draft never clears another chat',()=>{
 const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)},Store=Drafts();let drafts=new Store(storage);
 drafts.set('new-one','未发送');drafts.set('chat-two','另一段');drafts=new Store(storage);assert.equal(drafts.get('new-one'),'未发送');assert.equal(drafts.get('chat-two'),'另一段');
 drafts.delete('new-one');drafts=new Store(storage);assert.equal(drafts.has('new-one'),false);assert.equal(drafts.get('chat-two'),'另一段');drafts.set('chat-two','');assert.equal(new Store(storage).size,0);
});
test('corrupt or unavailable local draft storage leaves editing usable',()=>{
 const Store=Drafts();for(const data of ['null','{}','bad','[[1,"x"],["x",null]]'])assert.equal(new Store({getItem:()=>data}).size,0);
 const drafts=new Store({getItem(){throw Error('unavailable');},setItem(){throw Error('quota');}});drafts.set('one','keep in memory');assert.equal(drafts.get('one'),'keep in memory');
});
test('conversation history and new chat are direct header actions without modifying the selection or draft',()=>{
 const header={},chat={setAttribute(){}},c={selectedRole:'qa',role:()=>({id:'qa',name:'验收'}),esc:String,icon:()=>'',button:(action)=>`<button data-action="${action}"></button>`,$:id=>id==='#chat'?chat:header,syncSidebarAccessibility(){}};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function renderHeader('),source.indexOf('function render(force')),c);c.renderHeader();assert.match(header.innerHTML,/data-action="history"/);assert.match(header.innerHTML,/data-action="new-chat"/);assert.match(header.innerHTML,/data-action="edit-role"/);assert.equal(c.selectedRole,'qa');
});

test('inspecting a group execution preserves private navigation and exposes its result and files',async()=>{
 const task={id:'group-task',roleId:'qa',status:'completed',title:'协作任务',groupId:'g',messages:[{role:'assistant',content:'群结果'}],artifacts:[{id:'file',name:'结果.txt'}]};let shown;
 const c={api:async()=>task,role:()=>({name:'助理'}),esc:String,STATUS:{completed:'已完成'},messageMarkup:String,mediaMarkup:a=>`file:${a.id}`,approvals:()=>'',openSheet:(...args)=>{shown=args;},selectedId:'private',location:{hash:'#task/private'}};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('let inspectedTaskId='),source.indexOf('function showHistory(')),c);await c.showTaskInspection('group-task');assert.match(shown[1],/群结果/);assert.match(shown[1],/file:file/);assert.equal(c.selectedId,'private');assert.equal(c.location.hash,'#task/private');assert.equal(shown[2].key,'task-inspection');
});
