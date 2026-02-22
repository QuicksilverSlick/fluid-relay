# Unified Message Protocol — Discovery Report & Gap Closure Plan

*Last updated: 2026-02-22*

---

# Part 1: Discovery Report

## 1. Protocol Architecture

```
┌──────────────┐   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐   ┌──────────┐   ┌─────────┐
│   Claude     │   │  Agent SDK  │    │   Codex     │    │  OpenCode   │   │   ACP    │   │ Gemini  │
│  (CLI/NDJSON)│   │  (in-proc)  │    │ (JSON-RPC)  │    │   (SSE)     │   │(JSON-RPC)│   │ (→ACP)  │
└──────┬───────┘   └──────┬──────┘    └──────┬──────┘    └──────┬──────┘   └────┬─────┘   └────┬────┘
       │                  │                  │                  │               │              │
       ▼                  ▼                  ▼                  ▼               ▼              ▼
   message-          sdk-message-       codex-message-     opencode-message-  outbound-     (delegates
   translator.ts     translator.ts      translator.ts      translator.ts      translator.ts  to ACP)
       │              │ (delegates             │                  │               │
       │◄─────────────┘  to Claude)            │                  │               │
       │                                       │                  │               │
       └───────────────────────────────────────┴──────────────────┴───────────────┘
                                               │
                                      ┌────────▼────────┐
                                      │  UnifiedMessage │  ← 19 types, 7 content types
                                      └────────┬────────┘
                                               │
                                  ┌────────────┼────────────────┐
                                  ▼                             ▼
                         ┌────────────────┐           ┌──────────────────┐
                         │  State Reducer │           │  Message Router  │
                         │ (5 switch cases│           │ (12 switch cases │
                         │  + team scan)  │           │  + default trace)│
                         └────────────────┘           └────────┬─────────┘
                                                               │
                                                      ┌────────▼────────┐
                                                      │ Consumer Mapper │  ← maps 10 types to consumer
                                                      └────────┬────────┘
                                                               │
                                                      ┌────────▼────────┐
                                                      │   Frontend UI   │
                                                      └─────────────────┘
```

Note: The state reducer runs **before** the router switch on every message. It has explicit switch cases for `session_init`, `status_change`, `result`, `control_response`, and `configuration_change`. All other message types fall through to team tool-use correlation (scanning content blocks for team tool invocations — meaningful only for `assistant` and `tool_use_summary`). Team state changes are broadcast via `emitTeamEvents()` after reduction, not through the router switch.

## 2. Current UnifiedMessage Type Coverage

**19 types defined**, **12 have router switch handlers**, **10 have consumer mappers**, and **1 has a default trace handler**:

| UnifiedMessageType | Router Switch | Consumer Mapper | State Reducer | Broadcast to UI |
|---|:---:|:---:|:---:|:---:|
| `session_init` | YES | — (direct) | YES | YES |
| `status_change` | YES | — (direct) | YES | YES |
| `assistant` | YES | YES | YES (team scan) | YES |
| `result` | YES | YES | YES | YES |
| `stream_event` | YES | YES | — | YES |
| `permission_request` | YES | YES (filtered) | — | YES |
| `control_response` | YES (delegates) | — | YES (stub) | NO |
| `tool_progress` | YES | YES | — | YES |
| `tool_use_summary` | YES | YES | YES (team scan) | YES |
| `auth_status` | YES | YES | — | YES |
| `configuration_change` | YES | YES | YES | YES |
| `session_lifecycle` | YES | YES | — | YES |
| `user_message` | NO | NO | — | NO |
| `permission_response` | NO | NO | — | NO |
| `interrupt` | NO | NO | — | NO |
| `team_message` | NO — taxonomy only | NO | YES (via correlation) | YES (via team diff) |
| `team_task_update` | NO — taxonomy only | NO | YES (via correlation) | YES (via team diff) |
| `team_state_change` | NO — taxonomy only | NO | YES (via correlation) | YES (via team diff) |
| `unknown` | default (traced) | NO | — | NO |

