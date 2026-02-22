import { describe, expect, it, vi } from "vitest";
import { createMockSession } from "../../testing/cli-message-factories.js";
import { SessionRuntime } from "../session/session-runtime.js";
import { createRuntimeManager } from "./runtime-manager-factory.js";

function makeFactoryDeps(overrides?: Record<string, unknown>) {
  return {
    now: vi.fn(() => 123),
    maxMessageHistoryLength: 42,
    getBroadcaster: vi.fn(() => ({
      broadcast: vi.fn(),
      broadcastPresence: vi.fn(),
      sendTo: vi.fn(),
    })),
    getQueueHandler: vi.fn(() => ({
      handleQueueMessage: vi.fn(),
      handleUpdateQueuedMessage: vi.fn(),
      handleCancelQueuedMessage: vi.fn(),
    })),
    getSlashService: vi.fn(() => ({
      handleInbound: vi.fn(),
      executeProgrammatic: vi.fn().mockResolvedValue(null),
    })),
    sendToBackend: vi.fn(),
    tracedNormalizeInbound: vi.fn().mockReturnValue(null),
    persistSession: vi.fn(),
    warnUnknownPermission: vi.fn(),
    emitPermissionResolved: vi.fn(),
    onSessionSeeded: vi.fn(),
    onInvalidLifecycleTransition: vi.fn(),
    routeBackendMessage: vi.fn(),
    ...overrides,
  };
}

describe("createRuntimeManager", () => {
  it("lazily resolves dependencies only when first runtime is created", () => {
    const deps = makeFactoryDeps();
    const manager = createRuntimeManager(deps as any);

    expect(deps.getBroadcaster).not.toHaveBeenCalled();
    expect(deps.getQueueHandler).not.toHaveBeenCalled();
    expect(deps.getSlashService).not.toHaveBeenCalled();

    const runtime = manager.getOrCreate(createMockSession({ id: "s1" }));
    expect(runtime).toBeInstanceOf(SessionRuntime);
    expect(deps.getBroadcaster).toHaveBeenCalledTimes(1);
    expect(deps.getQueueHandler).toHaveBeenCalledTimes(1);
    expect(deps.getSlashService).toHaveBeenCalledTimes(1);
  });

  it("reuses runtime for the same session id without re-resolving getters", () => {
    const deps = makeFactoryDeps();
    const manager = createRuntimeManager(deps as any);
    const session = createMockSession({ id: "same" });

    const first = manager.getOrCreate(session);
    const second = manager.getOrCreate(session);

    expect(first).toBe(second);
    expect(deps.getBroadcaster).toHaveBeenCalledTimes(1);
    expect(deps.getQueueHandler).toHaveBeenCalledTimes(1);
    expect(deps.getSlashService).toHaveBeenCalledTimes(1);
  });

  it("resolves getter-backed collaborators per new session runtime", () => {
    const b1 = { broadcast: vi.fn(), broadcastPresence: vi.fn(), sendTo: vi.fn() };
    const b2 = { broadcast: vi.fn(), broadcastPresence: vi.fn(), sendTo: vi.fn() };
    const q1 = {
      handleQueueMessage: vi.fn(),
      handleUpdateQueuedMessage: vi.fn(),
      handleCancelQueuedMessage: vi.fn(),
    };
    const q2 = {
      handleQueueMessage: vi.fn(),
      handleUpdateQueuedMessage: vi.fn(),
      handleCancelQueuedMessage: vi.fn(),
    };
    const s1 = { handleInbound: vi.fn(), executeProgrammatic: vi.fn().mockResolvedValue(null) };
    const s2 = { handleInbound: vi.fn(), executeProgrammatic: vi.fn().mockResolvedValue(null) };

    const deps = makeFactoryDeps({
      getBroadcaster: vi.fn().mockReturnValueOnce(b1).mockReturnValueOnce(b2),
      getQueueHandler: vi.fn().mockReturnValueOnce(q1).mockReturnValueOnce(q2),
      getSlashService: vi.fn().mockReturnValueOnce(s1).mockReturnValueOnce(s2),
    });
    const manager = createRuntimeManager(deps as any);

    const runtime1 = manager.getOrCreate(createMockSession({ id: "s1" })) as any;
    const runtime2 = manager.getOrCreate(createMockSession({ id: "s2" })) as any;

    expect(runtime1).not.toBe(runtime2);
    expect(runtime1.deps.broadcaster).toBe(b1);
    expect(runtime2.deps.broadcaster).toBe(b2);
    expect(runtime1.deps.queueHandler).toBe(q1);
    expect(runtime2.deps.queueHandler).toBe(q2);
    expect(runtime1.deps.slashService).toBe(s1);
    expect(runtime2.deps.slashService).toBe(s2);
  });

  it("passes through scalar and callback deps to SessionRuntime", () => {
    const deps = makeFactoryDeps({
      maxMessageHistoryLength: 7,
      now: () => 999,
    });
    const manager = createRuntimeManager(deps as any);
    const runtime = manager.getOrCreate(createMockSession({ id: "s1" })) as any;

    expect(runtime.deps.maxMessageHistoryLength).toBe(7);
    expect(runtime.deps.now()).toBe(999);
    expect(runtime.deps.sendToBackend).toBe(deps.sendToBackend);
    expect(runtime.deps.tracedNormalizeInbound).toBe(deps.tracedNormalizeInbound);
    expect(runtime.deps.persistSession).toBe(deps.persistSession);
    expect(runtime.deps.warnUnknownPermission).toBe(deps.warnUnknownPermission);
    expect(runtime.deps.emitPermissionResolved).toBe(deps.emitPermissionResolved);
    expect(runtime.deps.onSessionSeeded).toBe(deps.onSessionSeeded);
    expect(runtime.deps.onInvalidLifecycleTransition).toBe(deps.onInvalidLifecycleTransition);
    expect(runtime.deps.routeBackendMessage).toBe(deps.routeBackendMessage);
  });
});
