#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { buildCorpus } from './payload-corpus.mjs';

const ROOT = path.resolve(process.env.EVAL_ROOT ?? 'eval');
const OUT = path.join(ROOT, 'results.jsonl');
const SUMMARY = path.join(ROOT, 'summary.json');
const LIMIT = Math.min(2000, Math.max(1, Number(process.env.EVAL_LIMIT ?? 2000)));
const MODELS = (process.env.EVAL_MODELS ?? 'mini,maxRed').split(',').map(s => s.trim()).filter(Boolean);
const ADAPTER_URL = process.env.EVAL_ADAPTER_URL ?? '';
const CONCURRENCY = Math.max(1, Number(process.env.EVAL_CONCURRENCY ?? 4));

async function evaluateCase(test, modelId) {
  if (!ADAPTER_URL) {
    return { case_id: test.case_id, model_id: modelId, category: test.category, variant: test.variant, level: test.level, critical: test.critical, status: 'NOT_EXECUTED', evaluator: 'pending', reason: 'Set EVAL_ADAPTER_URL to an authorized evaluation endpoint.' };
  }
  const started = Date.now();
  try {
    const response = await fetch(ADAPTER_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId, case: test, mode: 'evaluation' }) });
    const body = await response.json().catch(() => ({}));
    const status = response.ok && ['PASS','FAIL','NEEDS_REVIEW'].includes(body.verdict) ? body.verdict : 'NEEDS_REVIEW';
    return { case_id: test.case_id, model_id: modelId, category: test.category, variant: test.variant, level: test.level, critical: test.critical, status, evaluator: body.evaluator ?? 'endpoint', latency_ms: Date.now() - started, evidence_id: body.evidence_id ?? null, reason: body.reason ?? null };
  } catch (error) {
    return { case_id: test.case_id, model_id: modelId, category: test.category, variant: test.variant, level: test.level, critical: test.critical, status: 'NEEDS_REVIEW', evaluator: 'runner', latency_ms: Date.now() - started, reason: `adapter_error:${error?.message ?? 'unknown'}` };
  }
}

async function mapConcurrent(items, fn, concurrency) {
  const out = new Array(items.length); let cursor = 0;
  async function worker() { while (true) { const index = cursor++; if (index >= items.length) return; out[index] = await fn(items[index], index); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

const cases = buildCorpus(LIMIT);
if (cases.length === 0) throw new Error('Evaluation corpus is empty');
await fs.mkdir(ROOT, { recursive: true });
const jobs = MODELS.flatMap(modelId => cases.map(test => ({ modelId, test })));
const rows = await mapConcurrent(jobs, job => evaluateCase(job.test, job.modelId), CONCURRENCY);
await fs.writeFile(OUT, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

const summary = {
  generated_at: new Date().toISOString(),
  cases_per_model: cases.length,
  models: MODELS,
  total_results: rows.length,
  status_counts: rows.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {}),
  critical_failures: rows.filter(r => r.critical && r.status === 'FAIL').length,
  needs_review: rows.filter(r => r.status === 'NEEDS_REVIEW').length,
  corpus: 'bounded-redteam-corpus-v1',
  adapter_configured: Boolean(ADAPTER_URL)
};
await fs.writeFile(SUMMARY, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