**Notes:**
- `user_message`, `permission_response`, `interrupt` are intentionally consumer→backend only (outbound translation, never routed inbound).
- `team_*` types are a classification taxonomy used by `team-tool-recognizer.ts` to tag tool_use content blocks. They are **never emitted as standalone routable messages**. Team state is derived by the state reducer scanning `assistant`/`tool_use_summary` messages for team-related tool invocations, then broadcasting diffs as `session_update` events.
- `permission_request` mapper returns `null` for non-`can_use_tool` subtypes — a silent filter point (see Section 5).
- `unknown` falls through to the router's default case and is traced for diagnosability.
- State reducer `control_response` case is a stub — capabilities are applied by the router handler, not the reducer.

## 3. UnifiedContent Type Coverage

**7 types defined:**

| Content Type | Produced By (as content blocks in `assistant` messages) | Consumer Mapper |
|---|---|:---:|
| `text` | All adapters | YES |
| `tool_use` | Claude, Agent SDK | YES |
| `tool_result` | Claude, Agent SDK | YES |
| `thinking` | Claude, Agent SDK, OpenCode, ACP | YES |
| `refusal` | Claude, Agent SDK, Codex | YES |
| `code` | Claude, Agent SDK (forward-compat) | YES |
| `image` | Claude, Agent SDK (forward-compat), ACP inbound | YES |

**Adapter content block handling:**
- **Claude adapter** handles all 7 content types: `text`, `tool_use`, `tool_result`, `thinking`, `image`, `code`, `refusal`. Truly unknown block types (not in the 7-type union) are converted to empty text blocks with `dropped_content_block_types` tracked in metadata.
- **Agent SDK adapter** delegates `assistant` messages to the Claude translator, inheriting all 7 content types. SDK-specific message types (`hook_*`, `task_*`, `compact_boundary`, `files_persisted`) are translated directly in `sdk-message-translator.ts`.
- **Codex adapter** produces `text` and `refusal` as content blocks in `assistant` messages. Tool calls (`function_call`, `function_call_output`) are separate Codex items translated to standalone `tool_progress`/`tool_use_summary` messages, not content blocks.
- **OpenCode adapter** maps tool parts as separate `tool_progress`/`tool_use_summary` messages rather than content blocks. Text and reasoning parts produce `stream_event` messages with text/thinking content.
- **ACP adapter** produces `text` and `thinking` content blocks from `agent_message_chunk`/`agent_thought_chunk` events. Tool calls are separate session updates translated to `tool_progress`/`tool_use_summary` messages. Image content is supported inbound (user→backend) only.

## 4. Cross-Adapter Feature Matrix

### Streaming & Content

| Capability | Claude | Agent SDK | Codex | OpenCode | ACP/Gemini | Unified Protocol |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Text streaming | `stream_event` | `stream_event` (via Claude delegation) | `response.output_text.delta` + `item/agentMessage/delta` | `message.part.updated` + `message.part.delta` | `agent_message_chunk` | `stream_event` (YES) |
| Thinking/reasoning | `thinking` block | `thinking` block (via Claude delegation) | — | `reasoning` part | `agent_thought_chunk` | `ThinkingContent` (YES) |
| Refusal | `refusal` block | `refusal` block (via Claude delegation) | `refusal` part | — | — | `RefusalContent` (YES) |
| Image content | (forward-compat) | (forward-compat, via Claude delegation) | — | — | YES (inbound user→backend) | `ImageContent` (YES) |
| Code content | (forward-compat) | (forward-compat, via Claude delegation) | — | — | — | `CodeContent` (YES) |

### Tool Execution

| Capability | Claude | Agent SDK | Codex | OpenCode | ACP/Gemini | Unified Protocol |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Tool invocation | `tool_progress` | `tool_progress` (via Claude delegation) | `response.output_item.added` (function_call) | tool part `running` | `tool_call` | `tool_progress` (YES) |
| Tool completion | `tool_use_summary` | `tool_use_summary` (via Claude delegation) | `response.output_item.done` (function_call_output) | tool part `completed` | `tool_call_update` (completed) | `tool_use_summary` (YES) |
| Tool pending | — | — | — | tool part `pending` | — | `tool_progress` (YES) |
| Tool error | — | — | — | tool part `error` | `tool_call_update` (failed) | `tool_use_summary` (YES) |

