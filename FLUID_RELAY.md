# Fluid Relay — Upgraded BeamCode Fork

**Fork of [teng-lin/beamcode](https://github.com/teng-lin/beamcode)** with 8 upgrades targeting March 2026 best practices.

Named **fluid-relay** for its integration path with the Fluid Brain voice agent architecture — BeamCode's relay/fan-out model is the natural multiplexing layer between Fluid Brain's Cloudflare Workers + Durable Objects backend and multiple frontend consumers.

---

## Upgrades Implemented

### 1. MCP Server Surface (`src/mcp/mcp-server.ts`)

Exposes active BeamCode sessions as MCP tools via JSON-RPC over HTTP. Orchestrators (Claude Desktop, Cursor, other Claude Code instances) can discover and interact with sessions programmatically.

**Tools exposed:**
- `list_sessions` — enumerate active sessions
- `send_message` — send a user message to a session
- `get_history` — retrieve message history with pagination
- `approve_permission` — respond to pending permission requests
- `get_session_status` — detailed session inspection

**CLI:** `beamcode mcp serve [--port 9415]`

### 2. HTTP Streamable Transport (`src/relay/http-streamable-transport.ts`)

MCP 2025-03 compliant transport that replaces the cloudflared binary dependency. Uses Server-Sent Events (SSE) for server→client streaming and regular POST for client→server messages.

**Benefits:**
- No binary dependency required
- Works through corporate proxies
- Aligns with the MCP 2025-03 specification
- E2E encryption (libsodium) still applies at the message layer

**Endpoints:**
- `POST /mcp/stream` — client sends JSON-RPC message
- `GET /mcp/stream` — client receives SSE notification stream
- `GET /mcp/health` — health check

### 3. Agent Teams Coordination (`src/core/team/team-coordinator.ts`)

Upgrades the passive team layer (which only tracked presence) into an active task queue with claim/release semantics:

- `enqueue(task)` — add work to the shared queue
- `claim(taskId, agentId)` — atomically assign a task
- `release(taskId, agentId)` — release back to pool
- `complete(taskId, agentId)` — mark done, unblock dependents
- `getAvailable()` — list unclaimed tasks with met dependencies

All operations are idempotent. Emits events through the existing DomainEventBus for fan-out broadcast.

### 4. .mcp.json Auto-Discovery (`src/adapters/mcp-config-loader.ts`)

Reads `.mcp.json` from the project working directory at session-create time and auto-configures MCP tools. Makes BeamCode a first-class citizen of project-level toolchains.

### 5. Post-Quantum Crypto Interface (`src/utils/crypto/pqc-provider.ts`)

Unified crypto abstraction supporting:
- `x25519-xsalsa20-poly1305` (default) — current libsodium
- `ml-kem-768` (flag-gated) — NIST FIPS 203 lattice-based KEM
- `hybrid` (flag-gated) — both algorithms in parallel

ML-KEM-768 is interface-ready with stubs. Classical path delegates to existing libsodium. Feature-flagged via `setPQCEnabled(true)`.

### 6. Version Fix (`src/daemon/daemon.ts`)

Daemon health endpoint now reads version from `package.json` at runtime via `resolvePackageVersion()` instead of the hardcoded `"0.1.0"` string.

### 7. Consent Bypass Hardening (in `mcp-config-loader.ts`)

CVE-2026-21852 mitigation:
- Blocklists dangerous override settings (`autoApprove`, `trustAllServers`, etc.)
- Blocklists privilege-escalating env vars
- Blocklists dangerous command patterns
- Requires explicit user consent before activating project-scoped servers
- `formatConsentPrompt()` generates user-facing approval messages

### 8. gRPC Transport Adapter (`src/relay/grpc-transport-adapter.ts`)

Enterprise gRPC transport with full proto definition for:
- `StreamMessages` — bidirectional streaming
- `CreateSession` / `ListSessions` — session management
- `GetHistory` — server streaming replay
- `ApprovePermission` — permission handling

Requires `@grpc/grpc-js` as optional peer dependency. Includes embedded `.proto` definition accessible via `getProtoDefinition()`.

---

## File Manifest

| File | Upgrade |
|------|---------|
| `src/mcp/mcp-server.ts` | #1 — MCP server surface |
| `src/relay/http-streamable-transport.ts` | #2 — HTTP streamable transport |
| `src/core/team/team-coordinator.ts` | #3 — Agent Teams task coordination |
| `src/adapters/mcp-config-loader.ts` | #4, #7 — .mcp.json loader + CVE hardening |
| `src/utils/crypto/pqc-provider.ts` | #5 — Post-quantum crypto |
| `src/daemon/daemon.ts` | #6 — Version fix (edited) |
| `src/relay/grpc-transport-adapter.ts` | #8 — gRPC transport |
| `src/bin/beamcode.ts` | CLI `mcp serve` subcommand (edited) |
| `src/index.ts` | Barrel exports for all new modules (edited) |
| `src/utils/crypto/index.ts` | Crypto barrel exports (edited) |

---

## Fluid Brain Integration Notes

The relay architecture maps directly to Fluid Brain's needs:

- **Fan-out broadcast** → Multiple Fluid Brain devices (phone, desktop, watch) consuming the same agent session
- **HTTP Streamable Transport** → Runs behind Cloudflare Workers without binary dependencies
- **MCP server surface** → Fluid Brain's orchestrator layer can drive BeamCode sessions as tools
- **Team coordination** → Multiple Fluid Brain agents coordinating work through a shared task queue
- **PQC crypto** → Future-proofs the relay encryption for Fluid Brain's long-lived sessions

---

## License

MIT (inherited from beamcode)
