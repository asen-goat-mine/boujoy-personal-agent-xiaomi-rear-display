import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import { execFileSync } from 'node:child_process';
import {SERVICE_LABEL} from '../src/distribution.mjs';
const label=SERVICE_LABEL;
try{execFileSync('/bin/launchctl',['bootout',`gui/${process.getuid()}/${label}`],{stdio:'ignore'});}catch{}
fs.rmSync(path.join(os.homedir(),'Library/LaunchAgents',label+'.plist'),{force:true});
console.log('Background service removed. Tasks, credentials, and files were preserved.');
