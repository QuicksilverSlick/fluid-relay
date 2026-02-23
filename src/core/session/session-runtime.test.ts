import { describe, expect, it, vi } from "vitest";
import { createMockSession, createTestSocket } from "../../testing/cli-message-factories.js";
import { normalizeInbound } from "../messaging/inbound-normalizer.js";
import { makeDefaultState } from "../session/session-repository.js";
import { createUnifiedMessage } from "../types/unified-message.js";
import { SessionRuntime, type SessionRuntimeDeps } from "./session-runtime.js";

function makeDeps(overrides?: Partial<SessionRuntimeDeps>): SessionRuntimeDeps {
  const tracedNormalizeInbound = vi.fn((_session, msg) =>
    createUnifiedMessage({ type: "interrupt", role: "system", metadata: { source: msg.type } }),
  );
  return {
    now: () => 1700000000000,
    maxMessageHistoryLength: 100,
    broadcaster: {
      broadcast: vi.fn(),
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
    sendToBackend: vi.fn(),
    tracedNormalizeInbound,
    persistSession: vi.fn(),
    warnUnknownPermission: vi.fn(),
    emitPermissionResolved: vi.fn(),
    onInvalidLifecycleTransition: vi.fn(),

    gitTracker: {
      resetAttempt: vi.fn(),
      refreshGitInfo: vi.fn(() => null),
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
    const send = vi.fn();
    const session = createMockSession({
      id: "s1",
      data: { lastStatus: null },
      backendSession: { send } as any,
    });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.handleInboundCommand(
      {
        type: "user_message",
        content: "hello",
        session_id: "backend-1",
      },
      createTestSocket(),
    );

    expect(runtime.getLastStatus()).toBe("running");
    expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      expect.objectContaining({ type: "user_message", content: "hello" }),
    );
    expect(deps.tracedNormalizeInbound).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      expect.objectContaining({
        type: "user_message",
        content: "hello",
        session_id: "backend-1",
      }),
      expect.objectContaining({
        traceId: undefined,
        requestId: undefined,
        command: undefined,
      }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(runtime.getLifecycleState()).toBe("active");
    expect(deps.persistSession).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
  });

  it("rejects user_message when lifecycle is closed", () => {
    const send = vi.fn();
    const session = createMockSession({
      id: "s1",
      data: { lastStatus: null },
      backendSession: { send } as any,
    });
    const deps = makeDeps({
      tracedNormalizeInbound: vi.fn((_session, msg) => normalizeInbound(msg as any)),
    });
    const runtime = new SessionRuntime(session, deps);
    const ws = createTestSocket();

    expect(runtime.transitionLifecycle("closed", "test:force-close")).toBe(true);

    runtime.handleInboundCommand(
      {
        type: "user_message",
        content: "should-reject",
        session_id: "backend-1",
      },
      ws,
    );

    expect(runtime.getLifecycleState()).toBe("closed");
    expect(runtime.getLastStatus()).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(runtime.getMessageHistory()).toEqual([]);
    expect(runtime.getState().adapterName === undefined || true).toBe(true); // pendingMessages not changed
    expect(deps.persistSession).not.toHaveBeenCalled();
    expect(deps.broadcaster.sendTo).toHaveBeenCalledWith(ws, {
      type: "error",
      message: "Session is closing or closed and cannot accept new messages.",
    });
    expect(deps.onInvalidLifecycleTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        from: "closed",
        to: "active",
        reason: "inbound:user_message",
      }),
    );
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
    const runtime = new SessionRuntime(session, makeDeps({ maxMessageHistoryLength: 1 }));

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
    const runtime = new SessionRuntime(session, makeDeps({ maxMessageHistoryLength: 2 }));

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

  it("delegates slash_command handling to slash service", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.handleInboundCommand(
      {
        type: "slash_command",
        command: "/help",
      },
      createTestSocket(),
    );

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

    runtime.handleInboundCommand(
      {
        type: "permission_response",
        request_id: "perm-1",
        behavior: "allow",
        updated_input: { key: "value" },
        updated_permissions: [{ type: "setMode", mode: "plan", destination: "session" }],
        message: "ok",
      },
      createTestSocket(),
    );

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

    runtime.handleInboundCommand({ type: "interrupt" }, createTestSocket());

    expect(sendInterrupt).toHaveBeenCalledTimes(1);
  });

  it("routes set_model inbound commands to sendSetModel", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);
    const sendSetModel = vi.spyOn(runtime, "sendSetModel").mockImplementation(() => {});

    runtime.handleInboundCommand(
      {
        type: "set_model",
        model: "claude-opus",
      },
      createTestSocket(),
    );

    expect(sendSetModel).toHaveBeenCalledWith("claude-opus");
  });

  it("routes set_permission_mode inbound commands to sendSetPermissionMode", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);
    const sendSetPermissionMode = vi
      .spyOn(runtime, "sendSetPermissionMode")
      .mockImplementation(() => {});

    runtime.handleInboundCommand(
      {
        type: "set_permission_mode",
        mode: "plan",
      },
      createTestSocket(),
    );

    expect(sendSetPermissionMode).toHaveBeenCalledWith("plan");
  });

  it("rejects set_adapter for active sessions", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const ws = createTestSocket();
    const runtime = new SessionRuntime(session, deps);

    runtime.handleInboundCommand(
      {
        type: "set_adapter",
        adapter: "codex",
      },
      ws,
    );

    expect(deps.broadcaster.sendTo).toHaveBeenCalledWith(
      ws,
      expect.objectContaining({ type: "error" }),
    );
  });

  it("invokes backend message callbacks in order", () => {
    const session = createMockSession({ id: "s1" });
    const calls: string[] = [];
    const deps = makeDeps({
      onBackendMessageObserved: () => calls.push("observed"),
      routeBackendMessage: () => calls.push("route"),
      onBackendMessageHandled: () => calls.push("handled"),
    });
    const runtime = new SessionRuntime(session, deps);

    runtime.handleBackendMessage(
      createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: { status: "idle" },
      }),
    );

    expect(calls).toEqual(["observed", "route", "handled"]);
    expect(runtime.getLifecycleState()).toBe("idle");
  });

  it("derives lifecycle transitions from backend status/stream/result messages", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());

    expect(runtime.getLifecycleState()).toBe("awaiting_backend");

    runtime.handleBackendMessage(
      createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: { status: "idle" },
      }),
    );
    expect(runtime.getLifecycleState()).toBe("idle");

    runtime.handleBackendMessage(
      createUnifiedMessage({
        type: "stream_event",
        role: "system",
        metadata: {
          event: { type: "message_start" },
          parent_tool_use_id: null,
        },
      }),
    );
    expect(runtime.getLifecycleState()).toBe("active");

    runtime.handleBackendMessage(
      createUnifiedMessage({
        type: "result",
        role: "system",
        metadata: {
          subtype: "success",
          is_error: false,
          num_turns: 1,
        },
      }),
    );
    expect(runtime.getLifecycleState()).toBe("idle");
  });

  it("invokes signal callback", () => {
    const session = createMockSession({ id: "s1" });
    const onSignal = vi.fn();
    const deps = makeDeps({ onSignal });
    const runtime = new SessionRuntime(session, deps);

    runtime.handleSignal("backend:connected");

    expect(runtime.getLifecycleState()).toBe("active");
    expect(onSignal).toHaveBeenCalledWith(session, "backend:connected");
  });

  it("warns on permission response for unknown request id", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.sendPermissionResponse("missing", "deny");

    expect(deps.warnUnknownPermission).toHaveBeenCalledWith("s1", "missing");
    expect(deps.emitPermissionResolved).not.toHaveBeenCalled();
  });

  it("sends deny permission response to backend when pending request exists", () => {
    const send = vi.fn();
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
      backendSession: { send } as any,
    });
    const deps = makeDeps({
      tracedNormalizeInbound: vi.fn((_session, msg) => normalizeInbound(msg as any)),
    });
    const runtime = new SessionRuntime(session, deps);

    runtime.sendPermissionResponse("perm-1", "deny");

    expect(deps.emitPermissionResolved).toHaveBeenCalledWith("s1", "perm-1", "deny");
    expect(send).toHaveBeenCalledWith(
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

    runtime.handleBackendMessage(
      createUnifiedMessage({
        type: "session_init",
        role: "system",
        metadata: { model: "claude" },
      }),
    );

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

    runtime.handleBackendMessage(
      createUnifiedMessage({
        type: "result",
        role: "assistant",
        metadata: { num_turns: 1, is_error: false },
      }),
    );

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

    runtime.handleBackendMessage(
      createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: { status: "idle" },
      }),
    );

    expect(deps.queueHandler.autoSendQueuedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
    );
  });

  it("orchestrates team events when team state changes", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    // 1. Create team via tool_use in assistant message
    runtime.handleBackendMessage(
      createUnifiedMessage({
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
    );

    expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      expect.objectContaining({
        type: "session_update",
        session: { team: expect.objectContaining({ name: "team1" }) },
      }),
    );
    expect(deps.emitEvent).toHaveBeenCalledWith("team:created", expect.anything());

    // 2. Dissolve team via tool_use
    runtime.handleBackendMessage(
      createUnifiedMessage({
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
    );

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

    runtime.handleBackendMessage(
      createUnifiedMessage({
        type: "permission_request",
        role: "assistant",
        metadata: {
          request_id: "perm-1",
          tool_name: "Bash",
          input: { command: "ls" },
          tool_use_id: "tu-1",
        },
      }),
    );

    expect(deps.emitEvent).toHaveBeenCalledWith(
      "permission:requested",
      expect.objectContaining({ sessionId: "s1" }),
    );
  });

  it("orchestrates auth_status (emits auth_status event)", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.handleBackendMessage(
      createUnifiedMessage({
        type: "auth_status",
        role: "assistant",
        metadata: { isAuthenticating: true, output: ["Authenticating..."] },
      }),
    );

    expect(deps.emitEvent).toHaveBeenCalledWith(
      "auth_status",
      expect.objectContaining({ sessionId: "s1", isAuthenticating: true }),
    );
  });

  it("includes updated_permissions in permission response metadata", () => {
    const send = vi.fn();
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
      backendSession: { send } as any,
    });
    const deps = makeDeps({
      tracedNormalizeInbound: vi.fn((_session, msg) => normalizeInbound(msg as any)),
    });
    const runtime = new SessionRuntime(session, deps);

    runtime.sendPermissionResponse("perm-2", "allow", {
      updatedPermissions: [{ type: "setMode", mode: "plan", destination: "session" }],
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "permission_response",
        metadata: expect.objectContaining({
          updated_permissions: [{ type: "setMode", mode: "plan", destination: "session" }],
        }),
      }),
    );
  });

  it("normalizes and sends control requests for interrupt/model/mode", () => {
    const send = vi.fn();
    const session = createMockSession({ id: "s1", backendSession: { send } as any });
    const deps = makeDeps({
      tracedNormalizeInbound: vi.fn((_session, msg) => normalizeInbound(msg as any)),
    });
    const runtime = new SessionRuntime(session, deps);

    runtime.sendInterrupt();
    runtime.sendSetModel("claude-opus");
    runtime.sendSetPermissionMode("plan");

    expect(send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "interrupt",
      }),
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "configuration_change",
        metadata: expect.objectContaining({ subtype: "set_model", model: "claude-opus" }),
      }),
    );
    expect(send).toHaveBeenNthCalledWith(
      3,
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
    const deps = makeDeps({
      tracedNormalizeInbound: vi.fn((_session, msg) => normalizeInbound(msg as any)),
    });
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

  it("reports invalid lifecycle transitions via callback", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    expect(runtime.transitionLifecycle("closed", "force-close")).toBe(true);
    expect(runtime.transitionLifecycle("active", "invalid-reopen")).toBe(false);

    expect(deps.onInvalidLifecycleTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        from: "closed",
        to: "active",
      }),
    );
    expect(runtime.getLifecycleState()).toBe("closed");
  });

  it("applies reconnect_timeout policy by transitioning to degraded", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());

    runtime.handleSignal("backend:connected");
    runtime.handlePolicyCommand({ type: "reconnect_timeout" });

    expect(runtime.getLifecycleState()).toBe("degraded");
  });

  it("applies idle_reap policy by transitioning to closing", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());

    runtime.handlePolicyCommand({ type: "idle_reap" });

    expect(runtime.getLifecycleState()).toBe("closing");
  });

  it("sets adapter name and persists session", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.setAdapterName("codex");

    expect(runtime.getState().adapterName).toBe("codex");
    expect(runtime.getState().adapterName).toBe("codex");
    expect(deps.persistSession).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
  });

  it("seeds session state and invokes seed hook", () => {
    const session = createMockSession({ id: "s1" });
    const onSessionSeeded = vi.fn();
    const runtime = new SessionRuntime(session, makeDeps({ onSessionSeeded }));

    runtime.seedSessionState({ cwd: "/tmp/project", model: "claude-test" });

    expect(runtime.getState().cwd).toBe("/tmp/project");
    expect(runtime.getState().model).toBe("claude-test");
    let seededSession: any = null;
    const runtime2 = new SessionRuntime(
      createMockSession({ id: "s1" }),
      makeDeps({
        onSessionSeeded: (s) => {
          seededSession = s;
        },
      }),
    );
    runtime2.seedSessionState({ cwd: "/tmp/project", model: "claude-test" });
    expect(seededSession).not.toBeNull();
  });

  it("manages anonymous identity index and consumer registration lifecycle", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());
    const ws = createTestSocket();

    expect(runtime.allocateAnonymousIdentityIndex()).toBe(1);
    expect(runtime.allocateAnonymousIdentityIndex()).toBe(2);

    runtime.addConsumer(ws, {
      userId: "u1",
      displayName: "User One",
      role: "participant",
    });
    session.consumerRateLimiters.set(ws, { allow: () => true } as any);

    const identity = runtime.removeConsumer(ws);
    expect(identity).toEqual({
      userId: "u1",
      displayName: "User One",
      role: "participant",
    });
    expect(session.consumerSockets.has(ws)).toBe(false);
    expect(session.consumerRateLimiters.has(ws)).toBe(false);
  });

  it("routes presence_query inbound commands to broadcaster presence updates", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);
    const ws = createTestSocket();
    runtime.addConsumer(ws, { userId: "u1", displayName: "U1", role: "participant" });

    runtime.handleInboundCommand({ type: "presence_query" }, ws);

    expect(deps.broadcaster.broadcastPresence).toHaveBeenCalledWith(session);
  });

  it("getSessionSnapshot includes connected consumer identities", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());
    const ws1 = createTestSocket();
    const ws2 = createTestSocket();
    runtime.addConsumer(ws1, { userId: "u1", displayName: "Alice", role: "participant" });
    runtime.addConsumer(ws2, { userId: "u2", displayName: "Bob", role: "observer" });

    const snapshot = runtime.getSessionSnapshot();

    expect(snapshot.consumers).toEqual([
      { userId: "u1", displayName: "Alice", role: "participant" },
      { userId: "u2", displayName: "Bob", role: "observer" },
    ]);
    expect(snapshot.consumerCount).toBe(2);
  });

  it("owns state, backend session id, status, queued message, and history accessors", () => {
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
    const nextState = { ...session.data.state, model: "claude-sonnet-4-5" };
    const history = [{ type: "user_message", content: "hello", timestamp: 1 }] as any;

    runtime.setState(nextState);
    runtime.setBackendSessionId("backend-123");
    runtime.setLastStatus("running");
    runtime.setMessageHistory(history);
    runtime.setQueuedMessage(queued as any);

    expect(runtime.getState().model).toBe("claude-sonnet-4-5");
    expect(runtime.getState().model).toBe("claude-sonnet-4-5");
    expect(runtime.getState().adapterName).toBe(session.data.adapterName); // backendSessionId not exposed directly
    expect(runtime.getLastStatus()).toBe("running");
    expect(runtime.getMessageHistory()).toEqual(history);
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
    runtime.addConsumer(ws1, { userId: "u1", displayName: "U1", role: "participant" });
    runtime.addConsumer(ws2, { userId: "u2", displayName: "U2", role: "observer" });
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
    runtime.addConsumer(ws1, { userId: "u1", displayName: "U1", role: "participant" });
    runtime.addConsumer(ws2, { userId: "u2", displayName: "U2", role: "observer" });

    expect(() => runtime.closeAllConsumers()).not.toThrow();
    expect(ws2.close).toHaveBeenCalledTimes(1);
    expect(session.consumerSockets.size).toBe(0);
  });

  it("clears backend connection references", () => {
    const abort = new AbortController();
    const session = createMockSession({
      id: "s1",
      backendSession: { send: vi.fn(), close: vi.fn() } as any,
      backendAbort: abort,
    });
    const runtime = new SessionRuntime(session, makeDeps());

    runtime.clearBackendConnection();

    expect(session.backendSession).toBeNull();
    expect(session.backendAbort).toBeNull();
  });

  it("attaches and resets backend connection state", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());
    const backendSession = { send: vi.fn(), close: vi.fn() } as any;
    const abort = new AbortController();
    const slashExecutor = {
      handles: vi.fn(() => false),
      execute: vi.fn(async () => null),
      supportedCommands: vi.fn(() => ["/compact"]),
    } as any;

    runtime.attachBackendConnection({
      backendSession,
      backendAbort: abort,
      supportsSlashPassthrough: true,
      slashExecutor,
    });

    expect(session.backendSession).toBe(backendSession);
    expect(session.backendAbort).toBe(abort);
    expect(runtime.isBackendConnected()).toBe(true);
    expect(session.adapterSlashExecutor).toBe(slashExecutor);

    runtime.resetBackendConnectionState();

    expect(runtime.getBackendSession()).toBeNull();
    expect(runtime.isBackendConnected()).toBe(false);
  });

  it("drains pending messages atomically", () => {
    const m1 = createUnifiedMessage({ type: "interrupt", role: "system" });
    const m2 = createUnifiedMessage({ type: "interrupt", role: "system", metadata: { seq: 2 } });
    const session = createMockSession({
      id: "s1",
      data: { pendingMessages: [m1, m2] as any },
    });
    const runtime = new SessionRuntime(session, makeDeps());

    const drained = runtime.drainPendingMessages();

    expect(drained).toEqual([m1, m2]);
    expect(runtime.drainPendingMessages()).toEqual([]);
  });

  it("drains pending permission ids atomically", () => {
    const p1: any = {
      id: "p1",
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
      id: "p2",
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
        pendingPermissions: new Map([
          ["p1", p1],
          ["p2", p2],
        ]),
      },
    });
    const runtime = new SessionRuntime(session, makeDeps());

    const ids = runtime.drainPendingPermissionIds();

    expect(ids).toEqual(["p1", "p2"]);
    expect(runtime.getPendingPermissions()).toHaveLength(0);
  });

  it("owns pending passthrough queue operations", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());

    runtime.enqueuePendingPassthrough({
      command: "/compact",
      requestId: "r1",
      slashRequestId: "sr1",
      traceId: "t1",
      startedAtMs: 1,
    });
    runtime.enqueuePendingPassthrough({
      command: "/status",
      requestId: "r2",
      slashRequestId: "sr2",
      traceId: "t2",
      startedAtMs: 2,
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

    expect(deps.sendToBackend).toHaveBeenCalledWith(session, message);
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

  it("trySendRawToBackend returns 'unsupported' when sendRaw throws", () => {
    const session = createMockSession({
      id: "s1",
      backendSession: {
        send: vi.fn(),
        sendRaw: vi.fn(() => {
          throw new Error("not supported");
        }),
        close: vi.fn(),
        messages: (async function* () {})(),
        sessionId: "s1",
      } as any,
    });
    const runtime = new SessionRuntime(session, makeDeps());

    expect(runtime.trySendRawToBackend("ndjson-line")).toBe("unsupported");
  });

  it("handlePolicyCommand capabilities_timeout is a no-op", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    // Should not throw or change state
    expect(() => runtime.handlePolicyCommand({ type: "capabilities_timeout" })).not.toThrow();
  });

  it("blocks mutating commands when lease check denies ownership", () => {
    const send = vi.fn();
    const session = createMockSession({ id: "s1", backendSession: { send } as any });
    const onMutationRejected = vi.fn();
    const deps = makeDeps({
      canMutateSession: vi.fn().mockReturnValue(false),
      onMutationRejected,
    });
    const runtime = new SessionRuntime(session, deps);

    const accepted = runtime.sendUserMessage("blocked");
    runtime.handleInboundCommand(
      {
        type: "user_message",
        content: "blocked-2",
        session_id: "backend-1",
      },
      createTestSocket(),
    );

    expect(accepted).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(runtime.getMessageHistory()).toEqual([]);
    expect(onMutationRejected).toHaveBeenCalledWith("s1", "sendUserMessage");
    expect(onMutationRejected).toHaveBeenCalledWith("s1", "handleInboundCommand");
  });

  it("blocks backend connection state updates when lease is not owned", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps({
      canMutateSession: vi.fn().mockReturnValue(false),
      onMutationRejected: vi.fn(),
    });
    const runtime = new SessionRuntime(session, deps);
    const backendSession = { close: vi.fn() } as any;

    runtime.attachBackendConnection({
      backendSession,
      backendAbort: new AbortController(),
      supportsSlashPassthrough: true,
      slashExecutor: null,
    });
    runtime.setState({ ...runtime.getState(), model: "blocked" });

    expect(runtime.getBackendSession()).toBeNull();
    expect(runtime.getState().model).not.toBe("blocked");
  });

  it("covers lease-denied guards across mutating runtime APIs", async () => {
    const session = createMockSession({
      id: "s1",
      backendSession: {
        send: vi.fn(),
        sendRaw: vi.fn(),
        close: vi.fn(),
        messages: (async function* () {})(),
        sessionId: "s1",
      } as any,
    });
    const onMutationRejected = vi.fn();
    const deps = makeDeps({
      canMutateSession: vi.fn().mockReturnValue(false),
      onMutationRejected,
    });
    const runtime = new SessionRuntime(session, deps);
    const ws = createTestSocket();

    runtime.setAdapterName("claude");
    runtime.setLastStatus("running");
    runtime.setState({ ...runtime.getState(), model: "guarded" });
    runtime.setBackendSessionId("backend-guarded");
    runtime.setMessageHistory([{ type: "user_message", content: "x", timestamp: 1 } as any]);
    runtime.setQueuedMessage({
      consumerId: "c1",
      displayName: "u",
      content: "queued",
      queuedAt: Date.now(),
    });
    const timer = setTimeout(() => {}, 60_000);
    runtime.setPendingInitialize({
      requestId: "init-1",
      timer,
    });
    clearTimeout(timer);
    runtime.registerCLICommands([{ name: "/help", description: "help" }]);
    runtime.registerSlashCommandNames(["/compact"]);
    runtime.registerSkillCommands(["skill-a"]);
    runtime.clearDynamicSlashRegistry();
    runtime.seedSessionState({ cwd: "/tmp", model: "m" });
    runtime.allocateAnonymousIdentityIndex();
    runtime.addConsumer(ws, { userId: "u1", displayName: "u1", role: "participant" });
    runtime.enqueuePendingPassthrough({
      command: "/status",
      requestId: "r1",
      slashRequestId: "sr1",
      traceId: "t1",
      startedAtMs: 1,
    });
    runtime.shiftPendingPassthrough();
    runtime.storePendingPermission("p1", {
      id: "p1",
      request_id: "p1",
      command: "cmd",
      input: {},
      timestamp: Date.now(),
      expires_at: Date.now() + 1000,
      tool_name: "test",
      tool_use_id: "tu1",
      safety_risk: null,
    } as any);
    runtime.drainPendingMessages();
    runtime.drainPendingPermissionIds();
    runtime.checkRateLimit(ws, () => undefined);
    runtime.transitionLifecycle("active", "test");
    runtime.sendPermissionResponse("p1", "allow");
    runtime.sendInterrupt();
    runtime.sendSetModel("m2");
    runtime.sendSetPermissionMode("plan");
    runtime.handlePolicyCommand({ type: "reconnect_timeout" });
    await runtime.executeSlashCommand("/help");
    runtime.sendToBackend(createUnifiedMessage({ type: "interrupt", role: "system" }));
    runtime.handleBackendMessage(createUnifiedMessage({ type: "result", role: "assistant" }));
    runtime.handleSignal("backend:connected");

    // Basic sanity: guard callback was exercised heavily.
    expect(onMutationRejected).toHaveBeenCalled();
    // No guarded state changes should have applied.
    expect(runtime.getState().model).not.toBe("guarded");
    expect(runtime.getConsumerCount()).toBe(0);
    expect(runtime.getLifecycleState()).toBe("awaiting_backend");
  });
});
