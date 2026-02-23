/**
 * Session State Reducer
 *
 * Pure function that applies a UnifiedMessage to SessionData, returning a
 * `[SessionData, Effect[]]` tuple. No adapter dependencies, no side effects.
 *
 * - State transitions live in `reduce()` / field-specific sub-reducers.
 * - Effects capture everything the caller should do: broadcasts, event
 *   emissions, queued-message flushes, etc.
 *
 * Team tool_use blocks are buffered on arrival; tool_result blocks
 * are correlated with buffered tool_uses to drive team state transitions.
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
import { reduceTeamState } from "../team/team-state-reducer.js";
import type { CorrelatedToolUse } from "../team/team-tool-correlation.js";
import { TeamToolCorrelationBuffer } from "../team/team-tool-correlation.js";
import { recognizeTeamToolUses } from "../team/team-tool-recognizer.js";
import type { TeamState } from "../types/team-types.js";
import type { UnifiedMessage } from "../types/unified-message.js";
import { isToolResultContent } from "../types/unified-message.js";
import type { Effect } from "./effect-types.js";
import type { SessionData } from "./session-data.js";

// ---------------------------------------------------------------------------
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
export function reduceSessionData(
  data: SessionData,
  message: UnifiedMessage,
  correlationBuffer: TeamToolCorrelationBuffer,
): [SessionData, Effect[]] {
  const nextState = reduce(data.state, message, correlationBuffer);
  const nextLastStatus = reduceLastStatus(data.lastStatus, message);
  const nextMessageHistory = reduceMessageHistory(data.messageHistory, message);
  const nextBackendSessionId = reduceBackendSessionId(data.backendSessionId, message);
  const nextPendingPermissions = reducePendingPermissions(data.pendingPermissions, message);

  const changed =
    nextState !== data.state ||
    nextLastStatus !== data.lastStatus ||
    nextMessageHistory !== data.messageHistory ||
    nextBackendSessionId !== data.backendSessionId ||
    nextPendingPermissions !== data.pendingPermissions;

  const nextData: SessionData = changed
    ? {
        ...data,
        state: nextState,
        lastStatus: nextLastStatus,
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

/**
 * Apply a UnifiedMessage to SessionState, returning a new state.
 * Returns the original state reference if no fields changed.
 *
 * @param correlationBuffer — required; callers must provide a per-session buffer
 *   to prevent cross-session state corruption.
 */
export function reduce(
  state: SessionState,
  message: UnifiedMessage,
  correlationBuffer: TeamToolCorrelationBuffer = new TeamToolCorrelationBuffer(),
): SessionState {
  switch (message.type) {
    case "session_init":
      return reduceSessionInit(state, message);
    case "status_change":
      return reduceStatusChange(state, message);
    case "result":
      return reduceResult(state, message);
    case "control_response":
      return reduceControlResponse(state, message);
    case "configuration_change":
      return reduceConfigurationChange(state, message);
    default:
      break;
  }

  // Process team tool_use and tool_result in any message
  return reduceTeamTools(state, message, correlationBuffer);
}

// ---------------------------------------------------------------------------
// State sub-reducers
// ---------------------------------------------------------------------------

function reduceSessionInit(state: SessionState, msg: UnifiedMessage): SessionState {
  const m = msg.metadata;
  return {
    ...state,
    model: asString(m.model, state.model),
    cwd: asString(m.cwd, state.cwd),
    tools: asStringArray(m.tools, state.tools),
    permissionMode: asString(m.permissionMode, state.permissionMode),
    claude_code_version: asString(m.claude_code_version, state.claude_code_version),
    mcp_servers: asMcpServers(m.mcp_servers, state.mcp_servers),
    slash_commands: asStringArray(m.slash_commands, state.slash_commands),
    skills: asStringArray(m.skills, state.skills),
    authMethods: Array.isArray(m.authMethods)
      ? (m.authMethods as { id: string; name: string; description?: string | null }[])
      : state.authMethods,
  };
}

