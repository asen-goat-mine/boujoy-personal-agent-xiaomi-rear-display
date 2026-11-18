import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {macFiles} from '../src/tools/mac-files.mjs';
test('Desktop text aliases, append, version backup and generated document save',async t=>{
 const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'boujoy-desktop-')));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 for(const prefix of ['Desktop/','桌面/','~/Desktop/',home+'/Desktop/']){
  const result=await macFiles({action:'write',path:prefix+'报告.txt',content:'中文正文'},{home});
  assert.equal(result.path,'Desktop/报告.txt');assert.equal(await fs.readFile(path.join(home,result.path),'utf8'),'中文正文');
 }
 const appended=await macFiles({action:'write',path:'Desktop/报告.txt',content:'追加',append:true},{home});
 assert.equal(await fs.readFile(path.join(home,'Desktop',appended.previousVersion),'utf8'),'中文正文');
 assert.equal(await fs.readFile(path.join(home,appended.path),'utf8'),'中文正文追加');
 const bytes=Buffer.from('synthetic document bytes');
 const saved=await macFiles({action:'save',artifactId:'doc',path:'桌面/子目录/报告.docx'},{home,artifactBytes:async()=>({name:'报告.docx',bytes})});
 assert.deepEqual(await fs.readFile(path.join(home,saved.path)),bytes);
 for(const bad of ['Desktop/../Downloads/no.txt','Desktop/.hidden/no.txt',home+'/Downloads/no.txt','Desktop/'])await assert.rejects(macFiles({action:'write',path:bad,content:'no'},{home}),{code:'mac_files_denied'});
 await fs.mkdir(path.join(home,'Other'));await fs.symlink(path.join(home,'Other'),path.join(home,'Desktop/link'));
 await assert.rejects(macFiles({action:'write',path:'Desktop/link/no.txt',content:'no'},{home}),{code:'mac_files_denied'});
 await fs.symlink(path.join(home,'Other/target.txt'),path.join(home,'Desktop/link.txt'));
 await assert.rejects(macFiles({action:'write',path:'Desktop/link.txt',content:'no'},{home}),{code:'mac_files_denied'});
 await fs.rename(path.join(home,'Desktop'),path.join(home,'OldDesktop'));await fs.symlink(path.join(home,'Other'),path.join(home,'Desktop'));
 await assert.rejects(macFiles({action:'write',path:'Desktop/no.txt',content:'no'},{home}),{code:'mac_files_denied'});
});
