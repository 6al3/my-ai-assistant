import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReadonlyServiceIdentityContract, verifyReadonlyServiceIdentityContract } from './qrexec-readonly-service-identity-contract.mjs';

const base = {
  service: 'dig.ReadonlyProbe', coordinatorQube: 'dig-coordinator', serviceUser: 'dig-qrexec-ro',
  serviceUid: 991, configuredServiceUid: 991, gitSha: 'A'.repeat(40)
};

test('binds deployment identity to dedicated non-root uid and exact deployment', () => {
  const contract = buildReadonlyServiceIdentityContract(base);
  assert.equal(contract.expectedServiceUid, 991);
  assert.equal(contract.gitSha, 'a'.repeat(40));
  assert.equal(verifyReadonlyServiceIdentityContract(contract, {
    expectedService: base.service, expectedCoordinatorQube: base.coordinatorQube,
    expectedServiceUid: 991, expectedGitSha: base.gitSha
  }), true);
});

test('rejects root or mismatched configured uid', () => {
  assert.throws(() => buildReadonlyServiceIdentityContract({...base, serviceUid: 0}), /positive non-root uid/);
  assert.throws(() => buildReadonlyServiceIdentityContract({...base, configuredServiceUid: 992}), /uid mismatch/);
});

test('rejects deployment drift during verification', () => {
  const contract = buildReadonlyServiceIdentityContract(base);
  assert.throws(() => verifyReadonlyServiceIdentityContract(contract, {
    expectedService: base.service, expectedCoordinatorQube: 'other', expectedServiceUid: 991, expectedGitSha: base.gitSha
  }), /coordinator identity mismatch/);
  assert.throws(() => verifyReadonlyServiceIdentityContract(contract, {
    expectedService: base.service, expectedCoordinatorQube: base.coordinatorQube, expectedServiceUid: 991, expectedGitSha: 'b'.repeat(40)
  }), /git sha mismatch/);
});
