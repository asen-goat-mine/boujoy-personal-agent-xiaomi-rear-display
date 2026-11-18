import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fixture(){
 let html='',writes=0;const timeline={scrollHeight:200,scrollTop:10,clientHeight:50,get innerHTML(){return html;},set innerHTML(value){writes++;html=value;}},logs={open:false};
 const c={esc,online:true,selectedRole:'concierge',state:{roles:[{id:'concierge',name:'Assistant'},{id:'work',name:'Worker'}],approvals:[],tasks:[],platforms:[]},detail:{id:'task',status:'running',kind:'general',updatedAt:'2026-10-15T00:00:00Z',requests:0,messages:[{role:'user',content:'request'}],events:[]},ACTIVE:['running'],STATUS:{completed:'已完成'},TOOLS:{finish_task:'核验处理结果',phone_action:'操作手机'},robotCompanion:(t,status)=>'<status>'+status+'</status>',approvals:()=>'',comparisons:()=>'',button:()=>'',icon:()=>'',clock:()=>'',statusTag:s=>s};
 c.role=id=>c.state.roles.find(r=>r.id===id);c.$=s=>s==='#timeline'?timeline:s==='#activity-log'?logs:null;vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('function normalizeMessage('),source.indexOf('function approvals(')),c);vm.runInContext(source.slice(source.indexOf('function renderTimeline('),source.indexOf('function chatPreferences(')),c);
 return {c,timeline,logs,get writes(){return writes;}};
}
test('polling with identical content and hidden timing metadata does not replace transcript DOM',()=>{
 const f=fixture();f.c.renderTimeline();const before=f.timeline.innerHTML;f.c.renderTimeline();assert.equal(f.writes,1);
 f.c.detail={...f.c.detail,updatedAt:'2026-10-15T00:00:01Z',requests:1,events:[{type:'model_timing',at:'2026-10-15T00:00:01Z',text:'timing'}]};f.c.renderTimeline();assert.equal(f.timeline.innerHTML,before);assert.equal(f.writes,1,'non-presented metadata must not remove focused/selected DOM children');
});
test('a changed current activity still refreshes status even when its bookkeeping event is collapsed',()=>{
 const f=fixture();f.c.renderTimeline();f.c.detail.events.push({type:'tool',tool:'finish_task',at:'2026-10-15T00:00:02Z'});f.c.renderTimeline();assert.equal(f.writes,2);assert.match(f.timeline.innerHTML,/<status>核验处理结果<\/status>/);
});
test('updates preserve a reader scroll position and process disclosure state',()=>{
 const f=fixture();f.c.renderTimeline();f.timeline.scrollTop=27;f.logs.open=true;f.c.detail.events.push({type:'error',text:'Visible update',at:'2026-10-15T00:00:02Z'});f.c.renderTimeline();assert.equal(f.timeline.scrollTop,27);assert.match(f.timeline.innerHTML,/id="activity-log"[^>]* open/);
});
test('URL-valued link labels keep exactly the chosen outer destination',()=>{
 const {c}=fixture();for(const label of ['https://example.com/info','**https://example.com/info**','`https://example.com/info`']){const html=c.messageMarkup(`[${label}](https://example.com/target)`);assert.equal((html.match(/<a /g)||[]).length,1);assert.match(html,/href="https:\/\/example.com\/target"/);assert.ok(html.includes('https://example.com/info'));}
});
test('four-backtick and unfinished fences preserve literal markup without active links or HTML',()=>{
 const {c}=fixture();for(const text of ['````html\n<script>x()</script>\n```\nhttps://example.com/a\n````','```html\n<a href="javascript:alert(1)">x</a>\nhttps://example.com/a']){const html=c.messageMarkup(text);assert.match(html,/<pre tabindex="0" aria-label="代码"><code>/);assert.equal((html.match(/<pre /g)||[]).length,1);assert.equal((html.match(/<a /g)||[]).length,0);assert.equal(html.includes('<script>'),false);assert.ok(html.includes('https://example.com/a'));}
});
test('table pipes inside code and escaped cells preserve content with untrusted HTML escaped',()=>{
 const {c}=fixture();const html=c.messageMarkup('| one | two |\n| --- | --- |\n| `a|b` | x\\|y <img src=x onerror=alert(1)> |');assert.equal((html.match(/<td>/g)||[]).length,2);assert.match(html,/<code>a\|b<\/code>/);assert.ok(html.includes('x|y'));assert.equal(html.includes('<img'),false);assert.ok(html.includes('&lt;img'));
});
test('mobile drawer marks hidden navigation inert and returns focus when closed',()=>{
 let mobile=true,focused=null;const classes=new Set(),nodes={};for(const id of ['#sidebar','#chat','#sidebar-backdrop','[data-action="show-sidebar"]','[data-action="close-sidebar"]'])nodes[id]={attributes:{},setAttribute(k,v){this.attributes[k]=v;},focus(){focused=id;}};
 const c={$:id=>nodes[id],matchMedia:()=>({matches:mobile}),document:{body:{classList:{contains:v=>classes.has(v),toggle(v,on){if(on)classes.add(v);else classes.delete(v);}}}}};vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function syncSidebarAccessibility('),source.indexOf('function renderHeader(')),c);
 c.syncSidebarAccessibility();assert.equal(nodes['#sidebar'].inert,true);assert.equal(nodes['#chat'].inert,false);c.setSidebarOpen(true);assert.equal(nodes['#sidebar'].inert,false);assert.equal(nodes['#chat'].inert,true);assert.equal(focused,'[data-action="close-sidebar"]');assert.equal(nodes['[data-action="show-sidebar"]'].attributes['aria-expanded'],'true');c.setSidebarOpen(false);assert.equal(focused,'[data-action="show-sidebar"]');assert.equal(nodes['#chat'].inert,false);mobile=false;c.syncSidebarAccessibility();assert.equal(nodes['#sidebar'].inert,false);
});
