/**
 * UnifiedMessageRouter — T4 translation boundary (UnifiedMessage → ConsumerMessage).
 *
 * Routes backend UnifiedMessages to the appropriate handler: applies state
 * reduction, persists to message history, and broadcasts ConsumerMessages to
 * connected consumers. Decides what reaches consumers (e.g. text_delta,
 * tool_use) vs. what is handled internally (e.g. session_lifecycle,
 * control_response).
 *
 * Exposes a single `route(session, msg)` entry point.
 */

import { CONSUMER_PROTOCOL_VERSION } from "../../types/consumer-messages.js";
import type { SessionState } from "../../types/session-state.js";
import type { ConsumerBroadcaster } from "../consumer/consumer-broadcaster.js";
import type { SessionData } from "../session/session-data.js";
import type { Session } from "../session/session-repository.js";
import type { UnifiedMessage } from "../types/unified-message.js";
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
} from "./consumer-message-mapper.js";
import { extractTraceContext, type MessageTracer } from "./message-tracer.js";

/** Trace context threaded through the route() call to each handler. */
interface RouteTrace {
  sessionId: string;
  traceId?: string;
  requestId?: string;
  command?: string;
  phase: string;
}

export interface UnifiedMessageRouterDeps {
  broadcaster: ConsumerBroadcaster;
  tracer: MessageTracer;
}

// ─── UnifiedMessageRouter ────────────────────────────────────────────────────

export class UnifiedMessageRouter {
  private broadcaster: ConsumerBroadcaster;
  private tracer: MessageTracer;
  constructor(deps: UnifiedMessageRouterDeps) {
    this.broadcaster = deps.broadcaster;
    this.tracer = deps.tracer;
  }

  /** Route a UnifiedMessage through state reduction and the appropriate handler. */
  route(session: Session, msg: UnifiedMessage, prevData?: SessionData): void {
    const { traceId, requestId, command } = extractTraceContext(msg.metadata);
    const trace: RouteTrace = {
      sessionId: session.id,
      traceId,
      requestId,
      command,
      phase: "route_unified",
    };

    this.tracer.recv("bridge", msg.type, msg, trace);

    switch (msg.type) {
      case "session_init":
        this.handleSessionInit(session, msg, trace);
        break;
      case "status_change":
        this.handleStatusChange(session, msg, trace);
        break;
      case "assistant":
        this.handleAssistant(session, msg, trace, prevData);
        break;
      case "result":
        this.handleResult(session, msg, trace);
        break;
      case "stream_event":
        this.handleStreamEvent(session, msg, trace);
        break;
      case "permission_request":
        this.handlePermissionRequest(session, msg, trace);
        break;
      case "tool_progress":
        this.handleToolProgress(session, msg, trace);
        break;
      case "tool_use_summary":
        this.handleToolUseSummary(session, msg, trace, prevData);
        break;
      case "auth_status":
        this.handleAuthStatus(session, msg, trace);
        break;
      case "configuration_change":
        this.handleConfigurationChange(session, msg, trace);
        break;
      case "session_lifecycle":
        this.handleSessionLifecycle(session, msg, trace);
        break;
      default:
        this.tracer.recv("bridge", `unhandled:${msg.type}`, msg, trace);
        break;
    }
  }

  // ── Individual handlers ──────────────────────────────────────────────────

  private handleSessionInit(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const initMsg = {
      type: "session_init" as const,
      session: session.data.state,
      protocol_version: CONSUMER_PROTOCOL_VERSION,
    };
    this.traceT4("handleSessionInit", session, msg, initMsg, trace);
    this.broadcaster.broadcast(session, initMsg);
    // Registry population and capabilities initialization moved to SessionRuntime
  }

  private handleStatusChange(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const { status: _s, ...rest } = msg.metadata;
    const filtered = Object.fromEntries(Object.entries(rest).filter(([, v]) => v != null));
    const statusMsg = {
      type: "status_change" as const,
      status: session.data.lastStatus,
      ...(Object.keys(filtered).length > 0 && { metadata: filtered }),
    };
    this.traceT4("handleStatusChange", session, msg, statusMsg, trace);
    this.broadcaster.broadcast(session, statusMsg);

    // Broadcast permissionMode change so frontend can confirm the update
    if (msg.metadata.permissionMode !== undefined && msg.metadata.permissionMode !== null) {
      this.broadcaster.broadcast(session, {
        type: "session_update",
        session: { permissionMode: session.data.state.permissionMode } as Partial<SessionState>,
      });
    }
  }

  private handleAssistant(
    session: Session,
    msg: UnifiedMessage,
    trace: RouteTrace,
    prevData?: SessionData,
  ): void {
    const consumerMsg = mapAssistantMessage(msg);
    if (consumerMsg.type !== "assistant") return;
    this.traceT4("mapAssistantMessage", session, msg, consumerMsg, trace);

    // If history didn't change (deduped by reducer), don't broadcast.
    // This check is for test compatibility, as the reducer might not be run in some tests.
    if (prevData && session.data.messageHistory === prevData.messageHistory) {
      return;
    }

    this.broadcaster.broadcast(session, consumerMsg);
  }

