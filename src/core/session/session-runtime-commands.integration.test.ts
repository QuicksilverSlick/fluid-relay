import { describe, expect, it, vi } from "vitest";
import { createMockSession, createTestSocket } from "../../testing/cli-message-factories.js";
import { noopTracer } from "../messaging/message-tracer.js";
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
      initializeTimeoutMs: 50,
      applyCapabilities: vi.fn(),
      sendInitializeRequest: vi.fn(),
      handleControlResponse: vi.fn(),
    } as any,
    ...overrides,
  };
}

describe("SessionRuntime — inbound command routing", () => {
  it("queue_message → queueHandler.handleQueueMessage called", () => {
    const deps = makeDeps();
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, deps);
    const ws = createTestSocket();

    runtime.process({
      type: "INBOUND_COMMAND",
      command: { type: "queue_message", content: "hello" },
      ws,
    });

    expect(deps.queueHandler.handleQueueMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      { type: "queue_message", content: "hello" },
      ws,
    );
  });

  it("update_queued_message → queueHandler.handleUpdateQueuedMessage called", () => {
    const deps = makeDeps();
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, deps);
    const ws = createTestSocket();

    runtime.process({
      type: "INBOUND_COMMAND",
      command: { type: "update_queued_message", content: "updated" },
      ws,
    });

    expect(deps.queueHandler.handleUpdateQueuedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      { type: "update_queued_message", content: "updated" },
      ws,
    );
  });

  it("cancel_queued_message → queueHandler.handleCancelQueuedMessage called", () => {
    const deps = makeDeps();
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, deps);
    const ws = createTestSocket();

    runtime.process({
      type: "INBOUND_COMMAND",
      command: { type: "cancel_queued_message" },
      ws,
    });

    expect(deps.queueHandler.handleCancelQueuedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      ws,
    );
  });

  it("presence_query → broadcaster.broadcastPresence called", () => {
    const deps = makeDeps();
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, deps);
    const ws = createTestSocket();

    runtime.process({
      type: "INBOUND_COMMAND",
      command: { type: "presence_query" },
      ws,
    });

    expect(deps.broadcaster.broadcastPresence).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
    );
  });

  it("set_adapter on active session → sendTo called with error", () => {
    const deps = makeDeps();
    const session = createMockSession({
      id: "s1",
      backendSession: { send: vi.fn(), close: vi.fn() } as any,
    });
    const runtime = new SessionRuntime(session, deps);
    const ws = createTestSocket();

    runtime.process({
      type: "INBOUND_COMMAND",
      command: { type: "set_adapter", adapter: "codex" },
      ws,
    });

    expect(deps.broadcaster.sendTo).toHaveBeenCalledWith(
      ws,
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("Adapter cannot be changed"),
      }),
    );
  });

  it("sendPermissionResponse with unknown requestId → logger.warn called", () => {
    const deps = makeDeps();
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, deps);

    runtime.sendPermissionResponse("nonexistent-req-id", "allow");

    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("unknown request_id"));
  });

  it("CONSUMER_DISCONNECTED for unregistered socket → logger.warn about double-disconnect", () => {
    const deps = makeDeps();
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, deps);
    const unregisteredWs = createTestSocket();

    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "CONSUMER_DISCONNECTED", ws: unregisteredWs },
    });

    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("double-disconnect"));
  });

  it("PASSTHROUGH_ENQUEUED → peekPendingPassthrough returns the entry", () => {
    const deps = makeDeps();
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, deps);

    const entry = {
      command: "/compact",
      slashRequestId: "sr-1",
      traceId: "tr-1",
      startedAtMs: Date.now(),
    };

    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "PASSTHROUGH_ENQUEUED", entry },
    });

    expect(runtime.peekPendingPassthrough()).toEqual(entry);
  });

  it("checkRateLimit — factory returns undefined → returns true", () => {
    const deps = makeDeps();
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, deps);
    const ws = createTestSocket();

    const result = runtime.checkRateLimit(ws, () => undefined);
    expect(result).toBe(true);
  });

  it("checkRateLimit — factory called once, tryConsume called N times for same ws", () => {
    const deps = makeDeps();
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, deps);
    const ws = createTestSocket();

    const tryConsume = vi.fn().mockReturnValue(true);
    const createLimiter = vi.fn().mockReturnValue({ tryConsume });

    runtime.checkRateLimit(ws, createLimiter);
    runtime.checkRateLimit(ws, createLimiter);

    expect(createLimiter).toHaveBeenCalledTimes(1);
    expect(tryConsume).toHaveBeenCalledTimes(2);
  });
});
