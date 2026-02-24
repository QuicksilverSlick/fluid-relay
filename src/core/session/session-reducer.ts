/**
 * Session Reducer — top-level pure reducer.
 *
 * `sessionReducer(data, event, buffer)` is the single function that drives
 * all session state transitions. It returns `[SessionData, Effect[]]` —
 * the new state and a list of described side effects. The caller
 * (`SessionRuntime.process()`) executes the effects after applying the
 * new state.
 *
 * Routing:
 *   BACKEND_MESSAGE   → reduceBackendMessage  (session-state-reducer.ts)
 *   SYSTEM_SIGNAL     → reduceSystemSignal    (data patches, effects, and lifecycle transitions)
 *   INBOUND_COMMAND   → reduceInboundCommand  (pure data mutations only)
 *
 * All I/O (backend sends, slash commands, git resolution, capabilities
 * handshake) stays in SessionRuntime — these require handles (BackendSession,
 * services) that are not serializable and do not belong in pure functions.
 *
 * @module SessionControl
 */

import type { PermissionRequest } from "../../types/cli-messages.js";
import type { ConsumerMessage } from "../../types/consumer-messages.js";
import { CONSUMER_PROTOCOL_VERSION } from "../../types/consumer-messages.js";
import type { SessionState } from "../../types/session-state.js";
import type { InboundCommand } from "../interfaces/runtime-commands.js";
import {
  mapAssistantMessage,
  mapAuthStatus,
  mapConfigurationChange,
  mapPermissionRequest,
  mapResultMessage,
  mapSessionLifecycle,
  mapStreamEvent,
  mapToolProgress,
  mapToolUseSummary,
} from "../messaging/consumer-message-mapper.js";
import type { UnifiedMessage } from "../types/unified-message.js";
import { mapInboundCommandEffects } from "./effect-mapper.js";
import type { Effect } from "./effect-types.js";
import { upsertAssistantMessage, upsertToolUseSummary } from "./history-reducer.js";
import type { SessionData } from "./session-data.js";
import type { SessionEvent, SystemSignal } from "./session-event.js";
import type { LifecycleState } from "./session-lifecycle.js";
import { isLifecycleTransitionAllowed } from "./session-lifecycle.js";
import { reduce } from "./session-state-reducer.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ReducerConfig {
  readonly maxMessageHistoryLength: number;
}

/**
 * Top-level session reducer.
 *
 * Pure function — no I/O, no closures over external state.
 * teamCorrelation is now carried inside SessionData (data.teamCorrelation),
 * making the reducer fully pure with no external mutable state.
 */
export function sessionReducer(
  data: SessionData,
  event: SessionEvent,
  config: ReducerConfig = { maxMessageHistoryLength: Number.POSITIVE_INFINITY },
): [SessionData, Effect[]] {
  switch (event.type) {
    case "BACKEND_MESSAGE":
      return reduceBackendMessage(data, event.message, config);

    case "SYSTEM_SIGNAL":
      return reduceSystemSignal(data, event.signal);

    case "INBOUND_COMMAND":
      // Pure data side of inbound commands.
      // I/O side (backend sends, slash execution) stays in SessionRuntime.
      return reduceInboundCommand(data, event.command, config);
  }
}

// ---------------------------------------------------------------------------
// SYSTEM_SIGNAL reducer
// ---------------------------------------------------------------------------

/**
 * Apply a SystemSignal to SessionData.
 *
 * All signal kinds are handled in a single switch:
 *   - Data-patch signals mutate SessionData fields (no lifecycle change).
 *   - Effect signals produce side effects (broadcasts, event emissions).
 *   - Lifecycle signals transition the session lifecycle state.
 *   - No-op signals return the data unchanged.
 *
 * Returns the same data reference if nothing changed (cheap equality check
 * for the caller's markDirty() guard).
 */
