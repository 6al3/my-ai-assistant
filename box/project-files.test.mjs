import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import test from "node:test";

async function loadModule(root) {
  process.env.PROJECT_ROOT = root;
  return import(`./project-files.mjs?test=${Date.now()}-${Math.random()}`);
}

test('reads, updates and creates regular files inside root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dig-files-'));
  try {
    await fs.writeFile(path.join(root, 'a.txt'), 'one');
    const mod = await loadModule(root);
    assert.equal((await mod.readProjectFile('a.txt')).content, 'one');
    await mod.writeProjectFile('a.txt', 'two');
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'two');
    await mod.createProjectFile('sub/b.txt', 'three');
    assert.equal(await fs.readFile(path.join(root, 'sub/b.txt'), 'utf8'), 'three');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects symlink escape for files and directories', async (t) => {
  if (process.platform === 'win32') t.skip('symlink permissions vary on Windows runners');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dig-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dig-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    await fs.symlink(outside, path.join(root, 'linked-dir'));
    const mod = await loadModule(root);
    await assert.rejects(() => mod.readProjectFile('link.txt'), /Symbolic links|escapes/);
    await assert.rejects(() => mod.writeProjectFile('link.txt', 'x'), /Symbolic links|escapes/);
    await assert.rejects(() => mod.listProjectFiles('linked-dir'), /Symbolic links|escapes/);
    await assert.rejects(() => mod.createProjectFile('linked-dir/new.txt', 'x'), /Symbolic links|escapes/);
    assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('does not expose symlink entries in listings', async (t) => {
  if (process.platform === 'win32') t.skip('symlink permissions vary on Windows runners');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dig-list-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dig-list-out-'));
  try {
    await fs.writeFile(path.join(root, 'safe.txt'), 'safe');
    await fs.symlink(outside, path.join(root, 'hidden-link'));
    const mod = await loadModule(root);
    const items = await mod.listProjectFiles('.');
    assert.deepEqual(items.map(x => x.name), ['safe.txt']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('enforces size, update and delete safety rules', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dig-rules-'));
  try {
    const mod = await loadModule(root);
    await assert.rejects(() => mod.writeProjectFile('missing.txt', 'x'));
    await assert.rejects(() => mod.createProjectFile('huge.txt', 'x'.repeat(2 * 1024 * 1024 + 1)), /too large/i);
    await assert.rejects(() => mod.deleteProjectFile('.'), /root cannot be deleted/i);
    await fs.mkdir(path.join(root, 'dir'));
    await assert.rejects(() => mod.deleteProjectFile('dir'), /Recursive directory deletion is disabled/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
