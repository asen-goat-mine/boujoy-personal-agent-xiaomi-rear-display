import test from 'node:test';import assert from 'node:assert/strict';import {navigationPackageAllowed} from '../src/adapters/phone-application-families.mjs';import {phoneUseGrant,phoneUseCanObserve} from '../src/adapters/phone-use.mjs';
test('Settings read navigation covers exact Samsung settings modules and never package prefixes or other apps',()=>{
 const task={id:'t',status:'running',source:'user',messages:[{id:'human',role:'user',content:'打开设置，查看电池用量，再返回设置首页。'}]},scope=phoneUseGrant(task,{packageName:'com.android.settings',appName:'设置'});assert.ok(scope);
 const tree=pkg=>({content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',windowPkg:pkg,foreground:pkg,tree:`window pkg=${pkg} bounds=0,0,968,2376\nTextView "电池使用量" bounds=100,300,800,400`}})}]});
 assert.equal(phoneUseCanObserve('t',tree('com.samsung.android.sm_cn'),scope),true);
 for(const pkg of ['com.tencent.mm','com.samsung.android.sm_cn.fake','com.samsung.android.unrelated'])assert.equal(phoneUseCanObserve('t',tree(pkg),scope),false);
 assert.equal(navigationPackageAllowed('com.taobao.taobao','com.samsung.android.sm_cn'),false);
});