function reduceSystemSignal(data: SessionData, signal: SystemSignal): [SessionData, Effect[]] {
  switch (signal.kind) {
    // ── Data-patch signals (no lifecycle transition) ──────────────────────
    case "STATE_PATCHED":
      return [{ ...data, state: { ...data.state, ...signal.patch } }, []];

    case "LAST_STATUS_UPDATED":
      return [{ ...data, lastStatus: signal.status }, []];

    case "QUEUED_MESSAGE_UPDATED":
      return [{ ...data, queuedMessage: signal.message }, []];

    case "MODEL_UPDATED":
      return [
        { ...data, state: { ...data.state, model: signal.model } },
        [{ type: "BROADCAST_SESSION_UPDATE", patch: { model: signal.model } }],
      ];

    case "ADAPTER_NAME_SET":
      return [
        { ...data, adapterName: signal.name, state: { ...data.state, adapterName: signal.name } },
        [{ type: "PERSIST_NOW" }],
      ];

    case "SESSION_SEEDED": {
      const patch: Partial<SessionData["state"]> = {};
      if (signal.cwd) patch.cwd = signal.cwd;
      if (signal.model) patch.model = signal.model;
      const nextData =
        Object.keys(patch).length > 0 ? { ...data, state: { ...data.state, ...patch } } : data;
      return [nextData, [{ type: "RESOLVE_GIT_INFO" }]];
    }

    // ── Effect signals (no lifecycle transition) ─────────────────────────
    case "BACKEND_RELAUNCH_NEEDED":
      return [
        data,
        [
          { type: "EMIT_EVENT", eventType: "backend:relaunch_needed", payload: {} },
          { type: "BROADCAST", message: { type: "cli_disconnected" } },
        ],
      ];

    case "SLASH_PASSTHROUGH_RESULT":
      return [
        data,
        [
          {
            type: "BROADCAST",
            message: {
              type: "slash_command_result",
              command: signal.command,
              request_id: signal.requestId,
              content: signal.content,
              source: signal.source,
            },
          },
          {
            type: "EMIT_EVENT",
            eventType: "slash_command:executed",
            payload: { command: signal.command, source: signal.source, durationMs: 0 },
          },
        ],
      ];

    case "SLASH_PASSTHROUGH_ERROR":
      return [
        data,
        [
          {
            type: "BROADCAST",
            message: {
              type: "slash_command_error",
              command: signal.command,
              request_id: signal.requestId,
              error: signal.error,
            },
          },
          {
            type: "EMIT_EVENT",
            eventType: "slash_command:failed",
            payload: { command: signal.command, error: signal.error },
          },
        ],
      ];

    // ── Effect signals with lifecycle transitions ────────────────────────
    case "BACKEND_CONNECTED": {
      const drainEffects: Effect[] = data.pendingMessages.map((msg) => ({
        type: "SEND_TO_BACKEND" as const,
        message: msg,
      }));
      const effects: Effect[] = [
        { type: "BROADCAST", message: { type: "cli_connected" } },
        { type: "EMIT_EVENT", eventType: "backend:connected", payload: {} },
        ...drainEffects,
      ];
      const nextData = {
        ...data,
        adapterSupportsSlashPassthrough: signal.supportsSlashPassthrough,
        pendingMessages: [] as typeof data.pendingMessages,
      };
      if (isLifecycleTransitionAllowed(data.lifecycle, "active")) {
        return [{ ...nextData, lifecycle: "active" as const }, effects];
      }
      return [nextData, effects];
    }

    case "BACKEND_DISCONNECTED": {
      const cancelEffects: Effect[] = [...data.pendingPermissions.keys()].map((reqId) => ({
        type: "BROADCAST_TO_PARTICIPANTS" as const,
        message: { type: "permission_cancelled" as const, request_id: reqId },
      }));
      const effects: Effect[] = [
        { type: "BROADCAST", message: { type: "cli_disconnected" } },
        {
          type: "EMIT_EVENT",
          eventType: "backend:disconnected",
          payload: { code: 1000, reason: signal.reason },
        },
        ...cancelEffects,
      ];
      const resetData = {
        ...data,
        backendSessionId: undefined,
        adapterSupportsSlashPassthrough: false,
        pendingPermissions: new Map<string, PermissionRequest>(),
      };
      const shouldDegrade = data.lifecycle === "active" || data.lifecycle === "idle";
      if (shouldDegrade && isLifecycleTransitionAllowed(data.lifecycle, "degraded")) {
        return [{ ...resetData, lifecycle: "degraded" as const }, effects];
      }
      return [resetData, effects];
    }

    // ── Lifecycle-only signals ───────────────────────────────────────────
    case "SESSION_CLOSING":
      return applyLifecycleTransition(data, "closing");

    case "SESSION_CLOSED":
      return applyLifecycleTransition(data, "closed");

    case "RECONNECT_TIMEOUT":
      return applyLifecycleTransition(data, "degraded");

    case "IDLE_REAP":
      return applyLifecycleTransition(data, "closing");

    // ── No-op signals (handled by runtime or no pure data change) ────────
    case "PASSTHROUGH_ENQUEUED":
    case "CAPABILITIES_TIMEOUT":
    case "CONSUMER_CONNECTED":
    case "CONSUMER_DISCONNECTED":
    case "GIT_INFO_RESOLVED":
    case "CAPABILITIES_READY":
      return [data, []];
  }
}

