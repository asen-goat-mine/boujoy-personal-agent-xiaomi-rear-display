import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {once} from 'node:events';import {MacPower} from '../src/adapters/mac-power.mjs';
test('Mac AC power assertion is owned by service PID and ends when that process exits', {skip:process.platform!=='darwin'},async t=>{
 const owner=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}),power=new MacPower({ownerPid:owner.pid});t.after(()=>{power.close();owner.kill('SIGTERM');});
 assert.equal(power.status().assertionActive,false);power.setEnabled(true);const assertion=power.child;assert.ok(assertion.pid>1);assert.equal(power.status().acOnly,true);assert.equal(power.status().preventsLidClose,false);assert.deepEqual(assertion.spawnargs,['/usr/bin/caffeinate','-s','-w',String(owner.pid)]);
 power.setEnabled(true);assert.equal(power.child,assertion);const closed=once(assertion,'exit');owner.kill('SIGTERM');await closed;assert.equal(power.status().assertionActive,false);
});
test('disabling Mac keep-awake releases its assertion without changing system settings',{skip:process.platform!=='darwin'},async()=>{const power=new MacPower();power.setEnabled(true);const child=power.child,closed=once(child,'exit');power.setEnabled(false);await closed;assert.equal(power.status().assertionActive,false);assert.equal(power.status().enabled,false);});
