/**
 * Unit tests for SimpleSessionRegistry.
 *
 * Covers: register, getSession, listSessions, getStartingSessions,
 * markConnected, setBackendSessionId, setSessionName, setArchived,
 * removeSession, restoreFromStorage, and persistence behaviour.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LauncherStateStorage } from "../../interfaces/storage.js";
import type { SessionInfo } from "../../types/session-state.js";
import { SimpleSessionRegistry } from "./simple-session-registry.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeInput(overrides?: Partial<SessionInfo>) {
  return {
    sessionId: overrides?.sessionId ?? "sess-1",
    cwd: overrides?.cwd ?? "/tmp",
    createdAt: overrides?.createdAt ?? Date.now(),
    model: overrides?.model,
    adapterName: overrides?.adapterName,
  };
}

function makeMockStorage(stored?: SessionInfo[]): LauncherStateStorage {
  return {
    loadLauncherState: vi.fn().mockReturnValue(stored ?? null),
    saveLauncherState: vi.fn(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SimpleSessionRegistry", () => {
  let registry: SimpleSessionRegistry;

  beforeEach(() => {
    registry = new SimpleSessionRegistry();
  });

  // ── register ───────────────────────────────────────────────────────────────

  describe("register", () => {
    it("returns a SessionInfo with state='starting'", () => {
      const info = registry.register(makeInput());
      expect(info.sessionId).toBe("sess-1");
      expect(info.state).toBe("starting");
      expect(info.cwd).toBe("/tmp");
    });

    it("stores the session so getSession finds it", () => {
      registry.register(makeInput({ sessionId: "s-abc" }));
      expect(registry.getSession("s-abc")).toBeDefined();
    });

    it("persists to storage when provided", () => {
      const storage = makeMockStorage();
      const reg = new SimpleSessionRegistry(storage);
      reg.register(makeInput());
      expect(storage.saveLauncherState).toHaveBeenCalledOnce();
    });

    it("does not call storage.saveLauncherState when no storage", () => {
      // No storage — should not throw
      expect(() => registry.register(makeInput())).not.toThrow();
    });
  });

  // ── getSession ─────────────────────────────────────────────────────────────

  describe("getSession", () => {
    it("returns undefined for unknown session", () => {
      expect(registry.getSession("nonexistent")).toBeUndefined();
    });
  });

  // ── listSessions ───────────────────────────────────────────────────────────

  describe("listSessions", () => {
    it("returns empty array when no sessions", () => {
      expect(registry.listSessions()).toEqual([]);
    });

    it("returns all registered sessions", () => {
      registry.register(makeInput({ sessionId: "s1" }));
      registry.register(makeInput({ sessionId: "s2" }));
      expect(registry.listSessions()).toHaveLength(2);
    });
  });

  // ── getStartingSessions ────────────────────────────────────────────────────

  describe("getStartingSessions", () => {
    it("returns only sessions with state='starting'", () => {
      registry.register(makeInput({ sessionId: "s1" }));
      registry.register(makeInput({ sessionId: "s2" }));
      registry.markConnected("s1");

      const starting = registry.getStartingSessions();
      expect(starting).toHaveLength(1);
      expect(starting[0].sessionId).toBe("s2");
    });

    it("returns empty array when all sessions are connected", () => {
      registry.register(makeInput({ sessionId: "s1" }));
      registry.markConnected("s1");
      expect(registry.getStartingSessions()).toHaveLength(0);
    });

    it("returns all sessions when none are yet connected", () => {
      registry.register(makeInput({ sessionId: "s1" }));
      registry.register(makeInput({ sessionId: "s2" }));
      expect(registry.getStartingSessions()).toHaveLength(2);
    });
  });

  // ── markConnected ──────────────────────────────────────────────────────────

  describe("markConnected", () => {
    it("changes session state to connected", () => {
      registry.register(makeInput({ sessionId: "s1" }));
      registry.markConnected("s1");
      expect(registry.getSession("s1")?.state).toBe("connected");
    });

    it("is a no-op for non-existent session", () => {
      expect(() => registry.markConnected("unknown")).not.toThrow();
    });

    it("persists to storage after marking connected", () => {
      const storage = makeMockStorage();
      const reg = new SimpleSessionRegistry(storage);
      reg.register(makeInput({ sessionId: "s1" }));
      vi.clearAllMocks();

      reg.markConnected("s1");

      expect(storage.saveLauncherState).toHaveBeenCalledOnce();
      const saved = (storage.saveLauncherState as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as SessionInfo[];
      expect(saved.find((s) => s.sessionId === "s1")?.state).toBe("connected");
    });
  });

  // ── setBackendSessionId ────────────────────────────────────────────────────

  describe("setBackendSessionId", () => {
    it("stores the backend session ID on the session", () => {
      registry.register(makeInput({ sessionId: "s1" }));
      registry.setBackendSessionId("s1", "backend-xyz");
      expect(registry.getSession("s1")?.backendSessionId).toBe("backend-xyz");
    });

    it("is a no-op for non-existent session", () => {
      expect(() => registry.setBackendSessionId("unknown", "xyz")).not.toThrow();
    });

    it("persists to storage", () => {
      const storage = makeMockStorage();
      const reg = new SimpleSessionRegistry(storage);
      reg.register(makeInput({ sessionId: "s1" }));
      vi.clearAllMocks();

      reg.setBackendSessionId("s1", "backend-xyz");

      expect(storage.saveLauncherState).toHaveBeenCalledOnce();
    });
  });

  // ── setSessionName ─────────────────────────────────────────────────────────

  describe("setSessionName", () => {
    it("sets the display name on the session", () => {
      registry.register(makeInput({ sessionId: "s1" }));
      registry.setSessionName("s1", "My Project");
      expect(registry.getSession("s1")?.name).toBe("My Project");
    });

    it("is a no-op for non-existent session", () => {
      expect(() => registry.setSessionName("unknown", "name")).not.toThrow();
    });

    it("persists to storage", () => {
      const storage = makeMockStorage();
      const reg = new SimpleSessionRegistry(storage);
      reg.register(makeInput({ sessionId: "s1" }));
      vi.clearAllMocks();

      reg.setSessionName("s1", "My Project");

      expect(storage.saveLauncherState).toHaveBeenCalledOnce();
    });
  });

  // ── setArchived ────────────────────────────────────────────────────────────

  describe("setArchived", () => {
    it("sets archived to true", () => {
      registry.register(makeInput({ sessionId: "s1" }));
      registry.setArchived("s1", true);
      expect(registry.getSession("s1")?.archived).toBe(true);
    });

    it("sets archived to false", () => {
      registry.register(makeInput({ sessionId: "s1" }));
      registry.setArchived("s1", true);
      registry.setArchived("s1", false);
      expect(registry.getSession("s1")?.archived).toBe(false);
    });

    it("is a no-op for non-existent session", () => {
      expect(() => registry.setArchived("unknown", true)).not.toThrow();
    });

    it("persists to storage", () => {
      const storage = makeMockStorage();
      const reg = new SimpleSessionRegistry(storage);
      reg.register(makeInput({ sessionId: "s1" }));
      vi.clearAllMocks();

      reg.setArchived("s1", true);

      expect(storage.saveLauncherState).toHaveBeenCalledOnce();
    });
  });

  // ── removeSession ──────────────────────────────────────────────────────────

  describe("removeSession", () => {
    it("removes the session from the registry", () => {
      registry.register(makeInput({ sessionId: "s1" }));
      registry.removeSession("s1");
      expect(registry.getSession("s1")).toBeUndefined();
      expect(registry.listSessions()).toHaveLength(0);
    });

    it("is a no-op for non-existent session", () => {
      expect(() => registry.removeSession("unknown")).not.toThrow();
    });

    it("persists to storage after removal", () => {
      const storage = makeMockStorage();
      const reg = new SimpleSessionRegistry(storage);
      reg.register(makeInput({ sessionId: "s1" }));
      vi.clearAllMocks();

      reg.removeSession("s1");

      expect(storage.saveLauncherState).toHaveBeenCalledOnce();
      const saved = (storage.saveLauncherState as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as SessionInfo[];
      expect(saved).toHaveLength(0);
    });
  });

  // ── restoreFromStorage ─────────────────────────────────────────────────────

  describe("restoreFromStorage", () => {
    it("returns 0 when no storage is attached", () => {
      expect(registry.restoreFromStorage?.()).toBe(0);
    });

    it("returns 0 when storage returns null", () => {
      const storage = makeMockStorage(undefined); // null
      const reg = new SimpleSessionRegistry(storage);
      expect(reg.restoreFromStorage?.()).toBe(0);
    });

    it("returns 0 when storage returns non-array", () => {
      const storage: LauncherStateStorage = {
        loadLauncherState: vi.fn().mockReturnValue({ notAnArray: true }),
        saveLauncherState: vi.fn(),
      };
      const reg = new SimpleSessionRegistry(storage);
      expect(reg.restoreFromStorage?.()).toBe(0);
    });

    it("restores sessions from storage and returns count", () => {
      const existing: SessionInfo[] = [
        { sessionId: "s1", cwd: "/a", createdAt: 1, state: "connected" },
        { sessionId: "s2", cwd: "/b", createdAt: 2, state: "starting" },
      ];
      const storage = makeMockStorage(existing);
      const reg = new SimpleSessionRegistry(storage);

      const count = reg.restoreFromStorage?.() ?? 0;

      expect(count).toBe(2);
      expect(reg.getSession("s1")).toMatchObject({ sessionId: "s1", cwd: "/a" });
      expect(reg.getSession("s2")).toMatchObject({ sessionId: "s2", cwd: "/b" });
    });

    it("does not overwrite already-registered sessions", () => {
      const stored: SessionInfo[] = [
        { sessionId: "s1", cwd: "/from-storage", createdAt: 1, state: "connected" },
      ];
      const storage = makeMockStorage(stored);
      const reg = new SimpleSessionRegistry(storage);
      reg.register({ sessionId: "s1", cwd: "/already-registered", createdAt: 2 });

      const count = reg.restoreFromStorage?.() ?? 0;

      expect(count).toBe(0); // skipped because s1 already exists
      expect(reg.getSession("s1")?.cwd).toBe("/already-registered");
    });

    it("partially restores: skips duplicates, adds new", () => {
      const stored: SessionInfo[] = [
        { sessionId: "existing", cwd: "/old", createdAt: 1, state: "starting" },
        { sessionId: "new-one", cwd: "/new", createdAt: 2, state: "starting" },
      ];
      const storage = makeMockStorage(stored);
      const reg = new SimpleSessionRegistry(storage);
      reg.register({ sessionId: "existing", cwd: "/live", createdAt: 3 });

      const count = reg.restoreFromStorage?.() ?? 0;

      expect(count).toBe(1); // only new-one added
      expect(reg.listSessions()).toHaveLength(2);
    });
  });

  // ── persistence with storage ───────────────────────────────────────────────

  describe("persistence", () => {
    it("does not persist when storage is absent", () => {
      // All mutations should be silent — no error, no external call
      registry.register(makeInput());
      registry.markConnected("sess-1");
      registry.setSessionName("sess-1", "test");
      registry.setArchived("sess-1", true);
      registry.setBackendSessionId("sess-1", "b-1");
      registry.removeSession("sess-1");
    });

    it("persists the complete session list on each mutation", () => {
      const storage = makeMockStorage();
      const reg = new SimpleSessionRegistry(storage);

      reg.register(makeInput({ sessionId: "s1" }));
      reg.register(makeInput({ sessionId: "s2" }));
      reg.markConnected("s1");
      reg.removeSession("s2");

      // 4 mutations → 4 save calls
      expect(storage.saveLauncherState).toHaveBeenCalledTimes(4);

      // Final state: only s1 remains
      const lastSave = (storage.saveLauncherState as ReturnType<typeof vi.fn>).mock
        .calls[3][0] as SessionInfo[];
      expect(lastSave).toHaveLength(1);
      expect(lastSave[0].sessionId).toBe("s1");
    });
  });
});
