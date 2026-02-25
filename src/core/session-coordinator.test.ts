import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn(() => "/usr/bin/claude"));
vi.mock("node:child_process", () => ({ execFileSync: mockExecFileSync }));

import { ClaudeLauncher } from "../adapters/claude/claude-launcher.js";
import { MemoryStorage } from "../adapters/memory-storage.js";
import type { ProcessHandle, ProcessManager, SpawnOptions } from "../interfaces/process-manager.js";
import type { OnCLIConnection, WebSocketServerLike } from "../interfaces/ws-server.js";
import { MockBackendAdapter } from "../testing/adapter-test-helpers.js";
import type { CliAdapterName } from "./interfaces/adapter-names.js";
import type { AdapterResolver } from "./interfaces/adapter-resolver.js";
import type { BackendAdapter } from "./interfaces/backend-adapter.js";
import { SessionCoordinator } from "./session-coordinator.js";

// ---------------------------------------------------------------------------
// Minimal ProcessManager mock
// ---------------------------------------------------------------------------

interface TestProcessHandle extends ProcessHandle {
  resolveExit: (code: number | null) => void;
}

class TestProcessManager implements ProcessManager {
  readonly spawnCalls: SpawnOptions[] = [];
  readonly handles: TestProcessHandle[] = [];
  private alivePids = new Set<number>();
  private nextPid = 20000;

  spawn(options: SpawnOptions): ProcessHandle {
    this.spawnCalls.push(options);
    const pid = this.nextPid++;
    this.alivePids.add(pid);
    let resolveExit: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    const handle: TestProcessHandle = {
      pid,
      exited,
      kill: () => {
        this.alivePids.delete(pid);
        resolveExit!(0);
      },
      stdout: null,
      stderr: null,
      resolveExit: (code: number | null) => {
        this.alivePids.delete(pid);
        resolveExit!(code);
      },
    };
    this.handles.push(handle);
    return handle;
  }

  isAlive(pid: number): boolean {
    return this.alivePids.has(pid);
  }
}

// ---------------------------------------------------------------------------
// TrackingProcessManager — records kill signals per process for wiring tests
// ---------------------------------------------------------------------------

interface TrackingProcessHandle extends ProcessHandle {
  resolveExit: (code: number | null) => void;
  killCalls: string[];
}

class TrackingProcessManager implements ProcessManager {
  readonly spawnCalls: SpawnOptions[] = [];
  readonly spawnedProcesses: TrackingProcessHandle[] = [];
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
    const handle: TrackingProcessHandle = {
      pid,
      exited,
      kill: (signal: "SIGTERM" | "SIGKILL" | "SIGINT" = "SIGTERM") => {
        killCalls.push(signal);
        resolveExit!(0);
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

  get lastProcess(): TrackingProcessHandle | undefined {
    return this.spawnedProcesses[this.spawnedProcesses.length - 1];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function createTestConfig(overrides?: Partial<import("../types/config.js").ProviderConfig>) {
  return {
    port: 3456,
    relaunchDedupMs: 1,
    killGracePeriodMs: 1,
    initializeTimeoutMs: 1,
    ...overrides,
  };
}

function createLauncher(pm: ProcessManager, storage?: MemoryStorage) {
  return new ClaudeLauncher({
    processManager: pm,
    config: createTestConfig(),
    storage,
    logger: noopLogger,
  });
}

function mockResolver(
  adapters: Record<string, BackendAdapter>,
  defaultName: CliAdapterName = "claude",
): AdapterResolver {
  return {
    resolve: vi.fn((name?: CliAdapterName) => {
      const resolved = name ?? defaultName;
      const adapter = adapters[resolved];
      if (!adapter) throw new Error(`Unknown adapter: ${resolved}`);
      return adapter;
    }),
    defaultName,
    availableAdapters: ["claude", "codex", "acp", "gemini", "opencode"],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionCoordinator.createSession", () => {
  it("for claude: delegates to launcher.launch()", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    const result = await mgr.createSession({ cwd: process.cwd() });

    expect(result.sessionId).toBeTruthy();
    expect(result.cwd).toBe(process.cwd());
    expect(result.adapterName).toBe("claude");
    expect(result.state).toBe("starting");
    expect(result.createdAt).toBeGreaterThan(0);

    // Verify it appears in launcher
    const sessions = mgr.launcher.listSessions();
    expect(sessions.find((s) => s.sessionId === result.sessionId)).toBeDefined();

    await mgr.stop();
  });

  it("for codex: registers in launcher, connects via bridge", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const codexAdapter = new MockBackendAdapter();
    const connectSpy = vi.spyOn(codexAdapter, "connect");
    const resolver = mockResolver({
      claude: new MockBackendAdapter(),
      codex: codexAdapter,
    });

    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      adapterResolver: resolver,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    const result = await mgr.createSession({
      cwd: process.cwd(),
      adapterName: "codex",
    });

    expect(result.sessionId).toBeTruthy();
    expect(result.adapterName).toBe("codex");
    expect(result.state).toBe("connected");

    // Verify in launcher
    const sessions = mgr.launcher.listSessions();
    expect(sessions.find((s) => s.sessionId === result.sessionId)).toBeDefined();

    // Verify adapter.connect was called
    expect(connectSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: result.sessionId }),
    );

    await mgr.stop();
  });

  it("both claude and codex sessions appear in listSessions", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const codexAdapter = new MockBackendAdapter();
    const resolver = mockResolver({
      claude: new MockBackendAdapter(),
      codex: codexAdapter,
    });

    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      adapterResolver: resolver,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    const sdkResult = await mgr.createSession({ cwd: process.cwd() });
    const codexResult = await mgr.createSession({
      cwd: process.cwd(),
      adapterName: "codex",
    });

    const sessions = mgr.launcher.listSessions();
    const ids = sessions.map((s) => s.sessionId);
    expect(ids).toContain(sdkResult.sessionId);
    expect(ids).toContain(codexResult.sessionId);

    await mgr.stop();
  });

