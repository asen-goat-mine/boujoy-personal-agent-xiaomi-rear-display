import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {ROOT,HARNESS,DATA} from '../src/config.mjs';
import {DISTRIBUTION as D,BUILD_IDENTITY,readBuildIdentity} from '../src/distribution.mjs';
import serviceIdentity from '../desktop/service-identity.cjs';
import {verifyAndroidSourceReceipt} from './android-source-gate.mjs';
serviceIdentity.assertBuildIdentity(BUILD_IDENTITY,BUILD_IDENTITY);
const DESKTOP_VERSION=D.desktopVersion,DESKTOP_BUILD=D.desktopBuild,ANDROID_VERSION=D.androidVersion,ANDROID_CODE=D.androidVersionCode;
if(JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).version!==DESKTOP_VERSION)throw Error('The backend package version differs from distribution.json');
if(process.env.BOUJOY_ALLOW_UNVERIFIED_APK||process.env.BOUJOY_SHARE_WITHOUT_ANDROID)throw Error('Release packages require a verified Android APK; bypass options are forbidden');
const apkInput=process.env.BOUJOY_FRESH_ANDROID_APK;
if(!apkInput)throw Error('Set BOUJOY_FRESH_ANDROID_APK to the freshly built release APK');
const apk=fs.realpathSync(apkInput),record=path.join(path.dirname(apk),'output-metadata.json');
if(!fs.existsSync(record))throw Error('A release APK requires its adjacent output-metadata.json');
const meta=JSON.parse(fs.readFileSync(record,'utf8')),element=(meta.elements||[]).find(e=>e.outputFile===path.basename(apk));
if(meta.applicationId!==D.androidApplicationId||element?.versionName!==ANDROID_VERSION||Number(element?.versionCode)!==ANDROID_CODE)throw Error('The APK build record does not match the selected edition/version');
const sourceReceipt=verifyAndroidSourceReceipt({root:ROOT,apkPath:apk,distribution:D});
const buildTools=process.env.BOUJOY_ANDROID_BUILD_TOOLS;
if(!buildTools||!path.isAbsolute(buildTools))throw Error('Set BOUJOY_ANDROID_BUILD_TOOLS to the SDK build-tools directory containing aapt2 and apksigner');
const inspect=spawnSync(path.join(buildTools,'aapt2'),['dump','badging',apk],{encoding:'utf8'});
if(inspect.status!==0)throw Error('Cannot inspect the APK binary manifest');
const apkIdentity=inspect.stdout.match(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m);
if(!apkIdentity||apkIdentity[1]!==D.androidApplicationId||Number(apkIdentity[2])!==ANDROID_CODE||apkIdentity[3]!==ANDROID_VERSION)throw Error('The APK binary identity differs from distribution.json');
const signature=spawnSync(path.join(buildTools,'apksigner'),['verify','--verbose','--print-certs',apk],{encoding:'utf8'});
if(signature.status!==0)throw Error('APK signature verification failed');
const apkSha256=sourceReceipt.sha256;
const output=process.env.BOUJOY_SHARE_OUTPUT;
if(!output||!path.isAbsolute(output)||fs.existsSync(output))throw Error('Set BOUJOY_SHARE_OUTPUT to a new absolute directory');
const python=process.env.BOUJOY_SHARE_PYTHON;
if(!python||!fs.existsSync(path.join(python,'bin/python3')))throw Error('BOUJOY_SHARE_PYTHON must contain a portable Python runtime');
if(process.arch!=='arm64'||process.platform!=='darwin')throw Error('This package is for Apple silicon macOS');
const electron=path.join(process.env.BOUJOY_ELECTRON_RUNTIME||path.join(os.homedir(),'Library/Application Support/Boujoy/PersonalAgentDesktopRuntime'),'node_modules/electron/dist/Electron.app');
const app=path.join(output,D.productName+'.app'),resources=path.join(app,'Contents/Resources/app');
const run=(cmd,args)=>{const r=spawnSync(cmd,args,{stdio:'inherit'});if(r.status!==0)throw Error(cmd+' failed');};
const copy=(src,dst)=>{fs.mkdirSync(path.dirname(dst),{recursive:true});fs.cpSync(fs.realpathSync(src),dst,{recursive:true,verbatimSymlinks:true,filter:p=>!['.DS_Store','__pycache__','.git','.cache','.npm','coverage','test','tests','__tests__','fixtures','test-fixtures','PyObjCTest'].includes(path.basename(p)) && !/^\.env(?:[.-]|$)/i.test(path.basename(p)) && !/\.(?:log|jks|keystore|pem|key|p12|pfx|pyc|o|a|obj|tsbuildinfo)$/i.test(p)});};
fs.mkdirSync(output,{recursive:true});run('/usr/bin/ditto',[electron,app]);
for(const name of ['main.cjs','portable-runtime.cjs','preload.cjs','pet-preload.cjs','pet-state.cjs','media-permission.cjs','service-identity.cjs','pet'])copy(path.join(ROOT,'desktop',name),path.join(resources,name));
copy(path.join(ROOT,'web/assets/robot-head-base.png'),path.join(resources,'pet/robot-head-base.png'));
fs.writeFileSync(path.join(resources,'package.json'),JSON.stringify({name:`boujoy-${D.edition}-desktop`,productName:D.productName,version:DESKTOP_VERSION,main:'main.cjs'}));
fs.writeFileSync(path.join(resources,'runtime.json'),JSON.stringify({portable:true,distribution:D,expectedIdentity:BUILD_IDENTITY}));
for(const name of ['src','web','config','node_modules','package.json','package-lock.json','distribution.json','runtime-manifest.json'])copy(path.join(ROOT,name),path.join(resources,'backend',name));
copy(path.join(ROOT,'scripts/phone-ocr.js'),path.join(resources,'backend/scripts/phone-ocr.js'));
copy(path.join(ROOT,'scripts/verify-distribution.mjs'),path.join(resources,'backend/scripts/verify-distribution.mjs'));
copy(path.join(ROOT,'vendor/dsh-superagent'),path.join(resources,'backend/vendor/dsh-superagent'));
copy(path.join(ROOT,'scripts/build-official-superagent.mjs'),path.join(resources,'backend/scripts/build-official-superagent.mjs'));
// Public editions never embed the private optional Bok implementation.
for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md']){copy(path.join(ROOT,name),path.join(output,name));copy(path.join(ROOT,name),path.join(resources,'licenses',name));}
copy(path.join(ROOT,'docs/licenses'),path.join(output,'docs/licenses'));
copy(path.join(ROOT,'docs/licenses'),path.join(resources,'licenses/docs/licenses'));
for(const [source,name] of [[path.join(path.dirname(electron),'LICENSE'),'Electron-LICENSE'],[path.join(path.dirname(electron),'LICENSES.chromium.html'),'Chromium-LICENSES.html'],[path.join(ROOT,'docs/licenses/lucide.txt'),'Lucide-LICENSE']]){copy(source,path.join(output,'Licenses',name));copy(source,path.join(resources,'licenses',name));}
copy(process.execPath,path.join(resources,'runtime/node'));
copy(path.join(path.dirname(process.execPath),'../LICENSE'),path.join(resources,'runtime/Node-LICENSE'));
copy(python,path.join(resources,'runtime/python'));
// Core memory and Python execution need only the standard library.
fs.rmSync(path.join(resources,'runtime/python/lib/python3.12/site-packages'),{recursive:true,force:true});
// The portable product does not install packages; developer setup uses the recipient's own Python/pip.
fs.rmSync(path.join(resources,'runtime/python/lib/python3.12/ensurepip'),{recursive:true,force:true});
for(const name of ['include','share'])fs.rmSync(path.join(resources,'runtime/python',name),{recursive:true,force:true});
// Entry-point scripts of the removed packages (edge-tts, pip-installed tools…) carry the build
// machine's absolute interpreter path and cannot run on another Mac: drop them, keep the interpreter.
{const bin=path.join(resources,'runtime/python/bin');
 for(const name of fs.readdirSync(bin)){const file=path.join(bin,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>1_000_000)continue;
  const head=fs.readFileSync(file).subarray(0,200).toString('latin1');if(head.startsWith('#!')&&!head.startsWith('#!/bin/sh'))fs.rmSync(file);}}
