import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const FIXED_INPUTS=['android/app/build.gradle','android/build.gradle','android/settings.gradle','android/gradle.properties','distribution.json'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const ordered=inputs=>Object.fromEntries(Object.entries(inputs).sort(([a],[b])=>Buffer.compare(Buffer.from(a),Buffer.from(b))));
// Match Python json.dumps(inputs, sort_keys=True, separators=(',', ':'), ensure_ascii=True).
export const canonicalAndroidInputs=inputs=>JSON.stringify(ordered(inputs)).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
export const androidInputsDigest=inputs=>hash(canonicalAndroidInputs(inputs));
export function collectAndroidSourceInputs(root){
 root=path.resolve(root);const inputs={};
 function checked(name){
  let current=root;for(const part of name.split('/')){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw Error('Android source input may not use a symlink: '+name);}
  return current;
 }
 function walk(name){const file=checked(name),stat=fs.lstatSync(file);if(stat.isDirectory()){for(const entry of fs.readdirSync(file))walk(name+'/'+entry);}else if(stat.isFile())inputs[name]=hash(fs.readFileSync(file));else throw Error('Android source input is not a regular file: '+name);}
 walk('android/app/src');for(const name of FIXED_INPUTS){const file=checked(name);if(!fs.lstatSync(file).isFile())throw Error('Android build input is not a regular file: '+name);inputs[name]=hash(fs.readFileSync(file));}
 return ordered(inputs);
}
export function verifyAndroidSourceReceipt({root,apkPath,distribution}){
 const reportFile=path.join(path.dirname(apkPath),'boujoy-build-report.json');
 if(!fs.existsSync(reportFile))throw Error('A release APK requires its adjacent boujoy-build-report.json source receipt');
 const report=JSON.parse(fs.readFileSync(reportFile,'utf8'));
 for(const [key,wanted] of Object.entries({edition:distribution.edition,applicationId:distribution.androidApplicationId,version:distribution.androidVersion,versionCode:distribution.androidVersionCode}))if(report[key]!==wanted)throw Error('APK source receipt identity mismatch: '+key);
 const apkSha256=hash(fs.readFileSync(apkPath));if(report.sha256!==apkSha256)throw Error('APK bytes do not match the source build receipt');
 const recorded=report.androidSourceInputs;
 if(!recorded||Array.isArray(recorded)||typeof recorded!=='object'||!Object.values(recorded).every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))throw Error('Invalid Android source inputs in build receipt');
 if(!/^[a-f0-9]{64}$/.test(report.androidSourceDigest||'')||androidInputsDigest(recorded)!==report.androidSourceDigest)throw Error('Android source receipt digest is invalid');
 const actual=collectAndroidSourceInputs(root),names=Object.keys(actual),recordedNames=Object.keys(recorded);
 if(names.length!==recordedNames.length||names.some(name=>actual[name]!==recorded[name])||androidInputsDigest(actual)!==report.androidSourceDigest)throw Error('Android source inputs changed since this APK was built; rebuild before packaging');
 return {sha256:apkSha256,androidSourceDigest:report.androidSourceDigest,androidSourceInputCount:names.length,sourceInputsVerified:true};
}
