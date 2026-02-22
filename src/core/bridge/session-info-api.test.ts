import { describe, expect, it, vi } from "vitest";
import type { SessionState } from "../../types/session-state.js";
import type { Session, SessionRepository } from "../session-repository.js";
import type { RuntimeManager } from "./runtime-manager.js";
import { SessionInfoApi } from "./session-info-api.js";

function stubSession(id: string): Session {
  return { id } as Session;
}

function createApi() {
  const sessions = new Map<string, Session>();
  const store = {
    get: vi.fn((sessionId: string) => sessions.get(sessionId)),
    getAllStates: vi.fn().mockReturnValue([{ session_id: "s1" }] as SessionState[]),
    getStorage: vi.fn().mockReturnValue({}),
  } as unknown as SessionRepository;

  const runtime = {
    setAdapterName: vi.fn(),
    seedSessionState: vi.fn(),
    getSessionSnapshot: vi.fn().mockReturnValue({ id: "s1", lifecycle: "active" }),
    isBackendConnected: vi.fn().mockReturnValue(true),
  };

  const runtimeManager = {
    getOrCreate: vi.fn().mockReturnValue(runtime),
  } as unknown as RuntimeManager;

  const getOrCreateSession = vi.fn((sessionId: string) => {
    const session = sessions.get(sessionId) ?? stubSession(sessionId);
    sessions.set(sessionId, session);
    return session;
  });

  const api = new SessionInfoApi({
    store,
    runtimeManager,
    getOrCreateSession,
  });

  return { api, sessions, store, runtime, runtimeManager, getOrCreateSession };
}

describe("SessionInfoApi", () => {
  it("setAdapterName and seedSessionState delegate through runtime", () => {
    const { api, runtime, getOrCreateSession } = createApi();

    api.setAdapterName("s1", "codex");
    api.seedSessionState("s1", { cwd: "/tmp", model: "m1" });

    expect(getOrCreateSession).toHaveBeenCalledWith("s1");
    expect(runtime.setAdapterName).toHaveBeenCalledWith("codex");
    expect(runtime.seedSessionState).toHaveBeenCalledWith({ cwd: "/tmp", model: "m1" });
  });

  it("getSession returns undefined for missing session", () => {
    const { api, runtimeManager } = createApi();
    expect(api.getSession("missing")).toBeUndefined();
    expect(runtimeManager.getOrCreate).not.toHaveBeenCalled();
  });

  it("getSession delegates to runtime for existing session", () => {
    const { api, sessions, runtime, runtimeManager } = createApi();
    const session = stubSession("s1");
    sessions.set("s1", session);
    expect(api.getSession("s1")).toEqual({ id: "s1", lifecycle: "active" });
    expect(runtimeManager.getOrCreate).toHaveBeenCalledWith(session);
    expect(runtime.getSessionSnapshot).toHaveBeenCalled();
  });

  it("getAllSessions and getStorage delegate to store", () => {
    const { api, store } = createApi();
    expect(api.getAllSessions()).toEqual([{ session_id: "s1" }]);
    expect(api.getStorage()).toEqual({});
    expect(store.getAllStates).toHaveBeenCalled();
    expect(store.getStorage).toHaveBeenCalled();
  });

  it("isCliConnected returns false for missing session and delegates for existing", () => {
    const { api, sessions, runtime } = createApi();
    expect(api.isCliConnected("missing")).toBe(false);
    sessions.set("s1", stubSession("s1"));
    expect(api.isCliConnected("s1")).toBe(true);
    expect(runtime.isBackendConnected).toHaveBeenCalled();
  });
});
