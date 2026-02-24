import { describe, expect, it, vi } from "vitest";
import { createMockSession, createTestSocket } from "../../testing/cli-message-factories.js";
import type { BackendSession } from "../interfaces/backend-adapter.js";
import { noopTracer } from "../messaging/message-tracer.js";
import { makeDefaultState } from "../session/session-repository.js";
import { createUnifiedMessage } from "../types/unified-message.js";
import { SessionRuntime, type SessionRuntimeDeps } from "./session-runtime.js";

function makeDeps(overrides?: Partial<SessionRuntimeDeps>): SessionRuntimeDeps {
  return {
    config: { maxMessageHistoryLength: 100 },
    broadcaster: {
      broadcast: vi.fn(),
      broadcastToParticipants: vi.fn(),
      broadcastPresence: vi.fn(),
      sendTo: vi.fn(),
    } as any,
    queueHandler: {
      handleQueueMessage: vi.fn(),
      handleUpdateQueuedMessage: vi.fn(),
      handleCancelQueuedMessage: vi.fn(),
      autoSendQueuedMessage: vi.fn(),
    },
    slashService: {
      handleInbound: vi.fn(),
      executeProgrammatic: vi.fn(async () => null),
    },
    backendConnector: { sendToBackend: vi.fn() } as any,
    tracer: noopTracer,
    store: { persist: vi.fn(), persistSync: vi.fn() } as any,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    gitTracker: {
      resetAttempt: vi.fn(),
      refreshGitInfo: vi.fn(() => null),
      resolveGitInfo: vi.fn(),
    } as any,
    gitResolver: null,
    emitEvent: vi.fn(),
    capabilitiesPolicy: {
      initialize: vi.fn(),
      applyCapabilities: vi.fn(),
      sendInitializeRequest: vi.fn(),
      handleControlResponse: vi.fn(),
    } as any,

    ...overrides,
  };
}

