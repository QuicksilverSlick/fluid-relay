/**
 * Session state types — the two halves of per-session state.
 *
 * - `SessionData` — the serializable, immutable slice. All fields are readonly.
 *   Only `SessionRuntime` may produce new `SessionData` objects (by spreading:
 *   `{ ...data, state: newState }`). Nothing else may mutate session state —
 *   the compiler enforces this.
 *
 * - `SessionHandles` — the non-serializable runtime references. These are
 *   mutable and managed directly by `SessionRuntime` (not through the reducer).
 *   They do not survive process restarts.
 *
 * @module SessionControl
 */
import type { ConsumerIdentity } from "../../interfaces/auth.js";
import type { RateLimiter } from "../../interfaces/rate-limiter.js";
import type { WebSocketLike } from "../../interfaces/transport.js";
import type { PermissionRequest } from "../../types/cli-messages.js";
import type { ConsumerMessage } from "../../types/consumer-messages.js";
import type { SessionState } from "../../types/session-state.js";
import type { AdapterSlashExecutor, BackendSession } from "../interfaces/backend-adapter.js";
import type { SlashCommandRegistry } from "../slash/slash-command-registry.js";
import type { TeamToolCorrelationBuffer } from "../team/team-tool-correlation.js";
import type { UnifiedMessage } from "../types/unified-message.js";
import type { QueuedMessage } from "./session-repository.js";

// ── SessionHandles — mutable, non-serializable runtime references ────────────

export interface SessionHandles {
  /** BackendSession from BackendAdapter. */
  backendSession: BackendSession | null;
  /** AbortController for the backend message consumption loop. */
  backendAbort: AbortController | null;
  consumerSockets: Map<WebSocketLike, ConsumerIdentity>;
  consumerRateLimiters: Map<WebSocketLike, RateLimiter>;
  anonymousCounter: number;
  lastActivity: number;
  pendingInitialize: {
    requestId: string;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  /** Per-session correlation buffer for team tool_use↔tool_result pairing. */
  teamCorrelationBuffer: TeamToolCorrelationBuffer;
  /** Per-session slash command registry. */
  registry: SlashCommandRegistry;
  /** FIFO queue of passthrough slash commands awaiting CLI responses. */
  pendingPassthroughs: Array<{
    command: string;
    requestId?: string;
    slashRequestId: string;
    traceId: string;
    startedAtMs: number;
  }>;
  /** Adapter-specific slash command executor (e.g. Codex JSON-RPC translation). */
  adapterSlashExecutor: AdapterSlashExecutor | null;
}

// ── SessionData — immutable, serializable ────────────────────────────────────

export interface SessionData {
  /** Extracted from `session_init`. Absent until first backend connection. */
  readonly backendSessionId?: string;
  readonly state: SessionState;
  readonly pendingPermissions: ReadonlyMap<string, PermissionRequest>;
  readonly messageHistory: readonly ConsumerMessage[];
  readonly pendingMessages: readonly UnifiedMessage[];
  readonly queuedMessage: QueuedMessage | null;
  readonly lastStatus: "compacting" | "idle" | "running" | null;
  readonly adapterName?: string;
  readonly adapterSupportsSlashPassthrough: boolean;
}