/** Apply a lifecycle transition if allowed, returning unchanged data otherwise. */
function applyLifecycleTransition(
  data: SessionData,
  next: LifecycleState,
): [SessionData, Effect[]] {
  if (!isLifecycleTransitionAllowed(data.lifecycle, next)) {
    return [data, []];
  }
  return [{ ...data, lifecycle: next }, []];
}

// ---------------------------------------------------------------------------
// INBOUND_COMMAND reducer (pure data side only)
// ---------------------------------------------------------------------------

/**
 * Apply the pure data mutations for an inbound command.
 *
 * Handles the pure-state side of inbound commands:
 *   - `user_message`: sets lastStatus="running", appends to messageHistory, trims history.
 *     Returns `[data, []]` unchanged for closed/closing sessions — the runtime detects
 *     the no-op and sends a targeted `sendTo` error to the requesting WebSocket.
 *   - `set_model`: updates state.model, returns BROADCAST_SESSION_UPDATE effect.
 *   - Other commands: delegates to mapInboundCommandEffects for any pure effects
 *     (e.g., error for set_adapter).
 *
 * I/O side (backend sends, lifecycle transition, slash execution, queue management)
 * stays in SessionRuntime.
 */
function reduceInboundCommand(
  data: SessionData,
  command: InboundCommand,
  config: ReducerConfig,
): [SessionData, Effect[]] {
  switch (command.type) {
    case "user_message": {
      // Closed/closing: no state change — runtime will send targeted error via sendTo(ws).
      if (data.lifecycle === "closing" || data.lifecycle === "closed") {
        return [data, []];
      }
      const userMsg: ConsumerMessage = {
        type: "user_message",
        content: command.content,
        timestamp: Date.now(),
      };
      const nextHistory = trimHistory(
        [...data.messageHistory, userMsg],
        config.maxMessageHistoryLength,
      );
      const nextData: SessionData = {
        ...data,
        lastStatus: "running",
        messageHistory: nextHistory,
      };
      return [nextData, [{ type: "BROADCAST", message: userMsg }]];
    }

    case "set_model": {
      const nextData: SessionData = {
        ...data,
        state: { ...data.state, model: command.model },
      };
      return [
        nextData,
        [
          {
            type: "BROADCAST_SESSION_UPDATE",
            patch: { model: command.model } as Partial<SessionState>,
          },
        ],
      ];
    }

    default: {
      const effects = mapInboundCommandEffects(command.type, {
        sessionId: "", // sessionId not needed for pure effect mapping
        lifecycle: data.lifecycle,
      });
      return [data, effects];
    }
  }
}

// ---------------------------------------------------------------------------
// BACKEND_MESSAGE reducer
// ---------------------------------------------------------------------------

/**
 * Outer reducer — operates on full SessionData.
 * Returns `[nextData, effects]` where effects describe all side effects to
 * be executed by the caller (broadcasts, event emissions, etc.).
 */
function reduceBackendMessage(
  data: SessionData,
  message: UnifiedMessage,
  config: ReducerConfig,
): [SessionData, Effect[]] {
  const [nextState, nextCorrelation] = reduce(data.state, message, data.teamCorrelation);
  const nextLastStatus = reduceLastStatus(data.lastStatus, message);
  const nextLifecycle = reduceLifecycle(data.lifecycle, message);
  const nextMessageHistory = trimHistory(
    reduceMessageHistory(data.messageHistory, message),
    config.maxMessageHistoryLength,
  );
  const nextBackendSessionId = reduceBackendSessionId(data.backendSessionId, message);
  const nextPendingPermissions = reducePendingPermissions(data.pendingPermissions, message);

  const changed =
    nextState !== data.state ||
    nextCorrelation !== data.teamCorrelation ||
    nextLastStatus !== data.lastStatus ||
    nextLifecycle !== data.lifecycle ||
    nextMessageHistory !== data.messageHistory ||
    nextBackendSessionId !== data.backendSessionId ||
    nextPendingPermissions !== data.pendingPermissions;

  const nextData: SessionData = changed
    ? {
        ...data,
        state: nextState,
        teamCorrelation: nextCorrelation,
        lastStatus: nextLastStatus,
        lifecycle: nextLifecycle,
        messageHistory: nextMessageHistory,
        backendSessionId: nextBackendSessionId,
        pendingPermissions: nextPendingPermissions,
      }
    : data;

  const effects = buildEffects(data, message, nextData);
  return [nextData, effects];
}

