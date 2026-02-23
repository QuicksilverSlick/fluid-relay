import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDefaultState, type Session } from "../session/session-repository.js";
import { reduceSessionData } from "../session/session-state-reducer.js";
import { TeamToolCorrelationBuffer } from "../team/team-tool-correlation.js";
import { createUnifiedMessage, type UnifiedMessage } from "../types/unified-message.js";
import { noopTracer } from "./message-tracer.js";
import { UnifiedMessageRouter, type UnifiedMessageRouterDeps } from "./unified-message-router.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockBroadcaster() {
  return {
    broadcast: vi.fn(),
    broadcastToParticipants: vi.fn(),
  };
}

function _createMockCapabilitiesPolicy() {
  return {
    sendInitializeRequest: vi.fn(),
    applyCapabilities: vi.fn(),
    handleControlResponse: vi.fn(),
  };
}

function _createMockQueueHandler() {
  return {
    autoSendQueuedMessage: vi.fn(),
  };
}

function _createMockGitTracker() {
  return {
    resetAttempt: vi.fn(),
    resolveGitInfo: vi.fn(),
    refreshGitInfo: vi.fn().mockReturnValue(null),
  };
}

function _createMockGitResolver() {
  return {
    resolve: vi.fn().mockReturnValue(null),
  };
}

function createMockSession(id = "sess-1", stateOverrides: Record<string, unknown> = {}): Session {
  const state = { ...makeDefaultState(id), ...stateOverrides };
  return {
    id,
    backendSession: null,
    backendAbort: null,
    consumerSockets: new Map(),
    consumerRateLimiters: new Map(),
    anonymousCounter: 0,
    data: {
      state,
      pendingPermissions: new Map(),
      messageHistory: [],
      pendingMessages: [],
      queuedMessage: null,
      lastStatus: null,
      adapterSupportsSlashPassthrough: false,
      adapterName: undefined,
      backendSessionId: undefined,
    },
    lastActivity: Date.now(),
    pendingInitialize: null,
    teamCorrelationBuffer: {
      onToolUse: vi.fn(),
      onToolResult: vi.fn().mockReturnValue(null),
      flush: vi.fn().mockReturnValue(0),
      get pendingCount() {
        return 0;
      },
    } as any,
    registry: {
      clearDynamic: vi.fn(),
      registerFromCLI: vi.fn(),
      registerSkills: vi.fn(),
    } as any,
    pendingPassthroughs: [],
    adapterSlashExecutor: null,
  };
}

function createDeps(overrides: Partial<UnifiedMessageRouterDeps> = {}): UnifiedMessageRouterDeps {
  return {
    broadcaster: createMockBroadcaster() as any,
    emitEvent: vi.fn(),
    tracer: noopTracer,
    ...overrides,
  };
}

