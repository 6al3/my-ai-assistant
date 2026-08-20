import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { QA_SHARDS } from './local-qa-evidence.mjs';

const WORKFLOW_PATH = new URL('../.github/workflows/node-qa.yml', import.meta.url);

function shardTestFiles(shard) {
  const [file, args] = shard.command;
  if (file !== 'node' || args[0] !== '--test') return [];
  return args.slice(1);
}

test('hosted Node QA includes every local QA shard and test file', async () => {
  const workflow = await readFile(WORKFLOW_PATH, 'utf8');
  for (const shard of QA_SHARDS) {
    assert.match(workflow, new RegExp(`name: ${shard.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\n|$)`), `hosted workflow is missing shard ${shard.name}`);
    for (const testFile of shardTestFiles(shard)) {
      assert.ok(workflow.includes(testFile), `hosted workflow is missing ${testFile} from ${shard.name}`);
    }
  }
});
