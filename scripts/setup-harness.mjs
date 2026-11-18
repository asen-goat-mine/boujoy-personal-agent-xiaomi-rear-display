// Installs DeepSeek Harness (npm @deepseek-ai/dsh, MIT) into .runtime/harness for a source checkout.
// The packaged Mac app already contains it; this is only for running from source.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {LOCAL_HARNESS} from '../src/config.mjs';
const VERSION='0.2.1-alpha.2';
const manifest=path.join(LOCAL_HARNESS,'package.json');
fs.mkdirSync(LOCAL_HARNESS,{recursive:true});
fs.writeFileSync(manifest,JSON.stringify({private:true,dependencies:{'@deepseek-ai/dsh':VERSION}},null,2)+'\n');
const npm=process.platform==='win32'?'npm.cmd':'npm';
const result=spawnSync(npm,['install','--no-audit','--no-fund'],{cwd:LOCAL_HARNESS,stdio:'inherit'});
if(result.status!==0)process.exit(result.status||1);
const installed=JSON.parse(fs.readFileSync(path.join(LOCAL_HARNESS,'node_modules/@deepseek-ai/dsh/package.json'),'utf8'));
console.log(`DeepSeek Harness ${installed.version} 已安装到 ${LOCAL_HARNESS}`);