function reduceStatusChange(state: SessionState, msg: UnifiedMessage): SessionState {
  const m = msg.metadata;
  const status = m.status as string | null | undefined;

  let changed = false;
  const newState = { ...state };

  if (newState.is_compacting !== (status === "compacting")) {
    newState.is_compacting = status === "compacting";
    changed = true;
  }

  if (
    m.permissionMode !== undefined &&
    m.permissionMode !== null &&
    newState.permissionMode !== m.permissionMode
  ) {
    newState.permissionMode = m.permissionMode as string;
    changed = true;
  }

  return changed ? newState : state;
}

function reduceResult(state: SessionState, msg: UnifiedMessage): SessionState {
  const m = msg.metadata;
  const newState = { ...state };

  if (typeof m.total_cost_usd === "number") {
    newState.total_cost_usd = m.total_cost_usd;
  }
  if (typeof m.num_turns === "number") {
    newState.num_turns = m.num_turns;
  }
  if (typeof m.total_lines_added === "number") {
    newState.total_lines_added = m.total_lines_added;
  }
  if (typeof m.total_lines_removed === "number") {
    newState.total_lines_removed = m.total_lines_removed;
  }
  if (typeof m.duration_ms === "number") {
    newState.last_duration_ms = m.duration_ms;
  }
  if (typeof m.duration_api_ms === "number") {
    newState.last_duration_api_ms = m.duration_api_ms;
  }

  // Compute context usage from modelUsage
  const modelUsage = m.modelUsage as
    | Record<
        string,
        {
          inputTokens: number;
          outputTokens: number;
          cacheReadInputTokens: number;
          cacheCreationInputTokens: number;
          contextWindow: number;
          costUSD: number;
        }
      >
    | undefined;

  if (modelUsage) {
    newState.last_model_usage = modelUsage;
    for (const usage of Object.values(modelUsage)) {
      if (usage.contextWindow > 0) {
        newState.context_used_percent = Math.round(
          ((usage.inputTokens + usage.outputTokens) / usage.contextWindow) * 100,
        );
      }
    }
  }

  return newState;
}

function reduceConfigurationChange(state: SessionState, msg: UnifiedMessage): SessionState {
  const m = msg.metadata;
  const newState = { ...state };
  let changed = false;

  if (typeof m.model === "string" && m.model !== state.model) {
    newState.model = m.model;
    changed = true;
  }
  const newMode =
    typeof m.mode === "string"
      ? m.mode
      : typeof m.permissionMode === "string"
        ? m.permissionMode
        : undefined;
  if (newMode !== undefined && newMode !== state.permissionMode) {
    newState.permissionMode = newMode;
    changed = true;
  }

  return changed ? newState : state;
}

function reduceControlResponse(state: SessionState, _msg: UnifiedMessage): SessionState {
  // Capabilities are applied by the handler (applyCapabilities) which also
  // registers commands and broadcasts capabilities_ready. The reducer must
  // not mutate capabilities here to avoid setting state for messages with
  // unknown request_ids that the handler will ignore.
  return state;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : fallback;
}

function asMcpServers(
  value: unknown,
  fallback: { name: string; status: string }[],
): { name: string; status: string }[] {
  return Array.isArray(value) ? (value as { name: string; status: string }[]) : fallback;
}

// ---------------------------------------------------------------------------
// Team tool integration
// ---------------------------------------------------------------------------

/**
 * Apply a reduced TeamState to the session.
 * Returns the original state if the team state is unchanged (reference equality).
 */
function applyTeamState(
  currentState: SessionState,
  newTeamState: TeamState | undefined,
): SessionState {
  if (newTeamState === undefined) {
    if (currentState.team === undefined) return currentState;
    const { team: _team, ...rest } = currentState;
    return rest as SessionState;
  }
  if (newTeamState === currentState.team) {
    return currentState;
  }
  return {
    ...currentState,
    team: newTeamState,
  };
}

/**
 * Process team-related tool_use and tool_result content blocks.
 *
 * 1. Scans for team tool_use blocks → buffers and optimistically applies them
 * 2. Scans for tool_result blocks → correlates with buffered tool_uses
 * 3. When correlated, applies reduceTeamState
 * 4. Flushes stale correlation buffer entries (30s TTL)
 */
