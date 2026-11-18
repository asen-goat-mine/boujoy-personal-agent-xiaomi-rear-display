import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../src/config.mjs';
let failures=0;
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(/\.(mjs|cjs|js)$/.test(e.name)){const r=spawnSync(process.execPath,['--check',p],{encoding:'utf8'});if(r.status){console.error(r.stderr);failures++;}}}}
for(const d of ['src','scripts','web','tests','desktop'])walk(path.join(ROOT,d));
if(failures)process.exitCode=1;else console.log('JavaScript syntax checks passed.');
