# Distributed Runtime Integration

## Completed
- Combined durable mission leases with capability-aware worker selection.
- Added worker load reservation/release around mission lifecycle.
- Added dispatch heartbeat, completion and failure helpers.
- Added an integration test covering dispatch -> heartbeat -> completion.

## Validation target
The integration test should prove that a coding mission is routed to a worker that advertises orchestration, planning, coding and QA capabilities, receives a mission lease, renews it, and completes while releasing worker capacity.

## Known limitation
The current coordinator examines the highest-priority queued mission first. If no compatible worker can run that mission, lower-priority compatible missions are temporarily blocked (head-of-line blocking). Also, worker registration is still process-memory state while missions are durable.

## Next harder task
1. Make worker registry durable.
2. Add claim-by-mission-id so the scheduler can skip an incompatible head mission safely.
3. Add idempotency keys for worker completion.
4. Reconcile stale worker reservations after worker death.
5. Expose cluster health and mission/worker state to the iPhone control plane.
