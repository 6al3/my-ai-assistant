import assert from 'node:assert/strict';
import { constants as FS_CONSTANTS } from 'node:fs';
import test from 'node:test';
import { qualifyReadonlyFilesystemEnforcement } from './qrexec-readonly-filesystem-enforcement.mjs';

function permissionError(code = 'EACCES') {
  const error = new Error(code);
  error.code = code;
  return error;
}

function regularStat() {
  return { isSymbolicLink: () => false, isFile: () => true };
}

function fakeFs({ writableFile = false, writableDirectory = false, writableDescriptor = false, symlink = false } = {}) {
  return {
    async lstat() {
      return symlink
        ? { isSymbolicLink: () => true, isFile: () => false }
        : regularStat();
    },
    async access(target, mode) {
      const isParent = target === '/state';
      if (mode === FS_CONSTANTS.W_OK) {
        if ((isParent && writableDirectory) || (!isParent && writableFile)) return;
        throw permissionError();
      }
      return undefined;
    },
    async open() {
      if (!writableDescriptor) throw permissionError('EROFS');
      return { async close() {} };
    }
  };
}

function identity(euid = 1001, egid = 1001) {
  return { geteuid: () => euid, getegid: () => egid };
}

function qualify(options = {}) {
  return qualifyReadonlyFilesystemEnforcement({
    missionStorePath: '/state/missions.json',
    requestJournalPath: '/state/requests.json',
    expectedServiceUid: 1001,
    fsOps: fakeFs(),
    identityOps: identity(),
    ...options
  });
}

test('qualifies only when execution identity is bound and all durable-state writes are denied', async () => {
  const report = await qualify();
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.readiness, 'LAB READY');
  assert.equal(report.enforcementVerified, true);
  assert.equal(report.executionIdentity.identityBindingVerified, true);
  assert.equal(report.executionIdentity.nonRootVerified, true);
  assert.equal(report.executionIdentity.observedEuid, 1001);
  assert.equal(report.missionStore.fileWriteDenied, true);
  assert.equal(report.requestJournal.parentDirectoryWriteDenied, true);
});

test('fails closed when qualification runs as root', async () => {
  await assert.rejects(() => qualify({ identityOps: identity(0, 0) }), /must not run as root/);
});

test('fails closed when the observed service uid does not match deployment binding', async () => {
  await assert.rejects(() => qualify({ identityOps: identity(1002, 1001) }), /euid mismatch/);
});

test('fails closed when the service identity can write a durable-state file', async () => {
  await assert.rejects(() => qualify({ fsOps: fakeFs({ writableFile: true }) }), /MissionStore is writable/);
});

test('fails closed when a writable descriptor can be acquired', async () => {
  await assert.rejects(() => qualify({ fsOps: fakeFs({ writableDescriptor: true }) }), /writable descriptor is writable/);
});

test('fails closed when the parent directory permits atomic replacement', async () => {
  await assert.rejects(() => qualify({ fsOps: fakeFs({ writableDirectory: true }) }), /parent directory is writable/);
});

test('fails closed on symlinked durable state', async () => {
  await assert.rejects(() => qualify({ fsOps: fakeFs({ symlink: true }) }), /must not be a symlink/);
});
