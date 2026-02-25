import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockSession, createTestSocket } from "../../testing/cli-message-factories.js";
import { makeRuntimeDeps } from "../../testing/session-runtime-test-helpers.js";
import type { SessionRuntimeDeps } from "./session-runtime.js";
import { SessionRuntime } from "./session-runtime.js";

describe("SessionRuntime inbound command routing", () => {
  let deps: SessionRuntimeDeps;
  let runtime: SessionRuntime;

  beforeEach(() => {
    deps = makeRuntimeDeps();
    runtime = new SessionRuntime(createMockSession({ id: "s1" }), deps);
  });

  it("queue_message routes to queueHandler.handleQueueMessage", () => {
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

  it("update_queued_message routes to queueHandler.handleUpdateQueuedMessage", () => {
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

  it("cancel_queued_message routes to queueHandler.handleCancelQueuedMessage", () => {
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

  it("presence_query routes to broadcaster.broadcastPresence", () => {
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

  it("set_adapter on active session sends error", () => {
    const activeRuntime = new SessionRuntime(
      createMockSession({ id: "s1", backendSession: { send: vi.fn(), close: vi.fn() } as any }),
      deps,
    );
    const ws = createTestSocket();

    activeRuntime.process({
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

  it("sendPermissionResponse with unknown requestId warns", () => {
    runtime.sendPermissionResponse("nonexistent-req-id", "allow");

    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("unknown request_id"));
  });

  it("CONSUMER_DISCONNECTED for unregistered socket warns about double-disconnect", () => {
    const unregisteredWs = createTestSocket();

    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "CONSUMER_DISCONNECTED", ws: unregisteredWs },
    });

    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("double-disconnect"));
  });

  it("PASSTHROUGH_ENQUEUED stores entry accessible via peekPendingPassthrough", () => {
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

  it("checkRateLimit returns true when factory returns undefined", () => {
    expect(runtime.checkRateLimit(createTestSocket(), () => undefined)).toBe(true);
  });

  it("checkRateLimit calls factory once and tryConsume on each subsequent call", () => {
    const ws = createTestSocket();
    const tryConsume = vi.fn().mockReturnValue(true);
    const createLimiter = vi.fn().mockReturnValue({ tryConsume });

    runtime.checkRateLimit(ws, createLimiter);
    runtime.checkRateLimit(ws, createLimiter);

    expect(createLimiter).toHaveBeenCalledTimes(1);
    expect(tryConsume).toHaveBeenCalledTimes(2);
  });
});
