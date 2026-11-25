import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { assessBuildEvidence, buildUnitName } from '../scripts/updater/systemd-evidence.mjs';

const intent={root:resolve('fixture-deployment'),taskId:'00000000-1111-4222-8333-444444444444',bootId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',invocationId:'a'.repeat(32)};
const unit=buildUnitName(intent.root,intent.taskId);
const valid={unit,bootId:intent.bootId,invocationId:intent.invocationId,cgroupPath:`/system.slice/${unit}`,activeState:'inactive',cgroupState:'destroyed',result:'success',mainCode:1,mainStatus:0};

test('unit name is deterministic and rejects arbitrary unit strings',()=>{assert.match(unit,/^stardust-build-[a-f0-9]{16}-[a-f0-9-]{36}\.service$/);assert.throws(()=>buildUnitName(intent.root,'sshd.service'));assert.notEqual(unit,buildUnitName(resolve('different-deployment'),intent.taskId));});
test('success requires matching boot, invocation, complete service result and empty cgroup',()=>{assert.equal(assessBuildEvidence(intent,valid).status,'succeeded');for(const changed of [{bootId:'b'.repeat(36)},{invocationId:'b'.repeat(32)},{unit:'sshd.service'},{cgroupPath:'/system.slice/sshd.service'},{cgroupState:'unknown'},{activeState:'unknown'},{result:''}])assert.equal(assessBuildEvidence(intent,{...valid,...changed}).status,'uncertain');});
test('systemd timeout remains failure when the worker main process returned zero',()=>{const verdict=assessBuildEvidence(intent,{...valid,activeState:'failed',result:'timeout',mainCode:1,mainStatus:0});assert.deepEqual(verdict,{status:'failed',reason:'UNIT_RESULT_FAILED'});});
test('populated cgroup blocks success even after worker has exited',()=>{assert.equal(assessBuildEvidence(intent,{...valid,cgroupState:'populated'}).status,'running');assert.equal(assessBuildEvidence(intent,{...valid,activeState:'active'}).status,'running');});
test('garbage-collected unit or missing persisted invocation never counts as success',()=>{assert.equal(assessBuildEvidence(intent,{...valid,invocationId:''}).status,'uncertain');assert.equal(assessBuildEvidence({...intent,invocationId:null},valid).status,'uncertain');assert.equal(assessBuildEvidence(intent,undefined).status,'uncertain');});
test('retained service is complete only after it reaches exited and the cgroup is empty',()=>{assert.equal(assessBuildEvidence(intent,{...valid,activeState:'active',subState:'exited'}).status,'succeeded');assert.equal(assessBuildEvidence(intent,{...valid,activeState:'active',subState:'exited',cgroupState:'populated'}).status,'running');assert.equal(assessBuildEvidence(intent,{...valid,activeState:'active',subState:'running'}).status,'running');});
