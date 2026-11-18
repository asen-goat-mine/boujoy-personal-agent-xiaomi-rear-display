import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ANDROID_PACKAGE} from '../src/distribution.mjs';

const run=promisify(execFile);
test('ADB typing selects this edition with the original IME class and restores the previous keyboard',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'boujoy-edition-ime-')),tools=path.join(dir,'tools/platform-tools'),log=path.join(dir,'calls.jsonl');
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.mkdir(tools,{recursive:true});
 // Only this synthetic executable is invoked; the test cannot reach a real adb.
 await fs.writeFile(path.join(tools,'adb'),`#!/usr/bin/env node\n`+`const fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');if(args[0]==='devices')process.stdout.write('List of devices attached\\nfixture-device\\tdevice\\n');else if(args.join(' ')==='shell settings get secure default_input_method')process.stdout.write('com.example.keyboard/.InputMethod\\n');\n`,{mode:0o700});
 const source=new URL('../src/adapters/phone-ime-adb.mjs',import.meta.url).href;
 await run(process.execPath,['--input-type=module','-e',`const {withAdbIme}=await import(${JSON.stringify(source)});await withAdbIme(async()=> 'typed');`],{env:{...process.env,BOUJOY_DATA:dir,PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH},timeout:10000});
 const calls=(await fs.readFile(log,'utf8')).trim().split('\n').map(JSON.parse),ime=`${ANDROID_PACKAGE}/dev.boujoy.personalagent.BoujoyInputMethod`;
 assert.deepEqual(calls.filter(args=>args[1]==='ime'),[['shell','ime','enable',ime],['shell','ime','set',ime],['shell','ime','set','com.example.keyboard/.InputMethod']]);
});
