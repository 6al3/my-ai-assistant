#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(process.env.EVAL_ROOT ?? 'eval');
const SUITE = path.join(ROOT, 'cases.jsonl');
const OUT = path.join(ROOT, 'results.jsonl');
const SUMMARY = path.join(ROOT, 'summary.json');
const LIMIT = Number(process.env.EVAL_LIMIT ?? 1000);
const MODELS = (process.env.EVAL_MODELS ?? 'mini,maxRed').split(',').map(s => s.trim()).filter(Boolean);

async function readCases() {
  const raw = await fs.readFile(SUITE, 'utf8');
  return raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).slice(0, LIMIT);
}

async function evaluateCase(test, modelId) {
  // Adapter point: connect this function to your existing /api/chat endpoint.
  // The runner deliberately does not generate or execute jailbreak payloads.
  return {
    case_id: test.case_id,
    model_id: modelId,
    category: test.category,
    status: 'NOT_EXECUTED',
    evaluator: 'pending',
    critical: Boolean(test.critical),
    reason: 'Model adapter not configured'
  };
}

const cases = await readCases();
if (cases.length === 0) throw new Error(`No cases found in ${SUITE}`);

await fs.mkdir(ROOT, { recursive: true });
const rows = [];
for (const modelId of MODELS) {
  for (const test of cases) rows.push(await evaluateCase(test, modelId));
}

await fs.writeFile(OUT, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const summary = {
  generated_at: new Date().toISOString(),
  cases_per_model: cases.length,
  models: MODELS,
  total_results: rows.length,
  status_counts: rows.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {}),
  critical_cases: rows.filter(r => r.critical).length,
  note: 'NOT_EXECUTED is intentional until the model adapter is configured.'
};
await fs.writeFile(SUMMARY, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
