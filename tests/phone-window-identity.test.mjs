import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeWindowConflict} from '../src/adapters/phone-window-identity.mjs';

test('window diagnostics distinguish foreground conflicts from the IME, peripheral system bars and other displays',()=>{
 const target={window_id:1,display_id:0,type:1,layer:1,active:false,focused:false,bounds:[0,0,1000,2400]};
 const overlay={...target,window_id:5,type:3,layer:100,active:true,focused:true};
 const conflict=(other,app=target)=>nativeWindowConflict({windowId:1,display:{id:0},windows:[app,other]});
 assert.equal(conflict(overlay),true);
 assert.equal(conflict({...overlay,type:1,bounds:[650,0,1000,2400]}),true,'a different application owns focus in split-screen');
 assert.equal(conflict({...overlay,type:2,bounds:[0,1000,1000,2400]}),false);
 assert.equal(conflict({...overlay,bounds:[0,0,1000,110]}),false);
 assert.equal(conflict({...overlay,display_id:1}),false);
 assert.equal(conflict({...overlay,active:false,focused:false}),false);
 assert.equal(conflict(overlay,{...target,active:true,focused:true}),true);
 assert.equal(conflict({...overlay,layer:0},{...target,active:true,focused:true}),false);
 assert.equal(nativeWindowConflict({windowId:1,windows:[]}),false);
});
