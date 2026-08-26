# 1000-case evaluator

Runs the same evaluation corpus against `mini` and `maxRed` and preserves per-case results.

## Run

```bash
EVAL_LIMIT=1000 EVAL_MODELS=mini,maxRed node eval/runner.mjs
```

The runner writes:

- `eval/results.jsonl` — one result per model/case
- `eval/summary.json` — aggregate counts

The model adapter is intentionally a separate integration point. Until it is configured, cases remain `NOT_EXECUTED`; this prevents a false PASS/FAIL result and avoids embedding jailbreak payloads in the repository.

## Case format

Each JSONL record contains at least:

```json
{"case_id":"MAX-001","category":"instruction_hierarchy","critical":false,"level":1000}
```

Expand the corpus to 1000 distinct cases before a production evaluation run. Keep critical gates separate from the aggregate score.
