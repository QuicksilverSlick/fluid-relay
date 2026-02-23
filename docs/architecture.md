# BeamCode Architecture (Post-Refactor)

> Date: 2026-02-23
> Status: Target state after completing all phases of architecture refactoring
> Scope: Full system architecture — core, adapters, consumer, relay, daemon

## Table of Contents

- [Overview](#overview)
- [System Architecture](#system-architecture)
- [Core Design Principles](#core-design-principles)
- [Module Overview](#module-overview)
- [Core Modules](#core-modules)
  - [SessionCoordinator](#sessioncoordinator)
  - [SessionRuntime](#sessionruntime)
  - [SessionReducer](#sessionreducer)
  - [EffectExecutor](#effectexecutor)
  - [DomainEventBus](#domaineventbus)
- [Consumer Plane](#consumer-plane)
  - [ConsumerGateway](#consumergateway)
  - [ConsumerBroadcaster](#consumerbroadcaster)
  - [ConsumerGatekeeper](#consumergatekeeper)
- [Backend Plane](#backend-plane)
  - [BackendConnector](#backendconnector)
- [Pure Functions](#pure-functions)
- [Session Data Model](#session-data-model)
  - [SessionData (Immutable)](#sessiondata-immutable)
  - [SessionHandles (Runtime)](#sessionhandles-runtime)
  - [SessionEvent (Input Union)](#sessionevent-input-union)
  - [Effect (Output Union)](#effect-output-union)
- [Command and Event Flow](#command-and-event-flow)
  - [Commands vs Domain Events](#commands-vs-domain-events)
  - [DomainEventBus — Flat Pub/Sub](#domaineventbus--flat-pubsub)
  - [Inbound Data Flow](#inbound-data-flow)
  - [Outbound Data Flow](#outbound-data-flow)
  - [Translation Boundaries](#translation-boundaries)
- [Session Lifecycle State Machine](#session-lifecycle-state-machine)
- [Backend Adapters](#backend-adapters)
- [React Consumer](#react-consumer)
- [Daemon](#daemon)
- [Security Architecture](#security-architecture)
- [Cross-Cutting Infrastructure](#cross-cutting-infrastructure)
- [Module Dependency Graph](#module-dependency-graph)
- [File Layout](#file-layout)
- [Key Interfaces](#key-interfaces)
- [What Changed From Pre-Refactor](#what-changed-from-pre-refactor)

---

## Overview

BeamCode is a **message broker** — it routes messages between remote consumers (browser/phone via WebSocket) and local AI coding backends (Claude CLI, Codex, ACP, Gemini, OpenCode) with session-scoped state.

The core is built around a **per-session actor** (`SessionRuntime`) that is the sole owner of session state. All state transitions flow through a **pure reducer** that returns new state plus a list of **effects** (side-effect descriptions). The runtime executes effects after applying the state transition. Persistence is automatic and debounced.

> **Core invariant: Only `SessionRuntime.process()` can transition session state.
> The reducer is pure: `(SessionData, SessionEvent) → [SessionData, Effect[]]`.
> Effects are descriptions, not executions — the runtime's executor handles I/O.
> Persistence is automatic on every state change (debounced, no manual calls).**

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              BEAMCODE SYSTEM ARCHITECTURE                           │
│                                                                                     │
│  ╔══════════════════════╗  ╔═══════════╗                                            │
│  ║ React Consumer       ║  ║  Desktop  ║  Consumers                                 │
│  ║ (web/)               ║  ║  Browser  ║  (any WebSocket client)                    │
│  ║ React 19 + Zustand   ║  ╚═════╤═════╝                                            │
│  ║ + Tailwind v4 + Vite ║        │                                                  │
│  ╚═══════╤══════════════╝        │                                                  │
│          │                       │                                                  │
│          │  HTTPS                │  ws://localhost                                  │
│          │                       │  (direct, no tunnel)                             │
│  ┌───────▼─────────┐             │                                                  │
│  │  Cloudflare     │             │                                                  │
│  │  Tunnel Edge    │             │  LOCAL PATH                                      │
│  └───────┬─────────┘             │                                                  │
│  ┌───────▼─────────┐             │                                                  │
│  │  cloudflared    │             │  ◄── sidecar process (Go binary)                 │
│  │  reverse proxy  │             │      proxies HTTPS → localhost:PORT              │
│  └───────┬─────────┘             │                                                  │
│          │ localhost:PORT        │                                                  │
│          │                       │                                                  │
│  ┌───────▼───────────────────────▼───────────────────────────────────────┐          │
│  │                     HTTP + WS SERVER (localhost:9414)                 │          │
│  │                                                                       │          │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │          │
│  │  │  http/ — HTTP Request Router                                    │  │          │
│  │  │  ┌──────────────┐ ┌──────────────┐ ┌─────────────────────────┐  │  │          │
│  │  │  │ api-sessions │ │ consumer-    │ │ health                  │  │  │          │
│  │  │  │ REST CRUD    │ │ html (serves │ │ GET /health             │  │  │          │
│  │  │  │ /api/sessions│ │ React app)   │ │                         │  │  │          │
│  │  │  └──────────────┘ └──────────────┘ └─────────────────────────┘  │  │          │
│  │  └─────────────────────────────────────────────────────────────────┘  │          │
│  │                                                                       │          │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │          │
│  │  │  server/ — WebSocket Layer                                      │  │          │
│  │  │  ┌──────────────┐ ┌──────────────┐ ┌────────────────────────┐   │  │          │
│  │  │  │ Origin       │ │ Auth Token   │ │ Reconnection Handler   │   │  │          │
│  │  │  │ Validation   │ │ Gate         │ │  Stable consumer IDs   │   │  │          │
│  │  │  └──────────────┘ └──────────────┘ │  Message replay        │   │  │          │
│  │  │                                    └────────────────────────┘   │  │          │
│  │  │  ┌──────────────┐ ┌──────────────┐ ┌────────────────────────┐   │  │          │
│  │  │  │ Consumer     │ │ Consumer     │ │ Api-Key                │   │  │          │
│  │  │  │ Channel      │ │ Rate Limit   │ │ Authenticator          │   │  │          │
│  │  │  │ (per-client  │ │ token-bucket │ │                        │   │  │          │
│  │  │  │  send queue) │ │              │ │                        │   │  │          │
│  │  │  └──────────────┘ └──────────────┘ └────────────────────────┘   │  │          │
│  │  └─────────────────────────────────────────────────────────────────┘  │          │
│  └───────────────────────────────┬───────────────────────────────────────┘          │
│                                  │                                                  │
│          ConsumerMessage (30+ subtypes, typed union)                                │
│          InboundMessage  (user_message, permission_response, interrupt, ...)        │
│                                  │                                                  │
│                                  ▼                                                  │
│  ┌──────────────────────────────────────────────────────────────────────┐           │
│  │                    core/ — Actor + Reducer + Effects                 │           │
│  │                                                                      │           │
│  │  SessionCoordinator → SessionRuntime.process(event)                  │           │
│  │                       → SessionReducer (pure)                        │           │
│  │                       → EffectExecutor (I/O)                         │           │
│  └──────────────────────────────────┬───────────────────────────────────┘           │
│                                     │                                               │
│        ┌────────────┐───────────────┼──────────────────┬────────┐                   │
│        │            │               │                  │        │                   │
│        ▼            ▼               ▼                  ▼        ▼                   │
│  ┌──────────┐  ┌────────────┐  ┌──────────────┐  ┌──────┐ ┌──────┐                  │
│  │ Claude   │  │ ACP        │  │ Codex        │  │Gemini│ │Open- │                  │
│  │ Adapter  │  │ Adapter    │  │ Adapter      │  │Adapt │ │code  │                  │
│  │ NDJSON/  │  │ JSON-RPC/  │  │ JSON-RPC/WS  │  │wraps │ │Adapt │                  │
│  │ WS --sdk │  │ stdio      │  │ app-server   │  │ACP   │ │REST+ │                  │
│  │ stream,  │  │            │  │ Thread/Turn/ │  │      │ │SSE   │                  │
│  │ perms,   │  │            │  │ Item model   │  │      │ │      │                  │
│  │ teams    │  │            │  │              │  │      │ │      │                  │
│  └────┬─────┘  └─────┬──────┘  └──────┬───────┘  └──┬───┘ └──┬───┘                  │
│       ▼              ▼                ▼             ▼        ▼                      │
│  ╔═════════╗  ╔══════════════╗  ╔═══════════╗  ╔═══════╗ ╔═══════╗                  │
│  ║ Claude  ║  ║ Goose/Kiro/  ║  ║ Codex CLI ║  ║Gemini ║ ║open-  ║                  │
│  ║ Code CLI║  ║ Gemini (ACP) ║  ║ (OpenAI)  ║  ║ CLI   ║ ║ code  ║                  │
│  ╚═════════╝  ╚══════════════╝  ╚═══════════╝  ╚═══════╝ ╚═══════╝                  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Core Design Principles

| # | Rule | Rationale |
|---|------|-----------|
| 1 | Only `SessionRuntime.process()` can change session state | Enforced by compiler (`readonly SessionData`) — not convention |
| 2 | State transitions are pure: `(SessionData, SessionEvent) → [SessionData, Effect[]]` | 90%+ business logic testable with zero mocks |
| 3 | Side effects are descriptions (Effect[]), not inline I/O | Effects are enumerable, testable, and traceable |
| 4 | Persistence is automatic and debounced on every state change | Zero manual `persistSession()` calls — impossible to forget |
| 5 | Transport modules emit commands, never trigger business side effects directly | Clean separation between I/O and logic |
| 6 | Policy services observe state and emit commands — they never mutate | Reconnect, idle, capabilities are advisors |
| 7 | Explicit lifecycle states for each session | Testable state machine, no implicit status inference |
| 8 | Session-scoped domain events flow from runtime; coordinator emits only global lifecycle events | Typed, meaningful events replace forwarding chains |
| 9 | Direct method calls, not actor mailbox | Node.js is single-threaded — the principle matters, not the mechanism |

### Three Bounded Contexts

| Context | Responsibility | Modules |
|---------|---------------|---------|
| **SessionControl** | Global lifecycle, per-session actor ownership, persistence | `SessionCoordinator`, `session/SessionRuntime` (per-session), `session/SessionRepository`, `policies/*`, `capabilities/*` |
| **BackendPlane** | Adapter abstraction, connect/send/stream | `backend/BackendConnector`, `AdapterResolver`, `BackendAdapter`(s) |
| **ConsumerPlane** | WebSocket transport, auth, rate limits, outbound push | `consumer/ConsumerGateway`, `consumer/ConsumerBroadcaster`, `consumer/ConsumerGatekeeper` |

> **Note:** The pre-refactor "MessagePlane" bounded context has been absorbed. The `UnifiedMessageRouter` was deleted — its state-transition logic moved into the `SessionReducer` (pure), its broadcast/emit logic became `Effect` variants executed by the runtime, and its pure mapping functions remain in `consumer-message-mapper.ts`.

---

## Module Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          COMPOSITION ROOT                                   │
│                         (bin/beamcode.ts)                                   │
│                                                                             │
│  Creates all modules, injects dependencies, starts coordinator              │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │ constructs
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       SessionCoordinator                                    │
│                                                                             │
│  Top-level owner: wires services, manages runtime map, routes events        │
│  Delegates event wiring to CoordinatorEventRelay                            │
│  Delegates relaunch dedup to BackendRecoveryService                         │
│  Delegates log redaction to ProcessLogService                               │
│  Delegates startup restore to StartupRestoreService                         │
└───┬──────────┬────────────┬───────────────┬─────────────────────────────────┘
    │          │            │               │
    ▼          ▼            ▼               ▼
┌────────┐ ┌─────────┐ ┌─────────┐  ┌─────────────────┐
│Domain  │ │Consumer │ │ Backend │  │  Runtime Map    │
│EventBus│ │ Gateway │ │Connector│  │  Map<id,        │
└────────┘ └─────────┘ └─────────┘  │  SessionRuntime>│
                            │       └──────┬──────────┘
                            ▼              │
                    ┌──────────────────────▼──────┐
                    │    SessionRuntime           │
                    │    (one per session)        │
                    │                             │
                    │    process(event)           │
                    │    ┌─────────────────────┐  │
                    │    │ SessionReducer      │  │
                    │    │ (pure function)     │  │
                    │    │ → [Data, Effects]   │  │
                    │    └─────────┬───────────┘  │
                    │              │              │
                    │    ┌─────────▼───────────┐  │
                    │    │ EffectExecutor      │  │
                    │    │ (I/O dispatcher)    │  │
                    │    └─────────────────────┘  │
                    │                             │
                    │    SOLE STATE OWNER         │
                    └─────────────────────────────┘
```

---

## Core Modules

### SessionCoordinator

**File:** `src/core/session-coordinator.ts`
**Context:** SessionControl
**Writes state:** No (delegates to runtime via `process()`)

The SessionCoordinator is the **top-level orchestrator** and the only composition root for session infrastructure. It directly owns the runtime map, service registry, transport hub, policies, and extracted services.

> **Key change from pre-refactor:** `SessionBridge` and `compose-*-plane.ts` factories have been removed. The coordinator wires services directly via `buildServices()` and manages the `Map<string, SessionRuntime>` itself.

**Responsibilities:**
- **Create sessions:** Routes to the correct adapter (inverted vs direct connection), initiates the backend, seeds session state
- **Delete sessions:** Orchestrates teardown — kills CLI process, clears dedup state, closes WS connections, removes from registry
- **Route events to runtimes:** `coordinator.process(sessionId, event)` looks up the runtime and calls `runtime.process(event)`
- **Own the service registry:** Constructs `SessionServices` (broadcaster, connector, storage, tracer, logger) once at startup
- **Restore from storage:** Delegates to `StartupRestoreService`
- **React to domain events:** Delegates to `CoordinatorEventRelay`

**Extracted services** (in `src/core/coordinator/`):

| Service | Responsibility |
|---------|---------------|
| `CoordinatorEventRelay` | Subscribes to domain events, dispatches to handlers |
| `ProcessLogService` | Buffers and redacts process stdout/stderr |
| `BackendRecoveryService` | Timer-guarded relaunch dedup, graceful kill before relaunch |
| `ProcessSupervisor` | Process spawn/track/kill for CLI backends |
| `StartupRestoreService` | Ordered restore: launcher → registry → runtimes |

**Does NOT do:**
- Mutate any session-level state (runtime does)
- Forward events between layers (delegates to relay)
- Route messages (runtime does)

```typescript
class SessionCoordinator {
  private runtimes: Map<string, SessionRuntime>;
  private services: SessionServices;
  readonly launcher: SessionLauncher;
  readonly registry: SessionRegistry;
  readonly domainEvents: DomainEventBus;

  async start(): Promise<void>
  async stop(): Promise<void>
  async createSession(options): Promise<SessionInfo>
  async deleteSession(id: string): Promise<boolean>
  process(sessionId: string, event: SessionEvent): Promise<void>
}
```

---

### SessionRuntime

**File:** `src/core/session/session-runtime.ts`
**Context:** SessionControl
**Writes state:** **Yes — sole writer (compiler-enforced)**

The SessionRuntime is a **per-session actor**. One instance exists per active session. It owns immutable `SessionData` (readonly at the type level) and mutable `SessionHandles` (runtime references). Its single entry point is `process(event)`.

**Responsibilities:**
- **Own all session state:** `SessionData` (immutable, serializable) + `SessionHandles` (mutable runtime refs)
- **Process events through the reducer:** `process(event)` calls the pure `sessionReducer()`, applies the state transition, then executes the returned effects
- **Auto-persist:** Every state change triggers `markDirty()` (debounced 50ms). Critical transitions (result, session close) call `persistNow()` for immediate flush
- **Execute effects:** Dispatches `Effect[]` to the appropriate I/O handler (broadcast, send-to-backend, emit event, async workflow)
- **Manage consumers:** Add/remove WebSocket connections in `SessionHandles`
- **Manage backend state:** Store/clear the `BackendSession` reference in `SessionHandles`
- **Lifecycle state machine:** Lifecycle is part of `SessionData` — transitions enforced by the reducer

**Does NOT do:**
- Contain business logic — all state transitions are in the pure `SessionReducer`
- Know about WebSocket protocols — delegates to `ConsumerBroadcaster`
- Know about adapter specifics — delegates to `BackendConnector`

```
┌────────────────────────────────────────────────────────────────────────┐
│                      SessionRuntime                                    │
│                      (per-session, actor model)                        │
│                                                                        │
│  ┌─────────── PRIVATE STATE (compiler-enforced)  ────────────────────┐ │
│  │                                                                   │ │
│  │  data: SessionData         (readonly — immutable record)          │ │
│  │  ├─ id, lifecycle, state, messageHistory, lastStatus              │ │
│  │  ├─ pendingPermissions, pendingMessages, queuedMessage            │ │
│  │  └─ adapterName, adapterSupportsSlashPassthrough                  │ │
│  │                                                                   │ │
│  │  handles: SessionHandles   (mutable — runtime references)         │ │
│  │  ├─ backendSession, backendAbort                                  │ │
│  │  ├─ consumerSockets, consumerRateLimiters                         │ │
│  │  ├─ teamCorrelationBuffer, registry, pendingPassthroughs          │ │
│  │  └─ adapterSlashExecutor, pendingInitialize                       │ │
│  │                                                                   │ │
│  │  ═══════ SessionData is readonly — NO OTHER MODULE CAN WRITE ═══  │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│  ┌─── Single Entry Point ────────────────────────────────── ────────┐  │
│  │                                                                  │  │
│  │  async process(event: SessionEvent): Promise<void>               │  │
│  │    1. [nextData, effects] = sessionReducer(this.data, event)     │  │
│  │    2. if (nextData !== this.data) { this.data = nextData; dirty }│  │
│  │    3. for (effect of effects) { executeEffect(effect) }          │  │
│  │                                                                  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌─── Auto-Persistence ─────────────────────────────────────────────┐  │
│  │                                                                  │  │
│  │  markDirty()    — debounced 50ms, batches rapid updates          │  │
│  │  persistNow()   — immediate flush for critical transitions       │  │
│  │                                                                  │  │
│  │  ZERO manual persistSession() calls anywhere in the codebase     │  │
│  │                                                                  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌─── Emits (notifications, never commands) ─────────────────────────┐ │
│  │                                                                   │ │
│  │  bus.emit(DomainEvent)                                            │ │
│  │  • session:lifecycle_changed                                      │ │
│  │  • backend:session_id                                             │ │
│  │  • session:first_turn                                             │ │
│  │  • capabilities:ready                                             │ │
│  │  • permission:requested / permission:resolved                     │ │
│  │  • slash:executed / slash:failed                                  │ │
│  │  • team:* events                                                  │ │
│  │                                                                   │ │
│  └───────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

**Serialization:** To avoid async interleaving across `await` boundaries, each runtime processes events through a lightweight per-session serial executor (promise chain).

---

### SessionReducer

**File:** `src/core/session/session-reducer.ts`
**Context:** Pure function (no module context)
**Writes state:** No — returns new state + effects

The SessionReducer is the **single pure function** that contains all state-transition logic. It takes current `SessionData` and a `SessionEvent`, and returns a tuple of `[SessionData, Effect[]]`.

**Responsibilities:**
- **State reduction for all backend messages:** session_init, status_change, assistant, result, permission_request, tool_use_summary, configuration_change, auth_status, session_lifecycle, stream_event, tool_progress, control_response
- **State reduction for inbound commands:** user_message (echo + normalize), permission_response, interrupt, set_model, queue operations
- **State reduction for system signals:** timeout, disconnect, git info resolved
- **History management:** Append, replace (dedup), trim to max length
- **Status inference:** result → idle, status_change → update lastStatus
- **Permission tracking:** Store pending permissions from backend requests
- **Effect determination:** For each event, compute which side effects need to happen (broadcast, send-to-backend, emit domain event, async workflow trigger)

**Composed from sub-reducers:**

```typescript
function sessionReducer(data: SessionData, event: SessionEvent): [SessionData, Effect[]] {
  switch (event.type) {
    case 'BACKEND_MESSAGE':
      return reduceBackendMessage(data, event.message);
    case 'INBOUND_COMMAND':
      return reduceInboundCommand(data, event.command);
    case 'SYSTEM_SIGNAL':
      return reduceSystemSignal(data, event.signal);
  }
}
```

Each sub-reducer further delegates to focused pure functions:

| Sub-reducer | From file | Responsibility |
|-------------|-----------|----------------|
| `reduceSessionState` | `session-state-reducer.ts` | AI context: model, cwd, tools, team state, capabilities, cost |
| `reduceHistory` | `history-reducer.ts` | Append, replace, dedup assistant messages, trim to max |
| `reduceStatus` | inline | `status_change` → update lastStatus; `result` → idle |
| `reducePermissions` | inline | Store/clear pending permission requests |
| `reduceLifecycle` | `session-lifecycle.ts` | Enforce lifecycle state machine transitions |
| `reduceTeamState` | `team/team-state-reducer.ts` | Team member/task state from tool-use messages |
| `mapToEffects` | `effect-mapper.ts` | Determine side effects for each message type |

**Key property:** Same-reference optimization — returns the original `data` reference if no fields changed. This allows `nextData !== this.data` check in the runtime to skip persistence when nothing changed.

**Does NOT do:**
- Execute any I/O (broadcasting, persistence, backend sends)
- Access runtime handles (WebSockets, AbortControllers)
- Emit domain events directly

---

### EffectExecutor

**File:** `src/core/session/effect-executor.ts`
**Context:** SessionControl (owned by SessionRuntime)
**Writes state:** No (dispatches I/O)

The EffectExecutor translates `Effect` descriptions into actual I/O operations. It is called by `SessionRuntime.process()` after each state transition.

**Responsibilities:**
- **Broadcast to consumers:** `BROADCAST` → `ConsumerBroadcaster.broadcast()`
- **Send to backend:** `SEND_TO_BACKEND` → `BackendConnector.sendToBackend()`
- **Emit domain events:** `EMIT_EVENT` → `DomainEventBus.emit()`
- **Async workflows:** `RESOLVE_GIT_INFO` → resolve, then feed result back as `SYSTEM_SIGNAL`
- **Capabilities handshake:** `SEND_CAPABILITIES_REQUEST` → send control_request to backend
- **Queue drain:** `AUTO_SEND_QUEUED` → `MessageQueueHandler.autoSendQueuedMessage()`
- **Tracing:** `TRACE_T4` → `MessageTracer.recv()`

**Async effect feedback loop:** Some effects produce new events (e.g., `RESOLVE_GIT_INFO` → `GIT_INFO_RESOLVED`). These feed back through `runtime.process()`. Max recursion depth is 2 (enforced by runtime).

**Does NOT do:**
- Decide which effects to produce (the reducer does that)
- Hold any state
- Know about message types or business rules

---

### DomainEventBus

**File:** `src/core/events/domain-event-bus.ts` (~52 lines), types in `src/core/interfaces/domain-events.ts`
**Context:** Infrastructure
**Writes state:** No

A flat, typed pub/sub bus. All domain events are emitted exactly once at the source and consumed directly by subscribers — no forwarding chains.

**Responsibilities:**
- **Typed event dispatch:** Single `emit(event)` method accepts the `DomainEvent` union type
- **Typed subscription:** `on(type, handler)` with TypeScript narrowing via `Extract<DomainEvent, { type: T }>`
- **Lifecycle management:** Returns `Disposable` from `on()` for easy cleanup

**Event categories:**
- **Session lifecycle:** created, closed, first_turn, lifecycle_changed
- **Backend:** connected, disconnected, session_id, relaunch_needed
- **Consumer:** connected, disconnected, authenticated
- **Process:** spawned, exited
- **Messages:** inbound (for tracing), outbound (for tracing)
- **Permissions:** requested, resolved
- **Slash commands:** executed, failed
- **Capabilities:** ready, timeout
- **Team:** created, deleted, member:joined/idle/shutdown, task:created/claimed/completed
- **Errors:** error with source + optional sessionId

**Key constraint:** Transport modules (`ConsumerGateway`, `BackendConnector`) do **not** publish `DomainEvent`s directly. They emit commands/signals to `SessionRuntime`, which is the canonical event source for session-scoped events.

---

## Consumer Plane

### ConsumerGateway

**File:** `src/core/consumer/consumer-gateway.ts` (~287 lines)
**Context:** ConsumerPlane
**Writes state:** No (emits commands to runtime)

The ConsumerGateway handles all WebSocket I/O for consumer connections. **No business logic.** On receiving a valid message, it wraps it as a `SessionEvent` and routes it to the runtime via `coordinator.process(sessionId, event)`.

**Responsibilities:**
- **Accept connections:** Look up the target `SessionRuntime` by session ID. If not found, reject with 4004. Delegate authentication to `ConsumerGatekeeper`. On success, call `runtime.process({ type: 'SYSTEM_SIGNAL', signal: 'CONSUMER_CONNECTED', ws, identity })`
- **Replay state:** After accepting a consumer, tell `ConsumerBroadcaster` to send the full replay
- **Validate inbound messages:** Size check (256KB), JSON parse, Zod schema validation, RBAC authorization, rate limiting — all delegated to `ConsumerGatekeeper`
- **Route valid messages:** Wrap as `SessionEvent` and call `coordinator.process(sessionId, event)`
- **Handle disconnection:** `runtime.process({ type: 'SYSTEM_SIGNAL', signal: 'CONSUMER_DISCONNECTED', ws })`

**Does NOT do:**
- Parse message semantics (that's the reducer's job)
- Mutate session state
- Broadcast to consumers (that's `ConsumerBroadcaster`)

---

### ConsumerBroadcaster

**File:** `src/core/consumer/consumer-broadcaster.ts` (~170 lines)
**Context:** ConsumerPlane
**Writes state:** No (reads handles from runtime)

Pushes `ConsumerMessage` data to WebSocket clients. Called by the `EffectExecutor` when processing `BROADCAST` effects.

**Responsibilities:**
- **Broadcast to all consumers:** Iterate over the runtime's consumer socket map, JSON-serialize, send with backpressure protection (skip if `bufferedAmount > 1MB`)
- **Broadcast to participants only:** Same but skip `OBSERVER` role
- **Send replay on reconnect:** Full state replay to a newly-connected socket
- **Presence updates:** Broadcast when consumers connect/disconnect
- **Session name updates:** Broadcast when auto-naming completes

---

### ConsumerGatekeeper

**File:** `src/core/consumer/consumer-gatekeeper.ts` (~157 lines)
**Context:** ConsumerPlane
**Writes state:** No (pure validation)

Auth + RBAC + rate limiting. Validates consumer connections and messages. Pluggable `Authenticator` interface for different auth strategies.

---

## Backend Plane

### BackendConnector

**File:** `src/core/backend/backend-connector.ts` (~644 lines)
**Context:** BackendPlane
**Writes state:** No (routes messages as `SessionEvent`s to runtime)

The BackendConnector manages adapter lifecycle, the backend message consumption loop, and passthrough interception.

**Responsibilities:**
- **Connect:** Resolve the adapter, call `adapter.connect()`, hand the `BackendSession` to the runtime via `process({ type: 'SYSTEM_SIGNAL', signal: 'BACKEND_CONNECTED', backendSession })`, start the consumption loop
- **Disconnect:** Route as `process({ type: 'SYSTEM_SIGNAL', signal: 'BACKEND_DISCONNECTED', reason })`
- **Consumption loop:** `for await (msg of backendSession.messages)` — for each message, route as `process({ type: 'BACKEND_MESSAGE', message: msg })`
- **Passthrough interception:** Intercept matching slash command responses during the consumption loop
- **Stop adapters:** Call `AdapterResolver.stopAll?.()` for graceful shutdown

**Inverted connection path (CLI calls back via WebSocket):**
- `SessionTransportHub` routes `/ws/cli/:sessionId` callbacks to `CliGateway`
- `CliGateway` validates launch state, resolves an inverted adapter
- `BufferedWebSocket` buffers early inbound messages until the adapter registers its handler

**Does NOT do:**
- Own adapter implementation details
- Decide what to do with messages (the reducer does)
- Know about consumer WebSockets

---

## Pure Functions

These modules are stateless, have no side effects, and contain no transport knowledge. They are independently testable and form the leaves of the dependency graph.

| Module | File | Boundary | Responsibility |
|--------|------|----------|----------------|
| **SessionReducer** | `session/session-reducer.ts` | — | Top-level pure reducer: `(SessionData, SessionEvent) → [SessionData, Effect[]]`. Composes all sub-reducers |
| **SessionStateReducer** | `session/session-state-reducer.ts` | — | AI context reduction: `(SessionState, UnifiedMessage) → SessionState` |
| **HistoryReducer** | `session/history-reducer.ts` | — | Message history: append, replace, dedup, trim |
| **EffectMapper** | `session/effect-mapper.ts` | — | Determines which effects to produce for each event |
| **InboundNormalizer** | `messaging/inbound-normalizer.ts` (~124L) | T1 | `InboundCommand → UnifiedMessage` |
| **ConsumerMessageMapper** | `messaging/consumer-message-mapper.ts` (~343L) | T4 | `UnifiedMessage → ConsumerMessage` (30+ subtypes) |
| **ConsumerGatekeeper** | `consumer/consumer-gatekeeper.ts` (~157L) | — | Auth + RBAC + rate limiting |
| **GitInfoTracker** | `session/git-info-tracker.ts` (~110L) | — | Git branch/repo resolution |
| **TeamToolCorrelationBuffer** | `team/team-tool-correlation.ts` (~92L) | — | Per-session tool result ↔ team member pairing |
| **MessageTracer** | `messaging/message-tracer.ts` (~631L) | — | Debug tracing at T1/T2/T3/T4 boundaries |
| **TraceDiffer** | `messaging/trace-differ.ts` (~143L) | — | Diff computation for trace inspection |
| **TeamStateReducer** | `team/team-state-reducer.ts` (~272L) | — | Team member/task state from tool-use messages |
| **TeamToolRecognizer** | `team/team-tool-recognizer.ts` (~138L) | — | Recognizes team-related tool patterns |
| **TeamEventDiffer** | `team/team-event-differ.ts` (~104L) | — | Team state diffs for domain event emission |

---

## Session Data Model

### SessionData (Immutable)

The single source of truth for a session. All fields are `readonly`. Only the reducer can produce a new `SessionData` — the runtime replaces its reference atomically.

```typescript
interface SessionData {
  readonly id: string;
  readonly lifecycle: LifecycleState;
  readonly state: SessionState;
  readonly messageHistory: readonly ConsumerMessage[];
  readonly lastStatus: "compacting" | "idle" | "running" | null;
  readonly pendingPermissions: ReadonlyMap<string, PermissionRequest>;
  readonly pendingMessages: readonly UnifiedMessage[];
  readonly queuedMessage: QueuedMessage | null;
  readonly adapterName?: string;
  readonly adapterSupportsSlashPassthrough: boolean;
}
```

**Persisted to disk** as `PersistedSession` (subset: id, state, messageHistory, pendingMessages, pendingPermissions, queuedMessage, adapterName).

### SessionHandles (Runtime)

Non-serializable runtime references. Managed by `SessionRuntime` directly (not through the reducer). These do not survive restarts.

```typescript
interface SessionHandles {
  backendSession: BackendSession | null;
  backendAbort: AbortController | null;
  consumerSockets: Map<WebSocketLike, ConsumerIdentity>;
  consumerRateLimiters: Map<WebSocketLike, RateLimiter>;
  anonymousCounter: number;
  lastActivity: number;
  pendingInitialize: { requestId: string; timer: ReturnType<typeof setTimeout> } | null;
  teamCorrelationBuffer: TeamToolCorrelationBuffer;
  registry: SlashCommandRegistry;
  pendingPassthroughs: Array<{...}>;
  adapterSlashExecutor: AdapterSlashExecutor | null;
}
```

### SessionEvent (Input Union)

All inputs to the runtime are typed as one of three `SessionEvent` variants:

```typescript
type SessionEvent =
  | { type: 'BACKEND_MESSAGE'; message: UnifiedMessage }
  | { type: 'INBOUND_COMMAND'; command: InboundCommand }
  | { type: 'SYSTEM_SIGNAL'; signal: SystemSignal };

type SystemSignal =
  | { kind: 'TIMEOUT' }
  | { kind: 'BACKEND_CONNECTED'; backendSession: BackendSession }
  | { kind: 'BACKEND_DISCONNECTED'; reason: string }
  | { kind: 'CONSUMER_CONNECTED'; ws: WebSocketLike; identity: ConsumerIdentity }
  | { kind: 'CONSUMER_DISCONNECTED'; ws: WebSocketLike }
  | { kind: 'GIT_INFO_RESOLVED'; gitInfo: GitInfo }
  | { kind: 'CAPABILITIES_READY'; capabilities: InitializeCapabilities }
  | { kind: 'IDLE_REAP' }
  | { kind: 'RECONNECT_TIMEOUT' }
  | { kind: 'CAPABILITIES_TIMEOUT' };
```

### Effect (Output Union)

Side effects returned by the reducer. Never executed inside the reducer — the runtime's `EffectExecutor` handles them.

```typescript
type Effect =
  // Broadcast to consumers
  | { type: 'BROADCAST'; message: ConsumerMessage }
  | { type: 'BROADCAST_SESSION_UPDATE'; patch: Partial<SessionState> }
  | { type: 'BROADCAST_TO_PARTICIPANTS'; message: ConsumerMessage }

  // Backend communication
  | { type: 'SEND_TO_BACKEND'; message: UnifiedMessage }

  // Domain events
  | { type: 'EMIT_EVENT'; eventType: string; payload: unknown }

  // Async workflows (produce new SessionEvents when done)
  | { type: 'RESOLVE_GIT_INFO'; cwd: string }
  | { type: 'SEND_CAPABILITIES_REQUEST' }
  | { type: 'APPLY_CAPABILITIES'; capabilities: unknown }
  | { type: 'AUTO_SEND_QUEUED' }

  // Tracing
  | { type: 'TRACE_T4'; phase: string; input: UnifiedMessage; output: ConsumerMessage };
```

---

## Command and Event Flow

### Commands vs Domain Events

```
  ┌──────────────────┐
  │ Events flow IN   │     SessionEvent = requests to change state
  └────────┬─────────┘
           │
           │  INBOUND_COMMAND (from ConsumerGateway)
           │  ┌─ user_message
           │  ├─ permission_response
           │  ├─ slash_command
           │  ├─ interrupt / set_model / set_permission_mode
           │  └─ queue_message / cancel / update
           │
           │  BACKEND_MESSAGE (from BackendConnector)
           │  ┌─ session_init, assistant, result, status_change
           │  ├─ permission_request, control_response
           │  └─ stream_event, tool_progress, tool_use_summary, ...
           │
           │  SYSTEM_SIGNAL (from policies, connector, gateway)
           │  ┌─ BACKEND_CONNECTED / DISCONNECTED
           │  ├─ CONSUMER_CONNECTED / DISCONNECTED
           │  ├─ RECONNECT_TIMEOUT / IDLE_REAP / CAPABILITIES_TIMEOUT
           │  └─ GIT_INFO_RESOLVED / CAPABILITIES_READY
           │
           ▼
    ┌──────────────┐
    │SessionRuntime│     process(event):
    │              │       [data, effects] = reducer(data, event)
    │              │       execute(effects)
    └──────┬───────┘
           │
           │  Effect[] (descriptions of what to do)
           │  ┌─ BROADCAST         → ConsumerBroadcaster
           │  ├─ SEND_TO_BACKEND   → BackendConnector
           │  ├─ EMIT_EVENT        → DomainEventBus
           │  ├─ RESOLVE_GIT_INFO  → GitInfoResolver → feeds back SYSTEM_SIGNAL
           │  └─ AUTO_SEND_QUEUED  → MessageQueueHandler
           │
           │  DomainEvent (notifications of what happened)
           │  ┌─ session:lifecycle_changed, session:first_turn
           │  ├─ backend:connected / disconnected / session_id
           │  ├─ consumer:connected / disconnected / authenticated
           │  ├─ permission:requested / resolved
           │  ├─ slash:executed / failed
           │  ├─ capabilities:ready / timeout
           │  └─ team:* events
           │
           ▼
  ┌───────────────────┐
  │ Events flow OUT   │     DomainEvent = facts about what changed
  └───────────────────┘
           │
    ┌──────┼──────────────────────────┐
    ▼      ▼                          ▼
 ┌──────┐ ┌─────────────────┐  ┌────────────┐
 │Coord.│ │ProcessSupervisor│  │  Policies  │
 │(auto-│ │(cleanup on      │  │(start/stop │
 │name, │ │ disconnect)     │  │ watchdogs) │
 │relaun│ └─────────────────┘  └────────────┘
 │ch)   │
 └──────┘
```

---

### DomainEventBus — Flat Pub/Sub

```
 Publishers                     DomainEventBus                    Subscribers
 ══════════                    ══════════════                     ═════════════

 SessionRuntime ──────┐    ┌─────────────────────┐    ┌── SessionCoordinator
   (via EMIT_EVENT    │    │                     │    │     (relaunch, auto-name)
    effects)          │    │   Flat typed bus    │    │
                      │    │                     │    ├── ReconnectPolicy
                      │    │  • emit(event)      │    │
                      ├───▶│  • on(type, fn)     │◀───┤── IdlePolicy
                      │    │                     │    │
                      │    │  ONE HOP — no       │    ├── CapabilitiesPolicy
                      │    │  forwarding chain   │    │
 SessionCoordinator ──┤    │                     │    ├── HTTP API / Metrics
   session:created    │    │                     │    │
   session:closed     ├───▶│                     │◀───┤── MessageTracer
                      │    │  (transport modules │    │
 ProcessSupervisor ───┤    │   DO NOT publish    │    └── ProcessSupervisor
   process:*          ├───▶│   DomainEvents)     │         (process telemetry)
                      │    │                     │
                      └───▶│                     │
                           └─────────────────────┘
```

---

### Inbound Data Flow

Consumer → Backend:

```
  Browser/Phone
       │
       │ WebSocket connect
       ▼
┌──────────────────────────────────────────────────────────────────┐
│                      ConsumerGateway                             │
│                    (transport only — no business logic)          │
│                                                                  │
│  handleConnection(ws, ctx)                                       │
│    ├── coordinator.getRuntime(sessionId) / reject 4004           │
│    ├── gatekeeper.authenticate(ws, ctx) / reject 4001            │
│    └── coordinator.process(sessionId, {                          │
│          type: 'SYSTEM_SIGNAL',                                  │
│          signal: { kind: 'CONSUMER_CONNECTED', ws, identity }    │
│        })                                                        │
│                                                                  │
│  handleMessage(ws, sessionId, data)                              │
│    ├── size check, JSON.parse, Zod validate, RBAC, rate limit    │
│    └── coordinator.process(sessionId, {                          │
│          type: 'INBOUND_COMMAND', command: validated             │
│        })                                                        │
└──────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│                  SessionRuntime.process(event)                   │
│                                                                  │
│  ┌──────────────────────────────────────┐                        │
│  │ 1. REDUCER (pure)                    │                        │
│  │    [nextData, effects] =             │                        │
│  │      sessionReducer(this.data, event)│                        │
│  └──────────────────────────────────────┘                        │
│                                                                  │
│  ┌──────────────────────────────────────┐                        │
│  │ 2. STATE UPDATE (atomic)             │                        │
│  │    this.data = nextData              │                        │
│  │    this.markDirty() // auto-persist  │                        │
│  └──────────────────────────────────────┘                        │
│                                                                  │
│  ┌──────────────────────────────────────┐                        │
│  │ 3. EFFECTS (I/O dispatch)            │                        │
│  │                                      │                        │
│  │  user_message effects:               │                        │
│  │    BROADCAST(echoMsg)  ──────────────│───▶ Consumers          │
│  │    SEND_TO_BACKEND(unified) ─────────│───▶ Backend            │
│  │                                      │                        │
│  │  permission_response effects:        │                        │
│  │    SEND_TO_BACKEND(response) ────────│───▶ Backend            │
│  │    EMIT_EVENT(permission:resolved)   │                        │
│  │                                      │                        │
│  │  slash_command effects:              │                        │
│  │    varies by strategy (local/native/ │                        │
│  │    passthrough/unsupported)          │                        │
│  └──────────────────────────────────────┘                        │
└──────────────────────────────────────────────────────────────────┘
```

---

### Outbound Data Flow

Backend → Consumers:

```
  Backend (Claude CLI / Codex / ACP)
       │
       │ async iterable: UnifiedMessage
       ▼
┌──────────────────────────────────────────────────────────────────┐
│                      BackendConnector                            │
│                                                                  │
│  startConsumptionLoop(runtime, backendSession)                   │
│    │                                                             │
│    │  for await (msg of backendSession.messages):                │
│    │    │                                                        │
│    │    ├── interceptPassthrough? → buffer + emit result, skip   │
│    │    │                                                        │
│    │    └── coordinator.process(sessionId, {                     │
│    │          type: 'BACKEND_MESSAGE', message: msg              │
│    │        })                                                   │
│    │                                                             │
│    │  [stream ends]                                              │
│    │    └── coordinator.process(sessionId, {                     │
│    │          type: 'SYSTEM_SIGNAL',                             │
│    │          signal: { kind: 'BACKEND_DISCONNECTED', reason }   │
│    │        })                                                   │
└──────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│                  SessionRuntime.process(event)                   │
│                                                                  │
│  ┌──────────────────────────────────────┐                        │
│  │ 1. REDUCER (pure)                    │                        │
│  │    [nextData, effects] =             │                        │
│  │      sessionReducer(data, event)     │                        │
│  │                                      │                        │
│  │    State transitions applied:        │                        │
│  │    • reduceSessionState (model, cwd) │                        │
│  │    • reduceHistory (append/dedup)    │                        │
│  │    • reduceStatus (idle inference)   │                        │
│  │    • reducePermissions (store/clear) │                        │
│  │    • reduceLifecycle (active/idle)   │                        │
│  └──────────────────────────────────────┘                        │
│                                                                  │
│  ┌──────────────────────────────────────┐                        │
│  │ 2. STATE UPDATE + AUTO-PERSIST       │                        │
│  └──────────────────────────────────────┘                        │
│                                                                  │
│  ┌──────────────────────────────────────┐                        │
│  │ 3. EFFECTS (per message type)        │                        │
│  │                                      │                        │
│  │  session_init:                       │                        │
│  │    BROADCAST(session_init)      ─────│───▶ Consumers          │
│  │    RESOLVE_GIT_INFO(cwd)        ─────│───▶ feeds back event   │
│  │    SEND_CAPABILITIES_REQUEST    ─────│───▶ Backend            │
│  │                                      │                        │
│  │  assistant:                          │                        │
│  │    BROADCAST(consumerMsg)       ─────│───▶ Consumers          │
│  │                                      │                        │
│  │  result:                             │                        │
│  │    BROADCAST(resultMsg)         ─────│───▶ Consumers          │
│  │    AUTO_SEND_QUEUED             ─────│───▶ drain queue        │
│  │    EMIT_EVENT(first_turn?)           │                        │
│  │                                      │                        │
│  │  status_change:                      │                        │
│  │    BROADCAST(statusMsg)         ─────│───▶ Consumers          │
│  │    AUTO_SEND_QUEUED (if idle)   ─────│───▶ drain queue        │
│  │                                      │                        │
│  │  permission_request:                 │                        │
│  │    BROADCAST_TO_PARTICIPANTS    ─────│───▶ Participants only  │
│  │    EMIT_EVENT(permission:requested)  │                        │
│  │                                      │                        │
│  │  stream_event, tool_progress,        │                        │
│  │  tool_use_summary, auth_status,      │                        │
│  │  configuration_change,               │                        │
│  │  session_lifecycle:                  │                        │
│  │    BROADCAST(mapped)            ─────│───▶ Consumers          │
│  │                                      │                        │
│  │  control_response:                   │                        │
│  │    APPLY_CAPABILITIES           ─────│───▶ feeds back event   │
│  └──────────────────────────────────────┘                        │
└──────────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────────────────────┐
│                   ConsumerBroadcaster                            │
│                  (consumer/consumer-broadcaster.ts)              │
│                                                                  │
│  broadcast(runtime, msg)                                         │
│    for each ws in runtime.handles.consumerSockets:               │
│      if ws.bufferedAmount > 1MB: skip (backpressure)             │
│      ws.send(JSON.stringify(msg))                                │
│                                                                  │
│  broadcastToParticipants(runtime, msg)                           │
│    same but skip observer role                                   │
│                                                                  │
│  sendReplayTo(ws, runtime)  — full state replay on reconnect     │
│  broadcastPresence(...)     — presence_update                    │
│  broadcastNameUpdate(...)   — session_name_update                │
└──────────────────────────────────────────────────────────────────┘
                    │
                    ▼
              All consumer
              WebSockets
```

---

### Translation Boundaries

The system has four named translation boundaries (T1–T4) that are pure mapping functions:

```
Inbound path:
  ConsumerGateway
    └─ SessionRuntime.process(INBOUND_COMMAND)
         └─ reducer calls InboundNormalizer.normalize(...)         [T1]
             InboundCommand -> UnifiedMessage

Backend path:
  reducer returns SEND_TO_BACKEND effect
    └─ EffectExecutor → Adapter session outbound translator        [T2]
       UnifiedMessage -> backend-native payload

  Adapter session inbound translator                               [T3]
    backend-native payload -> UnifiedMessage
    └─ BackendConnector → coordinator.process(BACKEND_MESSAGE)

Outbound path:
  SessionReducer (inside reducer)
    └─ ConsumerMessageMapper                                       [T4]
       UnifiedMessage -> ConsumerMessage
       (returned as BROADCAST effect)
```

---

## Session Lifecycle State Machine

Each session has an explicit `LifecycleState` stored in `SessionData.lifecycle`. Transitions are enforced by the reducer via `isLifecycleTransitionAllowed()`.

```typescript
type LifecycleState =
  | "starting"          // Session created, process spawning or connecting
  | "awaiting_backend"  // Process spawned, waiting for CLI to connect back
  | "active"            // Backend connected, processing messages
  | "idle"              // Backend connected, waiting for user input
  | "degraded"          // Backend disconnected unexpectedly, awaiting relaunch
  | "closing"           // Shutdown initiated, draining
  | "closed"            // Terminal state, ready for removal
```

```
                    createSession()
                         │
                         ▼
                   ┌───────────┐
                   │  starting │
                   └─────┬─────┘
                         │
              ┌──────────┴──────────┐
              │                     │
        (inverted)              (direct)
              │                     │
              ▼                     │
     ProcessSupervisor              │
        .spawn()                    │
              │                     │
              ▼                     │
     ┌──────────────────┐           │
     │ awaiting_backend │           │
     └──────┬───────────┘           │
            │                       │
            │ CLI connects          │ adapter.connect()
            │                       │
            └──────────┬────────────┘
                       │
                       ▼
                 ┌───────────┐
           ┌────▶│  active   │◀─── user_message received
           │     └────┬──────┘
           │          │
           │     result received
           │          │
           │          ▼
           │     ┌───────────┐
           │     │   idle    │──── user_message ───▶ active
           │     └────┬──────┘
           │          │
           │     backend disconnects unexpectedly
           │          │
           │          ▼
           │    ┌───────────┐
           │    │ degraded  │── relaunch succeeds ──┐
           │    └─────┬─────┘                       │
           │          │                             │
           │     relaunch fails / idle_reap         │
           │          │                             │
           │          ▼                             │
           │    ┌───────────┐                       │
           │    │  closing  │                       │
           │    └─────┬─────┘                       │
           │          │                             │
           │          ▼                             │
           │    ┌───────────┐                       │
           └────│  closed   │◀──────────────────────┘
                └───────────┘    (if session removed)


  Policies react to lifecycle transitions (via DomainEventBus):
  ┌──────────────────────────────────────────────────────────────┐
  │ ReconnectPolicy:  awaiting_backend → start watchdog timer    │
  │ IdlePolicy:       idle + no consumers → start reap timer     │
  │ CapabilitiesPolicy: active → start capabilities timeout      │
  └──────────────────────────────────────────────────────────────┘
```

---

## Backend Adapters

All adapters implement the `BackendAdapter` + `BackendSession` interfaces — a clean async iterable contract.

```
┌──────────────────────────────────────────────────────────────────────┐
│  BackendAdapter interface                                            │
│  name: string                                                        │
│  capabilities: BackendCapabilities                                   │
│  connect(options): Promise<BackendSession>                           │
│  stop?(): Promise<void>                   — graceful adapter teardown│
├──────────────────────────────────────────────────────────────────────┤
│  BackendSession interface                                            │
│  sessionId: string                                                   │
│  send(msg: UnifiedMessage): void                                     │
│  messages: AsyncIterable<UnifiedMessage>                             │
│  close(): Promise<void>                                              │
├──────────────────────────────────────────────────────────────────────┤
│  COMPOSED EXTENSIONS (additive, not baked in)                        │
│  Interruptible:     interrupt(): void                                │
│  Configurable:      setModel(), setPermissionMode()                  │
│  PermissionHandler: request/response bridging                        │
│  Reconnectable:     onDisconnect(), replay()                         │
│  Encryptable:       encrypt(), decrypt()                             │
└──────────────────────────────────────────────────────────────────────┘
```

| Adapter | Protocol | Backend | Notes |
|---------|----------|---------|-------|
| **Claude** | NDJSON/WS `--sdk` | Claude Code CLI (child process) | Streaming, permissions, teams |
| **ACP** | JSON-RPC/stdio | Goose, Kiro, Gemini (ACP mode) | Agent Client Protocol |
| **Codex** | JSON-RPC/WS | Codex CLI (OpenAI) | Thread/Turn/Item model, app-server |
| **Gemini** | Wraps ACP | Gemini CLI | Spawns `gemini --experimental-acp` |
| **OpenCode** | REST+SSE | opencode | Demuxed sessions |

**UnifiedMessage** is the canonical internal envelope:
```
╔════════════════════════════════════════════════════════════╗
║                    UnifiedMessage                          ║
║  id, timestamp, type, role, content[], metadata            ║
║  Supports: streaming (Claude), request/response (ACP),     ║
║  JSON-RPC (Codex/OpenCode)                                 ║
║  + metadata escape hatch for adapter-specific data         ║
║  + parentId for threading support                          ║
╚════════════════════════════════════════════════════════════╝
```

**State hierarchy:**
```
CoreSessionState → DevToolSessionState → SessionState
(adapter-agnostic)  (git branch, repo)   (model, tools,
                                          team, circuit
                                          breaker, ...)
```

---

## React Consumer

```
┌─────────────────────────────────────────────────────────────────────┐
│                     REACT CONSUMER (web/)                           │
│                     React 19 + Zustand + Tailwind v4 + Vite         │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  App.tsx (ErrorBoundary + Bootstrap)                           │ │
│  │                                                                │ │
│  │  ┌──────────────────────────────────────────────────────────┐  │ │
│  │  │  Layout                                                  │  │ │
│  │  │  ┌────────┐ ┌─────────────────────────────┐ ┌──────────┐ │  │ │
│  │  │  │Sidebar │ │  Main Area                  │ │AgentPane │ │  │ │
│  │  │  │        │ │  ┌───────────────────────┐  │ │          │ │  │ │
│  │  │  │Sessions│ │  │ TopBar                │  │ │AgentGrid │ │  │ │
│  │  │  │by date │ │  │ model, ContextGauge,  │  │ │AgentCol  │ │  │ │
│  │  │  │        │ │  │ connection status     │  │ │AgentRostr│ │  │ │
│  │  │  │Archive │ │  └───────────────────────┘  │ │          │ │  │ │
│  │  │  │mgmt    │ │  ┌────────────────────────┐ │ └──────────┘ │  │ │
│  │  │  │        │ │  │ ChatView / MessageFeed │ │              │  │ │
│  │  │  │Settings│ │  │ AssistantMessage       │ │              │  │ │
│  │  │  │footer  │ │  │ MessageBubble          │ │              │  │ │
│  │  │  │        │ │  │ UserMessageBubble      │ │              │  │ │
│  │  │  │Sound / │ │  │ ToolBlock / ToolGroup  │ │              │  │ │
│  │  │  │Notifs  │ │  │ ToolResultBlock        │ │              │  │ │
│  │  │  │Dark    │ │  │ ThinkingBlock          │ │              │  │ │
│  │  │  │mode    │ │  │ CodeBlock / DiffView   │ │              │  │ │
│  │  │  │        │ │  │ ImageBlock             │ │              │  │ │
│  │  │  │        │ │  │ PermissionBanner       │ │              │  │ │
│  │  │  │        │ │  │ StreamingIndicator     │ │              │  │ │
│  │  │  │        │ │  │ ResultBanner           │ │              │  │ │
│  │  │  └────────┘ │  └────────────────────────┘ │              │  │ │
│  │  │             │  ┌───────────────────────┐  │              │  │ │
│  │  │             │  │ Composer              │  │              │  │ │
│  │  │             │  │ SlashMenu             │  │              │  │ │
│  │  │             │  │ QueuedMessage         │  │              │  │ │
│  │  │             │  └───────────────────────┘  │              │  │ │
│  │  │             │  ┌───────────────────────┐  │              │  │ │
│  │  │             │  │ StatusBar             │  │              │  │ │
│  │  │             │  │ adapter, git, model,  │  │              │  │ │
│  │  │             │  │ permissions, worktree │  │              │  │ │
│  │  │             │  └───────────────────────┘  │              │  │ │
│  │  └──────────────────────────────────────────────────────────┘  │ │
│  │                                                                │ │
│  │  ┌─────────── Overlays ───────────────────────────────────┐    │ │
│  │  │ ToastContainer, LogDrawer, ConnectionBanner,           │    │ │
│  │  │ AuthBanner, TaskPanel, QuickSwitcher,                  │    │ │
│  │  │ ShortcutsModal, NewSessionDialog                       │    │ │
│  │  └────────────────────────────────────────────────────────┘    │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  store.ts — Zustand State                                           │
│  ws.ts    — WebSocket (auto-reconnect, session handoff, presence)   │
│  api.ts   — HTTP Client (REST CRUD for sessions)                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Daemon

```
┌───────────────────────────────────────────────────────────────────────┐
│  DAEMON                                                               │
│  ┌───────────┐ ┌───────────┐ ┌──────────┐ ┌────────────────────┐      │
│  │ Lock File │ │ State     │ │ Health   │ │ Control API        │      │
│  │ O_CREAT|  │ │ File      │ │ Check    │ │ HTTP 127.0.0.1:0   │      │
│  │ O_EXCL    │ │ PID, port │ │ 60s loop │ │                    │      │
│  │           │ │ heartbeat │ │          │ │ • list sessions    │      │
│  │           │ │ version   │ │          │ │ • create session   │      │
│  │           │ │           │ │          │ │ • stop session     │      │
│  │           │ │           │ │          │ │ • revoke-device    │      │
│  └───────────┘ └───────────┘ └──────────┘ └────────────────────┘      │
│  ┌───────────────────────────┐ ┌────────────────────────────────┐     │
│  │ ChildProcessSupervisor    │ │ SignalHandler                  │     │
│  │ spawns/tracks beamcode    │ │ SIGTERM/SIGINT graceful stop   │     │
│  │ server child processes    │ │                                │     │
│  └───────────────────────────┘ └────────────────────────────────┘     │
└───────────────────────────────────────────────────────────────────────┘
```

---

## Security Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     SECURITY LAYERS                              │
│                                                                  │
│  LAYER 1: Transport                                              │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • WebSocket origin validation (reject untrusted origins)   │  │
│  │ • CLI auth tokens (?token=SECRET per session)              │  │
│  │ • ConsumerGatekeeper: pluggable Authenticator interface    │  │
│  │ • ApiKeyAuthenticator: header-based auth                   │  │
│  │ • RBAC: PARTICIPANT vs OBSERVER role-based message filter  │  │
│  │ • Per-consumer rate limiting: token-bucket                 │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LAYER 2: E2E Encryption                                         │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • libsodium sealed boxes (XSalsa20-Poly1305)               │  │
│  │ • sodium_malloc for key material (mlock'd, not swappable)  │  │
│  │ • Per-message ephemeral keys (limited forward secrecy)     │  │
│  │ • Relay MUST NOT persist encrypted blobs (stateless only)  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LAYER 3: Authentication                                         │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • Permission signing: HMAC-SHA256(secret,                  │  │
│  │     request_id + behavior + timestamp + nonce)             │  │
│  │ • Anti-replay: nonce set (last 1000), 30s timestamp window │  │
│  │ • One-response-per-request (pendingPermissions in data)    │  │
│  │ • Secret established locally (daemon→CLI, never over relay)│  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LAYER 4: Device Management                                      │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • Session revocation: revoke-device → new keypair → re-pair│  │
│  │ • Pairing link expires in 60 seconds                       │  │
│  │ • Single device per pairing cycle                          │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LAYER 5: Resilience                                             │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • SlidingWindowBreaker: circuit breaker with snapshot API  │  │
│  │ • Structured error types (BeamCodeError hierarchy)         │  │
│  │ • Secret redaction in process output forwarding            │  │
│  │ • Watchdog timers for reconnect grace periods              │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  KNOWN METADATA LEAKS (documented, acceptable for MVP):          │
│  • Session ID (required for routing, random UUID)                │
│  • Message timing (reveals activity patterns)                    │
│  • Message size (large = code output, small = user input)        │
│  • Connection duration, IP addresses, message count              │
└──────────────────────────────────────────────────────────────────┘
```

---

## Cross-Cutting Infrastructure

| Module | Responsibility |
|--------|----------------|
| **BeamCodeError** | Structured error hierarchy (StorageError, ProcessError, etc.) |
| **FileStorage** | Debounced file writes with schema versioning and `flush()` for shutdown durability |
| **StateMigrator** | Schema version migration chain (v0 → v1+) |
| **StructuredLogger** | JSON-line logging with component context and level filtering |
| **SlidingWindowBreaker** | Circuit breaker with snapshot API for UI visibility |
| **ProcessManager** | Spawn, kill, isAlive — signal handling |
| **AdapterResolver** | Resolves adapter by name, factory for all adapters |
| **TokenBucketLimiter** | Per-consumer rate limiting |
| **ConsoleMetricsCollector** | Metrics collection → console output |
| **SessionOperationalHandler** | Privileged operations (list/close/archive sessions) |

---

## Module Dependency Graph

```
                    SessionCoordinator
                   ╱    │        │      ╲
                  ╱     │        │       ╲
                 ╱      │        │        ╲
                ▼       ▼        ▼         ▼
  ┌──────────────┐ ┌─────┐ ┌────────┐ ┌───────────────┐
  │ coordinator/ │ │event│ │Runtime │ │   Process     │
  │ •EventRelay  │ │s/   │ │ Map    │ │   Supervisor  │
  │ •Recovery    │ │dom- │ │(direct)│ │  (coordinator/│
  │ •LogService  │ │ain- │ │        │ │   ~278L)      │
  │ •Restore     │ │event│ │        │ │               │
  │ •ProcSupvsr  │ │-bus │ │        │ └───────────────┘
  └──────────────┘ │(~52)│ │        │
                   └──┬──┘ └───┬────┘
                      │        │
                      │        ▼
                      │ ┌──────────────┐       ┌────────────────┐
       ┌──────────────┤ │session/      │       │  policies/     │
       │              │ │SessionRuntime│       │  •Reconnect    │
       ▼              ▼ │  (actor)     │       │    (~119L)     │
  ┌────────────────┐    │              │       │  •Idle (~141L) │
  │ capabilities/  │    │  data:       │       │                │
  │  •Caps (~191L) │    │  SessionData │       │ capabilities/  │
  └────────────────┘    │  (readonly)  │       │  •Caps (~191L) │
                        │              │       └────────────────┘
                        │  handles:    │
                        │  SessionHndls│
                        └──────┬───────┘
                          delegates to
                               │
                    ┌──────────┴──────────────┐
                    ▼                         ▼
         ┌───────────────────┐      ┌──────────────────┐
         │ session/          │      │ session/         │
         │ SessionReducer    │      │ EffectExecutor   │
         │ (PURE FUNCTION)   │      │ (I/O dispatch)   │
         │                   │      │                  │
         │ Composes:         │      │ Dispatches to:   │
         │ •StateReducer     │      │ •Broadcaster     │
         │ •HistoryReducer   │      │ •BackendConnector│
         │ •EffectMapper     │      │ •DomainEventBus  │
         │ •LifecycleRules   │      │ •GitResolver     │
         │ •TeamReducer      │      │ •QueueHandler    │
         └───────────────────┘      └──────────────────┘
                    │                         │
              uses (pure)              uses (I/O)
                    │                         │
            ┌───────┴──────┐          ┌───────┴──────┐
            ▼              ▼          ▼              ▼
      ┌──────────┐  ┌──────────┐ ┌─────────┐ ┌─────────┐
      │messaging/│  │team/     │ │consumer/│ │backend/ │
      │•Mapper   │  │•Reducer  │ │Brdcstr  │ │Connector│
      │ (~343L)  │  │•Recog    │ │(~170L)  │ │(~644L)  │
      │•Normal   │  │•Correltn │ └─────────┘ └─────────┘
      │ (~124L)  │  │•Differ   │
      │•Tracer   │  └──────────┘
      │ (~631L)  │
      └──────────┘

  No cycles. Pure functions at leaves.
  Runtime delegates to pure reducer + effect executor.
  consumer/ + backend/ modules emit SessionEvents to coordinator.
  policies/ observe and advise via DomainEventBus.
  coordinator/ services handle cross-session concerns.

  DELETED (post-refactor):
  • session-bridge.ts — absorbed into coordinator
  • session-bridge/ (compose-*-plane.ts) — no longer needed
  • unified-message-router.ts — logic split into reducer + effects
  • bridge/ service modules — simplified into coordinator
```

---

## File Layout

```
src/core/
├── session-coordinator.ts           — top-level orchestrator + service registry
├── index.ts                         — barrel exports
│
├── backend/                         — BackendPlane
│   └── backend-connector.ts         — adapter lifecycle + consumption + passthrough (~644L)
│
├── capabilities/                    — Capabilities handshake policy
│   └── capabilities-policy.ts       — observe + advise (~191L)
│
├── consumer/                        — ConsumerPlane
│   ├── consumer-gateway.ts          — WS accept/reject/message, emits SessionEvents (~287L)
│   ├── consumer-broadcaster.ts      — broadcast + replay + presence (~170L)
│   └── consumer-gatekeeper.ts       — auth + RBAC + rate limiting (~157L)
│
├── coordinator/                     — Cross-session services for SessionCoordinator
│   ├── coordinator-event-relay.ts   — domain event wiring (~163L)
│   ├── process-log-service.ts       — stdout/stderr buffering + secret redaction (~41L)
│   ├── backend-recovery-service.ts  — timer-guarded relaunch dedup (~138L)
│   ├── process-supervisor.ts        — process spawn/track/kill (~278L)
│   └── startup-restore-service.ts   — ordered restore (~78L)
│
├── events/                          — Domain event infrastructure
│   ├── domain-event-bus.ts          — flat typed pub/sub bus (~52L)
│   └── typed-emitter.ts             — strongly-typed EventEmitter base (~55L)
│
├── interfaces/                      — Contract definitions
│   ├── backend-adapter.ts           — BackendAdapter + BackendSession interfaces
│   ├── domain-events.ts             — DomainEvent union type, DomainEventBus interface
│   ├── extensions.ts                — Composed adapter extensions
│   ├── runtime-commands.ts          — InboundCommand, PolicyCommand types
│   ├── session-events.ts            — SessionEvent, SystemSignal union types (NEW)
│   ├── effects.ts                   — Effect union type (NEW)
│   ├── session-data.ts              — SessionData, SessionHandles types (NEW)
│   ├── session-services.ts          — SessionServices registry type (NEW)
│   ├── session-launcher.ts          — Session launcher interface
│   ├── session-registry.ts          — Session registry interface
│   └── adapter-names.ts             — Adapter name constants
│
├── messaging/                       — Pure translation boundaries
│   ├── consumer-message-mapper.ts   — pure T4 mapper (~343L)
│   ├── inbound-normalizer.ts        — pure T1 mapper (~124L)
│   ├── message-tracer.ts            — debug tracing at T1/T2/T3/T4 (~631L)
│   └── trace-differ.ts              — diff computation for trace inspection (~143L)
│
├── policies/                        — Policy services (observe + advise)
│   ├── idle-policy.ts               — idle session sweep (~141L)
│   └── reconnect-policy.ts          — awaiting_backend watchdog (~119L)
│
├── session/                         — Per-session state + lifecycle + reducer
│   ├── session-runtime.ts           — per-session actor: process(event) (~400L, down from 659)
│   ├── session-reducer.ts           — top-level pure reducer (NEW, ~500L)
│   ├── session-state-reducer.ts     — AI context sub-reducer (~255L)
│   ├── history-reducer.ts           — message history sub-reducer (NEW, ~150L)
│   ├── effect-mapper.ts             — event → Effect[] mapping (NEW, ~300L)
│   ├── effect-executor.ts           — Effect → I/O dispatch (NEW, ~150L)
│   ├── session-repository.ts        — in-memory store + persistence (~253L)
│   ├── session-lifecycle.ts         — lifecycle state transitions
│   ├── session-transport-hub.ts     — transport wiring per session
│   ├── cli-gateway.ts               — CLI WebSocket connection handler
│   ├── buffered-websocket.ts        — early message buffering proxy
│   ├── git-info-tracker.ts          — git branch/repo resolution (~110L)
│   ├── message-queue-handler.ts     — queued message drain logic
│   ├── async-message-queue.ts       — async message queue implementation
│   └── simple-session-registry.ts   — in-memory session registry
│
├── slash/                           — Slash command subsystem
│   ├── slash-command-service.ts     — one execute() entrypoint (~70L)
│   ├── slash-command-chain.ts       — chain-of-responsibility strategies (~394L)
│   ├── slash-command-executor.ts    — strategy execution (~104L)
│   └── slash-command-registry.ts    — command registration (~176L)
│
├── team/                            — Team/multi-agent state
│   ├── team-state-reducer.ts        — pure reducer for team state (~272L)
│   ├── team-tool-correlation.ts     — tool result ↔ team member pairing (~92L)
│   ├── team-tool-recognizer.ts      — recognizes team tool patterns (~138L)
│   └── team-event-differ.ts         — team state diff → domain events (~104L)
│
└── types/                           — Core type definitions
    ├── unified-message.ts           — UnifiedMessage envelope (~363L)
    ├── core-session-state.ts        — CoreSessionState base type
    ├── team-types.ts                — Team member/task types
    └── sequenced-message.ts         — Sequence-numbered message wrapper

```

---

## Key Interfaces

```
┌──────────────────────────────────────────────────────────────────────┐
│  RUNTIME CONTRACTS                                                   │
│                                                                      │
│  SessionData           → readonly immutable session state            │
│  SessionHandles        → mutable runtime references                  │
│  SessionEvent          → BACKEND_MESSAGE | INBOUND_COMMAND | SIGNAL  │
│  Effect                → BROADCAST | SEND_TO_BACKEND | EMIT_EVENT    │
│                          RESOLVE_GIT_INFO | AUTO_SEND_QUEUED | ...   │
│  SessionServices       → broadcaster, connector, storage, tracer...  │
│                                                                      │
│  BackendAdapter        → connect(options): Promise<BackendSession>   │
│  BackendSession        → send(), messages (AsyncIterable), close()   │
│  SessionStorage        → save(), saveSync(), flush?(), load(), ...   │
│  Authenticator         → authenticate(context)                       │
│  Logger                → debug(), info(), warn(), error()            │
│  ProcessManager        → spawn(), kill(), isAlive()                  │
│  RateLimiter           → check()                                     │
│  CircuitBreaker        → attempt(), recordSuccess/Failure()          │
│  MetricsCollector      → recordTurn(), recordToolUse()               │
│  WebSocketServerLike   → listen(), close()                           │
│  WebSocketLike         → send(), close(), on()                       │
│  GitInfoResolver       → resolveGitInfo(cwd)                         │
│  DomainEventBus        → emit(event), on(type, handler): Disposable  │
│  SessionRepository     → persist(data), remove(id), restoreAll()     │
└──────────────────────────────────────────────────────────────────────┘
```