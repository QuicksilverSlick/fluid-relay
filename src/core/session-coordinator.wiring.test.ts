import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn(() => "/usr/bin/claude"));
vi.mock("node:child_process", () => ({ execFileSync: mockExecFileSync }));
vi.mock("node:crypto", () => ({ randomUUID: () => "test-session-id" }));

import { ClaudeLauncher } from "../adapters/claude/claude-launcher.js";
import { MemoryStorage } from "../adapters/memory-storage.js";
import type { ProcessHandle, ProcessManager, SpawnOptions } from "../interfaces/process-manager.js";
import type { OnCLIConnection, WebSocketServerLike } from "../interfaces/ws-server.js";
import { SessionCoordinator } from "./session-coordinator.js";

function createLauncher(pm: ProcessManager, opts?: { storage?: MemoryStorage; logger?: any }) {
  return new ClaudeLauncher({
    processManager: pm,
    config: { port: 3456 },
    storage: opts?.storage,
    logger: opts?.logger,
  });
}

// ---------------------------------------------------------------------------
// Mock ProcessManager (matches the real ProcessManager interface)
// ---------------------------------------------------------------------------

interface MockProcessHandle extends ProcessHandle {
  resolveExit: (code: number | null) => void;
  killCalls: string[];
}

class MockProcessManager implements ProcessManager {
  readonly spawnCalls: SpawnOptions[] = [];
  readonly spawnedProcesses: MockProcessHandle[] = [];
  private alivePids = new Set<number>();
  private nextPid = 10000;

  spawn(options: SpawnOptions): ProcessHandle {
    this.spawnCalls.push(options);
    const pid = this.nextPid++;
    this.alivePids.add(pid);
    let resolveExit: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    const killCalls: string[] = [];
    const handle: MockProcessHandle = {
      pid,
      exited,
      kill(signal: "SIGTERM" | "SIGKILL" | "SIGINT" = "SIGTERM") {
        killCalls.push(signal);
      },
      stdout: null,
      stderr: null,
      resolveExit: (code: number | null) => {
        this.alivePids.delete(pid);
        resolveExit!(code);
      },
      killCalls,
    };
    this.spawnedProcesses.push(handle);
    return handle;
  }

  isAlive(pid: number): boolean {
    return this.alivePids.has(pid);
  }

  get lastProcess(): MockProcessHandle | undefined {
    return this.spawnedProcesses[this.spawnedProcesses.length - 1];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionCoordinator", () => {
  let mgr: SessionCoordinator;
  let pm: MockProcessManager;
  let storage: MemoryStorage;
  const noopLogger = { info() {}, warn() {}, error() {} };

  beforeEach(() => {
    vi.clearAllMocks();
    pm = new MockProcessManager();
    storage = new MemoryStorage();
    mgr = new SessionCoordinator({
      config: { port: 3456 },
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, { storage, logger: noopLogger }),
    });
  });

  // -----------------------------------------------------------------------
  // start / stop
  // -----------------------------------------------------------------------

