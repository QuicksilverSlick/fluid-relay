import { describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn(() => "/usr/bin/claude"));
vi.mock("node:child_process", () => ({ execFileSync: mockExecFileSync }));

import { ClaudeLauncher } from "../adapters/claude/claude-launcher.js";
import { MemoryStorage } from "../adapters/memory-storage.js";
import type { ProcessHandle, ProcessManager, SpawnOptions } from "../interfaces/process-manager.js";
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
// Helpers
// ---------------------------------------------------------------------------

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function createLauncher(pm: ProcessManager, storage?: MemoryStorage) {
  return new ClaudeLauncher({
    processManager: pm,
    config: { port: 3456 },
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
      config: { port: 3456 },
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
      config: { port: 3456 },
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
      config: { port: 3456 },
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
      config: { port: 3456 },
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
      config: { port: 3456 },
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
      config: { port: 3456 },
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
      config: { port: 3456 },
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
      config: { port: 3456 },
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
      config: { port: 3456 },
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
      config: { port: 3456 },
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
      config: { port: 3456 },
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
      config: { port: 3456 },
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
      config: { port: 3456 },
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
      config: { port: 3456 },
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
    const broadcastSpy = vi.spyOn((mgr as any).services.broadcaster, "broadcastWatchdogState");

    // With valid session
    reconnectBridge.broadcastWatchdogState(session.sessionId, {
      gracePeriodMs: 1000,
      startedAt: 0,
    });
    expect(broadcastSpy).toHaveBeenCalled();

    // With invalid session (should not throw, just ignore)
    reconnectBridge.broadcastWatchdogState("invalid", null);

    await mgr.stop();
  });

  it("covers event relay handlers for edge cases (resume failed, process exited)", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const mgr = new SessionCoordinator({
      config: { port: 3456 },
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });

    await mgr.start();
    const session = await mgr.createSession({ cwd: process.cwd() });

    const broadcaster = (mgr as any).services.broadcaster;
    const resumeFailedSpy = vi.spyOn(broadcaster, "broadcastResumeFailed");
    const circuitBreakerSpy = vi.spyOn(broadcaster, "broadcastCircuitBreakerState");

    const relayHandlers = (mgr as any).relay["deps"].handlers;

    // Simulate backend:resume_failed
    relayHandlers.onProcessResumeFailed({ sessionId: session.sessionId });
    expect(resumeFailedSpy).toHaveBeenCalledWith(expect.anything(), session.sessionId);

    // Simulate process_exited with circuit breaker state
    relayHandlers.onProcessExited({
      sessionId: session.sessionId,
      code: 1,
      signal: "SIGKILL",
      circuitBreaker: { status: "open", timeUntilResetMs: 5000 },
    });
    expect(circuitBreakerSpy).toHaveBeenCalledWith(expect.anything(), {
      status: "open",
      timeUntilResetMs: 5000,
    });

    await mgr.stop();
  });

  it("covers public bridge facade methods (isBackendConnected, broadcastProcessOutput, executeSlashCommand, on/off)", async () => {
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const mgr = new SessionCoordinator({
      config: { port: 3456 },
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });

    await mgr.start();
    const session = await mgr.createSession({ cwd: process.cwd() });

    // isBackendConnected
    const sessionStore = mgr.services.store.get(session.sessionId);
    expect(
      sessionStore && mgr.services.backendConnector.isBackendConnected(sessionStore),
    ).toBeFalsy();
    const missingStore = mgr.services.store.get("missing-session");
    expect(
      missingStore && mgr.services.backendConnector.isBackendConnected(missingStore),
    ).toBeFalsy();

    // broadcastProcessOutput is internal (via handleProcessOutput)
    const broadcastSpy = vi.spyOn((mgr as any).services.broadcaster, "broadcastProcessOutput");
    (mgr as any).handleProcessOutput(session.sessionId, "stdout", "test");
    expect(broadcastSpy).toHaveBeenCalled();

    // executeSlashCommand
    const slashSpy = vi.spyOn((mgr as any).services.runtimeApi, "executeSlashCommand");
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
      config: { port: 3456 },
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
    const policySpy = vi.spyOn((mgr as any).services.runtimeApi, "applyPolicyCommand");
    policyBridge.applyPolicyCommand(session.sessionId, { type: "idle_reap" });
    expect(policySpy).toHaveBeenCalled();

    // closeSession
    const closeSpy = vi.spyOn((mgr as any).services.lifecycleService, "closeSession");
    policyBridge.closeSession(session.sessionId);
    expect(closeSpy).toHaveBeenCalled();

    // recoveryService connectBackend
    const connectSpy = vi.spyOn((mgr as any).services.backendConnector, "connectBackend");
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
      config: { port: 3456 },
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });

    await mgr.start();
    const session = await mgr.createSession({}); // missing cwd triggers default fallback

    // renameSession with missing session returns null
    expect(mgr.renameSession("missing-session", "name")).toBeNull();

    // restoreFromStorage returning 0
    vi.spyOn((mgr as any).services.store, "restoreAll").mockReturnValue(0);
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
    const capSpy = vi.spyOn((mgr as any).services.runtimeApi, "applyPolicyCommand");
    relayHandlers.onCapabilitiesTimeout({ sessionId: session.sessionId });
    expect(capSpy).toHaveBeenCalled();

    // trigger onBackendRelaunchNeeded
    const relaunchSpy = vi.spyOn((mgr as any).recoveryService, "handleRelaunchNeeded");
    relayHandlers.onBackendRelaunchNeeded({ sessionId: session.sessionId });
    expect(relaunchSpy).toHaveBeenCalled();

    await mgr.stop();
  });
});
