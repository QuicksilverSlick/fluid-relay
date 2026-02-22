# Comprehensive Architecture Review

Date: 2026-02-22
Scope: Repository-wide architecture review (boundaries, runtime flow, resilience, security, operability, and testability)

## Findings (Ordered by Severity)

### High

1. Single long-lived token reused across API and WebSocket auth
- Impact: Token leakage grants broad control until process restart.
- Evidence: `src/bin/beamcode.ts:322`, `src/http/server.ts:13`
- Detail: A single `consumerToken` is injected into HTML and reused for `/api/*` plus WebSocket `?token` auth.
- Recommendation: Split token scopes (API vs WS), add rotation/revocation, and enforce short lifetime.

2. Process-local session state limits resilience and horizontal scaling
- Impact: Restart/failover can drop in-flight session metadata and pending control state.
- Evidence: `src/core/session/session-repository.ts:120`, `src/core/session-coordinator.ts:108`
- Detail: Session state is held in-process (`Map`) with local snapshoting, with no cluster-safe coordination.
- Recommendation: Introduce shared session backing (e.g., Redis/DB) or explicitly document single-node constraints.

### Medium

1. HTTP rename path bypasses domain/policy command flow
- Impact: Audit/RBAC/policy hooks can miss state mutations.
- Evidence: `src/http/api-sessions.ts:158`
- Detail: Rename mutates registry and broadcasts directly rather than going through coordinator/domain pipeline.
- Recommendation: Route through coordinator/bridge commands so all mutations emit uniform domain events.

2. Lifecycle transition invariants are not enforced
- Impact: Runtime can enter invalid states, causing misleading lifecycle-driven behavior.
- Evidence: `src/core/session/session-runtime.ts:336`, `src/core/session/session-lifecycle.ts:17`
- Detail: Invalid transitions are logged but still applied.
- Recommendation: Reject invalid transitions (no mutation) and optionally emit explicit error events.

3. Queued message state is not durably persisted
- Impact: Queued work can disappear after restart/crash.
- Evidence: `src/core/session/message-queue-handler.ts:80`, `src/core/session/session-runtime.ts:150`
- Detail: Queue slot updates stay in memory without corresponding persistence.
- Recommendation: Persist queue-slot state on change and restore it during startup.

4. Root redirect can point to stale/deleted session
- Impact: `/` may redirect users to dead session IDs.
- Evidence: `src/bin/beamcode.ts:393`, `src/http/server.ts:60`
- Detail: `activeSessionId` is set during startup and not consistently updated during session churn.
- Recommendation: Sync active session ID on create/delete/close events from coordinator.

5. Entrypoint behavior has limited default test coverage
- Impact: CLI flag/shutdown/bootstrap regressions can ship unnoticed.
- Evidence: `vitest.config.ts:5`, `src/bin/beamcode.ts:57`
- Detail: Default test configuration excludes `src/bin/**`.
- Recommendation: Add targeted unit tests for arg parsing, lifecycle wiring, and shutdown ordering.

6. Default observability is weak without optional flags
- Impact: Degraded visibility into session health and failure trends.
- Evidence: `src/bin/beamcode.ts:300`, `src/adapters/console-metrics-collector.ts:60`, `src/http/health.ts:4`
- Detail: Console metrics are mostly debug-level and minimal by default.
- Recommendation: Promote critical signals to default output and expose key counters in health/metrics.

### Low

1. Tunnel restart/failure signals are not strongly surfaced
- Impact: Public connectivity degradation may go unnoticed.
- Evidence: `src/relay/cloudflared-manager.ts:183`
- Detail: Restart logic exists, but health/metrics surfacing is limited.
- Recommendation: Emit explicit tunnel health metrics/events and include them in health checks.

2. Message tracing summary is global, not session-scoped
- Impact: Harder to diagnose per-session issues in multi-session runs.
- Evidence: `src/core/messaging/message-tracer.ts:353`
- Detail: Summary aggregates process-wide sets rather than per-session views.
- Recommendation: Track summary by session ID and surface session-tagged diagnostics.

3. Consumer-plane composition is tightly coupled to runtime internals
- Impact: Higher refactor cost and weaker transport/domain separation.
- Evidence: `src/core/session-bridge/compose-consumer-plane.ts:56`
- Detail: Consumer composition reaches deeply into runtime state and helpers.
- Recommendation: Narrow interfaces so transport interacts via explicit domain/service contracts.

## Strengths

- The bounded-context architecture is clear and mostly reflected in implementation (`docs/architecture.md:51`).
- `SessionCoordinator` and `SessionBridge` centralize lifecycle flow and context composition (`src/core/session-coordinator.ts:108`, `src/core/session-bridge.ts:24`).
- Runtime ownership is concentrated in session runtime/repository abstractions, which provides a solid foundation for future hardening (`src/core/session/session-runtime.ts:1`, `src/core/session/session-repository.ts:1`).

## Open Questions

1. Is single-node operation an intentional product constraint, or should active-active/multi-instance support be a target?
2. Is shared API/WS token behavior acceptable only for local trust mode, or intended for tunneled/remote usage?
3. Should queued message durability be a guaranteed contract across restarts?

## Recommended Next Steps

1. Implement token scope separation and rotation/revocation.
2. Enforce lifecycle transition validity in runtime state machine.
3. Persist queued-message state and restore on startup.
4. Sync root redirect target with live session lifecycle events.
5. Expand test coverage for CLI entrypoint and flag interactions.
6. Improve default observability and health surfacing for critical failures.

## Remediation Plan: Process-Local Session State

### Phase 1 (implemented in this branch)

1. Explicitly codify single-node constraints in runtime and docs.
2. Expose deployment topology in `/health` so operators and automation can detect unsupported horizontal scaling.
3. Emit startup warning to reduce accidental multi-instance assumptions.

Delivered changes:
- `/health` now includes:
  - `deployment.topology = "single-node"`
  - `deployment.session_state_scope = "process-local"`
  - `deployment.horizontal_scaling = "unsupported"`
- Startup now logs an explicit process-local session-state warning.
- CLI "already running" guidance now clarifies that separate `--data-dir` instances are isolated, not clustered.
- Documentation updated in `README.md` and `docs/architecture.md`.

### Phase 2 (in progress)

1. Introduce a shared coordination contract for live session ownership/leases.
2. Add pluggable distributed backend (Redis/DB) behind the contract.
3. Gate session mutation on lease ownership to prevent split-brain writes.

Delivered in this branch:
- Added a `SessionLeaseCoordinator` contract with in-memory default implementation.
- Added lease ownership checks at central runtime mutation ingress (`RuntimeApi`) and in mutating `SessionRuntime` methods.
- Added lifecycle lease semantics: `getOrCreateSession` now acquires/validates lease ownership; `removeSession`/`closeSession` release leases.
- Routed consumer/backend mutation paths through lease-aware runtime APIs where possible.

### Phase 3 (next)

1. Add multi-instance integration tests (failover, reconnect, queue durability).
2. Add metrics for lease contention/failover and propagate into health/readiness checks.
