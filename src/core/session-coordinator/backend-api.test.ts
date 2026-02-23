import { describe, expect, it, vi } from "vitest";
import type { Session, SessionRepository } from "../session/session-repository.js";
import { BackendApi } from "./backend-api.js";

function stubSession(id: string): Session {
  return { id } as Session;
}

function createApi(options?: { hasAdapter?: boolean }) {
  const sessions = new Map<string, Session>();
  const store = {
    get: vi.fn((sessionId: string) => sessions.get(sessionId)),
  } as unknown as SessionRepository;

  const backendConnector = {
    hasAdapter: options?.hasAdapter ?? true,
    connectBackend: vi.fn().mockResolvedValue(undefined),
    disconnectBackend: vi.fn().mockResolvedValue(undefined),
    isBackendConnected: vi.fn().mockReturnValue(true),
  };

  const capabilitiesPolicy = {
    cancelPendingInitialize: vi.fn(),
  };

  const getOrCreateSession = vi.fn((sessionId: string) => {
    const session = sessions.get(sessionId) ?? stubSession(sessionId);
    sessions.set(sessionId, session);
    return session;
  });

  const api = new BackendApi({
    store,
    backendConnector: backendConnector as any,
    capabilitiesPolicy: capabilitiesPolicy as any,
    getOrCreateSession,
  });

  return { api, sessions, store, backendConnector, capabilitiesPolicy, getOrCreateSession };
}

describe("BackendApi", () => {
  it("proxies hasAdapter", () => {
    const withAdapter = createApi({ hasAdapter: true });
    const withoutAdapter = createApi({ hasAdapter: false });
    expect(withAdapter.api.hasAdapter).toBe(true);
    expect(withoutAdapter.api.hasAdapter).toBe(false);
  });

  it("connectBackend resolves session then delegates to connector", async () => {
    const { api, backendConnector, getOrCreateSession } = createApi();
    await api.connectBackend("s1", { resume: true });
    expect(getOrCreateSession).toHaveBeenCalledWith("s1");
    expect(backendConnector.connectBackend).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      { resume: true },
    );
  });

  it("disconnectBackend is no-op when session is missing", async () => {
    const { api, capabilitiesPolicy, backendConnector } = createApi();
    await api.disconnectBackend("missing");
    expect(capabilitiesPolicy.cancelPendingInitialize).not.toHaveBeenCalled();
    expect(backendConnector.disconnectBackend).not.toHaveBeenCalled();
  });

  it("disconnectBackend cancels pending initialize and delegates", async () => {
    const { api, sessions, capabilitiesPolicy, backendConnector } = createApi();
    const session = stubSession("s1");
    sessions.set("s1", session);
    await api.disconnectBackend("s1");
    expect(capabilitiesPolicy.cancelPendingInitialize).toHaveBeenCalledWith(session);
    expect(backendConnector.disconnectBackend).toHaveBeenCalledWith(session);
  });

  it("isBackendConnected returns false for missing session", () => {
    const { api, backendConnector } = createApi();
    expect(api.isBackendConnected("missing")).toBe(false);
    expect(backendConnector.isBackendConnected).not.toHaveBeenCalled();
  });

  it("isBackendConnected delegates for existing session", () => {
    const { api, sessions, backendConnector } = createApi();
    const session = stubSession("s1");
    sessions.set("s1", session);
    vi.mocked(backendConnector.isBackendConnected).mockReturnValue(false);
    expect(api.isBackendConnected("s1")).toBe(false);
    expect(backendConnector.isBackendConnected).toHaveBeenCalledWith(session);
  });
});