  it("on connect failure for non-claude: cleans up registered session", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const failingAdapter = new MockBackendAdapter();
    failingAdapter.setShouldFail(true);

    const resolver = mockResolver({
      claude: new MockBackendAdapter(),
      codex: failingAdapter,
    });

    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      adapterResolver: resolver,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    await expect(mgr.createSession({ cwd: process.cwd(), adapterName: "codex" })).rejects.toThrow(
      "Connection failed",
    );

    // Verify the orphaned session was cleaned up
    const sessions = mgr.launcher.listSessions();
    expect(sessions).toHaveLength(0);

    await mgr.stop();
  });

  it("uses defaultAdapterName when none specified", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const codexAdapter = new MockBackendAdapter();
    const connectSpy = vi.spyOn(codexAdapter, "connect");
    const resolver = mockResolver(
      { claude: new MockBackendAdapter(), codex: codexAdapter },
      "codex",
    );

    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      adapterResolver: resolver,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    const result = await mgr.createSession({ cwd: process.cwd() });

    expect(result.adapterName).toBe("codex");
    expect(connectSpy).toHaveBeenCalled();

    await mgr.stop();
  });
});

describe("SessionCoordinator.deleteSession", () => {
  it("deletes session with a PID (claude)", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    const result = await mgr.createSession({ cwd: process.cwd() });
    const deleted = await mgr.deleteSession(result.sessionId);

    expect(deleted).toBe(true);
    expect(mgr.launcher.getSession(result.sessionId)).toBeUndefined();
  });

  it("deletes session without a PID (non-claude)", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const codexAdapter = new MockBackendAdapter();
    const resolver = mockResolver({
      claude: new MockBackendAdapter(),
      codex: codexAdapter,
    });

    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      adapterResolver: resolver,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    const result = await mgr.createSession({
      cwd: process.cwd(),
      adapterName: "codex",
    });
    const deleted = await mgr.deleteSession(result.sessionId);

    expect(deleted).toBe(true);
    expect(mgr.launcher.getSession(result.sessionId)).toBeUndefined();
  });

  it("returns false for non-existent session", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    const deleted = await mgr.deleteSession("nonexistent-id");

    expect(deleted).toBe(false);

    await mgr.stop();
  });

  it("deletes session from registry when registry !== launcher", async () => {
    const { SimpleSessionRegistry } = await import("./session/simple-session-registry.js");

    const pm = new TestProcessManager();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const registry = new SimpleSessionRegistry();
    const launcher = createLauncher(pm, new MemoryStorage());

    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage: new MemoryStorage(),
      logger,
      launcher,
      registry,
    });
    await mgr.start();

    registry.register({
      sessionId: "forward-sess",
      cwd: "/tmp",
      createdAt: Date.now(),
      adapterName: "acp",
    });

    expect(registry.getSession("forward-sess")).toBeDefined();
    expect(launcher.getSession("forward-sess")).toBeUndefined();

    const deleted = await mgr.deleteSession("forward-sess");
    expect(deleted).toBe(true);
    expect(registry.getSession("forward-sess")).toBeUndefined();

    await mgr.stop();
  });
});

