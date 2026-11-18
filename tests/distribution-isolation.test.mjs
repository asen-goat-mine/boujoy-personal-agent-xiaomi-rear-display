import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DISTRIBUTION,BUILD_IDENTITY,KEYCHAIN_ACCOUNT,KEYCHAIN_PREFIX,BACKGROUND_SUPPORTED,readDistribution,runtimeSourceManifest,readBuildIdentity} from '../src/distribution.mjs';
import {Secrets} from '../src/adapters/secrets.mjs';
import {RemoteSecrets} from '../src/remote/state.mjs';
import {Store,initialState} from '../src/core/store.mjs';

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-distribution-test-'));
  for(const name of ['src','web','config'])fs.mkdirSync(path.join(root,name));
  fs.writeFileSync(path.join(root,'src/server.mjs'),'export const sample = 1;\n');
  fs.writeFileSync(path.join(root,'distribution.json'),JSON.stringify(DISTRIBUTION));
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:DISTRIBUTION.desktopVersion}));
  fs.writeFileSync(path.join(root,'package-lock.json'),'{}');
  return root;
}

test('public edition has its own application, storage, pairing and credential identities',()=>{
  assert.equal(DISTRIBUTION.androidApplicationId,`dev.boujoy.${DISTRIBUTION.edition}`);
  assert.notEqual(DISTRIBUTION.port,18791);
  assert.notEqual(DISTRIBUTION.dataDirectoryName,'Boujoy Personal Agent');
  assert.notEqual(DISTRIBUTION.bindScheme,'boujoy');
  assert.notEqual(KEYCHAIN_ACCOUNT,'boujoy-personal-agent');
  assert.equal(KEYCHAIN_PREFIX,`dev.boujoy.${DISTRIBUTION.edition}`);
  assert.equal(BACKGROUND_SUPPORTED,DISTRIBUTION.edition==='xiaomi');
  assert.equal(BUILD_IDENTITY.edition,DISTRIBUTION.edition);
  assert.match(BUILD_IDENTITY.sourceDigest,/^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(BUILD_IDENTITY));
});

test('mixed edition metadata and package version are rejected before launch',()=>{
  const root=fixture();
  try{
    const wrong={...DISTRIBUTION,androidApplicationId:'dev.boujoy.personalagent'};
    fs.writeFileSync(path.join(root,'distribution.json'),JSON.stringify(wrong));
    assert.throws(()=>readDistribution(root),/identity mismatch/);
    fs.writeFileSync(path.join(root,'distribution.json'),JSON.stringify(DISTRIBUTION));
    fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'0.0.1'}));
    assert.throws(()=>readDistribution(root),/version disagree/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('runtime digest binds actual shipped bytes and refuses old or tampered source',()=>{
  const root=fixture();
  try{
    const manifest=runtimeSourceManifest(root);
    fs.writeFileSync(path.join(root,'runtime-manifest.json'),JSON.stringify(manifest));
    const running=readBuildIdentity(root);assert.equal(running.sourceDigest,manifest.sourceDigest);
    fs.writeFileSync(path.join(root,'src/server.mjs'),'export const sample = 2;\n');
    assert.throws(()=>readBuildIdentity(root),/does not match/);
    assert.equal(running.sourceDigest,manifest.sourceDigest,'An already running identity must remain the one captured at startup');
    fs.writeFileSync(path.join(root,'runtime-manifest.json'),JSON.stringify(runtimeSourceManifest(root)));
    assert.notEqual(readBuildIdentity(root).sourceDigest,running.sourceDigest);
    fs.symlinkSync(path.join(root,'package.json'),path.join(root,'src/external.json'));
    assert.throws(()=>runtimeSourceManifest(root),/symlink/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('model and remote secrets never look up or write the personal edition Keychain namespace',async()=>{
  const calls=[],exec=async(command,args)=>{calls.push({command,args});return {stdout:'synthetic-test-value'};};
  const secrets=new Secrets({exec});
  const connector='connector-00000000-0000-4000-8000-000000000001';
  await secrets.get(connector);await secrets.set('deepseek','synthetic-test-value');await secrets.remove(connector);
  const remote=new RemoteSecrets({exec});await remote.get('mac-route');await remote.set('android-route','synthetic-test-value');
  assert.equal(calls.length,5);
  for(const {command,args} of calls){
    assert.equal(command,'/usr/bin/security');assert.equal(args[args.indexOf('-a')+1],KEYCHAIN_ACCOUNT);
    assert.ok(args[args.indexOf('-s')+1].startsWith(KEYCHAIN_PREFIX+'.'));
    assert.ok(!args.includes('boujoy-personal-agent'));
  }
});

test('Phone Use edition cannot restore background execution and starts with no selected device',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-edition-state-'));let store;
  try{
    const state=initialState();assert.equal(state.settings.phoneEnabled,false);assert.equal(state.settings.phoneUseDeviceId,null);
    assert.equal(state.settings.phoneExecutionMode,'main');
    state.settings.phoneExecutionMode='background';fs.writeFileSync(path.join(root,'state.json'),JSON.stringify(state));
    store=new Store(root);assert.equal(store.data.settings.phoneExecutionMode,BACKGROUND_SUPPORTED?'background':'main');
  }finally{store?.close();fs.rmSync(root,{recursive:true,force:true});}
});