// ---------------------------------------------------------------------------
// Effect builder — pure, depends only on prev/next data and the message
// ---------------------------------------------------------------------------

function buildEffects(
  prevData: SessionData,
  message: UnifiedMessage,
  nextData: SessionData,
): Effect[] {
  const effects: Effect[] = [];

  switch (message.type) {
    case "session_init": {
      effects.push({
        type: "BROADCAST",
        message: {
          type: "session_init",
          session: nextData.state,
          protocol_version: CONSUMER_PROTOCOL_VERSION,
        },
      });
      effects.push({ type: "AUTO_SEND_QUEUED" });
      break;
    }

    case "status_change": {
      const { status: _s, ...rest } = message.metadata;
      const filtered = Object.fromEntries(Object.entries(rest).filter(([, v]) => v != null));
      effects.push({
        type: "BROADCAST",
        message: {
          type: "status_change",
          status: nextData.lastStatus,
          ...(Object.keys(filtered).length > 0 && { metadata: filtered }),
        },
      });
      if (message.metadata.permissionMode != null) {
        effects.push({
          type: "BROADCAST_SESSION_UPDATE",
          patch: { permissionMode: nextData.state.permissionMode },
        });
      }
      // Auto-send on "idle" transition
      if (nextData.lastStatus === "idle" && prevData.lastStatus !== "idle") {
        effects.push({ type: "AUTO_SEND_QUEUED" });
      }
      break;
    }

    case "assistant": {
      // Only broadcast if history actually changed (dedup guard)
      if (nextData.messageHistory !== prevData.messageHistory) {
        const mapped = mapAssistantMessage(message);
        if (mapped.type === "assistant") {
          effects.push({ type: "BROADCAST", message: mapped });
        }
      }
      break;
    }

    case "result": {
      effects.push({ type: "BROADCAST", message: mapResultMessage(message) });
      effects.push({ type: "AUTO_SEND_QUEUED" });
      // Emit first-turn completion event when num_turns reaches 1
      const numTurns = message.metadata?.num_turns as number | undefined;
      const isError = message.metadata?.is_error as boolean | undefined;
      if (numTurns === 1 && !isError) {
        const firstUser = prevData.messageHistory.find((e) => e.type === "user_message");
        if (firstUser && firstUser.type === "user_message") {
          effects.push({
            type: "EMIT_EVENT",
            eventType: "session:first_turn_completed",
            payload: { firstUserMessage: firstUser.content },
          });
        }
      }
      break;
    }

    case "stream_event": {
      const event = message.metadata?.event as { type?: string } | undefined;
      const parentToolUseId = message.metadata?.parent_tool_use_id;
      // Infer "running" from message_start on the main session only
      if (event?.type === "message_start" && !parentToolUseId) {
        effects.push({
          type: "BROADCAST",
          message: { type: "status_change", status: nextData.lastStatus },
        });
      }
      effects.push({ type: "BROADCAST", message: mapStreamEvent(message) });
      break;
    }

    case "permission_request": {
      const mapped = mapPermissionRequest(message);
      if (mapped) {
        effects.push({
          type: "BROADCAST_TO_PARTICIPANTS",
          message: { type: "permission_request", request: mapped.consumerPerm },
        });
        effects.push({
          type: "EMIT_EVENT",
          eventType: "permission:requested",
          payload: { request: mapped.cliPerm },
        });
      }
      break;
    }

    case "tool_progress": {
      effects.push({ type: "BROADCAST", message: mapToolProgress(message) });
      break;
    }

    case "tool_use_summary": {
      // Only broadcast if history changed (dedup guard)
      if (nextData.messageHistory !== prevData.messageHistory) {
        const mapped = mapToolUseSummary(message);
        if (mapped.type === "tool_use_summary") {
          effects.push({ type: "BROADCAST", message: mapped });
        }
      }
      break;
    }

    case "auth_status": {
      effects.push({ type: "BROADCAST", message: mapAuthStatus(message) });
      const m = message.metadata;
      effects.push({
        type: "EMIT_EVENT",
        eventType: "auth_status",
        payload: {
          isAuthenticating: m.isAuthenticating as boolean,
          output: m.output as string[] | undefined,
          error: m.error as string | undefined,
        },
      });
      break;
    }

    case "configuration_change": {
      effects.push({ type: "BROADCAST", message: mapConfigurationChange(message) });
      const m = message.metadata;
      const patch: Partial<SessionState> = {};
      if (typeof m.model === "string") patch.model = m.model;
      if (typeof m.mode === "string") {
        patch.permissionMode = m.mode;
      } else if (typeof m.permissionMode === "string") {
        patch.permissionMode = m.permissionMode;
      }
      if (Object.keys(patch).length > 0) {
        effects.push({ type: "BROADCAST_SESSION_UPDATE", patch });
      }
      break;
    }

    case "session_lifecycle": {
      effects.push({ type: "BROADCAST", message: mapSessionLifecycle(message) });
      break;
    }
  }

  return effects;
}

