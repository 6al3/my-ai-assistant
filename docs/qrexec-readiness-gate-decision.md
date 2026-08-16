# Qrexec readiness gate decision

## Problem
A single successful read-only qrexec probe can be a transient success. Before allowing any synthetic mission mutation across a real Qubes VM boundary, DIG needs a deterministic gate that proves transport/auth stability, pending-request recovery, zero mutations, and acceptable latency over repeated samples.

## Independent approaches compared

| Approach | Correctness | Robustness | Latency | Resource use | Regression risk | QA value |
|---|---|---|---|---|---|---|
| One read-only probe then mutate | Medium | Low | Best | Best | Medium | Low |
| Repeated read-only probe gate with explicit invariants | High | High | Low overhead | Low | Low | High |
| Jump directly to synthetic claim/reclaim faults | High eventual coverage | Medium before transport is proven | Higher | Higher | Highest | High but noisy |

## Selected approach
**Repeated read-only probe gate with explicit invariants**.

It wins because it separates transport/auth/recovery readiness from mission mutation semantics. It requires at least three samples, keeps `mutationPerformed=false`, requires zero unresolved recoveries, requires every probe to report `transport-auth-ready`, and checks p95 probe/recovery latency budgets. This creates a hard fail-closed gate before the next phase can perform synthetic claim/reclaim testing.

## Failure/lessons retained
- A single green probe is not evidence of stable VM-boundary behavior.
- Transport/auth failures and mission-state failures should not be mixed in the same first acceptance step; doing so makes regressions harder to localize.
- Readiness must be machine-evaluable rather than inferred from logs.
- Latency belongs in the gate because a functionally correct but repeatedly stalled qrexec path is not worker-ready.

## Next gate
Run the repeated read-only gate inside a real worker Qube against the real coordinator Qube. Only after `READ_ONLY_GATE_PASS` should DIG run synthetic claim → lost session → restart → lease reclaim → recovery scenarios. No real financial transactions or external exploitation are in scope.