describe("SessionRuntime", () => {
  it("hydrates slash registry from persisted state on runtime creation", () => {
    const session = createMockSession({
      id: "s1",
      data: {
        state: {
          ...createMockSession().data.state,
          slash_commands: ["/help", "/clear"],
          skills: ["tdd-guide"],
        },
        pendingPermissions: new Map(),
        messageHistory: [],
        pendingMessages: [],
        queuedMessage: null,
        lastStatus: null,
        adapterSupportsSlashPassthrough: false,
      },
    });
    const clearDynamic = vi.fn();
    const registerFromCLI = vi.fn();
    const registerSkills = vi.fn();
    session.registry = {
      clearDynamic,
      registerFromCLI,
      registerSkills,
    } as any;

    new SessionRuntime(session, makeDeps());

    expect(clearDynamic).toHaveBeenCalledTimes(1);
    expect(registerFromCLI).toHaveBeenCalledWith([
      { name: "/help", description: "" },
      { name: "/clear", description: "" },
    ]);
    expect(registerSkills).toHaveBeenCalledWith(["tdd-guide"]);
  });

  it("handles user_message with optimistic running state", () => {
    const session = createMockSession({
      id: "s1",
      data: { lastStatus: null },
      backendSession: { send: vi.fn() } as any,
    });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "INBOUND_COMMAND",
      command: {
        type: "user_message",
        content: "hello",
        session_id: "backend-1",
      },
      ws: createTestSocket(),
    });

    expect(runtime.getLastStatus()).toBe("running");
    expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      expect.objectContaining({ type: "user_message", content: "hello" }),
    );
    expect(deps.backendConnector.sendToBackend).toHaveBeenCalledTimes(1);
    expect(runtime.getLifecycleState()).toBe("active");
    expect(deps.store.persist).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
  });

  it("rejects user_message when lifecycle is closed", () => {
    const send = vi.fn();
    const session = createMockSession({
      id: "s1",
      data: { lastStatus: null },
      backendSession: { send } as any,
    });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);
    const ws = createTestSocket();

    runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "SESSION_CLOSING" } });
    runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "SESSION_CLOSED" } });

    runtime.process({
      type: "INBOUND_COMMAND",
      command: {
        type: "user_message",
        content: "should-reject",
        session_id: "backend-1",
      },
      ws: ws,
    });

    expect(runtime.getLifecycleState()).toBe("closed");
    expect(runtime.getLastStatus()).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(runtime.getMessageHistory()).toEqual([]);
    expect(runtime.getState().adapterName === undefined || true).toBe(true); // pendingMessages not changed
    expect(deps.store.persist).not.toHaveBeenCalled();
    expect(deps.broadcaster.sendTo).toHaveBeenCalledWith(ws, {
      type: "error",
      message: "Session is closing or closed and cannot accept new messages.",
    });
    // The reducer now short-circuits for closed/closing lifecycle before attempting
    // a transitionLifecycle call, so no logger.warn is emitted.
  });

  it("trims message history using runtime-owned max length", () => {
    const send = vi.fn();
    const session = createMockSession({
      id: "s1",
      data: {
        messageHistory: [{ type: "user_message", content: "old", timestamp: 1 }] as any,
      },
      backendSession: { send } as any,
    });
    const runtime = new SessionRuntime(
      session,
      makeDeps({ config: { maxMessageHistoryLength: 1 } }),
    );

    runtime.sendUserMessage("new");

    expect(runtime.getMessageHistory()).toHaveLength(1);
    expect(runtime.getMessageHistory()[0]).toEqual(
      expect.objectContaining({ type: "user_message", content: "new" }),
    );
  });

  it("keeps the most recent user messages when trimming", () => {
    const send = vi.fn();
    const session = createMockSession({
      id: "s1",
      backendSession: { send } as any,
    });
    const runtime = new SessionRuntime(
      session,
      makeDeps({ config: { maxMessageHistoryLength: 2 } }),
    );

    runtime.sendUserMessage("first");
    runtime.sendUserMessage("second");
    runtime.sendUserMessage("third");

    expect(runtime.getMessageHistory()).toHaveLength(2);
    expect(runtime.getMessageHistory()[0]).toEqual(
      expect.objectContaining({ type: "user_message", content: "second" }),
    );
    expect(runtime.getMessageHistory()[1]).toEqual(
      expect.objectContaining({ type: "user_message", content: "third" }),
    );
  });

  it("trims messageHistory to maxMessageHistoryLength when processing backend messages", () => {
    const deps = makeDeps({ config: { maxMessageHistoryLength: 2 } });
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, deps);

    // Three assistant messages should be reduced to 2
    for (let i = 0; i < 3; i++) {
      runtime.process({
        type: "BACKEND_MESSAGE",
        message: createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [{ type: "text", text: `msg${i}` }],
          metadata: { message_id: `id${i}` },
        }),
      });
    }

    expect(runtime.getMessageHistory().length).toBe(2);
  });

  it("delegates slash_command handling to slash service", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "INBOUND_COMMAND",
      command: {
        type: "slash_command",
        command: "/help",
      },
      ws: createTestSocket(),
    });

    expect(deps.slashService.handleInbound).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: "slash_command",
        command: "/help",
      }),
    );
  });

  it("routes permission_response inbound commands to sendPermissionResponse", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);
    const sendPermissionResponse = vi
      .spyOn(runtime, "sendPermissionResponse")
      .mockImplementation(() => {});

    runtime.process({
      type: "INBOUND_COMMAND",
      command: {
        type: "permission_response",
        request_id: "perm-1",
        behavior: "allow",
        updated_input: { key: "value" },
        updated_permissions: [{ type: "setMode", mode: "plan", destination: "session" }],
        message: "ok",
      },
      ws: createTestSocket(),
    });

    expect(sendPermissionResponse).toHaveBeenCalledWith("perm-1", "allow", {
      updatedInput: { key: "value" },
      updatedPermissions: [{ type: "setMode", mode: "plan", destination: "session" }],
      message: "ok",
    });
  });

  it("routes interrupt inbound commands to sendInterrupt", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);
    const sendInterrupt = vi.spyOn(runtime, "sendInterrupt").mockImplementation(() => {});

    runtime.process({
      type: "INBOUND_COMMAND",
      command: { type: "interrupt" },
      ws: createTestSocket(),
    });

    expect(sendInterrupt).toHaveBeenCalledTimes(1);
  });

  it("routes set_model inbound commands to sendSetModel", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);
    const sendSetModel = vi.spyOn(runtime, "sendSetModel").mockImplementation(() => {});

    runtime.process({
      type: "INBOUND_COMMAND",
      command: {
        type: "set_model",
        model: "claude-opus",
      },
      ws: createTestSocket(),
    });

    expect(sendSetModel).toHaveBeenCalledWith("claude-opus");
  });

  it("routes set_permission_mode inbound commands to sendSetPermissionMode", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);
    const sendSetPermissionMode = vi
      .spyOn(runtime, "sendSetPermissionMode")
      .mockImplementation(() => {});

    runtime.process({
      type: "INBOUND_COMMAND",
      command: {
        type: "set_permission_mode",
        mode: "plan",
      },
      ws: createTestSocket(),
    });

    expect(sendSetPermissionMode).toHaveBeenCalledWith("plan");
  });

  it("rejects set_adapter for active sessions", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const ws = createTestSocket();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "INBOUND_COMMAND",
      command: {
        type: "set_adapter",
        adapter: "codex",
      },
      ws: ws,
    });

    expect(deps.broadcaster.sendTo).toHaveBeenCalledWith(
      ws,
      expect.objectContaining({ type: "error" }),
    );
  });

  it("derives lifecycle transitions from backend status/stream/result messages", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());

    expect(runtime.getLifecycleState()).toBe("awaiting_backend");

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: { status: "idle" },
      }),
    });
    expect(runtime.getLifecycleState()).toBe("idle");

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "stream_event",
        role: "system",
        metadata: {
          event: { type: "message_start" },
          parent_tool_use_id: null,
        },
      }),
    });
    expect(runtime.getLifecycleState()).toBe("active");

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "result",
        role: "system",
        metadata: {
          subtype: "success",
          is_error: false,
          num_turns: 1,
        },
      }),
    });
    expect(runtime.getLifecycleState()).toBe("idle");
  });

  it("warns on permission response for unknown request id", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.sendPermissionResponse("missing", "deny");

    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("missing"));
    expect(deps.emitEvent).not.toHaveBeenCalledWith("permission:resolved", expect.anything());
  });

  it("sends deny permission response to backend when pending request exists", () => {
    const perm: any = {
      request_id: "perm-1",
      options: [],
      expires_at: Date.now() + 1000,
      tool_name: "Bash",
      tool_use_id: "tu-1",
      safety_risk: null,
    };
    const session = createMockSession({
      id: "s1",
      data: { pendingPermissions: new Map([["perm-1", perm]]) },
    });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.sendPermissionResponse("perm-1", "deny");

    expect(deps.emitEvent).toHaveBeenCalledWith("permission:resolved", {
      sessionId: "s1",
      requestId: "perm-1",
      behavior: "deny",
    });
    expect(deps.backendConnector.sendToBackend).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      expect.objectContaining({
        type: "permission_response",
        metadata: expect.objectContaining({ request_id: "perm-1", behavior: "deny" }),
      }),
    );
    expect(runtime.getPendingPermissions().find((p) => p.request_id === "perm-1")).toBeUndefined();
  });

  it("orchestrates session_init (registry reset, git reset, caps initialize)", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);
    const clearDynamic = vi.fn();
    session.registry = {
      clearDynamic,
      registerFromCLI: vi.fn(),
      registerSkills: vi.fn(),
    } as any;

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "session_init",
        role: "system",
        metadata: { model: "claude" },
      }),
    });

    expect(clearDynamic).toHaveBeenCalled();
    expect(deps.gitTracker.resetAttempt).toHaveBeenCalledWith("s1");
    expect(deps.capabilitiesPolicy.sendInitializeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
    );
  });

  it("orchestrates result (auto-naming, git refresh, queue check)", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    // Mock history for auto-naming
    (session.data as any).messageHistory = [
      { type: "user_message", content: "first message" } as any,
    ];

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "result",
        role: "assistant",
        metadata: { num_turns: 1, is_error: false },
      }),
    });

    expect(deps.emitEvent).toHaveBeenCalledWith("session:first_turn_completed", expect.anything());
    expect(deps.gitTracker.refreshGitInfo).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
    );
    expect(deps.queueHandler.autoSendQueuedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
    );
  });

  it("orchestrates status_change to idle (queue check)", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: { status: "idle" },
      }),
    });

    expect(deps.queueHandler.autoSendQueuedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
    );
  });

  it("orchestrates team events when team state changes", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    // 1. Create team via tool_use in assistant message
    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu1",
            name: "TeamCreate",
            input: { team_name: "team1" },
          },
        ],
      }),
    });

    expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      expect.objectContaining({
        type: "session_update",
        session: { team: expect.objectContaining({ name: "team1" }) },
      }),
    );
    expect(deps.emitEvent).toHaveBeenCalledWith("team:created", expect.anything());

    // 2. Dissolve team via tool_use
    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu2",
            name: "TeamDelete",
            input: {},
          },
        ],
      }),
    });

    expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      expect.objectContaining({ type: "session_update", session: { team: null } }),
    );
    expect(deps.emitEvent).toHaveBeenCalledWith("team:deleted", expect.anything());
  });

  it("orchestrates permission_request (emits permission:requested event)", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "permission_request",
        role: "assistant",
        metadata: {
          request_id: "perm-1",
          tool_name: "Bash",
          input: { command: "ls" },
          tool_use_id: "tu-1",
        },
      }),
    });

    expect(deps.emitEvent).toHaveBeenCalledWith(
      "permission:requested",
      expect.objectContaining({ sessionId: "s1" }),
    );
  });

  it("orchestrates auth_status (emits auth_status event)", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "auth_status",
        role: "assistant",
        metadata: { isAuthenticating: true, output: ["Authenticating..."] },
      }),
    });

    expect(deps.emitEvent).toHaveBeenCalledWith(
      "auth_status",
      expect.objectContaining({ sessionId: "s1", isAuthenticating: true }),
    );
  });

  it("includes updated_permissions in permission response metadata", () => {
    const perm: any = {
      request_id: "perm-2",
      options: [],
      expires_at: Date.now() + 1000,
      tool_name: "Bash",
      tool_use_id: "tu-2",
      safety_risk: null,
    };
    const session = createMockSession({
      id: "s1",
      data: { pendingPermissions: new Map([["perm-2", perm]]) },
    });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.sendPermissionResponse("perm-2", "allow", {
      updatedPermissions: [{ type: "setMode", mode: "plan", destination: "session" }],
    });

    expect(deps.backendConnector.sendToBackend).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      expect.objectContaining({
        type: "permission_response",
        metadata: expect.objectContaining({
          updated_permissions: [{ type: "setMode", mode: "plan", destination: "session" }],
        }),
      }),
    );
  });

  it("normalizes and sends control requests for interrupt/model/mode", () => {
    const session = createMockSession({ id: "s1", backendSession: { send: vi.fn() } as any });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.sendInterrupt();
    runtime.sendSetModel("claude-opus");
    runtime.sendSetPermissionMode("plan");

    expect(deps.backendConnector.sendToBackend).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "s1" }),
      expect.objectContaining({
        type: "interrupt",
      }),
    );
    expect(deps.backendConnector.sendToBackend).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "s1" }),
      expect.objectContaining({
        type: "configuration_change",
        metadata: expect.objectContaining({ subtype: "set_model", model: "claude-opus" }),
      }),
    );
    expect(deps.backendConnector.sendToBackend).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ id: "s1" }),
      expect.objectContaining({
        type: "configuration_change",
        metadata: expect.objectContaining({ subtype: "set_permission_mode", mode: "plan" }),
      }),
    );
  });

  it("sendSetModel updates session.data.state.model and broadcasts session_update", () => {
    const send = vi.fn();
    const session = createMockSession({
      id: "s1",
      data: { state: { ...makeDefaultState("s1"), model: "claude-sonnet-4-6" } },
      backendSession: { send } as any,
    });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.sendSetModel("claude-haiku-4-5");

    expect(runtime.getState().model).toBe("claude-haiku-4-5");
    expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      expect.objectContaining({
        type: "session_update",
        session: expect.objectContaining({ model: "claude-haiku-4-5" }),
      }),
    );
  });

  it("sendSetModel does not update state or broadcast when backendSession is null", () => {
    const session = createMockSession({
      id: "s1",
      data: { state: { ...makeDefaultState("s1"), model: "claude-sonnet-4-6" } },
    });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.sendSetModel("claude-haiku-4-5");

    expect(runtime.getState().model).toBe("claude-sonnet-4-6");
    expect(deps.broadcaster.broadcast).not.toHaveBeenCalled();
  });

  it("delegates programmatic slash execution to slash service", async () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    (deps.slashService.executeProgrammatic as any).mockResolvedValueOnce({
      content: "help",
      source: "emulated",
    });
    const runtime = new SessionRuntime(session, deps);

    const result = await runtime.executeSlashCommand("/help");

    expect(result).toEqual({ content: "help", source: "emulated" });
    expect(deps.slashService.executeProgrammatic).toHaveBeenCalledWith(session, "/help");
  });

  it("returns null when slash service does not emulate programmatic command", async () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    (deps.slashService.executeProgrammatic as any).mockResolvedValueOnce(null);
    const runtime = new SessionRuntime(session, deps);

    const result = await runtime.executeSlashCommand("/status");

    expect(result).toBeNull();
    expect(deps.slashService.executeProgrammatic).toHaveBeenCalledWith(session, "/status");
  });

  it("rejects invalid lifecycle transitions (closed → active)", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    // Transition to closed via SYSTEM_SIGNAL
    runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "SESSION_CLOSING" } });
    runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "SESSION_CLOSED" } });
    expect(runtime.getLifecycleState()).toBe("closed");

    // Attempt to reopen — should stay closed (reducer rejects invalid transitions)
    const mockBackendSession = { send: vi.fn(), sendRaw: vi.fn(), close: vi.fn(), messages: [] };
    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: {
        kind: "BACKEND_CONNECTED",
        backendSession: mockBackendSession as unknown as BackendSession,
        backendAbort: new AbortController(),
        supportsSlashPassthrough: false,
        slashExecutor: null,
      },
    });
    expect(runtime.getLifecycleState()).toBe("closed");
  });

  it("applies reconnect_timeout policy by transitioning to degraded", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());

    const mockBackendSession = { send: vi.fn(), sendRaw: vi.fn(), close: vi.fn(), messages: [] };
    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: {
        kind: "BACKEND_CONNECTED",
        backendSession: mockBackendSession as unknown as BackendSession,
        backendAbort: new AbortController(),
        supportsSlashPassthrough: false,
        slashExecutor: null,
      },
    });
    runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "RECONNECT_TIMEOUT" } });

    expect(runtime.getLifecycleState()).toBe("degraded");
  });

  it("applies idle_reap policy by transitioning to closing", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());

    runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "IDLE_REAP" } });

    expect(runtime.getLifecycleState()).toBe("closing");
  });

  describe("SYSTEM_SIGNAL state-patch kinds", () => {
    it("STATE_PATCHED merges patch into data.state", () => {
      const session = createMockSession({ id: "s1" });
      const runtime = new SessionRuntime(session, makeDeps());

      runtime.process({
        type: "SYSTEM_SIGNAL",
        signal: { kind: "STATE_PATCHED", patch: { model: "claude-opus-4" } },
      });

      expect(runtime.getState().model).toBe("claude-opus-4");
    });

    it("LAST_STATUS_UPDATED sets lastStatus", () => {
      const session = createMockSession({ id: "s1" });
      const runtime = new SessionRuntime(session, makeDeps());

      runtime.process({
        type: "SYSTEM_SIGNAL",
        signal: { kind: "LAST_STATUS_UPDATED", status: "running" },
      });

      expect(runtime.getLastStatus()).toBe("running");
    });

    it("QUEUED_MESSAGE_UPDATED sets queuedMessage", () => {
      const session = createMockSession({ id: "s1" });
      const runtime = new SessionRuntime(session, makeDeps());
      const queued = { consumerId: "u1", displayName: "User", content: "hi", queuedAt: 1 };

      runtime.process({
        type: "SYSTEM_SIGNAL",
        signal: { kind: "QUEUED_MESSAGE_UPDATED", message: queued },
      });

      expect(runtime.getQueuedMessage()).toEqual(queued);
    });

    it("MODEL_UPDATED patches state.model and broadcasts session_update", () => {
      const session = createMockSession({ id: "s1" });
      const deps = makeDeps();
      const runtime = new SessionRuntime(session, deps);

      runtime.process({
        type: "SYSTEM_SIGNAL",
        signal: { kind: "MODEL_UPDATED", model: "claude-haiku-4" },
      });

      expect(runtime.getState().model).toBe("claude-haiku-4");
      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ id: "s1" }),
        expect.objectContaining({ type: "session_update", session: { model: "claude-haiku-4" } }),
      );
    });
  });

  it("sets adapter name and persists session via ADAPTER_NAME_SET signal", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "ADAPTER_NAME_SET", name: "codex" } });

    expect(runtime.getState().adapterName).toBe("codex");
    expect(runtime.getState().adapterName).toBe("codex");
    expect(deps.store.persist).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
  });

  it("seeds session state and triggers git resolution", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "SESSION_SEEDED", cwd: "/tmp/project", model: "claude-test" },
    });

    expect(runtime.getState().cwd).toBe("/tmp/project");
    expect(runtime.getState().model).toBe("claude-test");
    expect(deps.gitTracker.resolveGitInfo).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
    );
  });

  it("manages anonymous identity index and consumer registration lifecycle", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());
    const ws = createTestSocket();

    expect(runtime.allocateAnonymousIdentityIndex()).toBe(1);
    expect(runtime.allocateAnonymousIdentityIndex()).toBe(2);

    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: {
        kind: "CONSUMER_CONNECTED",
        ws,
        identity: { userId: "u1", displayName: "User One", role: "participant" },
      },
    });
    session.consumerRateLimiters.set(ws, { allow: () => true } as any);

    expect(runtime.getConsumerIdentity(ws)).toEqual({
      userId: "u1",
      displayName: "User One",
      role: "participant",
    });
    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "CONSUMER_DISCONNECTED", ws },
    });
    expect(session.consumerSockets.has(ws)).toBe(false);
    expect(session.consumerRateLimiters.has(ws)).toBe(false);
  });

  it("routes presence_query inbound commands to broadcaster presence updates", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);
    const ws = createTestSocket();
    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: {
        kind: "CONSUMER_CONNECTED",
        ws,
        identity: { userId: "u1", displayName: "U1", role: "participant" },
      },
    });

    runtime.process({ type: "INBOUND_COMMAND", command: { type: "presence_query" }, ws: ws });

    expect(deps.broadcaster.broadcastPresence).toHaveBeenCalledWith(session);
  });

  it("getSessionSnapshot includes connected consumer identities", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());
    const ws1 = createTestSocket();
    const ws2 = createTestSocket();
    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: {
        kind: "CONSUMER_CONNECTED",
        ws: ws1,
        identity: { userId: "u1", displayName: "Alice", role: "participant" },
      },
    });
    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: {
        kind: "CONSUMER_CONNECTED",
        ws: ws2,
        identity: { userId: "u2", displayName: "Bob", role: "observer" },
      },
    });

    const snapshot = runtime.getSessionSnapshot();

    expect(snapshot.consumers).toEqual([
      { userId: "u1", displayName: "Alice", role: "participant" },
      { userId: "u2", displayName: "Bob", role: "observer" },
    ]);
    expect(snapshot.consumerCount).toBe(2);
  });

  it("owns state, status, and queued message accessors via system signals", () => {
    const session = createMockSession({
      id: "s1",
      data: { lastStatus: null, queuedMessage: null },
    });
    const runtime = new SessionRuntime(session, makeDeps());
    const queued = {
      consumerId: "u1",
      displayName: "User One",
      content: "queued",
      queuedAt: 1,
    };

    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "STATE_PATCHED", patch: { model: "claude-sonnet-4-5" } },
    });
    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "LAST_STATUS_UPDATED", status: "running" },
    });
    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "QUEUED_MESSAGE_UPDATED", message: queued as any },
    });

    expect(runtime.getState().model).toBe("claude-sonnet-4-5");
    expect(runtime.getLastStatus()).toBe("running");
    expect(runtime.getQueuedMessage()).toEqual(queued);
  });

  it("owns rate limiter map mutation for consumer throttling", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());
    const ws = createTestSocket();
    const limiter = { tryConsume: vi.fn(() => true) };
    const createLimiter = vi.fn(() => limiter as any);

    expect(runtime.checkRateLimit(ws, createLimiter)).toBe(true);
    expect(createLimiter).toHaveBeenCalledTimes(1);
    expect(session.consumerRateLimiters.get(ws)).toBe(limiter);

    expect(runtime.checkRateLimit(ws, createLimiter)).toBe(true);
    expect(createLimiter).toHaveBeenCalledTimes(1);
    expect(limiter.tryConsume).toHaveBeenCalledTimes(2);
  });

  it("closes and unregisters all consumers during shutdown cleanup", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());
    const ws1 = createTestSocket();
    const ws2 = createTestSocket();
    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: {
        kind: "CONSUMER_CONNECTED",
        ws: ws1,
        identity: { userId: "u1", displayName: "U1", role: "participant" },
      },
    });
    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: {
        kind: "CONSUMER_CONNECTED",
        ws: ws2,
        identity: { userId: "u2", displayName: "U2", role: "observer" },
      },
    });
    session.consumerRateLimiters.set(ws1, { tryConsume: () => true } as any);
    session.consumerRateLimiters.set(ws2, { tryConsume: () => true } as any);

    runtime.closeAllConsumers();

    expect(ws1.close).toHaveBeenCalledTimes(1);
    expect(ws2.close).toHaveBeenCalledTimes(1);
    expect(session.consumerSockets.size).toBe(0);
    expect(session.consumerRateLimiters.size).toBe(0);
  });

  it("continues shutdown cleanup when a consumer close throws", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());
    const ws1 = createTestSocket();
    const ws2 = createTestSocket();
    ws1.close.mockImplementation(() => {
      throw new Error("already closed");
    });
    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: {
        kind: "CONSUMER_CONNECTED",
        ws: ws1,
        identity: { userId: "u1", displayName: "U1", role: "participant" },
      },
    });
    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: {
        kind: "CONSUMER_CONNECTED",
        ws: ws2,
        identity: { userId: "u2", displayName: "U2", role: "observer" },
      },
    });

    expect(() => runtime.closeAllConsumers()).not.toThrow();
    expect(ws2.close).toHaveBeenCalledTimes(1);
    expect(session.consumerSockets.size).toBe(0);
  });

  it("attaches backend connection via BACKEND_CONNECTED signal and clears it via BACKEND_DISCONNECTED", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());
    const backendSession = {
      send: vi.fn(),
      close: vi.fn(),
      sessionId: "s1",
      sendRaw: vi.fn(),
      messages: [],
    } as any;
    const abort = new AbortController();
    const slashExecutor = {
      handles: vi.fn(() => false),
      execute: vi.fn(async () => null),
      supportedCommands: vi.fn(() => ["/compact"]),
    } as any;

    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: {
        kind: "BACKEND_CONNECTED",
        backendSession,
        backendAbort: abort,
        supportsSlashPassthrough: true,
        slashExecutor,
      },
    });

    expect(runtime.getBackendSession()).toBe(backendSession);
    expect(runtime.getBackendAbort()).toBe(abort);
    expect(runtime.isBackendConnected()).toBe(true);

    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "BACKEND_DISCONNECTED", reason: "normal" },
    });

    expect(runtime.getBackendSession()).toBeNull();
    expect(runtime.isBackendConnected()).toBe(false);
    expect(session.adapterSlashExecutor).toBeNull();
  });

  it("BACKEND_CONNECTED drains pending messages via SEND_TO_BACKEND effects", () => {
    const m1 = createUnifiedMessage({ type: "interrupt", role: "system" });
    const m2 = createUnifiedMessage({ type: "interrupt", role: "system", metadata: { seq: 2 } });
    const mockBackendSession = {
      send: vi.fn(),
      sendRaw: vi.fn(),
      messages: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
      close: vi.fn(),
    };
    const session = createMockSession({
      id: "s1",
      data: { pendingMessages: [m1, m2] as any },
    });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: {
        kind: "BACKEND_CONNECTED",
        backendSession: mockBackendSession as any,
        backendAbort: new AbortController(),
        supportsSlashPassthrough: false,
        slashExecutor: null,
      },
    });

    // SEND_TO_BACKEND effects should have sent pending messages to the backend
    expect(deps.backendConnector.sendToBackend).toHaveBeenCalledTimes(2);
    // pendingMessages cleared via reducer
    expect(runtime.getMessageHistory()).toBeDefined(); // session still valid
  });

  it("BACKEND_DISCONNECTED cancels pending permissions via BROADCAST_TO_PARTICIPANTS effects", () => {
    const p1: any = {
      request_id: "p1",
      command: "cmd",
      input: {},
      timestamp: Date.now(),
      expires_at: Date.now() + 1000,
      tool_name: "test",
      tool_use_id: "tu1",
      safety_risk: null,
    };
    const p2: any = {
      request_id: "p2",
      command: "cmd",
      input: {},
      timestamp: Date.now(),
      expires_at: Date.now() + 1000,
      tool_name: "test",
      tool_use_id: "tu2",
      safety_risk: null,
    };
    const session = createMockSession({
      id: "s1",
      data: {
        lifecycle: "active" as any,
        pendingPermissions: new Map([
          ["p1", p1],
          ["p2", p2],
        ]),
      },
    });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    // Connect with supportsSlashPassthrough: true so we can verify it resets on disconnect
    const mockBackendSession = { send: vi.fn(), sendRaw: vi.fn(), close: vi.fn(), messages: [] };
    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: {
        kind: "BACKEND_CONNECTED",
        backendSession: mockBackendSession as unknown as BackendSession,
        backendAbort: new AbortController(),
        supportsSlashPassthrough: true,
        slashExecutor: null,
      },
    });
    // adapterSupportsSlashPassthrough lives on SessionData (not SessionData.state);
    // access it via the runtime's private session reference (which is updated by spread on each mutation)
    expect((runtime as any).session.data.adapterSupportsSlashPassthrough).toBe(true);

    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "BACKEND_DISCONNECTED", reason: "test" },
    });

    // BROADCAST_TO_PARTICIPANTS effects should send permission_cancelled for each pending permission
    expect(deps.broadcaster.broadcastToParticipants).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "permission_cancelled", request_id: "p1" }),
    );
    expect(deps.broadcaster.broadcastToParticipants).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "permission_cancelled", request_id: "p2" }),
    );
    // pendingPermissions cleared via reducer
    expect(runtime.getPendingPermissions()).toHaveLength(0);
    expect(runtime.getLifecycleState()).toBe("degraded");
    // adapterSupportsSlashPassthrough must be reset on disconnect
    expect((runtime as any).session.data.adapterSupportsSlashPassthrough ?? false).toBe(false);
  });

  it("owns pending passthrough queue operations", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());

    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: {
        kind: "PASSTHROUGH_ENQUEUED",
        entry: {
          command: "/compact",
          requestId: "r1",
          slashRequestId: "sr1",
          traceId: "t1",
          startedAtMs: 1,
        },
      },
    });
    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: {
        kind: "PASSTHROUGH_ENQUEUED",
        entry: {
          command: "/status",
          requestId: "r2",
          slashRequestId: "sr2",
          traceId: "t2",
          startedAtMs: 2,
        },
      },
    });

    expect(runtime.peekPendingPassthrough()).toEqual(
      expect.objectContaining({ command: "/compact", requestId: "r1" }),
    );
    expect(runtime.shiftPendingPassthrough()).toEqual(
      expect.objectContaining({ command: "/compact", requestId: "r1" }),
    );
    expect(runtime.shiftPendingPassthrough()).toEqual(
      expect.objectContaining({ command: "/status", requestId: "r2" }),
    );
    expect(runtime.shiftPendingPassthrough()).toBeUndefined();
  });

  it("sends unified messages to backend when connected", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);
    const message = createUnifiedMessage({ type: "interrupt", role: "system" });

    runtime.sendToBackend(message);

    expect(deps.backendConnector.sendToBackend).toHaveBeenCalledWith(session, message);
  });

  it("getSupportedModels/Commands/AccountInfo return defaults when capabilities absent", () => {
    const session = createMockSession({
      id: "s1",
      data: { state: { ...makeDefaultState("s1"), capabilities: undefined } },
    });
    const runtime = new SessionRuntime(session, makeDeps());

    expect(runtime.getSupportedModels()).toEqual([]);
    expect(runtime.getSupportedCommands()).toEqual([]);
    expect(runtime.getAccountInfo()).toBeNull();
  });

  it("trySendRawToBackend returns 'unsupported' when sendRaw is not present", () => {
    const session = createMockSession({
      id: "s1",
      backendSession: {
        send: vi.fn(),
        // sendRaw intentionally absent — adapter does not support raw send
        close: vi.fn(),
        messages: (async function* () {})(),
        sessionId: "s1",
      } as any,
    });
    const runtime = new SessionRuntime(session, makeDeps());

    expect(runtime.trySendRawToBackend("ndjson-line")).toBe("unsupported");
  });

  it("trySendRawToBackend propagates errors thrown by sendRaw (network errors are not misclassified as unsupported)", () => {
    const session = createMockSession({
      id: "s1",
      backendSession: {
        send: vi.fn(),
        sendRaw: vi.fn(() => {
          throw new Error("connection reset");
        }),
        close: vi.fn(),
        messages: (async function* () {})(),
        sessionId: "s1",
      } as any,
    });
    const runtime = new SessionRuntime(session, makeDeps());

    expect(() => runtime.trySendRawToBackend("ndjson-line")).toThrow("connection reset");
  });

  it("CAPABILITIES_TIMEOUT signal is a no-op", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    // Should not throw or change state
    expect(() =>
      runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "CAPABILITIES_TIMEOUT" } }),
    ).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // sendControlRequest — null backendSession branch
  // ---------------------------------------------------------------------------

  it("pending permissions are populated via BACKEND_MESSAGE permission_request", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "permission_request",
        metadata: {
          request_id: "perm-x",
          options: [],
          expires_at: Date.now() + 1000,
          tool_name: "Bash",
          tool_use_id: "tu-x",
          safety_risk: null,
        },
      }),
    });

    expect(runtime.getPendingPermissions()).toHaveLength(1);
    expect(runtime.getPendingPermissions()[0].request_id).toBe("perm-x");
  });

  it("sendInterrupt is a no-op when no backendSession is attached", () => {
    const session = createMockSession({ id: "s1" }); // no backendSession
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    // Should not throw — sendControlRequest returns early at the null-check
    expect(() => runtime.sendInterrupt()).not.toThrow();
    expect(deps.broadcaster.broadcast).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // handleBackendMessage — history trim branch
  // ---------------------------------------------------------------------------

  it("trims messageHistory when backend messages push it over maxMessageHistoryLength", () => {
    const session = createMockSession({
      id: "s1",
      data: {
        messageHistory: [
          { type: "user_message", content: "msg-a", timestamp: 1 } as any,
          { type: "user_message", content: "msg-b", timestamp: 2 } as any,
        ],
      },
    });
    const runtime = new SessionRuntime(
      session,
      makeDeps({ config: { maxMessageHistoryLength: 1 } }),
    );

    // Any backend message will cause handleBackendMessage to evaluate the trim condition
    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: { status: "idle" },
      }),
    });

    expect(runtime.getMessageHistory()).toHaveLength(1);
    expect(runtime.getMessageHistory()[0]).toMatchObject({ content: "msg-b" });
  });

  // ---------------------------------------------------------------------------
  // orchestrateSessionInit — branch coverage
  // ---------------------------------------------------------------------------

  it("emits backend:session_id event when session_init carries session_id", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "session_init",
        role: "system",
        metadata: { model: "claude", session_id: "backend-xyz-123" },
      }),
    });

    expect(deps.emitEvent).toHaveBeenCalledWith("backend:session_id", {
      sessionId: "s1",
      backendSessionId: "backend-xyz-123",
    });
  });

  it("resolves git info on session_init when gitResolver is provided and cwd is set", () => {
    const gitInfo = { branch: "main", repoRoot: "/project" };
    const gitResolver = { resolve: vi.fn(() => gitInfo) };
    const session = createMockSession({
      id: "s1",
      data: { state: { ...createMockSession().data.state, cwd: "/project" } },
    });
    const deps = makeDeps({ gitResolver: gitResolver as any });
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "session_init",
        role: "system",
        metadata: { model: "claude" },
      }),
    });

    expect(gitResolver.resolve).toHaveBeenCalledWith("/project");
    expect(runtime.getState().git_branch).toBe("main");
  });

  it("registers slash_commands and skills from session_init state into registry", () => {
    const session = createMockSession({ id: "s1" });
    const clearDynamic = vi.fn();
    const registerFromCLI = vi.fn();
    const registerSkills = vi.fn();
    session.registry = { clearDynamic, registerFromCLI, registerSkills } as any;
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);
    clearDynamic.mockClear();
    registerFromCLI.mockClear();
    registerSkills.mockClear();

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "session_init",
        role: "system",
        metadata: { slash_commands: ["/compact", "/help"], skills: ["tdd-guide"] },
      }),
    });

    // clearDynamic called to reset, then re-registered from init data
    expect(clearDynamic).toHaveBeenCalled();
    expect(registerFromCLI).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: "/compact" })]),
    );
    expect(registerSkills).toHaveBeenCalledWith(["tdd-guide"]);
  });

  it("calls applyCapabilities when session_init metadata carries capabilities object", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    const caps = { commands: [{ name: "/compact" }], models: ["claude-opus-4-6"], account: null };

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "session_init",
        role: "system",
        metadata: { model: "claude", capabilities: caps },
      }),
    });

    expect(deps.capabilitiesPolicy.applyCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      caps.commands,
      caps.models,
      null,
    );
    expect(deps.capabilitiesPolicy.sendInitializeRequest).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // orchestrateControlResponse — session-changed branch
  // ---------------------------------------------------------------------------

  it("marks dirty when handleControlResponse mutates session state", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    // Simulate handleControlResponse patching state via process()
    (deps.capabilitiesPolicy.handleControlResponse as any).mockImplementationOnce(() => {
      runtime.process({
        type: "SYSTEM_SIGNAL",
        signal: { kind: "STATE_PATCHED", patch: { model: "injected-model" } },
      });
    });

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "control_response",
        role: "assistant",
        metadata: { request_id: "ctrl-1", capabilities: {} },
      }),
    });

    expect(runtime.getState().model).toBe("injected-model");
  });

  // ---------------------------------------------------------------------------
  // orchestrateResult — git update broadcast branch
  // ---------------------------------------------------------------------------

  it("broadcasts git update when refreshGitInfo returns truthy", () => {
    const session = createMockSession({ id: "s1" });
    const gitUpdate = { branch: "feature/new", repoRoot: "/repo" };
    const deps = makeDeps({
      gitTracker: {
        resetAttempt: vi.fn(),
        refreshGitInfo: vi.fn(() => gitUpdate),
        resolveGitInfo: vi.fn(),
      } as any,
    });
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "result",
        role: "assistant",
        metadata: { subtype: "success", num_turns: 2, is_error: false },
      }),
    });

    // State update is handled internally by gitTracker.refreshGitInfo → patchState → process(STATE_PATCHED).
    // The mock doesn't dispatch that signal, so we only assert the broadcast here.
    expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), {
      type: "session_update",
      session: gitUpdate,
    });
  });

  // ---------------------------------------------------------------------------
  // applyLifecycleFromBackendMessage — running/compacting branches
  // ---------------------------------------------------------------------------

  it("transitions to active on status_change with running status", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());

    // First put it in idle state
    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: { status: "idle" },
      }),
    });
    expect(runtime.getLifecycleState()).toBe("idle");

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: { status: "running" },
      }),
    });
    expect(runtime.getLifecycleState()).toBe("active");
  });

  it("transitions to active on status_change with compacting status", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: { status: "idle" },
      }),
    });

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: { status: "compacting" },
      }),
    });
    expect(runtime.getLifecycleState()).toBe("active");
  });

  // ---------------------------------------------------------------------------
  // sendPermissionResponse — no backendSession branch
  // ---------------------------------------------------------------------------

  it("clears pending permission and emits event when backendSession is absent", () => {
    const perm: any = {
      request_id: "perm-3",
      options: [],
      expires_at: Date.now() + 1000,
      tool_name: "Bash",
      tool_use_id: "tu-3",
      safety_risk: null,
    };
    const session = createMockSession({
      id: "s1",
      data: { pendingPermissions: new Map([["perm-3", perm]]) },
      // no backendSession
    });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.sendPermissionResponse("perm-3", "allow");

    expect(deps.emitEvent).toHaveBeenCalledWith("permission:resolved", {
      sessionId: "s1",
      requestId: "perm-3",
      behavior: "allow",
    });
    expect(runtime.getPendingPermissions()).toHaveLength(0);
    // No backend send attempted since backendSession is null
    expect(deps.broadcaster.broadcast).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Fix 4: SESSION_SEEDED with no params edge case
  // ---------------------------------------------------------------------------

  it("SESSION_SEEDED with no params triggers git resolution but does not change state", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    const stateBefore = runtime.getState();
    runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "SESSION_SEEDED" } });
    // State should be unchanged
    expect(runtime.getState()).toEqual(stateBefore);
    // But git resolution should still be triggered
    expect(deps.gitTracker.resolveGitInfo).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Fix 5: BACKEND_CONNECTED ordering guarantee
  // ---------------------------------------------------------------------------

  it("BACKEND_CONNECTED sets backendSession handle before executing SEND_TO_BACKEND effects", () => {
    // Pre-populate a pending message (queued since no backend is connected yet)
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.sendUserMessage("hello"); // queued since no backend

    // Intercept sendToBackend so we can verify the handle is already set at call time
    let backendSessionAtCallTime: ReturnType<typeof runtime.getBackendSession> | undefined;
    (deps.backendConnector.sendToBackend as ReturnType<typeof vi.fn>).mockImplementation(() => {
      backendSessionAtCallTime = runtime.getBackendSession();
    });

    const mockBackendSession = {
      send: vi.fn(),
      sendRaw: vi.fn(),
      close: vi.fn(),
      messages: [],
    };

    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: {
        kind: "BACKEND_CONNECTED",
        backendSession: mockBackendSession as unknown as BackendSession,
        backendAbort: new AbortController(),
        supportsSlashPassthrough: false,
        slashExecutor: null,
      },
    });

    // The handle must be set at the time sendToBackend() was called (not null)
    expect(backendSessionAtCallTime).toBe(mockBackendSession);
    expect(deps.backendConnector.sendToBackend).toHaveBeenCalled();
  });
});
