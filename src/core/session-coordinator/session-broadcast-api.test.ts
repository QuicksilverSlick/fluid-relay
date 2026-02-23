import { describe, expect, it, vi } from "vitest";
import type { Session, SessionRepository } from "../session/session-repository.js";
import { SessionBroadcastApi } from "./session-broadcast-api.js";

function stubSession(id: string): Session {
  return { id } as Session;
}

function createApi() {
  const sessions = new Map<string, Session>();
  const store = {
    get: vi.fn((sessionId: string) => sessions.get(sessionId)),
  } as unknown as SessionRepository;

  const broadcaster = {
    broadcastNameUpdate: vi.fn(),
    broadcastResumeFailed: vi.fn(),
    broadcastProcessOutput: vi.fn(),
    broadcastWatchdogState: vi.fn(),
    broadcastCircuitBreakerState: vi.fn(),
  };

  const api = new SessionBroadcastApi({
    store,
    broadcaster: broadcaster as any,
  });

  return { api, sessions, broadcaster };
}

describe("SessionBroadcastApi", () => {
  it("delegates all broadcasts for existing session", () => {
    const { api, sessions, broadcaster } = createApi();
    const session = stubSession("s1");
    sessions.set("s1", session);

    api.broadcastNameUpdate("s1", "name");
    api.broadcastResumeFailedToConsumers("s1");
    api.broadcastProcessOutput("s1", "stdout", "line");
    api.broadcastWatchdogState("s1", { gracePeriodMs: 1000, startedAt: 1 });
    api.broadcastCircuitBreakerState("s1", {
      state: "open",
      failureCount: 2,
      recoveryTimeRemainingMs: 5000,
    });

    expect(broadcaster.broadcastNameUpdate).toHaveBeenCalledWith(session, "name");
    expect(broadcaster.broadcastResumeFailed).toHaveBeenCalledWith(session, "s1");
    expect(broadcaster.broadcastProcessOutput).toHaveBeenCalledWith(session, "stdout", "line");
    expect(broadcaster.broadcastWatchdogState).toHaveBeenCalledWith(session, {
      gracePeriodMs: 1000,
      startedAt: 1,
    });
    expect(broadcaster.broadcastCircuitBreakerState).toHaveBeenCalledWith(session, {
      state: "open",
      failureCount: 2,
      recoveryTimeRemainingMs: 5000,
    });
  });

  it("is a no-op for missing session", () => {
    const { api, broadcaster } = createApi();

    api.broadcastNameUpdate("missing", "name");
    api.broadcastResumeFailedToConsumers("missing");
    api.broadcastProcessOutput("missing", "stderr", "x");
    api.broadcastWatchdogState("missing", null);
    api.broadcastCircuitBreakerState("missing", {
      state: "closed",
      failureCount: 0,
      recoveryTimeRemainingMs: 0,
    });

    expect(broadcaster.broadcastNameUpdate).not.toHaveBeenCalled();
    expect(broadcaster.broadcastResumeFailed).not.toHaveBeenCalled();
    expect(broadcaster.broadcastProcessOutput).not.toHaveBeenCalled();
    expect(broadcaster.broadcastWatchdogState).not.toHaveBeenCalled();
    expect(broadcaster.broadcastCircuitBreakerState).not.toHaveBeenCalled();
  });
});