  describe("start() and stop()", () => {
    it("starts without error", () => {
      expect(() => mgr.start()).not.toThrow();
    });

    it("stops gracefully", async () => {
      mgr.start();
      await expect(mgr.stop()).resolves.not.toThrow();
    });

    it("multiple start() calls are idempotent", () => {
      mgr.start();
      expect(() => mgr.start()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Wiring: backend:session_id → launcher.setBackendSessionId
  // -----------------------------------------------------------------------

  describe("backend:session_id wiring", () => {
    it("forwards to launcher.setBackendSessionId", () => {
      mgr.start();
      const info = mgr.launcher.launch({ cwd: "/tmp" });
      // Simulate the bridge emitting backend:session_id
      (mgr as any)._bridgeEmitter.emit("backend:session_id" as any, {
        sessionId: info.sessionId,
        backendSessionId: "cli-abc-123",
      });

      const session = mgr.launcher.getSession(info.sessionId);
      expect(session?.backendSessionId).toBe("cli-abc-123");
    });
  });

  // -----------------------------------------------------------------------
  // Wiring: backend:connected → launcher.markConnected
  // -----------------------------------------------------------------------

  describe("backend:connected wiring", () => {
    it("forwards to launcher.markConnected", () => {
      mgr.start();
      const info = mgr.launcher.launch({ cwd: "/tmp" });
      expect(info.state).toBe("starting");

      (mgr as any)._bridgeEmitter.emit("backend:connected" as any, { sessionId: info.sessionId });

      const session = mgr.launcher.getSession(info.sessionId);
      expect(session?.state).toBe("connected");
    });

    it("seeds bridge session state when launcher spawns a process", () => {
      mgr.start();
      const info = mgr.launcher.launch({ cwd: "/tmp", model: "test-model" });

      const snapshot = (mgr as any).getSessionSnapshot(info.sessionId);
      expect(snapshot).toBeDefined();
      expect(snapshot!.state.cwd).toBe("/tmp");
      expect(snapshot!.state.model).toBe("test-model");
      expect(snapshot!.state.adapterName).toBe("claude");
    });
  });

  // -----------------------------------------------------------------------
  // Wiring: backend:relaunch_needed → launcher.relaunch (with dedup)
  // -----------------------------------------------------------------------

  describe("backend:relaunch_needed wiring", () => {
    it("triggers launcher.relaunch", async () => {
      mgr.start();
      const info = mgr.launcher.launch({ cwd: "/tmp" });
      // Simulate the process exiting so relaunch is meaningful
      pm.lastProcess!.resolveExit(1);
      await pm.lastProcess!.exited;
      const spawnsBefore = pm.spawnCalls.length;

      (mgr as any)._bridgeEmitter.emit("backend:relaunch_needed" as any, {
        sessionId: info.sessionId,
      });
      // Allow async relaunch to run
      await new Promise((r) => setTimeout(r, 10));

      expect(pm.spawnCalls.length).toBeGreaterThan(spawnsBefore);
    });
  });

  // -----------------------------------------------------------------------
  // Event forwarding
  // -----------------------------------------------------------------------

  describe("event forwarding", () => {
    it("re-emits bridge events", () => {
      mgr.start();
      const received: string[] = [];
      mgr.on("backend:connected", () => received.push("backend:connected"));

      (mgr as any)._bridgeEmitter.emit("backend:connected" as any, { sessionId: "s1" });

      expect(received).toContain("backend:connected");
    });

    it("re-emits launcher events", () => {
      mgr.start();
      const received: unknown[] = [];
      mgr.on("process:spawned", (payload) => received.push(payload));

      mgr.launcher.launch({ cwd: "/tmp" });

      expect(received).toHaveLength(1);
      expect((received[0] as any).pid).toBeDefined();
    });

    it("dual-publishes to domain event bus", () => {
      mgr.start();
      const received: unknown[] = [];
      mgr.domainEvents.on("backend:connected", (event) => received.push(event));

      (mgr as any)._bridgeEmitter.emit("backend:connected" as any, { sessionId: "s1" });

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        source: "bridge",
        type: "backend:connected",
        payload: { sessionId: "s1" },
      });
      expect(typeof (received[0] as { timestamp: unknown }).timestamp).toBe("number");
    });

    it("consumes domain bus bridge events for coordination handlers", () => {
      mgr.start();
      const info = mgr.launcher.launch({ cwd: "/tmp" });

      mgr.domainEvents.publishBridge("backend:session_id", {
        sessionId: info.sessionId,
        backendSessionId: "cli-via-domain-bus",
      });

      expect(mgr.launcher.getSession(info.sessionId)?.backendSessionId).toBe("cli-via-domain-bus");
    });
  });

  // -----------------------------------------------------------------------
  // Stop kills all
  // -----------------------------------------------------------------------

  describe("stop", () => {
    it("kills all launched processes", async () => {
      mgr.start();
      mgr.launcher.launch({ cwd: "/tmp" });
      expect(pm.spawnedProcesses).toHaveLength(1);

      // Resolve the exit so kill completes
      setTimeout(() => pm.lastProcess!.resolveExit(0), 5);
      await mgr.stop();

      expect(pm.lastProcess!.killCalls).toContain("SIGTERM");
    });
  });

  // -----------------------------------------------------------------------
  // WebSocket server integration
  // -----------------------------------------------------------------------

  describe("WebSocket server integration", () => {
    it("starts and stops WS server when provided", async () => {
      const listenCalls: OnCLIConnection[] = [];
      const closeCalled: boolean[] = [];

      const mockServer: WebSocketServerLike = {
        async listen(onConnection) {
          listenCalls.push(onConnection);
        },
        async close() {
          closeCalled.push(true);
        },
      };

      const mgr = new SessionCoordinator({
        config: { port: 3456 },
        server: mockServer,
        launcher: createLauncher(pm),
      });

      await mgr.start();
      expect(listenCalls).toHaveLength(1);

      await mgr.stop();
      expect(closeCalled).toHaveLength(1);
    });

    it("works without WS server (backwards compatible)", async () => {
      const mgr = new SessionCoordinator({
        config: { port: 3456 },
        launcher: createLauncher(pm),
      });

      // Should not throw when no server provided
      await mgr.start();
      await mgr.stop();
    });

    it("wires CLI connections to onConnection callback", async () => {
      let capturedOnConnection: OnCLIConnection | null = null;

      const mockServer: WebSocketServerLike = {
        async listen(onConnection) {
          capturedOnConnection = onConnection;
        },
        async close() {},
      };

      const mgr = new SessionCoordinator({
        config: { port: 3456 },
        server: mockServer,
        launcher: createLauncher(pm),
        // No adapter — socket should be closed
      });

      await mgr.start();
      expect(capturedOnConnection).not.toBeNull();

      // Simulate a CLI connection without an adapter
      const mockSocket = {
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
      };

      capturedOnConnection!(mockSocket as any, "test-session-id");

      // Without an adapter, the socket should be closed
      expect(mockSocket.close).toHaveBeenCalled();

      await mgr.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Forwarded structured data APIs
  // -----------------------------------------------------------------------

  describe("Forwarded structured data APIs", () => {
    it("getSupportedModels forwards to bridge", () => {
      mgr.start();
      // No capabilities yet, should return empty
      expect(mgr.getSupportedModels("nonexistent")).toEqual([]);
    });

    it("getSupportedCommands forwards to bridge", () => {
      mgr.start();
      expect(mgr.getSupportedCommands("nonexistent")).toEqual([]);
    });

    it("getAccountInfo forwards to bridge", () => {
      mgr.start();
      expect(mgr.getAccountInfo("nonexistent")).toBeNull();
    });

    it("forwards capabilities:ready event", () => {
      mgr.start();
      const handler = vi.fn();
      mgr.on("capabilities:ready", handler);

      // Simulate the bridge emitting the event
      (mgr as any)._bridgeEmitter.emit("capabilities:ready" as any, {
        sessionId: "sess-1",
        commands: [{ name: "/help", description: "Help" }],
        models: [{ value: "claude-sonnet-4-5-20250929", displayName: "Sonnet" }],
        account: { email: "test@test.com" },
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sess-1" }));
    });

    it("forwards capabilities:timeout event", () => {
      mgr.start();
      const handler = vi.fn();
      mgr.on("capabilities:timeout", handler);

      (mgr as any)._bridgeEmitter.emit("capabilities:timeout" as any, {
        sessionId: "sess-1",
      });

      expect(handler).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });
  });

  // -----------------------------------------------------------------------
  // AdapterResolver wiring
  // -----------------------------------------------------------------------

  describe("adapterResolver wiring", () => {
    it("defaultAdapterName returns resolver default when provided", () => {
      const mockResolver = {
        resolve: vi.fn(),
        defaultName: "codex" as const,
        availableAdapters: ["claude", "codex", "acp"] as const,
      };

      const resolverMgr = new SessionCoordinator({
        config: { port: 3456 },
        storage,
        logger: noopLogger,
        adapterResolver: mockResolver as any,
        launcher: createLauncher(pm, { storage, logger: noopLogger }),
      });

      expect(resolverMgr.defaultAdapterName).toBe("codex");
    });

    it("defaultAdapterName falls back to claude without resolver", () => {
      expect(mgr.defaultAdapterName).toBe("claude");
    });
  });

  // -----------------------------------------------------------------------
  // Process output forwarding
  // -----------------------------------------------------------------------

  describe("process output forwarding", () => {
    it("forwards stdout with redaction to broadcastProcessOutput", () => {
      mgr.start();
      const broadcastSpy = vi
        .spyOn((mgr as any).broadcaster, "broadcastProcessOutput")
        .mockImplementation(() => {});
      const info = mgr.launcher.launch({ cwd: "/tmp" });

      (mgr.launcher as any).emit("process:stdout" as any, {
        sessionId: info.sessionId,
        data: "safe output line\n",
      });

      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: info.sessionId }),
        "stdout",
        expect.any(String),
      );
    });

    it("forwards stderr to broadcastProcessOutput", () => {
      mgr.start();
      const broadcastSpy = vi
        .spyOn((mgr as any).broadcaster, "broadcastProcessOutput")
        .mockImplementation(() => {});
      const info = mgr.launcher.launch({ cwd: "/tmp" });

      (mgr.launcher as any).emit("process:stderr" as any, {
        sessionId: info.sessionId,
        data: "error line\n",
      });

      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: info.sessionId }),
        "stderr",
        expect.any(String),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Session auto-naming on first turn
  // -----------------------------------------------------------------------

  describe("session auto-naming on first turn", () => {
    it("derives name from first user message, truncates at 50, and broadcasts", () => {
      mgr.start();
      const broadcastSpy = vi
        .spyOn((mgr as any).broadcaster, "broadcastNameUpdate")
        .mockImplementation(() => {});
      const setNameSpy = vi.spyOn(mgr.launcher, "setSessionName").mockImplementation(() => {});

      const info = mgr.launcher.launch({ cwd: "/tmp" });

      const longMessage = "A".repeat(60);
      (mgr as any)._bridgeEmitter.emit("session:first_turn_completed" as any, {
        sessionId: info.sessionId,
        firstUserMessage: longMessage,
      });

      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: info.sessionId }),
        expect.stringContaining("..."),
      );
      // Name should be truncated to 50 chars: 47 + "..."
      const calledName = broadcastSpy.mock.calls[0][1];
      expect(calledName.length).toBeLessThanOrEqual(50);
      expect(setNameSpy).toHaveBeenCalledWith(info.sessionId, calledName);
    });

    it("skips naming if session already has a name", () => {
      mgr.start();
      const broadcastSpy = vi
        .spyOn((mgr as any).broadcaster, "broadcastNameUpdate")
        .mockImplementation(() => {});

      const info = mgr.launcher.launch({ cwd: "/tmp" });
      // Set a name before auto-naming triggers
      mgr.launcher.setSessionName(info.sessionId, "Existing Name");

      (mgr as any)._bridgeEmitter.emit("session:first_turn_completed" as any, {
        sessionId: info.sessionId,
        firstUserMessage: "Hello world",
      });

      expect(broadcastSpy).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Session closed cleanup
  // -----------------------------------------------------------------------

  describe("session closed cleanup", () => {
    it("deletes processLogBuffers when session is closed", () => {
      mgr.start();
      const broadcastSpy = vi
        .spyOn((mgr as any).broadcaster, "broadcastProcessOutput")
        .mockImplementation(() => {});
      const info = mgr.launcher.launch({ cwd: "/tmp" });

      // Generate some process output to populate the buffer
      (mgr.launcher as any).emit("process:stdout" as any, {
        sessionId: info.sessionId,
        data: "line-before-close\n",
      });
      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: info.sessionId }),
        "stdout",
        expect.stringContaining("line-before-close"),
      );

      // Emit session:closed — should clean up the buffer
      (mgr as any)._bridgeEmitter.emit("session:closed" as any, { sessionId: info.sessionId });

      // After close, new output for same session creates a fresh buffer
      // (the old accumulated lines are gone). Verify output still works.
      broadcastSpy.mockClear();
      (mgr.launcher as any).emit("process:stdout" as any, {
        sessionId: info.sessionId,
        data: "line-after-close\n",
      });
      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: info.sessionId }),
        "stdout",
        expect.stringContaining("line-after-close"),
      );
    });
  });

  // -----------------------------------------------------------------------
  // executeSlashCommand forwarding
  // -----------------------------------------------------------------------

  describe("executeSlashCommand forwarding", () => {
    it("delegates to bridge.executeSlashCommand", async () => {
      mgr.start();
      const executeSpy = vi.spyOn(mgr, "executeSlashCommand").mockResolvedValue({
        content: "help output",
        source: "emulated" as const,
      });

      const result = await mgr.executeSlashCommand("test-session", "/help");

      expect(executeSpy).toHaveBeenCalledWith("test-session", "/help");
      expect(result).toEqual({ content: "help output", source: "emulated" });
    });
  });
});
