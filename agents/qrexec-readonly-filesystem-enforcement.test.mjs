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

test('qualifies only when files, writable descriptors, and parent-directory writes are denied', async () => {
  const report = await qualifyReadonlyFilesystemEnforcement({
    missionStorePath: '/state/missions.json',
    requestJournalPath: '/state/requests.json',
    fsOps: fakeFs()
  });
  assert.equal(report.readiness, 'LAB READY');
  assert.equal(report.enforcementVerified, true);
  assert.equal(report.missionStore.fileWriteDenied, true);
  assert.equal(report.requestJournal.parentDirectoryWriteDenied, true);
});

test('fails closed when the service identity can write a durable-state file', async () => {
  await assert.rejects(() => qualifyReadonlyFilesystemEnforcement({
    missionStorePath: '/state/missions.json',
    requestJournalPath: '/state/requests.json',
    fsOps: fakeFs({ writableFile: true })
  }), /MissionStore is writable/);
});

test('fails closed when a writable descriptor can be acquired', async () => {
  await assert.rejects(() => qualifyReadonlyFilesystemEnforcement({
    missionStorePath: '/state/missions.json',
    requestJournalPath: '/state/requests.json',
    fsOps: fakeFs({ writableDescriptor: true })
  }), /writable descriptor is writable/);
});

test('fails closed when the parent directory permits atomic replacement', async () => {
  await assert.rejects(() => qualifyReadonlyFilesystemEnforcement({
    missionStorePath: '/state/missions.json',
    requestJournalPath: '/state/requests.json',
    fsOps: fakeFs({ writableDirectory: true })
  }), /parent directory is writable/);
});

test('fails closed on symlinked durable state', async () => {
  await assert.rejects(() => qualifyReadonlyFilesystemEnforcement({
    missionStorePath: '/state/missions.json',
    requestJournalPath: '/state/requests.json',
    fsOps: fakeFs({ symlink: true })
  }), /must not be a symlink/);
});
