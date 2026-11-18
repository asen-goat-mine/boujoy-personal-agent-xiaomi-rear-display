import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function readDistribution(root){
  const value=JSON.parse(fs.readFileSync(path.join(root,'distribution.json'),'utf8'));
  if(value.schemaVersion!==1||!['phoneuse','xiaomi'].includes(value.edition))throw Error('Unsupported distribution edition');
  const edition=value.edition,phoneuse=edition==='phoneuse';
  const expected={androidApplicationId:`dev.boujoy.${edition}`,androidNamespace:'dev.boujoy.personalagent',
    bundleId:`dev.boujoy.${edition}.desktop`,bindScheme:`boujoy-${edition}`,
    dataDirectoryName:phoneuse?'Boujoy Phone Use':'Boujoy Xiaomi',
    memoryDirectoryName:phoneuse?'Boujoy-PhoneUse-Memory':'Boujoy-Xiaomi-Memory',
    keychainAccount:`boujoy-${edition}`,keychainServicePrefix:`dev.boujoy.${edition}`,
    launchdLabel:`dev.boujoy.${edition}.service`,port:phoneuse?18891:18892,supportsBackground:!phoneuse};
  for(const [name,wanted] of Object.entries(expected))if(value[name]!==wanted)throw Error(`Distribution identity mismatch: ${name}`);
  for(const name of ['desktopVersion','androidVersion'])if(!/^\d+\.\d+\.\d+$/.test(value[name]))throw Error(`Invalid distribution ${name}`);
  for(const name of ['desktopBuild','androidVersionCode'])if(!Number.isSafeInteger(value[name])||value[name]<1)throw Error(`Invalid distribution ${name}`);
  const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
  if(version!==value.desktopVersion)throw Error('Package and distribution version disagree');
  return Object.freeze(value);
}

/** Exact shipped runtime source, excluding dependencies, tests and recipient state. */
export function runtimeSourceManifest(root){
  const files={};
  function add(name){
    const file=path.join(root,name),stat=fs.lstatSync(file);
    if(stat.isSymbolicLink())throw Error(`Runtime source may not be a symlink: ${name}`);
    if(stat.isDirectory()){
      for(const child of fs.readdirSync(file).sort())if(child!=='.DS_Store')add(`${name}/${child}`);
    }else if(stat.isFile())files[name]=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    else throw Error(`Unsupported runtime source: ${name}`);
  }
  for(const name of ['src','web','config','distribution.json','package.json','package-lock.json'])add(name);
  const ordered=Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b,'en')));
  const sourceDigest=createHash('sha256').update(Object.entries(ordered).map(([name,hash])=>`${name}\0${hash}\n`).join('')).digest('hex');
  return {schemaVersion:1,sourceDigest,files:ordered};
}
export function readBuildIdentity(root,distribution=readDistribution(root)){
  const actual=runtimeSourceManifest(root),file=path.join(root,'runtime-manifest.json');
  if(fs.existsSync(file)){
    const expected=JSON.parse(fs.readFileSync(file,'utf8'));
    if(expected.schemaVersion!==1||expected.sourceDigest!==actual.sourceDigest||JSON.stringify(expected.files)!==JSON.stringify(actual.files))throw Error('Runtime source does not match the release manifest');
  }
  return Object.freeze({edition:distribution.edition,version:distribution.desktopVersion,
    sourceDigest:actual.sourceDigest,androidApplicationId:distribution.androidApplicationId,
    androidVersion:distribution.androidVersion,androidVersionCode:distribution.androidVersionCode});
}

export const DISTRIBUTION=readDistribution(ROOT);
export const ANDROID_PACKAGE=DISTRIBUTION.androidApplicationId;
export const BIND_SCHEME=DISTRIBUTION.bindScheme;
export const BACKGROUND_SUPPORTED=DISTRIBUTION.supportsBackground;
export const KEYCHAIN_ACCOUNT=DISTRIBUTION.keychainAccount;
export const KEYCHAIN_PREFIX=DISTRIBUTION.keychainServicePrefix;
export const SERVICE_LABEL=DISTRIBUTION.launchdLabel;
// Capture once at process startup: an old process cannot claim subsequently replaced code.
export const BUILD_IDENTITY=readBuildIdentity(ROOT,DISTRIBUTION);