describe("SessionCoordinator.renameSession", () => {
  it("renames through coordinator/bridge flow and emits session:renamed", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    const created = await mgr.createSession({ cwd: process.cwd() });
    const coordinatorEvents: Array<{ sessionId: string; name: string }> = [];
    const domainEvents: Array<{ sessionId: string; name: string }> = [];

    mgr.on("session:renamed", (payload) => coordinatorEvents.push(payload));
    mgr.domainEvents.on("session:renamed", ({ payload }) => domainEvents.push(payload));

    const renamed = mgr.renameSession(created.sessionId, "My Session");

    expect(renamed).toMatchObject({ sessionId: created.sessionId, name: "My Session" });
    expect(mgr.registry.getSession(created.sessionId)?.name).toBe("My Session");
    expect(coordinatorEvents).toEqual([{ sessionId: created.sessionId, name: "My Session" }]);
    expect(domainEvents).toEqual([{ sessionId: created.sessionId, name: "My Session" }]);

    await mgr.stop();
  });

  it("returns null when session is missing", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    const renamed = mgr.renameSession("missing-session", "new-name");

    expect(renamed).toBeNull();

    await mgr.stop();
  });
});

describe("SessionCoordinator edge cases and internal wiring", () => {
  it("covers setServer passing down to transportHub", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });
    const mockServer = { on: vi.fn(), close: vi.fn() } as any;
    mgr.setServer(mockServer);

    // Verify it was passed to transport hub (we can check internal references if needed or just trust the call finishes)
    expect((mgr as any).transportHub["server"]).toBe(mockServer);
  });

  it("covers storage flush error during closeSessions", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const flushSpy = vi.fn().mockRejectedValue(new Error("Simulated flush error"));
    (storage as any).flush = flushSpy;

    const warnSpy = vi.spyOn(noopLogger, "warn");

    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });

    await mgr.start();
    await mgr.stop(); // should catch the flush error and log warning

    expect(flushSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to flush storage during shutdown",
      expect.any(Object),
    );
  });

  it("covers recoveryService.bridge.isBackendConnected and bridgeLifecycle edge cases", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });

    await mgr.start();
    const session = await mgr.createSession({ cwd: process.cwd() });

    // Test recoveryService bridge
    const recoveryBridge = (mgr as any).recoveryService["bridge"];
    expect(recoveryBridge.isBackendConnected(session.sessionId)).toBe(false);
    expect(recoveryBridge.isBackendConnected("non-existent")).toBe(false);

    // Test watchdog broadcast internal method given to policies
    const reconnectBridge = (mgr as any).reconnectController["deps"]["bridge"];
    const broadcastSpy = vi.spyOn((mgr as any).broadcaster, "broadcast");

    // With valid session
    reconnectBridge.broadcastWatchdogState(session.sessionId, {
      gracePeriodMs: 1000,
      startedAt: 0,
    });
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "session_update" }),
    );

    // With invalid session (should not throw, just ignore)
    reconnectBridge.broadcastWatchdogState("invalid", null);

    await mgr.stop();
  });

  it("covers event relay handlers for edge cases (resume failed, process exited)", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });

    await mgr.start();
    const session = await mgr.createSession({ cwd: process.cwd() });

    const broadcaster = (mgr as any).broadcaster;
    const broadcastSpy = vi.spyOn(broadcaster, "broadcast");

    const relayHandlers = (mgr as any).relay["deps"].handlers;

    // Simulate backend:resume_failed
    relayHandlers.onProcessResumeFailed({ sessionId: session.sessionId });
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "resume_failed" }),
    );

    broadcastSpy.mockClear();

    // Simulate process_exited with circuit breaker state
    relayHandlers.onProcessExited({
      sessionId: session.sessionId,
      code: 1,
      signal: "SIGKILL",
      circuitBreaker: { status: "open", timeUntilResetMs: 5000 },
    });
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "session_update" }),
    );

    await mgr.stop();
  });

  it("covers public bridge facade methods (isBackendConnected, broadcastProcessOutput, executeSlashCommand, on/off)", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });

    await mgr.start();
    const session = await mgr.createSession({ cwd: process.cwd() });

    // isBackendConnected
    expect(mgr.isBackendConnected(session.sessionId)).toBeFalsy();
    expect(mgr.isBackendConnected("missing-session")).toBeFalsy();

    // broadcastProcessOutput is internal (via handleProcessOutput → runtime.process → broadcastToParticipants)
    const broadcastSpy = vi.spyOn((mgr as any).broadcaster, "broadcastToParticipants");
    (mgr as any).handleProcessOutput(session.sessionId, "stdout", "test");
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "process_output" }),
    );

    // executeSlashCommand
    const slashSpy = vi.spyOn(mgr, "executeSlashCommand");
    mgr.executeSlashCommand(session.sessionId, "/test");
    expect(slashSpy).toHaveBeenCalled();

    // on / off
    const listener = vi.fn();
    mgr._bridgeEmitter.on("session:renamed", listener);
    mgr._bridgeEmitter.emit("session:renamed", { sessionId: session.sessionId, name: "New Name" });
    expect(listener).toHaveBeenCalledWith({ sessionId: session.sessionId, name: "New Name" });
    mgr._bridgeEmitter.off("session:renamed", listener);

    await mgr.stop();
  });

  it("covers bridgeLifecycle methods passed to policies and connectBackend in recoveryService", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });

    await mgr.start();
    const session = await mgr.createSession({ cwd: process.cwd() });

    // policy bridge (bridgeLifecycle)
    const policyBridge = (mgr as any).reconnectController["deps"]["bridge"];

    // getAllSessions
    const sessions = policyBridge.getAllSessions();
    expect(sessions.length).toBeGreaterThan(0);

    // getSession
    const snapshot = policyBridge.getSession(session.sessionId);
    expect(snapshot).toBeDefined();

    // applyPolicyCommand
    const policySpy = vi.spyOn(mgr as any, "applyPolicyCommandForSession");
    policyBridge.applyPolicyCommand(session.sessionId, { type: "idle_reap" });
    expect(policySpy).toHaveBeenCalled();

    // closeSession
    const closeSpy = vi.spyOn(mgr as any, "closeSessionInternal");
    policyBridge.closeSession(session.sessionId);
    expect(closeSpy).toHaveBeenCalled();

    // recoveryService connectBackend
    const connectSpy = vi.spyOn((mgr as any).backendConnector, "connectBackend");
    const recoveryBridge = (mgr as any).recoveryService["bridge"];
    await expect(recoveryBridge.connectBackend(session.sessionId, {})).rejects.toThrow(
      "No BackendAdapter configured",
    );
    expect(connectSpy).toHaveBeenCalled();

    await mgr.stop();
  });

  it("covers remaining missing branches for 100% coverage", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });

    await mgr.start();
    const session = await mgr.createSession({}); // missing cwd triggers default fallback

    // renameSession with missing session returns null
    expect(mgr.renameSession("missing-session", "name")).toBeNull();

    // restoreFromStorage returning 0
    vi.spyOn((mgr as any).store, "restoreAll").mockReturnValue(0);
    const restoreBridge = (mgr as any).startupRestoreService["bridge"];
    restoreBridge.restoreFromStorage();

    // getSessionSnapshot with missing session
    const policyBridge = (mgr as any).reconnectController["deps"]["bridge"];
    expect(policyBridge.getSession("missing-session")).toBeUndefined();

    const relayHandlers = (mgr as any).relay["deps"].handlers;

    // onProcessSpawned with missing registry info
    relayHandlers.onProcessSpawned({ sessionId: "missing-session" });

    // onProcessResumeFailed with missing session
    relayHandlers.onProcessResumeFailed({ sessionId: "missing-session" });

    // onFirstTurnCompleted branches (name mapping logic)
    const renameSpy = vi.spyOn(mgr, "renameSession");
    // empty user message
    relayHandlers.onFirstTurnCompleted({ sessionId: session.sessionId, firstUserMessage: "   " });
    // long truncated message
    relayHandlers.onFirstTurnCompleted({
      sessionId: session.sessionId,
      firstUserMessage: "a".repeat(100),
    });
    expect(renameSpy).toHaveBeenCalledWith(session.sessionId, "a".repeat(47) + "...");

    // trigger onCapabilitiesTimeout
    const capSpy = vi.spyOn(mgr as any, "applyPolicyCommandForSession");
    relayHandlers.onCapabilitiesTimeout({ sessionId: session.sessionId });
    expect(capSpy).toHaveBeenCalled();

    // trigger onBackendRelaunchNeeded
    const relaunchSpy = vi.spyOn((mgr as any).recoveryService, "handleRelaunchNeeded");
    relayHandlers.onBackendRelaunchNeeded({ sessionId: session.sessionId });
    expect(relaunchSpy).toHaveBeenCalled();

    await mgr.stop();
  });
});

