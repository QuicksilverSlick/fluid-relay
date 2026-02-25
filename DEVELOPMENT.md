# Development

Architecture reference, testing, and message tracing.

## Table of Contents

- [Architecture](#architecture)
- [Building](#building)
- [Testing](#testing)
- [UnifiedMessage Protocol](#unifiedmessage-protocol)
- [Message Tracing](#message-tracing)

---

## Architecture

See [docs/architecture.md](docs/architecture.md) for architecture diagrams, data flows, module decomposition, and package structure.

**Summary:** An HTTP+WS server routes `ConsumerMessage` / `InboundMessage` through `SessionBridge` (~386L, composition split across `bridge/` and `session-bridge/`) and `SessionCoordinator` (~400L, with extracted services in `coordinator/`) to a `BackendAdapter` — Claude, ACP, Codex, Gemini, or OpenCode. Core logic is organized into 14 subdirectories under `src/core/`: `backend/`, `bridge/`, `capabilities/`, `consumer/`, `coordinator/`, `events/`, `interfaces/`, `messaging/`, `policies/`, `session/`, `session-bridge/`, `slash/`, `team/`, `types/`. A daemon layer manages process lifecycle; a relay layer adds Cloudflare Tunnel + E2E encryption for remote access.

---

## Building

```sh
# Install dependencies
pnpm install

# Full build (library + web consumer)
pnpm build

# Library only
pnpm build:lib

# Web consumer only (outputs to web/dist/, copied to dist/consumer/)
pnpm build:web

# Type check
pnpm typecheck

# Architecture boundary checks
pnpm check:arch

# Lint / format
pnpm lint
pnpm check:fix
```

---

## Testing

BeamCode has **three test tiers**, all powered by [Vitest](https://vitest.dev/). You almost always want to start with unit tests, then validate on a real backend.

### Test Tiers at a Glance

| Tier | Command | Speed | Credentials | What it validates |
|------|---------|-------|-------------|-------------------|
| **Unit + Integration** | `pnpm test` | ~2s | None | Core logic, adapters, translators, crypto, daemon, session lifecycle, streaming, permissions, message queues |
| **E2E smoke** | `pnpm test:e2e:smoke` | ~30–60s | Binary only | Spawn, connect, init, clean shutdown — no AI calls |
| **E2E full** | `pnpm test:e2e:full` | minutes | Binary + API key or CLI OAuth | Live prompt/response, streaming, interrupt, multi-turn |
| **E2E real** | `pnpm test:e2e:real` | minutes | Binary + API key or CLI OAuth | All backend adapter tests — skips standalone infrastructure smoke files |

> Both E2E tiers can be scoped to a single adapter (e.g. `pnpm test:e2e:gemini`) or a single test name with `-t`. See [Running a Single Test](#running-a-single-test).

#### Integration tests

Session lifecycle, status flow, streaming conversation, permission routing, presence/RBAC, message queue, and WebSocket server flow tests run as `*.integration.test.ts` files alongside the modules they test (under `src/core/` and `src/server/`). They use `MockProcessManager` and require no credentials. They run automatically with `pnpm test`.

#### Why smoke vs full?

E2E tests are split into two tiers because they differ on **cost, speed, and credential requirements**:

| | Smoke | Full |
|---|---|---|
| **API calls** | None — only spawns the CLI binary | Sends real prompts, consumes tokens |
| **Credentials** | Binary in PATH is enough | Also needs API key or CLI OAuth (e.g. `claude auth login`) |
| **Duration** | ~30–60s (dominated by CLI startup) | Minutes (waiting for AI responses) |
| **CI trigger** | Every PR | Nightly only |
| **Failure means** | Process/connection/infrastructure bug | Message translation or protocol bug |

Smoke tests prove the infrastructure works (spawn → connect → init → teardown). Full tests prove the data path works (prompt → stream → assistant reply → result). If smoke passes but full fails, the bug is in message handling, not process management.

#### E2E Smoke

Smoke tests spawn the actual CLI binary (claude, gemini, codex, etc.) and verify:

- Process spawns and connects back to beamcode's WebSocket server
- Consumer receives `session_init` and `cli_connected`
- Multiple consumers, reconnection, and concurrent sessions work
- `deleteSession` cleans up properly

No prompts are sent — no AI API calls, no cost.

```bash
pnpm test:e2e:smoke            # all adapters
pnpm test:e2e:smoke:claude
pnpm test:e2e:smoke:agent-sdk
pnpm test:e2e:smoke:gemini
```

#### E2E Full

Full tests build on smoke by exercising live AI interactions:

- Send `user_message`, receive `assistant` reply with expected content
- `stream_event` messages arrive before `result`
- Multi-turn conversation (second prompt after first completes)
- Interrupt mid-turn and recover with a fresh prompt
- Broadcast assistant reply to multiple consumers
- `set_permission_mode` keeps backend healthy

These are gated behind `it.runIf(runFull)` in the shared test factory (`src/e2e/shared-e2e-tests.ts`). Duration varies by backend and API response time.

```bash
pnpm test:e2e:full             # all adapters + smoke files
pnpm test:e2e:real             # all adapters, skipping smoke files
pnpm test:e2e:claude           # shortcut for full:claude (smoke + AI)
pnpm test:e2e:full:claude      # explicit: smoke + AI
pnpm test:e2e:real:claude      # alias: smoke + AI
pnpm test:e2e:real:agent-sdk
pnpm test:e2e:real:codex
pnpm test:e2e:real:gemini
pnpm test:e2e:real:opencode
```

### Running a Single Test

Isolate by file and/or name. The `-t` flag matches a substring of the test description.

```bash
# Unit / mock E2E
pnpm exec vitest run -t "parseNDJSON"
pnpm exec vitest run src/utils/ndjson.test.ts

# Real backend — single file, single test
E2E_PROFILE=real-smoke USE_REAL_CLI=true \
  pnpm exec vitest run src/e2e/session-coordinator-claude.e2e.test.ts \
  --config vitest.e2e.real.config.ts \
  -t "launch emits process spawn"

# Per-backend shortcut scripts also accept -t via --
pnpm test:e2e:gemini -- -t "user_message gets an assistant reply"
pnpm test:e2e:claude -- -t "broadcast assistant reply"
```

### Real Backend Prerequisites

Tests auto-skip when a prerequisite is missing (detection logic in `src/e2e/prereqs.ts`).

| Backend | Binary | Auth |
|---------|--------|------|
| `claude` | `claude` in PATH | `ANTHROPIC_API_KEY` or `claude auth login` |
| `agent-sdk` | `claude` in PATH | `claude auth login` (uses CLI token, no API key needed) |
| `codex` | `codex` in PATH | handled by CLI |
| `gemini` | `gemini` in PATH | `GOOGLE_API_KEY` or CLI config |
| `opencode` | `opencode` in PATH | handled by CLI config |

### Frontend Tests

```bash
cd web && pnpm test          # all component tests
cd web && pnpm test:watch
cd web && pnpm exec vitest run src/components/Composer.test.tsx
```

Libraries: `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`.

### Coverage

```bash
pnpm exec vitest run --coverage       # backend → ./coverage/
cd web && pnpm exec vitest run --coverage  # frontend → ./web/coverage/
```

### CI Lanes

| Lane | Trigger | Scope |
|------|---------|-------|
| Unit + integration | Every PR | Core logic, session lifecycle, streaming, permissions, adapters |
| E2E smoke | PRs, Claude auth required¹ | Claude only (process + session) |
| E2E full | Nightly, per-adapter auth required² | All adapters |

¹ In CI, gated on the `ANTHROPIC_API_KEY` secret. Locally, OAuth (`claude auth login`) also works.

² Full nightly requires secrets for each adapter: `ANTHROPIC_API_KEY` (Claude / Agent SDK), `GOOGLE_API_KEY` (Gemini), and equivalent credentials for Codex and OpenCode. Until all secrets are configured in CI, run missing adapters manually before release.

> Until nightly CI is fully configured for all adapters, run `pnpm test:e2e:<adapter>` manually before releasing changes that affect a specific adapter.

### Debugging Real E2E Test Failures

Real backend tests spawn actual CLI processes and communicate over WebSockets. When a test fails, the error message alone is rarely enough.

#### Step 1: Read the automatic trace dump

Every real E2E test file runs `dumpTraceOnFailure()` in `afterEach`. When a test fails it prints to stderr — no flags needed:

- **Session state** — consumer count, last status, message history length, launcher state
- **Last 20 events** — `process:spawned`, `backend:connected`, `backend:disconnected`, `error`, …
- **Last 15 lines of CLI stderr** — auth failures, crash messages, stack traces
- **Last 10 lines of CLI stdout** — startup messages, version info

Common patterns:

| Symptom in trace | Likely cause |
|-----------------|--------------|
| `process:exited code=1` shortly after spawn | Binary not found, bad CLI args, or auth failure |
| `backend:disconnected` before any messages | CLI crashed during initialization |
| `error source=bridge` | Message translation or routing failure |
| No `backend:connected` event | CLI never connected back to beamcode's WS server |
| `capabilities:ready` missing | CLI connected but capability handshake timed out |
| stderr shows `API_KEY` errors | Missing or invalid credentials |

#### Step 2: Run with message tracing

If the trace dump isn't enough, enable `BEAMCODE_TRACE=1` and redirect stderr to a file:

```bash
BEAMCODE_TRACE=1 BEAMCODE_TRACE_LEVEL=full BEAMCODE_TRACE_ALLOW_SENSITIVE=1 \
  E2E_PROFILE=real-full USE_REAL_CLI=true \
  pnpm exec vitest run src/e2e/session-coordinator-gemini.e2e.test.ts \
  --config vitest.e2e.real.config.ts \
  -t "user_message gets an assistant reply" 2>trace.ndjson
```

Trace levels: `smart` (default — bodies included, sensitive keys redacted) · `headers` (timing + size, no body) · `full` (everything, requires `BEAMCODE_TRACE_ALLOW_SENSITIVE=1`)

#### Step 3: Inspect the trace

```bash
pnpm trace:inspect dropped-backend-types trace.ndjson   # dropped/unmapped message types
pnpm trace:inspect failed-context trace.ndjson           # failed /context attempts
pnpm trace:inspect empty-results-by-version trace.ndjson
```

Or query manually — each event is NDJSON with `boundary`, `diff`, `seq`, `layer`, `direction`:

```bash
# Show fields silently dropped at each translation boundary
grep '"boundary"' trace.ndjson | node -e "
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  const obj = JSON.parse(line);
  const drops = (obj.diff || []).filter(d => d.startsWith('-'));
  if (drops.length) console.log('[' + obj.boundary + '] ' + obj.messageType + ' DROPPED:', drops);
});
"
```

A `-fieldName` entry in the `diff` array means the field was **silently dropped** at that translation boundary.

#### Translation Boundary Quick Reference

| Boundary | Where bugs hide | File to fix |
|----------|----------------|-------------|
| T1 `InboundMessage → UnifiedMessage` | Consumer sends but backend ignores | `src/core/messaging/inbound-normalizer.ts` |
| T2 `UnifiedMessage → NativeCLI` | Backend receives wrong params | Adapter's `send()` method |
| T3 `NativeCLI → UnifiedMessage` | Backend response not translated | Adapter's message loop |
| T4 `UnifiedMessage → ConsumerMessage` | Consumer never receives the message | `src/core/messaging/unified-message-router.ts` |

#### Key files

| File | Purpose |
|------|---------|
| `src/test-utils/session-test-utils.ts` | `setupTestSessionCoordinator()`, `connectTestConsumer()`, `waitForMessageType()`, etc. |
| `src/e2e/helpers.ts` | `attachTrace()`, `dumpTraceOnFailure()`, `getTrace()` |
| `src/e2e/session-coordinator-setup.ts` | `setupRealSession()` — coordinator with trace attached |
| `src/e2e/prereqs.ts` | Binary/auth detection, auto-skip logic |
| `src/e2e/shared-e2e-tests.ts` | Shared parameterised test factory (`registerSharedSmokeTests`, `registerSharedFullTests`) |
| `src/core/messaging/message-tracer.ts` | `MessageTracerImpl` for T1–T4 boundary tracing |

### Shared Test Helpers

`src/test-utils/session-test-utils.ts`:

| Helper | Purpose |
|--------|---------|
| `createProcessManager()` | Profile-aware mock/real CLI process manager |
| `setupTestSessionCoordinator()` | Session coordinator with in-memory storage |
| `connectTestConsumer(port, id)` | Open a WebSocket as a consumer |
| `connectTestCLI(port, id)` | Open a WebSocket as a CLI client |
| `collectMessages(ws, count)` | Collect N messages from a WebSocket |
| `waitForMessage(ws, predicate)` | Wait until a message matches a predicate |
| `waitForMessageType(ws, type)` | Wait for a specific message type |
| `closeWebSockets(...sockets)` | Graceful WebSocket cleanup |
| `cleanupSessionCoordinator(mgr)` | Tear down a test session coordinator |

`src/test-utils/backend-test-utils.ts`: mock infrastructure per adapter (ACP subprocess, Codex WebSocket, OpenCode HTTP+SSE). Used by the adapter integration tests in `src/adapters/<name>/*.integration.test.ts`.

### Architecture Boundary Checks

```bash
pnpm check:arch
```

Current guards:
- Transport modules must not import backend lifecycle modules directly
- Policy modules must not import transport/backend lifecycle modules directly
- Transport modules must not emit `backend:*` events directly

Temporary exceptions go in `docs/refactor-plan/architecture-waivers.json` with `rule`, `file`, `reason`, and optional `expires_on`.

### Manual Testing

```bash
pnpm build
pnpm start --no-tunnel                        # start locally
curl http://localhost:9414/health              # health check
pnpm start --no-tunnel --port 8080

# With full trace output redirected to file
pnpm start --no-tunnel --verbose --trace --trace-level full --trace-allow-sensitive 2>trace.log
```

`Ctrl+C` once = graceful shutdown. `Ctrl+C` twice = force exit.

### Rebuild and Restart Guide

The frontend HTML (including bundled JS) is loaded from disk **once at startup** and cached in memory (`src/http/consumer-html.ts`). The server never re-reads it while running. A restart is therefore required whenever you rebuild either layer.

| Changed | Build command | Restart required? |
|---------|--------------|:-----------------:|
| Backend only (`src/`) | `pnpm build:lib` | ✅ |
| Frontend only (`web/src/`) | `pnpm build:web` | ✅ |
| Both | `pnpm build` | ✅ |

**Iterating on frontend UI without restarting:**

```bash
pnpm dev:web          # Vite dev server on port 5174, HMR enabled
```

Vite proxies the WebSocket to the already-running beamcode server on port 9414, so you get hot-reload on React/CSS changes without touching the server process. Use this for frontend-only iteration; switch to `pnpm build` + restart when you also change backend code.

---

## UnifiedMessage Protocol

See **[docs/unified-message-protocol.md](docs/unified-message-protocol.md)** for the full specification — all 19 message types, 7 content block types, field schemas, and versioning rules.

**Quick reference — types broadcast to consumers:**

| Type | Direction | Broadcast to UI |
|------|-----------|:---------------:|
| `session_init` | backend → consumer | ✅ |
| `status_change` | backend → consumer | ✅ |
| `assistant` | backend → consumer | ✅ |
| `result` | backend → consumer | ✅ |
| `stream_event` | backend → consumer | ✅ |
| `permission_request` | backend → consumer | ✅ |
| `tool_progress` | backend → consumer | ✅ |
| `tool_use_summary` | backend → consumer | ✅ |
| `auth_status` | backend → consumer | ✅ |
| `configuration_change` | backend → consumer | ✅ |
| `user_message` | consumer → backend | — |
| `permission_response` | consumer → backend | — |
| `interrupt` | consumer → backend | — |
| `session_lifecycle` | internal | ✅ |

#### `status_change` values

The `status` field on a `status_change` message reflects the session's current operational state:

| Value | Meaning |
|-------|---------|
| `"running"` | Actively processing a prompt |
| `"idle"` | Ready to accept a new message |
| `"compacting"` | Context window is being compacted |
| `"retry"` | Rate-limited — backend is waiting to retry; `metadata` contains `message`, `attempt`, and `next` (epoch ms until next attempt) |
| `null` | Unknown / transitional |

When `status === "retry"`, the frontend renders the message and attempt count in the streaming indicator and clears it automatically when the backend resumes.

---

## Message Tracing

BeamCode includes a debug tracing system that logs every message crossing a translation boundary as NDJSON to stderr. Useful for diagnosing message drops, field transformations, and timing issues across the frontend → bridge → backend pipeline.

### Enabling

```bash
# Smart mode (default): bodies included, large fields truncated, sensitive keys redacted
beamcode --trace

# Headers only: traceId, type, direction, timing, size — no body
beamcode --trace --trace-level headers

# Full payloads: every message logged as-is (requires explicit opt-in)
beamcode --trace --trace-level full --trace-allow-sensitive
pnpm start --no-tunnel --verbose --trace --trace-level full --trace-allow-sensitive 2>trace.log

# Environment-variable controls (CLI flags override env)
BEAMCODE_TRACE=1 beamcode
BEAMCODE_TRACE=1 BEAMCODE_TRACE_LEVEL=headers beamcode
BEAMCODE_TRACE=1 BEAMCODE_TRACE_LEVEL=full BEAMCODE_TRACE_ALLOW_SENSITIVE=1 beamcode
```

### Trace Inspect

Use `trace-inspect` for common operator queries on NDJSON trace logs:

```bash
pnpm trace:inspect dropped-backend-types trace.ndjson
pnpm trace:inspect failed-context trace.ndjson
pnpm trace:inspect empty-results-by-version trace.ndjson
```

### Translation Boundaries

There are 4 translation boundaries where bugs hide:

| # | Boundary | Translator | Location |
|---|----------|-----------|----------|
| T1 | `InboundMessage` → `UnifiedMessage` | `normalizeInbound()` | `src/core/messaging/inbound-normalizer.ts` |
| T2 | `UnifiedMessage` → Native CLI format | Adapter outbound translator | Each adapter's `send()` method |
| T3 | Native CLI response → `UnifiedMessage` | Adapter inbound translator | Each adapter's message loop |
| T4 | `UnifiedMessage` → `ConsumerMessage` | `map*()` functions | `src/core/messaging/unified-message-router.ts` |

Each boundary emits a `translate` trace event with before/after objects and an auto-generated diff. A field appearing as `-metadata.someField` in the diff means it was **silently dropped** at that boundary.

### Trace Event Schema

```json
{
  "trace": true,
  "traceId": "t_a1b2c3d4",
  "layer": "bridge",
  "direction": "translate",
  "messageType": "user_message",
  "sessionId": "sess-abc",
  "seq": 17,
  "ts": "2026-02-19T10:30:00.123Z",
  "elapsed_ms": 3,
  "translator": "normalizeInbound",
  "boundary": "T1",
  "from": { "format": "InboundMessage", "body": {} },
  "to": { "format": "UnifiedMessage", "body": {} },
  "diff": ["session_id → metadata.session_id", "+role: user"]
}
```

### Key Files

| File | Purpose |
|------|---------|
| `src/core/messaging/message-tracer.ts` | `MessageTracer` interface, `MessageTracerImpl`, `noopTracer` |
| `src/core/messaging/trace-differ.ts` | Auto-diff utility for translation events |

### Programmatic Usage

```ts
import { MessageTracerImpl, noopTracer } from "beamcode";

const tracer = new MessageTracerImpl({ level: "smart", allowSensitive: false });
const mgr = new SessionManager({ config, launcher, tracer });
```

When `--trace` is not set, `noopTracer` is used — all methods are empty functions with zero overhead.