### Permissions & Control

| Capability | Claude | Agent SDK | Codex | OpenCode | ACP/Gemini | Unified Protocol |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Permission request | `control_request` | `canUseTool` callback → `permission_request` (via PermissionBridge) | `approval_requested` + `item/commandExecution/requestApproval` + `item/fileChange/requestApproval` | `permission.updated` | `session/request_permission` | `permission_request` (YES) |
| Interrupt/cancel | `control_request` (interrupt) | `query.interrupt()` | `turn/interrupt` (modern) / `turn.cancel` (legacy) | HTTP POST abort | `session/cancel` | `interrupt` (YES) |

### Error Handling

| Capability | Claude | Agent SDK | Codex | OpenCode | ACP/Gemini | Unified Protocol |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Error subtypes | 3 codes: `max_turns`, `max_budget`, `execution_error` | Inherits Claude codes (via delegation) + `execution_error` on catch | 4 codes: `rate_limit`, `output_length`, `aborted`, `execution_error` | 6 codes: `provider_auth`, `output_length`, `aborted`, `context_overflow`, `api_error`, `unknown` | Pluggable classifier; Gemini: `provider_auth`, `rate_limit`, `context_overflow`, `api_error` | `UnifiedErrorCode` (YES) |

### Session Lifecycle & Configuration

| Capability | Claude | Agent SDK | Codex | OpenCode | ACP/Gemini | Unified Protocol |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Session init | `system/init` | `system:init` (via Claude delegation) | `initialize` response | `server.connected` | `initialize` result | `session_init` (YES) |
| Session compaction | `is_compacting` flag in status | `compact_boundary` → `status_change` | `/compact` slash cmd (outbound only) | `session.compacted` | — | `status_change` (Claude/Agent SDK) / `session_lifecycle` (OpenCode) |
| Message removal | — | — | — | `message.removed` | — | `session_lifecycle` (YES) |
| Step boundaries | — | — | — | `step-start`/`step-finish` | — | `status_change` (YES) |
| Plan display | — | — | — | — | `plan` session update | `status_change` (YES) |
| Dynamic commands | slash_commands in init (static) | — | — | — | `available_commands_update` | `configuration_change` (YES) |
| Mode/config change | — | — | — | — | `current_mode_update` | `configuration_change` (YES) |
| Session lifecycle | — | — | `thread/started` → `session_created` | 5 of 7 events | — | `session_lifecycle` (YES) |
| Model switching | `set_model` (outbound) | — | — | model in prompt params | `session/set_model` | `configuration_change` (YES) |
| Slash commands | YES (bridge-level) | — (SDK-native, not proxied) | YES (4 custom: `/compact`, `/new`, `/review`, `/rename`) | NO | YES (via `available_commands_update`) | Adapter-specific |
| Hook lifecycle | — | `hook_started`/`hook_progress`/`hook_response` → `status_change` | — | — | — | `status_change` (Agent SDK only) |
| Task lifecycle | — | `task_started`/`task_notification` → `status_change` | — | — | — | `status_change` (Agent SDK only) |
| Files persisted | — | `files_persisted` → `status_change` | — | — | — | `status_change` (Agent SDK only) |

### Observability & Auth

| Capability | Claude | Agent SDK | Codex | OpenCode | ACP/Gemini | Unified Protocol |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Token usage | Full (per-turn + per-model + cache) | Full (via Claude delegation) | — | Full (input, output, reasoning, cache + cost) | Passthrough (forwarded from prompt result) | Partial (shape varies by adapter) |
| Auth flow | `auth_status` messages | `auth_status` (via Claude delegation) | — | `provider_auth` → `auth_status` | `auth_status` on provider_auth errors + `authMethods` in init | `auth_status` (YES) |
| Teams | YES (`teams: true`) | YES (`teams: true`) | — | — | — | 3 types (state-only, Claude/Agent SDK) |

