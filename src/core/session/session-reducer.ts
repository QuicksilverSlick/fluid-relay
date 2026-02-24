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
 *   BACKEND_MESSAGE   → reduceSessionData (session-state-reducer.ts)
 *   SYSTEM_SIGNAL     → reduceLifecycle   (pure lifecycle transitions)
 *   INBOUND_COMMAND   → reduceInbound     (pure data mutations only)
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
import type { TeamToolCorrelationBuffer } from "../team/team-tool-correlation.js";
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
 * The `correlationBuffer` is a per-session mutable buffer passed in by the
 * runtime; it is the only "impure" parameter and is logged as a known
 * exception in the architecture doc (team tool correlation is inherently
 * stateful).
 */
export function sessionReducer(
  data: SessionData,
  event: SessionEvent,
  correlationBuffer: TeamToolCorrelationBuffer,
  config: ReducerConfig = { maxMessageHistoryLength: Number.POSITIVE_INFINITY },
): [SessionData, Effect[]] {
  switch (event.type) {
    case "BACKEND_MESSAGE":
      return reduceBackendMessage(data, event.message, correlationBuffer, config);

    case "SYSTEM_SIGNAL":
      return reduceSystemSignal(data, event.signal);

    case "INBOUND_COMMAND":
      // Pure data side of inbound commands.
      // I/O side (backend sends, slash execution) stays in SessionRuntime.
      return reduceInboundCommand(data, event.command.type);
  }
}

// ---------------------------------------------------------------------------
// SYSTEM_SIGNAL reducer
// ---------------------------------------------------------------------------

/**
 * Apply a SystemSignal to SessionData — only lifecycle transitions.
 *
 * Returns the same data reference if nothing changed (cheap equality check
 * for the caller's markDirty() guard).
 */
function reduceSystemSignal(data: SessionData, signal: SystemSignal): [SessionData, Effect[]] {
  const next = lifecycleForSignal(data.lifecycle, signal);
  if (!next || !isLifecycleTransitionAllowed(data.lifecycle, next)) {
    return [data, []];
  }
  return [{ ...data, lifecycle: next }, []];
}

/** Map a SystemSignal kind to the target lifecycle state, or null if no transition. */
function lifecycleForSignal(current: LifecycleState, signal: SystemSignal): LifecycleState | null {
  switch (signal.kind) {
    case "BACKEND_CONNECTED":
      return "active";
    case "BACKEND_DISCONNECTED":
      return current === "active" || current === "idle" ? "degraded" : null;
    case "SESSION_CLOSED":
      return "closed";
    case "RECONNECT_TIMEOUT":
      return "degraded";
    case "IDLE_REAP":
      return "closing";
    case "CAPABILITIES_TIMEOUT":
    case "CONSUMER_CONNECTED":
    case "CONSUMER_DISCONNECTED":
    case "GIT_INFO_RESOLVED":
    case "CAPABILITIES_READY":
      // No pure data change for these — handled by runtime orchestration.
      return null;
  }
}

// ---------------------------------------------------------------------------
// INBOUND_COMMAND reducer (pure data side only)
// ---------------------------------------------------------------------------

/**
 * Apply the pure data mutations for an inbound command.
 *
 * This only handles the parts of inbound command processing that are pure:
 *   - Generating error effects for closed/closing sessions
 *   - No state mutations for most commands (the impure I/O side stays in runtime)
 *
 * Note: Most inbound command handling (sending to backend, slash execution,
 * queue management) requires handles that aren't serializable — those stay in
 * SessionRuntime.handleInboundCommand(). This function produces the Effects
 * that describe the pure output of the command.
 */
function reduceInboundCommand(data: SessionData, commandType: string): [SessionData, Effect[]] {
  const effects = mapInboundCommandEffects(commandType, {
    sessionId: "", // sessionId not needed for pure effect mapping
    lifecycle: data.lifecycle,
  });
  return [data, effects];
}

// Public API
// ---------------------------------------------------------------------------

/**
 * Outer reducer — operates on full SessionData.
 * Returns `[nextData, effects]` where effects describe all side effects to
 * be executed by the caller (broadcasts, event emissions, etc.).
 *
 * @param correlationBuffer — per-session buffer from session.teamCorrelationBuffer.
 *   Callers (SessionRuntime) must provide this; the reducer itself stays pure.
 */
function reduceBackendMessage(
  data: SessionData,
  message: UnifiedMessage,
  correlationBuffer: TeamToolCorrelationBuffer,
  config: ReducerConfig,
): [SessionData, Effect[]] {
  const nextState = reduce(data.state, message, correlationBuffer);
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
    nextLastStatus !== data.lastStatus ||
    nextLifecycle !== data.lifecycle ||
    nextMessageHistory !== data.messageHistory ||
    nextBackendSessionId !== data.backendSessionId ||
    nextPendingPermissions !== data.pendingPermissions;

  const nextData: SessionData = changed
    ? {
        ...data,
        state: nextState,
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
          // sessionId will be injected by executeEffects
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
        // sessionId will be injected by executeEffects
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
      // sessionId will be injected by executeEffects
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
      const modeValue =
        typeof m.mode === "string"
          ? m.mode
          : typeof m.permissionMode === "string"
            ? m.permissionMode
            : undefined;
      if (modeValue !== undefined) patch.permissionMode = modeValue;
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