function msg(type: string, metadata: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: type as any,
    role: "system",
    metadata,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UnifiedMessageRouter", () => {
  const routeMessage = (session: any, m: any) => {
    const prevData = session.data;
    session.data = reduceSessionData(
      session.data,
      m,
      session.teamCorrelationBuffer || new TeamToolCorrelationBuffer(),
    );
    router.route(session, m, prevData);
  };

  let deps: UnifiedMessageRouterDeps;
  let router: UnifiedMessageRouter;
  let session: Session;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createDeps();
    router = new UnifiedMessageRouter(deps);
    session = createMockSession();
  });

  // ── session_init ──────────────────────────────────────────────────────

  describe("session_init", () => {
    it("broadcasts session_init and persists", () => {
      const m = msg("session_init", { model: "claude" });
      routeMessage(session, m);

      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "session_init" }),
      );
    });
  });

  // ── status_change ─────────────────────────────────────────────────────

  describe("status_change", () => {
    it("updates lastStatus and broadcasts", () => {
      const m = msg("status_change", { status: "running" });
      (session.data as any).lastStatus = "running";
      routeMessage(session, m);

      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "status_change", status: "running" }),
      );
    });

    it("broadcasts permissionMode change when present", () => {
      session.data.state.permissionMode = "bypassPermissions";
      const m = msg("status_change", { status: "idle", permissionMode: "bypassPermissions" });
      routeMessage(session, m);

      // Should broadcast both status_change and session_update
      const broadcastCalls = (deps.broadcaster.broadcast as ReturnType<typeof vi.fn>).mock.calls;
      const sessionUpdateCall = broadcastCalls.find(
        (call: unknown[]) => (call[1] as any).type === "session_update",
      );
      expect(sessionUpdateCall).toBeDefined();
    });

    it("broadcasts status: retry and retains retry metadata", () => {
      const m = msg("status_change", {
        status: "retry",
        retry: true,
        attempt: 1,
        message: "The usage limit has been reached",
        next: 9999999,
      });
      (session.data as any).lastStatus = "retry";
      routeMessage(session, m);

      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({
          type: "status_change",
          status: "retry",
          metadata: expect.objectContaining({
            retry: true,
            attempt: 1,
            message: "The usage limit has been reached",
            next: 9999999,
          }),
        }),
      );
    });
  });

  // ── assistant ─────────────────────────────────────────────────────────

  describe("assistant", () => {
    it("adds to history and broadcasts", () => {
      const m = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        metadata: {
          message_id: "msg-1",
          model: "claude",
          stop_reason: "end_turn",
          parent_tool_use_id: null,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });
      routeMessage(session, m);

      expect(session.data.messageHistory).toHaveLength(1);
      expect(deps.broadcaster.broadcast).toHaveBeenCalled();
    });

    it("preserves empty assistant content without stream backfill", () => {
      const stream = msg("stream_event", {
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "stream text" },
        },
      });
      routeMessage(session, stream);

      const emptyAssistant = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [],
        metadata: {
          message_id: "msg-empty",
          model: "claude",
          stop_reason: "end_turn",
          parent_tool_use_id: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });
      routeMessage(session, emptyAssistant);

      const last = session.data.messageHistory[session.data.messageHistory.length - 1];
      expect(last.type).toBe("assistant");
      if (last.type === "assistant") {
        expect(last.message.content).toEqual([]);
      }
    });

    it("drops duplicate assistant events with same message id and content", () => {
      const m = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "same" }],
        metadata: {
          message_id: "msg-dup",
          model: "claude",
          stop_reason: "end_turn",
          parent_tool_use_id: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });

      routeMessage(session, m);
      routeMessage(session, m);

      expect(session.data.messageHistory).toHaveLength(1);
      expect(deps.broadcaster.broadcast).toHaveBeenCalledTimes(1);
    });

    it("updates prior assistant entry when same message id has new content", () => {
      const first = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "first" }],
        metadata: {
          message_id: "msg-update",
          model: "claude",
          stop_reason: "end_turn",
          parent_tool_use_id: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });
      const second = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "second" }],
        metadata: {
          message_id: "msg-update",
          model: "claude",
          stop_reason: "end_turn",
          parent_tool_use_id: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });

      routeMessage(session, first);
      routeMessage(session, second);

      expect(session.data.messageHistory).toHaveLength(1);
      const item = session.data.messageHistory[0];
      expect(item.type).toBe("assistant");
      if (item.type === "assistant") {
        expect(item.message.id).toBe("msg-update");
        expect(item.message.content).toEqual([{ type: "text", text: "second" }]);
      }
      expect(deps.broadcaster.broadcast).toHaveBeenCalledTimes(2);
    });
  });

  // ── result ────────────────────────────────────────────────────────────

  describe("result", () => {
    it("persists session after result updates", () => {
      const m = msg("result", {
        subtype: "success",
        is_error: false,
        num_turns: 2,
        total_cost_usd: 0.01,
      });
      routeMessage(session, m);
    });
  });

  // ── stream_event ──────────────────────────────────────────────────────

  describe("stream_event", () => {
    it("infers running status from message_start (not sub-agent)", () => {
      const m = msg("stream_event", {
        event: { type: "message_start" },
        parent_tool_use_id: undefined,
      });
      (session.data as any).lastStatus = "running";
      routeMessage(session, m);

      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "status_change", status: "running" }),
      );
    });

    it("does not set running for sub-agent message_start", () => {
      const m = msg("stream_event", {
        event: { type: "message_start" },
        parent_tool_use_id: "tu-123",
      });
      routeMessage(session, m);

      expect(session.data.lastStatus).not.toBe("running");
    });

    it("does not set running for non-message_start events", () => {
      const m = msg("stream_event", {
        event: { type: "content_block_delta" },
      });
      routeMessage(session, m);

      expect(session.data.lastStatus).not.toBe("running");
    });
  });

  // ── permission_request ────────────────────────────────────────────────

  describe("permission_request", () => {
    it("stores pending permission and broadcasts to participants", () => {
      const m = msg("permission_request", {
        request_id: "perm-1",
        tool_name: "Bash",
        input: { command: "ls" },
        tool_use_id: "tu-1",
      });
      routeMessage(session, m);

      expect(session.data.pendingPermissions.has("perm-1")).toBe(true);
      expect(deps.broadcaster.broadcastToParticipants).toHaveBeenCalled();
      // emitEvent("permission:requested") is now emitted by SessionRuntime.orchestratePermissionRequest
    });

    it("skips non-can_use_tool subtypes", () => {
      const m = msg("permission_request", {
        subtype: "other_type",
        request_id: "perm-1",
        tool_name: "Bash",
        input: {},
        tool_use_id: "tu-1",
      });
      routeMessage(session, m);

      expect(session.data.pendingPermissions.has("perm-1")).toBe(false);
      expect(deps.broadcaster.broadcastToParticipants).not.toHaveBeenCalled();
    });
  });

  // ── control_response ──────────────────────────────────────────────────

  // ── tool_progress ─────────────────────────────────────────────────────

  describe("tool_progress", () => {
    it("broadcasts tool progress", () => {
      const m = msg("tool_progress", {
        tool_use_id: "tu-1",
        tool_name: "Bash",
        elapsed_time_seconds: 5,
      });
      routeMessage(session, m);

      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "tool_progress" }),
      );
    });
  });

  // ── tool_use_summary ──────────────────────────────────────────────────

  describe("tool_use_summary", () => {
    it("persists and broadcasts tool use summary", () => {
      const m = msg("tool_use_summary", {
        summary: "Ran command",
        tool_use_id: "tu-1",
        tool_use_ids: ["tu-1"],
        output: "ok",
      });
      routeMessage(session, m);

      expect(session.data.messageHistory).toHaveLength(1);
      expect(session.data.messageHistory[0]).toEqual(
        expect.objectContaining({
          type: "tool_use_summary",
          tool_use_id: "tu-1",
          output: "ok",
        }),
      );
      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "tool_use_summary" }),
      );
    });

    it("drops duplicate tool summaries with same tool_use_id and payload", () => {
      const m = msg("tool_use_summary", {
        summary: "Ran command",
        tool_use_id: "tu-dup",
        tool_use_ids: ["tu-dup"],
        output: "ok",
      });

      routeMessage(session, m);
      routeMessage(session, m);

      expect(session.data.messageHistory).toHaveLength(1);
      expect(deps.broadcaster.broadcast).toHaveBeenCalledTimes(1);
    });

    it("updates existing tool summary when same tool_use_id has new output", () => {
      const first = msg("tool_use_summary", {
        summary: "Ran command",
        tool_use_id: "tu-update",
        tool_use_ids: ["tu-update"],
        output: "line 1",
      });
      const second = msg("tool_use_summary", {
        summary: "Ran command",
        tool_use_id: "tu-update",
        tool_use_ids: ["tu-update"],
        output: "line 1\nline 2",
      });

      routeMessage(session, first);
      routeMessage(session, second);

      expect(session.data.messageHistory).toHaveLength(1);
      expect(session.data.messageHistory[0]).toEqual(
        expect.objectContaining({
          type: "tool_use_summary",
          tool_use_id: "tu-update",
          output: "line 1\nline 2",
        }),
      );
      expect(deps.broadcaster.broadcast).toHaveBeenCalledTimes(2);
    });
  });

  // ── auth_status ───────────────────────────────────────────────────────

  describe("auth_status", () => {
    it("broadcasts and emits auth_status event", () => {
      const m = msg("auth_status", {
        isAuthenticating: true,
        output: ["Authenticating..."],
      });
      routeMessage(session, m);

      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "auth_status" }),
      );
      // emitEvent("auth_status") is now emitted by SessionRuntime.orchestrateAuthStatus
    });
  });

  // ── configuration_change ──────────────────────────────────────────────

  describe("configuration_change", () => {
    it("broadcasts model patch via session_update", () => {
      const m = msg("configuration_change", { model: "claude-opus" });
      routeMessage(session, m);

      const broadcastCalls = (deps.broadcaster.broadcast as ReturnType<typeof vi.fn>).mock.calls;
      const updateCall = broadcastCalls.find(
        (call: unknown[]) => (call[1] as any).type === "session_update",
      );
      expect(updateCall).toBeDefined();
      expect((updateCall![1] as any).session.model).toBe("claude-opus");
    });

    it("broadcasts permissionMode from mode field", () => {
      const m = msg("configuration_change", { mode: "bypassPermissions" });
      routeMessage(session, m);

      const broadcastCalls = (deps.broadcaster.broadcast as ReturnType<typeof vi.fn>).mock.calls;
      const updateCall = broadcastCalls.find(
        (call: unknown[]) =>
          (call[1] as any).type === "session_update" &&
          (call[1] as any).session?.permissionMode !== undefined,
      );
      expect(updateCall).toBeDefined();
    });

    it("broadcasts permissionMode from permissionMode field", () => {
      const m = msg("configuration_change", { permissionMode: "plan" });
      routeMessage(session, m);

      const broadcastCalls = (deps.broadcaster.broadcast as ReturnType<typeof vi.fn>).mock.calls;
      const updateCall = broadcastCalls.find(
        (call: unknown[]) =>
          (call[1] as any).type === "session_update" &&
          (call[1] as any).session?.permissionMode !== undefined,
      );
      expect(updateCall).toBeDefined();
    });

    it("persists when patch has keys", () => {
      const m = msg("configuration_change", { model: "claude-opus" });
      routeMessage(session, m);
    });

    it("does not broadcast session_update when no model or mode", () => {
      const m = msg("configuration_change", { unrelated: true });
      routeMessage(session, m);

      const broadcastCalls = (deps.broadcaster.broadcast as ReturnType<typeof vi.fn>).mock.calls;
      // Should have the configuration_change broadcast but no session_update
      const updateCall = broadcastCalls.find(
        (call: unknown[]) => (call[1] as any).type === "session_update",
      );
      expect(updateCall).toBeUndefined();
    });
  });

  // ── session_lifecycle ─────────────────────────────────────────────────

  describe("session_lifecycle", () => {
    it("broadcasts session lifecycle message", () => {
      const m = msg("session_lifecycle", { subtype: "resumed" });
      routeMessage(session, m);

      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "session_lifecycle" }),
      );
    });
  });

  // ── default / unhandled ────────────────────────────────────────────────

  it("routes unhandled message types to tracer without throwing", () => {
    const m = msg("some_unknown_type_xyz");
    expect(() => routeMessage(session, m)).not.toThrow();
  });
});