## 5. Complete Silent Drop Inventory

**19 drop points** across 6 adapters. All drops are intentional — categorized below.

| # | Layer | File | What's Dropped | Category |
|---|---|---|---|---|
| 1 | Claude adapter | `message-translator.ts` | `keep_alive` messages → `null` | Heartbeat |
| 2 | Claude adapter | `message-translator.ts` | `user` echo messages → `null` | Intentional |
| 3 | Claude adapter | `message-translator.ts` | Unknown CLI types → `null` | Defensive |
| 4 | Claude adapter | `message-translator.ts` | Unknown content block types (outside the 7-type union) → empty text (tracked in `dropped_content_block_types` metadata) | Defensive |
| 5 | Codex adapter | `codex-message-translator.ts` | Unknown event types → `null` | Defensive |
| 5b | Codex adapter | `codex-message-translator.ts` | Unknown item types in `translateItemAdded`/`translateItemDone` → `null` | Defensive |
| 7 | OpenCode adapter | `opencode-message-translator.ts` | `server.heartbeat` → `null` | Heartbeat |
| 8 | OpenCode adapter | `opencode-message-translator.ts` | `permission.replied` → `null` | Intentional |
| 11 | OpenCode adapter | `opencode-message-translator.ts` | `session.updated` → `null` | Future |
| 13 | OpenCode adapter | `opencode-message-translator.ts` | `session.diff` → `null` | Intentional |
| 15b | OpenCode adapter | `opencode-message-translator.ts` | Non-text field deltas (`translateDelta` returns `null` if `field !== "text"`) | Intentional |
| 16 | OpenCode adapter | `opencode-message-translator.ts` | Unknown event types → `null` | Defensive |
| 19 | ACP adapter | `outbound-translator.ts` | Unknown session updates → `unknown` type (passthrough, not truly silent) | Defensive |
| 20 | ACP adapter | `acp-session.ts` | `fs/*`, `terminal/*` requests → error stub response | Feature gap |
| 25 | Consumer mapper | `consumer-message-mapper.ts` | `permission_request` with subtype ≠ `can_use_tool` → `null` (not broadcast) | Intentional |
| 26 | Agent SDK adapter | `sdk-message-translator.ts` | `user` echo messages → `null` | Intentional |
| 27 | Agent SDK adapter | `sdk-message-translator.ts` | `keep_alive` messages → `null` | Heartbeat |
| 28 | Agent SDK adapter | `sdk-message-translator.ts` | Unknown top-level message types → `null` | Defensive |
| 29 | Agent SDK adapter | `sdk-message-translator.ts` | Unknown `system` subtypes → `null` | Defensive |

### Drop Categories