// ---------------------------------------------------------------------------
// Field reducers
// ---------------------------------------------------------------------------

function reduceBackendSessionId(
  current: string | undefined,
  message: UnifiedMessage,
): string | undefined {
  if (message.type === "session_init" && message.metadata?.session_id) {
    return message.metadata.session_id as string;
  }
  return current;
}

function reducePendingPermissions(
  current: ReadonlyMap<string, PermissionRequest>,
  message: UnifiedMessage,
): ReadonlyMap<string, PermissionRequest> {
  if (message.type === "permission_request" && message.metadata?.request_id) {
    if (message.metadata.subtype && message.metadata.subtype !== "can_use_tool") return current;
    const next = new Map(current);
    next.set(
      message.metadata.request_id as string,
      message.metadata as unknown as PermissionRequest,
    );
    return next;
  }
  if (message.type === "permission_response" && message.metadata?.request_id) {
    const next = new Map(current);
    next.delete(message.metadata.request_id as string);
    return next;
  }
  return current;
}

function reduceLastStatus(
  current: SessionData["lastStatus"],
  message: UnifiedMessage,
): SessionData["lastStatus"] {
  switch (message.type) {
    case "status_change": {
      const status = message.metadata?.status;
      if (status === "running" || status === "idle" || status === "compacting") {
        return status;
      }
      return current;
    }
    case "result":
      return "idle";
    case "stream_event": {
      const event = message.metadata?.event as { type?: string } | undefined;
      const parent_tool_use_id = message.metadata?.parent_tool_use_id;
      if (event?.type === "message_start" && !parent_tool_use_id) {
        return "running";
      }
      return current;
    }
    default:
      return current;
  }
}

function reduceLifecycle(current: LifecycleState, message: UnifiedMessage): LifecycleState {
  let next: LifecycleState | null = null;
  if (message.type === "status_change") {
    const status = message.metadata?.status;
    if (status === "idle") next = "idle";
    else if (status === "running" || status === "compacting") next = "active";
  } else if (message.type === "result") {
    next = "idle";
  } else if (message.type === "stream_event") {
    const event = message.metadata?.event as { type?: string } | undefined;
    const parent_tool_use_id = message.metadata?.parent_tool_use_id;
    if (event?.type === "message_start" && !parent_tool_use_id) {
      next = "active";
    }
  }

  if (next && isLifecycleTransitionAllowed(current, next)) {
    return next;
  }
  return current;
}

function reduceMessageHistory(
  current: readonly ConsumerMessage[],
  message: UnifiedMessage,
): readonly ConsumerMessage[] {
  if (message.type === "assistant") {
    const mapped = mapAssistantMessage(message);
    if (mapped.type !== "assistant") return current;
    return upsertAssistantMessage(current, mapped);
  }

  if (message.type === "result") {
    const mapped = mapResultMessage(message);
    return [...current, mapped];
  }

  if (message.type === "tool_use_summary") {
    const mapped = mapToolUseSummary(message);
    if (mapped.type !== "tool_use_summary") return current;
    return upsertToolUseSummary(current, mapped);
  }

  return current;
}

function trimHistory(
  history: readonly ConsumerMessage[],
  maxLen: number,
): readonly ConsumerMessage[] {
  return history.length > maxLen ? history.slice(-maxLen) : history;
}