for(const name of ['node_modules','package.json','package-lock.json'])copy(path.join(HARNESS,name),path.join(resources,'harness',name));
// Prune each isolated dependency tree; never modify the developer installation.
for(const tree of ['backend','harness']){
 const r=spawnSync('npm',['prune','--omit=dev','--offline','--ignore-scripts','--no-audit','--no-fund','--cache',path.join(os.tmpdir(),'boujoy-share-npm-cache')],{cwd:path.join(resources,tree),stdio:'inherit'});
 if(r.status!==0)throw Error('Production dependency prune failed: '+tree);
}
// Dependency preparation may use an explicitly supplied, checksum-pinned directory.
// No device registry, release.json or other runtime state is copied.
const phoneuse=process.env.BOUJOY_PHONEUSE_DIR||path.join(DATA,'tools/phoneuse/1.3.0');
for(const [name,expected] of [['phoneuse_client.py','e45c8af8d95db1801c851f75b958155eb209c8fa5d4d163de85012f809608540'],['PhoneUse-1.3.0.apk','a01a28e9d2c3f28f5391214e6b920033efdc5f5a203b681ddd6965e9fcde8f1e']]){
 const src=path.join(phoneuse,name);if(createHash('sha256').update(fs.readFileSync(src)).digest('hex')!==expected)throw Error('Pinned public PhoneUse checksum mismatch: '+name);
 copy(src,name.endsWith('.apk')?path.join(output,'Android',name):path.join(resources,'phoneuse',name));
}
copy(path.join(phoneuse,'LICENSE'),path.join(resources,'phoneuse/LICENSE'));
copy(path.join(phoneuse,'LICENSE'),path.join(output,'Android/PhoneUse-LICENSE'));
// Restore the canonical source manifests after dependency pruning so the runtime
// source digest is the same in the source checkout and in the portable backend.
for(const name of ['package.json','package-lock.json'])copy(path.join(ROOT,name),path.join(resources,'backend',name));
const target=path.join(output,`Android/Boujoy-${D.edition}-Android-${ANDROID_VERSION}.apk`);copy(apk,target);
const androidApk={...sourceReceipt,verified:true,applicationId:D.androidApplicationId,version:ANDROID_VERSION,versionCode:ANDROID_CODE,binaryManifestVerified:true,signatureVerified:true};
for(const name of ['README.md','使用说明.md','交给AI配置.md','版本与验证.md','开始使用.txt','SETUP.md','AI-SETUP.md','TROUBLESHOOTING.md'])copy(path.join(ROOT,'docs/share',name),path.join(output,name));
fs.writeFileSync(path.join(output,'构建信息.json'),JSON.stringify({version:DESKTOP_VERSION,build:DESKTOP_BUILD,edition:D.edition,productName:D.productName,bundleId:D.bundleId,androidVersion:ANDROID_VERSION,androidVersionCode:ANDROID_CODE,androidApk,buildIdentity:BUILD_IDENTITY,sourceDigest:BUILD_IDENTITY.sourceDigest,sourceArchiveHasGitHistory:false},null,2)+'\n');
// Recipient-controlled relay setup sources; never package route tables or .env files.
for(const name of ['.dockerignore','src/remote/protocol.mjs','src/remote/relay.mjs','scripts/run-relay.mjs',...['Caddyfile','Caddyfile.ip','Dockerfile','README.md','compose.yaml','package-lock.json','package.json','start.sh'].map(n=>'deploy/relay/'+n)])copy(path.join(ROOT,name),path.join(output,'配置源码',name));
const plist=path.join(app,'Contents/Info.plist');
for(const [key,value] of Object.entries({CFBundleName:D.productName,CFBundleDisplayName:D.productName,CFBundleIdentifier:D.bundleId,CFBundleShortVersionString:DESKTOP_VERSION,CFBundleVersion:String(DESKTOP_BUILD)}))run('/usr/libexec/PlistBuddy',['-c',`Set :${key} ${value}`,plist]);
const hasMic=spawnSync('/usr/libexec/PlistBuddy',['-c','Print :NSMicrophoneUsageDescription',plist],{stdio:'ignore'}).status===0;
run('/usr/libexec/PlistBuddy',['-c',`${hasMic?'Set':'Add'} :NSMicrophoneUsageDescription ${hasMic?'':'string '}用于你主动发起的语音输入，按当前配置转写为可编辑文字；可能发送至 DeepSeek。`,plist]);
// Portable Python distributions may contain absolute build-machine symlinks.
// Relocate only to an existing sibling; never ship a dangling/external target.
function checkLinks(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isSymbolicLink()){const target=fs.readlinkSync(file);if(path.isAbsolute(target)){const sibling=path.join(dir,path.basename(target));if(!fs.existsSync(sibling))throw Error('Nonportable symlink: '+file);fs.unlinkSync(file);fs.symlinkSync(path.basename(target),file);}if(!fs.existsSync(file)||!fs.realpathSync(file).startsWith(app+path.sep))throw Error('Escaping or broken symlink: '+file);}else if(entry.isDirectory())checkLinks(file);}}
serviceIdentity.assertBuildIdentity(readBuildIdentity(path.join(resources,'backend')),BUILD_IDENTITY);
checkLinks(app);
run('/usr/bin/codesign',['--force','--deep','--sign','-',app]);
run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
const sums=[];
function checksums(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(dir,entry.name);if(entry.isDirectory())checksums(file);else if(entry.isFile()&&!['SHA256SUMS','SHA256.txt'].includes(path.relative(output,file)))sums.push(createHash('sha256').update(fs.readFileSync(file)).digest('hex')+'  '+path.relative(output,file));}}
checksums(output);fs.writeFileSync(path.join(output,'SHA256SUMS'),sums.join('\n')+'\n');fs.writeFileSync(path.join(output,'SHA256.txt'),sums.join('\n')+'\n');
console.log(output);