  private handleResult(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const consumerMsg = mapResultMessage(msg);
    this.traceT4("mapResultMessage", session, msg, consumerMsg, trace);
    this.broadcaster.broadcast(session, consumerMsg);

    // Auto-naming and git refresh (moved to SessionRuntime)
  }

  private handleStreamEvent(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const m = msg.metadata;
    const event = m.event as { type?: string } | undefined;

    // Derive "running" status from message_start (main session only).
    // The CLI only sends status_change for "compacting" | null — it never
    // reports "running", so the bridge must infer it from stream events.
    //
    // This inference is Claude-specific:
    // - OpenCode: emits "busy" via session.status → handled by handleStatusChange()
    // - ACP/Gemini: no explicit "running" — activity implied by stream_event/tool_progress
    // Generalizing (e.g. treating first stream_event as "running") was rejected
    // due to false positives from sub-agent streams. See ISSUE 3 in
    // docs/unified-message-protocol.md.
    if (event?.type === "message_start" && !m.parent_tool_use_id) {
      this.broadcaster.broadcast(session, {
        type: "status_change",
        status: session.data.lastStatus,
      });
    }

    const streamConsumerMsg = mapStreamEvent(msg);
    this.traceT4("mapStreamEvent", session, msg, streamConsumerMsg, trace);
    this.broadcaster.broadcast(session, streamConsumerMsg);
  }

  private handlePermissionRequest(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const mapped = mapPermissionRequest(msg);
    if (!mapped) return;
    this.traceT4("mapPermissionRequest", session, msg, mapped.consumerPerm, trace);

    const { consumerPerm } = mapped;
    this.broadcaster.broadcastToParticipants(session, {
      type: "permission_request",
      request: consumerPerm,
    });
  }

  private handleToolProgress(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const consumerMsg = mapToolProgress(msg);
    this.traceT4("mapToolProgress", session, msg, consumerMsg, trace);
    this.broadcaster.broadcast(session, consumerMsg);
  }

  private handleToolUseSummary(
    session: Session,
    msg: UnifiedMessage,
    trace: RouteTrace,
    prevData?: SessionData,
  ): void {
    const consumerMsg = mapToolUseSummary(msg);
    if (consumerMsg.type !== "tool_use_summary") return;
    this.traceT4("mapToolUseSummary", session, msg, consumerMsg, trace);

    // If history didn't change (deduped by reducer), don't broadcast.
    if (prevData && session.data.messageHistory === prevData.messageHistory) {
      return;
    }

    this.broadcaster.broadcast(session, consumerMsg);
  }

  private handleAuthStatus(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const consumerMsg = mapAuthStatus(msg);
    this.traceT4("mapAuthStatus", session, msg, consumerMsg, trace);
    this.broadcaster.broadcast(session, consumerMsg);
  }

  private handleConfigurationChange(
    session: Session,
    msg: UnifiedMessage,
    trace: RouteTrace,
  ): void {
    const consumerMsg = mapConfigurationChange(msg);
    this.traceT4("mapConfigurationChange", session, msg, consumerMsg, trace);
    this.broadcaster.broadcast(session, consumerMsg);

    // Also broadcast a session_update so frontend state stays in sync
    const m = msg.metadata;
    const patch: Record<string, unknown> = {};
    if (typeof m.model === "string") patch.model = m.model;
    const modeValue =
      typeof m.mode === "string"
        ? m.mode
        : typeof m.permissionMode === "string"
          ? m.permissionMode
          : undefined;
    if (modeValue !== undefined) patch.permissionMode = modeValue;
    if (Object.keys(patch).length > 0) {
      this.broadcaster.broadcast(session, {
        type: "session_update",
        session: patch as Partial<SessionState>,
      });
    }
  }

  private handleSessionLifecycle(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const consumerMsg = mapSessionLifecycle(msg);
    this.traceT4("mapSessionLifecycle", session, msg, consumerMsg, trace);
    this.broadcaster.broadcast(session, consumerMsg);
  }

  // ── Trace helpers ────────────────────────────────────────────────────────

  private traceT4(
    mapperName: string,
    session: Session,
    unifiedMsg: UnifiedMessage,
    consumerMsg: unknown,
    trace: RouteTrace,
  ): void {
    this.tracer.translate(
      mapperName,
      "T4",
      { format: "UnifiedMessage", body: unifiedMsg },
      { format: "ConsumerMessage", body: consumerMsg },
      {
        sessionId: session.id,
        traceId: trace.traceId,
        requestId: trace.requestId,
        command: trace.command,
        phase: "t4",
      },
    );
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
}
