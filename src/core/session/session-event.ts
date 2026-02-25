/**
 * SessionEvent — all inputs to `SessionRuntime.process()`.
 *
 * Every external stimulus that can change session state is represented as a
 * SessionEvent variant. The runtime dispatches on `event.type` and delegates
 * to the appropriate handler/reducer. This gives us a single entry point,
 * making the runtime easier to reason about and test.
 *
 * @module SessionControl
 */

import type { ConsumerIdentity } from "../../interfaces/auth.js";
import type { WebSocketLike } from "../../interfaces/transport.js";
import type {
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
} from "../../types/cli-messages.js";
import type { SessionState } from "../../types/session-state.js";
import type { AdapterSlashExecutor, BackendSession } from "../interfaces/backend-adapter.js";
import type { InboundCommand } from "../interfaces/runtime-commands.js";
import type { QueuedMessage } from "../session/session-repository.js";
import type { TeamState } from "../types/team-types.js";
import type { UnifiedMessage } from "../types/unified-message.js";

/**
 * All system-level signals that can arrive at a session.
 *
 * These are emitted by transport modules (BackendConnector, ConsumerGateway)
 * and policy services — never by the runtime itself.
 */
export type SystemSignal =
  /** Backend adapter connected — hand off the BackendSession. */
  | {
      kind: "BACKEND_CONNECTED";
      backendSession: BackendSession;
      backendAbort: AbortController;
      supportsSlashPassthrough: boolean;
      slashExecutor: AdapterSlashExecutor | null;
    }
  /** Backend adapter disconnected unexpectedly (stream ended or error). */
  | { kind: "BACKEND_DISCONNECTED"; reason: string }
  /** A consumer WebSocket connected and was authenticated. */
  | { kind: "CONSUMER_CONNECTED"; ws: WebSocketLike; identity: ConsumerIdentity }
  /** A consumer WebSocket disconnected. */
  | { kind: "CONSUMER_DISCONNECTED"; ws: WebSocketLike }
  /** Git info was resolved asynchronously. */
  | { kind: "GIT_INFO_RESOLVED" }
  /** Capabilities handshake completed successfully. */
  | { kind: "CAPABILITIES_READY" }
  /** Session is idle with no consumers — eligible for reaping. */
  | { kind: "IDLE_REAP" }
  /** Backend did not connect within the reconnect grace window. */
  | { kind: "RECONNECT_TIMEOUT" }
  /** Capabilities did not arrive within the timeout window. */
  | { kind: "CAPABILITIES_TIMEOUT" }
  /** Backend needs to be relaunched (e.g. consumer connected but CLI is dead). */
  | { kind: "BACKEND_RELAUNCH_NEEDED" }
  /** Session is closing — initiated by coordinator before teardown. */
  | { kind: "SESSION_CLOSING" }
  /** Explicit session close initiated by coordinator. */
  | { kind: "SESSION_CLOSED" }
  /** Merge a partial SessionState patch into data.state (no lifecycle change). Broadcasts session_update if broadcast=true. */
  | { kind: "STATE_PATCHED"; patch: Partial<SessionState>; broadcast?: boolean }
  /** Set lastStatus directly (e.g. optimistic "running" from MessageQueueHandler). */
  | { kind: "LAST_STATUS_UPDATED"; status: "compacting" | "idle" | "running" | null }
  /** Set queuedMessage (managed by MessageQueueHandler). */
  | { kind: "QUEUED_MESSAGE_UPDATED"; message: QueuedMessage | null }
  /** Optimistic model update with session_update broadcast (used by sendSetModel). */
  | { kind: "MODEL_UPDATED"; model: string }
  /** Set the adapter name for the session (used during session creation / process spawn). */
  | { kind: "ADAPTER_NAME_SET"; name: string }
  /** Slash passthrough command completed successfully. */
  | {
      kind: "SLASH_PASSTHROUGH_RESULT";
      command: string;
      requestId?: string;
      content: string;
      source: "cli" | "emulated";
    }
  /** Slash passthrough command failed. */
  | { kind: "SLASH_PASSTHROUGH_ERROR"; command: string; requestId?: string; error: string }
  /** Local/adapter-native slash command completed successfully. */
  | {
      kind: "SLASH_LOCAL_RESULT";
      command: string;
      requestId?: string;
      content: string;
      source: string;
      durationMs: number;
    }
  /** Local/adapter-native slash command failed. */
  | { kind: "SLASH_LOCAL_ERROR"; command: string; requestId?: string; error: string }
  /** A passthrough slash command was enqueued for the CLI. */
  | {
      kind: "PASSTHROUGH_ENQUEUED";
      entry: {
        command: string;
        requestId?: string;
        slashRequestId: string;
        traceId: string;
        startedAtMs: number;
      };
    }
  /** Seed initial session state (cwd, model) and trigger git info resolution. */
  | { kind: "SESSION_SEEDED"; cwd?: string; model?: string }
  /** Watchdog reconnect state changed (for consumer UI updates). */
  | {
      kind: "WATCHDOG_STATE_CHANGED";
      watchdog: { gracePeriodMs: number; startedAt: number } | null;
    }
  /** Backend process failed to resume. */
  | { kind: "RESUME_FAILED"; sessionId: string }
  /** Circuit breaker state changed (for consumer UI updates). */
  | {
      kind: "CIRCUIT_BREAKER_CHANGED";
      circuitBreaker: { state: string; failureCount: number; recoveryTimeRemainingMs: number };
    }
  /** Session was renamed. */
  | { kind: "SESSION_RENAMED"; name: string }
  /** Backend process produced stdout/stderr output. */
  | { kind: "PROCESS_OUTPUT_RECEIVED"; stream: "stdout" | "stderr"; data: string }
  /** Permission request was resolved (allow/deny). */
  | { kind: "PERMISSION_RESOLVED"; requestId: string; behavior: "allow" | "deny" }
  /** A user message was added to the pending queue (no backend yet). */
  | { kind: "PENDING_MESSAGE_ADDED"; message: UnifiedMessage }
  /** Team state changed — diff and emit domain events. */
  | {
      kind: "TEAM_STATE_DIFFED";
      prevTeam: TeamState | undefined;
      currentTeam: TeamState | undefined;
      sessionId: string;
    }
  /** Capabilities received from CLI — patch state, broadcast capabilities_ready, emit event. */
  | {
      kind: "CAPABILITIES_APPLIED";
      commands: InitializeCommand[];
      models: InitializeModel[];
      account: InitializeAccount | null;
    }
  /** A message was queued for the session — update state, broadcast message_queued. */
  | { kind: "MESSAGE_QUEUED"; queued: QueuedMessage }
  /** A queued message was edited — update state, broadcast queued_message_updated. */
  | {
      kind: "QUEUED_MESSAGE_EDITED";
      content: string;
      images?: { media_type: string; data: string }[];
    }
  /** A queued message was cancelled — clear state, broadcast queued_message_cancelled. */
  | { kind: "QUEUED_MESSAGE_CANCELLED" }
  /** A queued message was auto-sent — clear state, broadcast queued_message_sent. */
  | { kind: "QUEUED_MESSAGE_SENT" };

/**
 * Discriminated union of all events that SessionRuntime.process() accepts.
 *
 * - BACKEND_MESSAGE: A message received from the backend adapter (CLI/API).
 * - INBOUND_COMMAND: A command received from a connected consumer (WebSocket).
 * - SYSTEM_SIGNAL:   A lifecycle or connectivity signal from infrastructure.
 */
export type SessionEvent =
  | { type: "BACKEND_MESSAGE"; message: UnifiedMessage }
  | { type: "INBOUND_COMMAND"; command: InboundCommand; ws: WebSocketLike }
  | { type: "SYSTEM_SIGNAL"; signal: SystemSignal };