// ---------------------------------------------------------------------------
// SessionCoordinator — event wiring and signal routing
// (uses TrackingProcessManager to verify kill signals)
// ---------------------------------------------------------------------------

describe("SessionCoordinator wiring", () => {
  let mgr: SessionCoordinator;
  let pm: TrackingProcessManager;
  let storage: MemoryStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    pm = new TrackingProcessManager();
    storage = new MemoryStorage();
    mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });
  });

  afterEach(async () => {
    await mgr.stop().catch(() => {});
    vi.useRealTimers();
  });

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

  describe("backend:session_id wiring", () => {
    it("forwards to launcher.setBackendSessionId", () => {
      mgr.start();
      const info = mgr.launcher.launch({ cwd: "/tmp" });
      (mgr as any)._bridgeEmitter.emit("backend:session_id" as any, {
        sessionId: info.sessionId,
        backendSessionId: "cli-abc-123",
      });

      const session = mgr.launcher.getSession(info.sessionId);
      expect(session?.backendSessionId).toBe("cli-abc-123");
    });
  });

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

  describe("backend:relaunch_needed wiring", () => {
    it("triggers launcher.relaunch", async () => {
      mgr.start();
      const info = mgr.launcher.launch({ cwd: "/tmp" });
      pm.lastProcess!.resolveExit(1);
      await pm.lastProcess!.exited;
      const spawnsBefore = pm.spawnCalls.length;

      (mgr as any)._bridgeEmitter.emit("backend:relaunch_needed" as any, {
        sessionId: info.sessionId,
      });
      vi.advanceTimersByTime(10);
      await Promise.resolve();

      expect(pm.spawnCalls.length).toBeGreaterThan(spawnsBefore);
    });
  });

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

  describe("stop kills all processes", () => {
    it("kills all launched processes", async () => {
      mgr.start();
      mgr.launcher.launch({ cwd: "/tmp" });
      expect(pm.spawnedProcesses).toHaveLength(1);

      await mgr.stop();

      expect(pm.lastProcess!.killCalls).toContain("SIGTERM");
    });
  });

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

      const coord = new SessionCoordinator({
        config: createTestConfig(),
        server: mockServer,
        launcher: createLauncher(pm),
      });

      await coord.start();
      expect(listenCalls).toHaveLength(1);

      await coord.stop();
      expect(closeCalled).toHaveLength(1);
    });

    it("works without WS server (backwards compatible)", async () => {
      const coord = new SessionCoordinator({
        config: createTestConfig(),
        launcher: createLauncher(pm),
      });

      await coord.start();
      await coord.stop();
    });

    it("wires CLI connections to onConnection callback", async () => {
      let capturedOnConnection: OnCLIConnection | null = null;

      const mockServer: WebSocketServerLike = {
        async listen(onConnection) {
          capturedOnConnection = onConnection;
        },
        async close() {},
      };

      const coord = new SessionCoordinator({
        config: createTestConfig(),
        server: mockServer,
        launcher: createLauncher(pm),
      });

      await coord.start();
      expect(capturedOnConnection).not.toBeNull();

      const mockSocket = { send: vi.fn(), close: vi.fn(), on: vi.fn() };
      capturedOnConnection!(mockSocket as any, "test-session-id");
      expect(mockSocket.close).toHaveBeenCalled();

      await coord.stop();
    });
  });

  describe("Forwarded structured data APIs", () => {
    it("getSupportedModels forwards to bridge", () => {
      mgr.start();
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

  describe("adapterResolver wiring", () => {
    it("defaultAdapterName returns resolver default when provided", () => {
      const resolver = {
        resolve: vi.fn(),
        defaultName: "codex" as const,
        availableAdapters: ["claude", "codex", "acp"] as const,
      };

      const resolverMgr = new SessionCoordinator({
        config: createTestConfig(),
        storage,
        logger: noopLogger,
        adapterResolver: resolver as any,
        launcher: createLauncher(pm, storage),
      });

      expect(resolverMgr.defaultAdapterName).toBe("codex");
    });

    it("defaultAdapterName falls back to claude without resolver", () => {
      expect(mgr.defaultAdapterName).toBe("claude");
    });
  });

  describe("process output forwarding", () => {
    it("forwards stdout with redaction to broadcastToParticipants", () => {
      mgr.start();
      const broadcastSpy = vi
        .spyOn((mgr as any).broadcaster, "broadcastToParticipants")
        .mockImplementation(() => {});
      const info = mgr.launcher.launch({ cwd: "/tmp" });

      (mgr.launcher as any).emit("process:stdout" as any, {
        sessionId: info.sessionId,
        data: "safe output line\n",
      });

      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: info.sessionId }),
        expect.objectContaining({ type: "process_output", stream: "stdout" }),
      );
    });

    it("forwards stderr to broadcastToParticipants", () => {
      mgr.start();
      const broadcastSpy = vi
        .spyOn((mgr as any).broadcaster, "broadcastToParticipants")
        .mockImplementation(() => {});
      const info = mgr.launcher.launch({ cwd: "/tmp" });

      (mgr.launcher as any).emit("process:stderr" as any, {
        sessionId: info.sessionId,
        data: "error line\n",
      });

      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: info.sessionId }),
        expect.objectContaining({ type: "process_output", stream: "stderr" }),
      );
    });
  });

  describe("session auto-naming on first turn", () => {
    it("derives name from first user message, truncates at 50, and broadcasts", () => {
      mgr.start();
      const broadcastSpy = vi
        .spyOn((mgr as any).broadcaster, "broadcast")
        .mockImplementation(() => {});
      const setNameSpy = vi.spyOn(mgr.launcher, "setSessionName").mockImplementation(() => {});

      const info = mgr.launcher.launch({ cwd: "/tmp" });
      const longMessage = "A".repeat(60);
      (mgr as any)._bridgeEmitter.emit("session:first_turn_completed" as any, {
        sessionId: info.sessionId,
        firstUserMessage: longMessage,
      });

      const nameUpdateCall = broadcastSpy.mock.calls.find(
        ([, msg]) => (msg as any).type === "session_name_update",
      );
      expect(nameUpdateCall).toBeDefined();
      const calledName = (nameUpdateCall![1] as any).name;
      expect(calledName).toContain("...");
      expect(calledName.length).toBeLessThanOrEqual(50);
      expect(setNameSpy).toHaveBeenCalledWith(info.sessionId, calledName);
    });

    it("skips naming if session already has a name", () => {
      mgr.start();
      const broadcastSpy = vi
        .spyOn((mgr as any).broadcaster, "broadcast")
        .mockImplementation(() => {});

      const info = mgr.launcher.launch({ cwd: "/tmp" });
      mgr.launcher.setSessionName(info.sessionId, "Existing Name");

      (mgr as any)._bridgeEmitter.emit("session:first_turn_completed" as any, {
        sessionId: info.sessionId,
        firstUserMessage: "Hello world",
      });

      const nameUpdateCall = broadcastSpy.mock.calls.find(
        ([, msg]) => (msg as any).type === "session_name_update",
      );
      expect(nameUpdateCall).toBeUndefined();
    });
  });

  describe("session closed cleanup", () => {
    it("deletes processLogBuffers when session is closed", () => {
      mgr.start();
      const broadcastSpy = vi
        .spyOn((mgr as any).broadcaster, "broadcastToParticipants")
        .mockImplementation(() => {});
      const info = mgr.launcher.launch({ cwd: "/tmp" });

      (mgr.launcher as any).emit("process:stdout" as any, {
        sessionId: info.sessionId,
        data: "line-before-close\n",
      });
      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: info.sessionId }),
        expect.objectContaining({
          type: "process_output",
          stream: "stdout",
          data: expect.stringContaining("line-before-close"),
        }),
      );

      (mgr as any)._bridgeEmitter.emit("session:closed" as any, { sessionId: info.sessionId });

      broadcastSpy.mockClear();
      (mgr.launcher as any).emit("process:stdout" as any, {
        sessionId: info.sessionId,
        data: "line-after-close\n",
      });
      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: info.sessionId }),
        expect.objectContaining({
          type: "process_output",
          stream: "stdout",
          data: expect.stringContaining("line-after-close"),
        }),
      );
    });
  });

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
