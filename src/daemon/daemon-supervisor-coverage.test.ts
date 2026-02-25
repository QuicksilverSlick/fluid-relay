/**
 * Additional coverage tests for ChildProcessSupervisor targeting uncovered branches:
 *   - lines 124-125: stopAll() — iterates all session IDs and stops them
 *   - lines 137-138: removeSession() — deletes session from map and removes process handle
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ProcessHandle, ProcessManager, SpawnOptions } from "../interfaces/process-manager.js";
import { ChildProcessSupervisor } from "./child-process-supervisor.js";

interface MockProcessHandle extends ProcessHandle {
  resolveExit: (code: number | null) => void;
}

class MockProcessManager implements ProcessManager {
  readonly spawnCalls: SpawnOptions[] = [];
  readonly handles: MockProcessHandle[] = [];
  private nextPid = 20000;

  spawn(options: SpawnOptions): ProcessHandle {
    this.spawnCalls.push(options);
    const pid = this.nextPid++;
    let resolveExit: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => {
      resolveExit = r;
    });
    const handle: MockProcessHandle = {
      pid,
      exited,
      kill() {},
      stdout: null,
      stderr: null,
      resolveExit: (code) => resolveExit!(code),
    };
    this.handles.push(handle);
    return handle;
  }

  isAlive(): boolean {
    return false;
  }

  get handleAt(): (index: number) => MockProcessHandle | undefined {
    return (index) => this.handles[index];
  }
}

describe("ChildProcessSupervisor — uncovered branches", () => {
  let pm: MockProcessManager;
  let supervisor: ChildProcessSupervisor;

  beforeEach(() => {
    pm = new MockProcessManager();
    supervisor = new ChildProcessSupervisor({ processManager: pm });
  });

  // -------------------------------------------------------------------------
  // lines 124-125: stopAll()
  // -------------------------------------------------------------------------

  describe("stopAll()", () => {
    it("stops all active sessions and marks each as stopped", async () => {
      const sessionA = supervisor.createSession({ cwd: "/a" });
      const sessionB = supervisor.createSession({ cwd: "/b" });

      // Resolve exits so killProcess can complete for both handles
      pm.handles[0].resolveExit(0);
      pm.handles[1].resolveExit(0);

      await supervisor.stopAll();

      expect(sessionA.status).toBe("stopped");
      expect(sessionB.status).toBe("stopped");
    });

    it("resolves immediately when there are no sessions", async () => {
      // Calling stopAll with an empty session map should not throw
      await expect(supervisor.stopAll()).resolves.toBeUndefined();
    });

    it("stops a single session via stopAll", async () => {
      const session = supervisor.createSession({ cwd: "/single" });
      pm.handles[0].resolveExit(0);

      await supervisor.stopAll();

      expect(session.status).toBe("stopped");
      expect(supervisor.sessionCount).toBe(1); // session entry remains in map after stop
    });
  });

  // -------------------------------------------------------------------------
  // lines 137-138: removeSession()
  // -------------------------------------------------------------------------

  describe("removeSession()", () => {
    it("removes the session from the session map", () => {
      const session = supervisor.createSession({ cwd: "/tmp" });
      const { sessionId } = session;

      expect(supervisor.getSession(sessionId)).toBeDefined();
      supervisor.removeSession(sessionId);
      expect(supervisor.getSession(sessionId)).toBeUndefined();
    });

    it("decrements session count after removal", () => {
      const sessionA = supervisor.createSession({ cwd: "/a" });
      supervisor.createSession({ cwd: "/b" });

      expect(supervisor.sessionCount).toBe(2);
      supervisor.removeSession(sessionA.sessionId);
      expect(supervisor.sessionCount).toBe(1);
    });

    it("handles removal of a non-existent session without throwing", () => {
      expect(() => supervisor.removeSession("does-not-exist")).not.toThrow();
    });

    it("removes the process handle so it is no longer tracked", () => {
      const session = supervisor.createSession({ cwd: "/tmp" });
      const { sessionId } = session;

      // The process handle should exist before removal
      expect(supervisor.hasProcess(sessionId)).toBe(true);
      supervisor.removeSession(sessionId);
      // After removal the process handle is gone
      expect(supervisor.hasProcess(sessionId)).toBe(false);
    });
  });
});
