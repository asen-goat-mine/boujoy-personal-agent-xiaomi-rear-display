import test from 'node:test';import assert from 'node:assert/strict';
import {samePhoneTarget} from '../src/adapters/phone-observation.mjs';
function page({clock='12:00',ad='old',label='闪购',bounds='294,95,488,188',dialog=false,pkg='app',field='搜索商品'}={}){
 const tree=`window pkg=com.android.systemui layer=1 bounds=0,0,968,95\n  TextView "${clock}" bounds=0,0,100,95\nwindow pkg=${pkg} layer=0 bounds=0,0,968,2376\n  LinearLayout clickable bounds=${bounds}\n    TextView "${label}" bounds=294,111,372,171\n  TextView "${ad}" bounds=0,500,968,600\n  EditText "${field}" editable focused bounds=0,200,968,300${dialog?'\nwindow pkg=permission layer=2 bounds=0,0,968,2376\n  TextView "confirm" bounds=0,0,968,2376':''}`;
 return {content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:pkg,windowPkg:pkg,window:'0,0,968,2376',tree}})}]};
}
test('clock and advertisements do not invalidate an unchanged named navigation target',()=>{
 assert.equal(samePhoneTarget(page(),page({clock:'12:01'}),{action:'back'}),true);
 assert.equal(samePhoneTarget(page(),page({ad:'new'}),{action:'tap',x:391,y:141}),true);
});
test('moved targets, changed labels, overlays and different apps remain blocked',()=>{
 for(const change of [{bounds:'400,95,594,188'},{label:'付款'},{dialog:true},{pkg:'other'}])assert.equal(samePhoneTarget(page(),page({...change,ad:'new'}),{action:'tap',x:391,y:141}),false);
});
test('transaction taps and generic gestures keep the full content check',()=>{
 assert.equal(samePhoneTarget(page({label:'确认付款',ad:'10元'}),page({label:'确认付款',ad:'20元'}),{action:'tap',x:391,y:141}),false);
 assert.equal(samePhoneTarget(page(),page({ad:'new'}),{action:'swipe',x1:400,y1:1000,x2:400,y2:500}),false);
});
test('typing tolerates unrelated updates only while the same field stays focused and unchanged',()=>{
 assert.equal(samePhoneTarget(page(),page({ad:'new'}),{action:'type',text:'冰美式'}),true);
 assert.equal(samePhoneTarget(page(),page({ad:'new',field:'付款密码'}),{action:'type',text:'冰美式'}),false);
});
