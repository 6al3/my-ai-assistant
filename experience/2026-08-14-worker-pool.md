# Worker Pool Cycle — 2026-08-14

## Completed
- Added worker registration with capabilities, concurrency limits and metadata.
- Added worker heartbeats and stale-worker detection.
- Added capability-aware scheduling that prefers full capability matches and lower normalized load.
- Added worker reservation/release accounting.
- Added `/api/workers` for registration, heartbeat, reaping and status/ranking queries.
- Added scheduler lifecycle tests and package-level syntax/test wiring.

## Validation scope
The repository now contains deterministic unit-level checks for capability routing and load accounting. Runtime execution still needs to be run on the DIG box or CI because the GitHub connector does not execute Node processes.

## Failure / lesson
A sequential package update initially failed with HTTP 409 because the wrong blob SHA was supplied. Re-fetching the target file and using its exact current SHA fixed the update. Lesson: every sequential GitHub contents write must use the branch-specific current blob SHA.

## Current limitation
The worker registry is process-local memory. It is suitable for scheduler logic validation but not yet durable across coordinator restarts and not safe for multiple coordinators.

## Next harder task
Unify the durable mission queue and worker pool behind one coordinator:
1. Durable worker registry with persisted heartbeats.
2. Atomic capability-aware mission claim.
3. Mission lease bound to worker registration generation.
4. Idempotency keys for completion/results.
5. Dead-worker recovery and reassignment without duplicate completion.
6. Per-worker metrics: success rate, latency, retries, load and health.
