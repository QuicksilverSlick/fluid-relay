import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../types/session-state.js";
import { pickMostRecentSessionId, reconcileActiveSessionId } from "./active-session-id.js";

function makeSession(sessionId: string, createdAt: number): SessionInfo {
  return {
    sessionId,
    createdAt,
    cwd: "/tmp",
    state: "connected",
  };
}

describe("active-session-id", () => {
  describe("pickMostRecentSessionId", () => {
    it("returns empty string when there are no sessions", () => {
      expect(pickMostRecentSessionId([])).toBe("");
    });

    it("returns session id with highest createdAt", () => {
      const sessions = [
        makeSession("older", 10),
        makeSession("newest", 30),
        makeSession("middle", 20),
      ];
      expect(pickMostRecentSessionId(sessions)).toBe("newest");
    });
  });

  describe("reconcileActiveSessionId", () => {
    it("keeps the current active session when it still exists", () => {
      const sessions = [makeSession("s1", 1), makeSession("s2", 2)];
      expect(reconcileActiveSessionId("s1", sessions)).toBe("s1");
    });

    it("falls back to most recent when current active session is stale", () => {
      const sessions = [makeSession("s1", 1), makeSession("s2", 2)];
      expect(reconcileActiveSessionId("stale", sessions)).toBe("s2");
    });

    it("returns empty string when current session is stale and no sessions remain", () => {
      expect(reconcileActiveSessionId("stale", [])).toBe("");
    });
  });
});