function reduceTeamTools(
  state: SessionState,
  message: UnifiedMessage,
  correlationBuffer: TeamToolCorrelationBuffer,
): SessionState {
  let currentState = state;

  // 1. Buffer + optimistic apply: apply team state immediately on tool_use
  //    without waiting for tool_result (which the CLI stream may never send).
  //    The correlation path (step 2) remains as a secondary mechanism for
  //    environments where tool_result blocks do arrive.
  const teamUses = recognizeTeamToolUses(message);
  for (const use of teamUses) {
    correlationBuffer.onToolUse(use);
    const optimistic: CorrelatedToolUse = { recognized: use, result: undefined };
    currentState = applyTeamState(currentState, reduceTeamState(currentState.team, optimistic));
  }

  // 2. Correlate any tool_result blocks with buffered team tool_uses
  for (const block of message.content) {
    if (!isToolResultContent(block)) continue;
    const correlated = correlationBuffer.onToolResult(block);
    if (!correlated) continue;
    currentState = applyTeamState(currentState, reduceTeamState(currentState.team, correlated));
  }

  // 3. Flush stale entries (30s TTL)
  correlationBuffer.flush(30_000);

  return currentState;
}

function reduceMessageHistory(
  current: readonly ConsumerMessage[],
  message: UnifiedMessage,
): readonly ConsumerMessage[] {
  if (message.type === "assistant") {
    const mapped = mapAssistantMessage(message);
    if (mapped.type !== "assistant") return current;

    // Find existing message by ID
    let index = -1;
    for (let i = current.length - 1; i >= 0; i--) {
      const item = current[i];
      if (
        item.type === "assistant" &&
        (item as Extract<ConsumerMessage, { type: "assistant" }>).message.id === mapped.message.id
      ) {
        index = i;
        break;
      }
    }

    if (index >= 0) {
      const existing = current[index] as Extract<ConsumerMessage, { type: "assistant" }>;
      if (assistantMessagesEquivalent(existing, mapped)) {
        return current;
      }
      const next = [...current];
      next[index] = mapped;
      return next;
    }

    return [...current, mapped];
  }

  if (message.type === "result") {
    const mapped = mapResultMessage(message);
    return [...current, mapped];
  }

  if (message.type === "tool_use_summary") {
    const mapped = mapToolUseSummary(message);
    if (mapped.type !== "tool_use_summary") return current;

    const toolUseId = mapped.tool_use_id ?? mapped.tool_use_ids[0];
    if (toolUseId) {
      let index = -1;
      for (let i = current.length - 1; i >= 0; i--) {
        const item = current[i];
        if (item.type === "tool_use_summary") {
          const itemToolUseId = item.tool_use_id ?? item.tool_use_ids[0];
          if (itemToolUseId === toolUseId) {
            index = i;
            break;
          }
        }
      }

      if (index >= 0) {
        const existing = current[index] as Extract<ConsumerMessage, { type: "tool_use_summary" }>;
        if (toolSummariesEquivalent(existing, mapped)) {
          return current;
        }
        const next = [...current];
        next[index] = mapped;
        return next;
      }
    }

    return [...current, mapped];
  }

  return current;
}

function assistantMessagesEquivalent(
  a: Extract<ConsumerMessage, { type: "assistant" }>,
  b: Extract<ConsumerMessage, { type: "assistant" }>,
): boolean {
  if (a.parent_tool_use_id !== b.parent_tool_use_id) return false;
  if (a.message.id !== b.message.id) return false;
  if (a.message.model !== b.message.model) return false;
  if (a.message.stop_reason !== b.message.stop_reason) return false;
  return JSON.stringify(a.message.content) === JSON.stringify(b.message.content);
}

function toolSummariesEquivalent(
  a: Extract<ConsumerMessage, { type: "tool_use_summary" }>,
  b: Extract<ConsumerMessage, { type: "tool_use_summary" }>,
): boolean {
  return (
    a.summary === b.summary &&
    a.status === b.status &&
    a.is_error === b.is_error &&
    JSON.stringify(a.tool_use_ids) === JSON.stringify(b.tool_use_ids) &&
    JSON.stringify(a.output) === JSON.stringify(b.output) &&
    JSON.stringify(a.error) === JSON.stringify(b.error)
  );
}
