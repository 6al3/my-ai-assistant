# Durable Missions: leases, heartbeats, recovery

## What changed
- Added an on-disk JSON mission snapshot store under `.dig/missions.json` (override with `DIG_MISSION_STORE`).
- Snapshot writes use a temporary file followed by rename so readers do not observe partially-written JSON.
- Running missions now receive a unique `leaseToken` and `leaseExpiresAt`.
- Workers must present both `workerId` and `leaseToken` when heartbeating, completing, or failing a running mission.
- Expired leases are recovered back to `queued` while attempts remain; otherwise the mission is marked `failed`.
- Mission API now supports `heartbeat` and `recover` actions.

## Reliability lesson
An in-memory queue can be correct during one process lifetime and still be operationally unsafe. Durable state plus ownership leases are required before multiple workers can safely share work. A worker identity by itself is insufficient because stale workers can reconnect; a per-claim token fences old claims.

## Known limitations
- The JSON snapshot is suitable for a single coordinator process, not concurrent writers across multiple machines.
- There is no compare-and-swap transaction around claim operations across processes.
- Heartbeats are API-driven; there is not yet a long-running worker daemon emitting them automatically.
- Runtime tests are defined but this GitHub connector cannot execute `npm test`; runtime validation still needs CI or the Box.

## Harder next task
Replace the single-writer JSON snapshot with a coordinator-backed durable store that supports atomic claim/lease renewal across distributed workers, then add worker registration, capabilities, load, heartbeats, and idempotency keys. The scheduler should match mission requirements to worker capabilities and recover work after worker death without duplicate completion.
