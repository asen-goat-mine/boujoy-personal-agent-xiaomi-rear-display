// Rebuild the unchanged official engine from the pinned vendored TypeScript.
import {execFileSync} from 'node:child_process';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),vendor=path.join(root,'vendor/dsh-superagent');
execFileSync('pnpm',['exec','tsdown','src/core/index.ts','--no-config','--out-dir','boujoy-core','--format','esm','--platform','node','--target','es2024'],{cwd:vendor,stdio:'inherit'});
fs.mkdirSync(path.join(root,'src/vendor'),{recursive:true});fs.copyFileSync(path.join(vendor,'boujoy-core/index.mjs'),path.join(root,'src/vendor/dsh-superagent-core.mjs'));fs.copyFileSync(path.join(vendor,'LICENSE'),path.join(root,'src/vendor/dsh-superagent-LICENSE'));