**Intentional** (7 drops: #2, #8, #13, #15b, #25, #26) — Correctly dropped, no future action needed.
- **#2** `user` echo: The bridge already sent this message; echoing it would duplicate in the UI.
- **#8** `permission.replied`: Server-side ack that our permission reply was received. UI already updated optimistically.
- **#13** `session.diff`: Incremental state diffs. Full state arrives via `message.updated`, `part.updated`, etc. Consuming diffs would require a diff-apply engine for no consumer benefit.
- **#15b** Non-text field deltas: Only text deltas are meaningful for streaming display.
- **#25** Non-`can_use_tool` permissions: Currently the only permission subtype; others are filtered as a safety measure.
- **#26** Agent SDK `user` echo: Same rationale as #2 — echo suppression at the SDK translator layer.

**Defensive** (8 drops: #3, #4, #5, #5b, #16, #19, #28, #29) — Catch-all fallbacks for unknown/future wire types. Traced at the session level.

**Heartbeat** (3 drops: #1, #7, #27) — Connection keepalives with future potential. See "Future: Connection Health" below.

**Future** (1 drop: #11) — Actionable in future work. See "Future: Session Title Updates" below.

**Feature gap** (1 drop: #20) — Requires new feature development. See "Future: ACP Host Capabilities" below.

### Future: Connection Health (#1, #7, #27)

Claude's `keep_alive`, OpenCode's `server.heartbeat`, and Agent SDK's `keep_alive` are periodic signals that confirm the backend connection is alive. Today they are dropped silently. These could:
- Feed a **connection watchdog** — if heartbeats stop arriving, the consumer knows the backend is unresponsive and can show a "reconnecting" indicator.
- Emit a lightweight `status_change` with `status: "connected"` or a dedicated `heartbeat` message type.

**When to implement**: When the frontend adds a connection health indicator or stale-session detection.

### Future: Session Title Updates (#11)

OpenCode's `session.updated` carries the full `OpencodeSession` object including `title`, `summary`, and `share` fields. The session title is auto-generated from the first prompt and changes mid-session. Today this event is dropped because the title doesn't surface in the UI. Could map to `session_lifecycle(session_updated)` with `title` metadata when the frontend supports dynamic session titles.

### Future: ACP Host Capabilities (#20)

ACP agents (e.g., Goose) send `fs/read_text_file`, `fs/write_text_file`, `terminal/execute` JSON-RPC requests asking the host to perform file/terminal operations on their behalf. BeamCode currently stubs these with `-32601 Method not supported`. Implementing this would mean BeamCode acts as a sandboxed execution host for ACP agents — a significant feature that goes beyond the unified message protocol.

## 6. Metadata Key Inconsistencies

| Concept | Claude | Agent SDK | Codex | OpenCode | ACP | Status |
|---|---|---|---|---|---|---|
| Session ID | `session_id` | `session_id` (via Claude) | `session_id` | `session_id` | `session_id` | **RESOLVED** |
| Tool call ID | `tool_use_id` | `tool_use_id` (via Claude) | `tool_use_id` | `tool_use_id` | `tool_use_id` | **RESOLVED** |
| Error flag | `is_error` | `is_error` (via Claude) | `is_error` | `is_error` | `is_error` | Consistent |
| Error detail | `error` (string) | `error` (via Claude) | `error` (string) | `error` + `error_name` + `error_message` | — | **RESOLVED** — OpenCode now emits canonical `error` key alongside adapter-specific keys |
| Error code | `error_code` | `error_code` (via Claude) | `error_code` | `error_code` | `error_code` | **RESOLVED** |
| Model ID | `model` | `model` (via Claude) | (not emitted) | `model_id` + `provider_id` | varies | **INCONSISTENT** — no canonical `model` key across adapters |
| Tool status | `status` (string) | `status` (via Claude) | `status` (string) | `status` (string) | `status` (string) | **RESOLVED** — Codex `done: true` removed; all adapters use `status` string |
| Thinking | content block | content block (via Claude) | — | content block | content block | Consistent (via `ThinkingContent`) |
| Cost/usage | `usage` object | `usage` object (via Claude) | — | `cost` + `tokens` | passthrough (`inputTokens` + `outputTokens` if present) | **INCONSISTENT** — Claude/Agent SDK/OpenCode/ACP provide usage in different shapes; Codex doesn't provide it |

## 7. Remaining Open Issues

### ISSUE 1: ~~Metadata Shape Divergence Across Adapters~~ — PARTIALLY RESOLVED

~~**Severity:** Medium~~

Most metadata keys are now consistent across adapters:
- **Error detail**: OpenCode now emits canonical `error` key alongside `error_name`/`error_message`
- **Tool status**: Codex `done: true` removed; all adapters use `status` string
- **Error code**: All adapters produce canonical `UnifiedErrorCode` values

Remaining inconsistencies (lower priority):
- **Model ID**: Claude uses `model`, OpenCode uses `model_id` + `provider_id`, Codex doesn't emit it
- **Cost/usage**: Claude/Agent SDK (`usage` object), OpenCode (`cost` + `tokens`), and ACP (passthrough `inputTokens`/`outputTokens`) provide usage in different shapes; Codex doesn't provide it
