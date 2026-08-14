# Reliability v2 cycle

## Completed
- Added a durable worker snapshot store (`workers/worker-store.mjs`) using atomic temp-file replace and mode 0600.
- Reload worker registry state at process startup and persist registrations, heartbeats, load changes, stale/offline transitions and test resets.
- Added `claimMissionById` so dispatch can claim the exact mission selected by the scheduler.
- Removed head-of-line blocking in the distributed coordinator: incompatible high-priority missions are skipped while preserving their queued state, allowing lower-priority compatible missions to run.
- Expanded the distributed runtime test to isolate stores in a temporary directory, verify worker persistence, verify skip behavior, heartbeat a lease and complete the selected mission.
- Expanded `npm run check` / `npm test` coverage to the worker store, registry, scheduler, coordinator and distributed reliability test.

## Validation
- GitHub accepted all modified modules and test files on branch `dig-reliability-v2`.
- Combined commit status for `5732af271b64d3cd9707998e0229d4111760f300` reports Vercel failures whose target explicitly says `build-rate-limit`; this is an external deployment quota failure, not evidence of a syntax or test failure.
- No GitHub-hosted test workflow is currently available in the repository, so execution of `npm test` is not independently confirmed by CI in this cycle.

## Failure / lesson
- Deployment status alone is insufficient as a validation signal when the provider is rate-limited. Add a repository-native CI workflow so syntax and tests run independently of deployment quotas.
- Durable worker load can still become stale after a hard worker death. Persisting the registry solves restart loss, but active-job reconciliation is still required.

## Next harder task
Build reservation reconciliation + idempotent completion: derive expected worker load from running mission leases, repair stale reservations after worker death/restart, reject duplicate completion side effects with idempotency keys, and expose a compact cluster-health endpoint consumable by the iPhone control plane.
