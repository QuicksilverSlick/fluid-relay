import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../interfaces/logger.js";
import type { MetricsCollector } from "../../interfaces/metrics.js";
import { createMockSession } from "../../testing/cli-message-factories.js";
import type { Session, SessionRepository } from "../session/session-repository.js";
import type { RuntimeManager } from "./runtime-manager.js";
import { SessionLifecycleService } from "./session-lifecycle-service.js";

function createService() {
  const sessions = new Map<string, Session>();

  const store = {
    has: vi.fn((sessionId: string) => sessions.has(sessionId)),
    get: vi.fn((sessionId: string) => sessions.get(sessionId)),
    getOrCreate: vi.fn((sessionId: string) => {
      const existing = sessions.get(sessionId);
      if (existing) return existing;
      const created = createMockSession({ id: sessionId });
      sessions.set(sessionId, created);
      return created;
    }),
    remove: vi.fn((sessionId: string) => {
      sessions.delete(sessionId);
    }),
    keys: vi.fn(() => sessions.keys()),
  } as unknown as SessionRepository;

  const runtime = {
    transitionLifecycle: vi.fn(),
    getBackendSession: vi.fn().mockReturnValue(null),
    closeBackendConnection: vi.fn().mockResolvedValue(undefined),
    closeAllConsumers: vi.fn(),
    handleSignal: vi.fn(),
  };

  const runtimeManager = {
    getOrCreate: vi.fn().mockReturnValue(runtime),
    delete: vi.fn().mockReturnValue(true),
    clear: vi.fn(),
  } as unknown as RuntimeManager;

  const capabilitiesPolicy = {
    cancelPendingInitialize: vi.fn(),
  };

  const metrics: MetricsCollector = {
    recordEvent: vi.fn(),
  };

  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const emitSessionClosed = vi.fn();

  const service = new SessionLifecycleService({
    store,
    runtimeManager,
    capabilitiesPolicy: capabilitiesPolicy as any,
    metrics,
    logger,
    emitSessionClosed,
  });

  return {
    service,
    sessions,
    store,
    runtime,
    runtimeManager,
    capabilitiesPolicy,
    metrics,
    logger,
    emitSessionClosed,
  };
}

describe("SessionLifecycleService", () => {
  it("getOrCreateSession creates runtime and records metric only for new sessions", () => {
    const { service, metrics, runtimeManager } = createService();

    const first = service.getOrCreateSession("s1");
    const second = service.getOrCreateSession("s1");

    expect(first).toBe(second);
    expect(runtimeManager.getOrCreate).toHaveBeenCalledTimes(2);
    expect(metrics.recordEvent).toHaveBeenCalledTimes(1);
    expect(metrics.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session:created", sessionId: "s1" }),
    );
  });

  it("removeSession cancels pending initialize when session exists", () => {
    const { service, sessions, capabilitiesPolicy, runtimeManager, store } = createService();
    const session = createMockSession({ id: "s1" });
    sessions.set("s1", session);

    service.removeSession("s1");

    expect(capabilitiesPolicy.cancelPendingInitialize).toHaveBeenCalledWith(session);
    expect(runtimeManager.delete).toHaveBeenCalledWith("s1");
    expect(store.remove).toHaveBeenCalledWith("s1");
  });

  it("removeSession still deletes runtime/store when session does not exist", () => {
    const { service, capabilitiesPolicy, runtimeManager, store } = createService();

    service.removeSession("missing");

    expect(capabilitiesPolicy.cancelPendingInitialize).not.toHaveBeenCalled();
    expect(runtimeManager.delete).toHaveBeenCalledWith("missing");
    expect(store.remove).toHaveBeenCalledWith("missing");
  });

  it("closeSession is a no-op when session is missing", async () => {
    const { service, runtimeManager, capabilitiesPolicy, emitSessionClosed, metrics } =
      createService();

    await service.closeSession("missing");

    expect(runtimeManager.getOrCreate).not.toHaveBeenCalled();
    expect(runtimeManager.delete).not.toHaveBeenCalled();
    expect(capabilitiesPolicy.cancelPendingInitialize).not.toHaveBeenCalled();
    expect(metrics.recordEvent).not.toHaveBeenCalled();
    expect(emitSessionClosed).not.toHaveBeenCalled();
  });

  it("closeSession closes backend when present, removes session, records metric, emits event", async () => {
    const {
      service,
      sessions,
      runtime,
      runtimeManager,
      capabilitiesPolicy,
      store,
      metrics,
      emitSessionClosed,
    } = createService();
    const session = createMockSession({ id: "s1" });
    sessions.set("s1", session);
    vi.mocked(runtime.getBackendSession).mockReturnValue({} as any);

    await service.closeSession("s1");

    expect(runtime.transitionLifecycle).toHaveBeenCalledWith("closing", "session:close");
    expect(capabilitiesPolicy.cancelPendingInitialize).toHaveBeenCalledWith(session);
    expect(runtime.closeBackendConnection).toHaveBeenCalledTimes(1);
    expect(runtime.closeAllConsumers).toHaveBeenCalledTimes(1);
    expect(runtime.handleSignal).toHaveBeenCalledWith("session:closed");
    expect(store.remove).toHaveBeenCalledWith("s1");
    expect(runtimeManager.delete).toHaveBeenCalledWith("s1");
    expect(metrics.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session:closed", sessionId: "s1" }),
    );
    expect(emitSessionClosed).toHaveBeenCalledWith("s1");
  });

  it("closeSession skips backend close when backend is not present", async () => {
    const { service, sessions, runtime, logger } = createService();
    sessions.set("s1", createMockSession({ id: "s1" }));
    vi.mocked(runtime.getBackendSession).mockReturnValue(null);

    await service.closeSession("s1");

    expect(runtime.closeBackendConnection).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("closeSession logs warning when backend close fails but still completes cleanup", async () => {
    const { service, sessions, runtime, logger, store, runtimeManager, emitSessionClosed } =
      createService();
    sessions.set("s1", createMockSession({ id: "s1" }));
    vi.mocked(runtime.getBackendSession).mockReturnValue({} as any);
    vi.mocked(runtime.closeBackendConnection).mockRejectedValue(new Error("boom"));

    await service.closeSession("s1");

    expect(logger.warn).toHaveBeenCalledWith("Failed to close backend session", {
      sessionId: "s1",
      error: expect.any(Error),
    });
    expect(runtime.closeAllConsumers).toHaveBeenCalled();
    expect(runtime.handleSignal).toHaveBeenCalledWith("session:closed");
    expect(store.remove).toHaveBeenCalledWith("s1");
    expect(runtimeManager.delete).toHaveBeenCalledWith("s1");
    expect(emitSessionClosed).toHaveBeenCalledWith("s1");
  });

  it("closeAllSessions closes each session and then clears runtime manager", async () => {
    const { service, sessions, runtimeManager } = createService();
    sessions.set("s1", createMockSession({ id: "s1" }));
    sessions.set("s2", createMockSession({ id: "s2" }));

    const spy = vi.spyOn(service, "closeSession");
    await service.closeAllSessions();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith("s1");
    expect(spy).toHaveBeenCalledWith("s2");
    expect(runtimeManager.clear).toHaveBeenCalledTimes(1);
  });
});
