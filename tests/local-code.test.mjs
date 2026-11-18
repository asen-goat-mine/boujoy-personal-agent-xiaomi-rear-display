import test from 'node:test';
import {NEEDS_SANDBOX_PYTHON} from './helpers/requirements.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {createTaskContract,initializeTimeline} from '../src/core/task-contract.mjs';
import {readTaskArtifact} from '../src/tools/artifacts.mjs';
import {runLocalPython} from '../src/tools/local-code.mjs';
async function fixture(t){
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'boujoy-code-test-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));await fs.mkdir(path.join(dataDir,'artifacts'));
 const prompt='用 Python 分析附件数据，计算平均数并生成 CSV 文件',task={id:'task-code',source:'user',prompt,messages:[{id:'u1',role:'user',content:prompt}],cloudConsent:true,status:'running'};initializeTimeline(task,{budgetMs:60000});task.taskContract=createTaskContract(task);
 const bytes=Buffer.from('1,2,3\n'),artifact={id:'input1',taskId:task.id,name:'data.csv',path:'data.csv',mime:'text/csv',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};await fs.writeFile(path.join(dataDir,'artifacts/data.csv'),bytes);
 const store={data:{artifacts:[artifact]},task:()=>task};const run=(args,extra={})=>runLocalPython({task,store,dataDir,args,...extra});return {dataDir,task,store,run};
}
test('real macOS sandbox computes from a verified text attachment and emits a real hashed artifact',{skip:NEEDS_SANDBOX_PYTHON},async t=>{
 const x=await fixture(t),result=await x.run({inputArtifactIds:['input1'],outputNames:['result.csv'],code:'import statistics,csv,sys\nassert sys.dont_write_bytecode, "The isolated worker must not write into the signed Python runtime"\nvalues=list(map(int,open(INPUTS["input1"]).read().strip().split(",")))\nmean=statistics.mean(values)\nprint(mean)\nwith open(OUTPUTS["result.csv"],"w") as f: csv.writer(f).writerows([["mean"],[mean]])'});
 assert.equal(result.completed,true);assert.equal(result.exitCode,0);assert.equal(result.stdout.trim(),'2');assert.equal(result.sandbox,'macos-seatbelt');assert.equal(result.artifacts.length,1);const bytes=await fs.readFile(path.join(x.dataDir,'artifacts',result.artifacts[0].path));assert.match(bytes.toString(),/mean\r?\n2/);assert.equal(result.artifacts[0].sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(result.authorizationSource,false);
 assert.deepEqual(await fs.readdir(path.join(x.dataDir,'code-runs')),[]);
});
test('OS sandbox rejects native file access, networking, subprocess and weakening its own profile',{skip:NEEDS_SANDBOX_PYTHON},async t=>{
 const x=await fixture(t),secret=path.join(x.dataDir,'fixture-secret');await fs.writeFile(secret,'do-not-read');
 const network=net.createServer(socket=>socket.destroy());await new Promise((resolve,reject)=>{network.once('error',reject);network.listen(0,'127.0.0.1',resolve);});t.after(()=>new Promise(resolve=>network.close(resolve)));const blockedPort=network.address().port;
 const result=await x.run({code:`import ctypes,os,socket,subprocess,json\nresults={}\nlibc=ctypes.CDLL(None,use_errno=True)\nfd=libc.open(${JSON.stringify(secret)}.encode(),0)\nresults["nativeFileDenied"]=fd==-1\nfor name,fn in [("network",lambda:socket.create_connection(("127.0.0.1",${blockedPort}),timeout=1)),("process",lambda:subprocess.run(["/bin/echo","bad"])),("write",lambda:open(${JSON.stringify(secret)},"w"))]:\n try: fn(); results[name]=False\n except (PermissionError,OSError): results[name]=True\nlib=ctypes.CDLL("/usr/lib/libsandbox.dylib");error=ctypes.c_char_p()\nlib.sandbox_init(b"(version 1)(allow default)",0,ctypes.byref(error))\nresults["stillDenied"]=libc.open(${JSON.stringify(secret)}.encode(),0)==-1\nprint(json.dumps(results))`});
 assert.equal(result.completed,true,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{nativeFileDenied:true,network:true,process:true,write:true,stillDenied:true});assert.equal(await fs.readFile(secret,'utf8'),'do-not-read');
});
test('code cannot alter inputs, create undeclared output or expose parent secret environment',{skip:NEEDS_SANDBOX_PYTHON},async t=>{
 const x=await fixture(t);process.env.BOUJOY_CODE_TEST_SECRET='private-fixture';t.after(()=>delete process.env.BOUJOY_CODE_TEST_SECRET);
 const result=await x.run({inputArtifactIds:['input1'],code:'import os,json\nr={"environment":os.environ.get("BOUJOY_CODE_TEST_SECRET")}\nfor name,p in [("input",INPUTS["input1"]),("undeclared","extra.txt")]:\n try: open(p,"w").write("bad");r[name]=False\n except (PermissionError,OSError):r[name]=True\nprint(json.dumps(r))'});
 assert.equal(result.completed,true,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{environment:null,input:true,undeclared:true});
});
test('cancellation kills actual running computation and leaves no artifact or child work',{skip:NEEDS_SANDBOX_PYTHON},async t=>{
 const x=await fixture(t),controller=new AbortController();const pending=x.run({code:'while True: pass'},{signal:controller.signal});setTimeout(()=>controller.abort(),100);
 await assert.rejects(pending,e=>e.code==='cancelled');assert.deepEqual(await fs.readdir(path.join(x.dataDir,'code-runs')),[]);assert.deepEqual(await fs.readdir(path.join(x.dataDir,'artifacts')),['data.csv']);
});
test('scope, task artifact ownership, output paths and failed code are enforced',{skip:NEEDS_SANDBOX_PYTHON},async t=>{
 const x=await fixture(t);await assert.rejects(x.run({code:'pass',outputNames:['../bad.txt']}));await assert.rejects(x.run({code:'pass',inputArtifactIds:['other']}),e=>e.code==='artifact_not_found');
 const fail=await x.run({code:'raise ValueError("calculation failed")',outputNames:['empty.txt']});assert.equal(fail.completed,false);assert.match(fail.stderr,/calculation failed/);assert.deepEqual(fail.artifacts,[]);
 x.task.messages[0].content='你好';await assert.rejects(x.run({code:'print(1)'}),e=>e.code==='code_not_authorized');
});
test('paused tasks cannot enter the sandbox and invalid output never leaves a partial published artifact',{skip:NEEDS_SANDBOX_PYTHON},async t=>{
 const x=await fixture(t);x.task.status='paused';await assert.rejects(x.run({code:'print(1)'}),e=>e.code==='cancelled');x.task.status='running';
 await assert.rejects(x.run({code:'open(OUTPUTS["first.txt"],"w").write("valid")\nopen(OUTPUTS["second.json"],"w").write("invalid json")',outputNames:['first.txt','second.json']}));assert.deepEqual(await fs.readdir(path.join(x.dataDir,'artifacts')),['data.csv']);
 const failure=await x.run({code:'open(OUTPUTS["large.txt"],"w").write("a"*(2*1024*1024))',outputNames:['large.txt']});assert.equal(failure.completed,false);assert.deepEqual(failure.artifacts,[]);
 const flood=await x.run({code:'print("a"*100000)'});assert.equal(flood.completed,false);assert.equal(flood.termination,'output_limit');assert.ok(Buffer.byteLength(flood.stdout+flood.stderr)<=64*1024);
});

test('Python reads a complete large HTML input without enlarging model previews or bypassing validation',{skip:NEEDS_SANDBOX_PYTHON},async t=>{
 const x=await fixture(t),artifact=x.store.data.artifacts[0],file=path.join(x.dataDir,'artifacts/data.csv');
 const install=async bytes=>{Object.assign(artifact,{name:'design.html',mime:'text/html',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});await fs.writeFile(file,bytes);};
 await install(Buffer.from('<html><script>'+ 'x'.repeat(450000)+'</script><h1>手机端设计稿</h1></html>'));
 const preview=JSON.parse((await readTaskArtifact({taskId:x.task.id,id:artifact.id,artifacts:x.store.data.artifacts,dataDir:x.dataDir})).content[0].text);
 assert.equal(preview.truncated,true);assert.ok(Buffer.byteLength(preview.content)<=200*1024);
 const args={inputArtifactIds:[artifact.id],code:'import re\ntext=open(INPUTS["input1"]).read()\nprint(re.search(r"<h1>(.*?)</h1>",text).group(1))'};
 const result=await x.run(args);assert.equal(result.completed,true,result.stderr);assert.equal(result.stdout.trim(),'手机端设计稿');
 await fs.appendFile(file,'changed');await assert.rejects(x.run(args),e=>e.code==='artifact_changed');
 await install(Buffer.from('x'.repeat(1024*1024+1)));await assert.rejects(x.run(args),/完整可读取/);
 await install(Buffer.concat([Buffer.from('x'.repeat(450000)),Buffer.from([0xff])]));await assert.rejects(x.run(args),/完整可读取/);
 await install(Buffer.from('x'.repeat(450000)+'\0'));await assert.rejects(x.run(args),/完整可读取/);
 artifact.taskId='other-task';await assert.rejects(x.run(args),e=>e.code==='artifact_not_found');
});


test('packed HTML is decoded as untrusted data inside the existing offline sandbox',{skip:NEEDS_SANDBOX_PYTHON},async t=>{
 const x=await fixture(t),artifact=x.store.data.artifacts[0],file=path.join(x.dataDir,'artifacts/data.csv');
 const inner='<h1>合成设计稿</h1><p>助理列表、对话、确认卡</p><script>throw new Error("must never execute document scripts")</script>';
 const packed=JSON.stringify({mime:'text/html',compressed:true,data:gzipSync(Buffer.from(inner)).toString('base64')});
 const bytes=Buffer.from('<html><!--'+ 'padding'.repeat(60000)+'--><script type="application/json">'+packed+'</script></html>');
 Object.assign(artifact,{name:'packed.html',mime:'text/html',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});await fs.writeFile(file,bytes);
 const result=await x.run({inputArtifactIds:[artifact.id],code:`import re,json,gzip,base64
text=open(INPUTS["input1"]).read()
row=json.loads(re.search(r'<script type="application/json">(.*?)</script>',text).group(1))
decoded=gzip.decompress(base64.b64decode(row["data"])).decode()
decoded=re.sub(r"<script.*?</script>","",decoded,flags=re.S)
print(re.sub(r"<[^>]+>"," ",decoded).strip())`});
 assert.equal(result.completed,true,result.stderr);assert.equal(result.networkAllowed,false);assert.equal(result.authorizationSource,false);assert.match(result.stdout,/合成设计稿.*助理列表、对话、确认卡/);assert.doesNotMatch(result.stdout,/must never execute/);assert.equal((await fs.readFile(file)).equals(bytes),true);
});
