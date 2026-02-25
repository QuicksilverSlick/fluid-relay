import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn(() => "/usr/bin/claude"));
vi.mock("node:child_process", () => ({ execFileSync: mockExecFileSync }));

import { ClaudeLauncher } from "../../adapters/claude/claude-launcher.js";
import { MemoryStorage } from "../../adapters/memory-storage.js";
import type {
  ProcessHandle,
  ProcessManager,
  SpawnOptions,
} from "../../interfaces/process-manager.js";
import { MockBackendAdapter } from "../../testing/adapter-test-helpers.js";
import type { CliAdapterName } from "../interfaces/adapter-names.js";
import type { AdapterResolver } from "../interfaces/adapter-resolver.js";
import type { BackendAdapter } from "../interfaces/backend-adapter.js";
import { SessionCoordinator } from "../session-coordinator.js";

// ---------------------------------------------------------------------------
// Minimal ProcessManager mock
// ---------------------------------------------------------------------------

class TestProcessManager implements ProcessManager {
  private nextPid = 30000;

  spawn(_options: SpawnOptions): ProcessHandle {
    const pid = this.nextPid++;
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => {
      resolveExit = r;
    });
    return { pid, exited, kill: () => resolveExit(0), stdout: null, stderr: null };
  }

  isAlive(_pid: number): boolean {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestConfig() {
  return { port: 3456, relaunchDedupMs: 1, killGracePeriodMs: 1, initializeTimeoutMs: 50 };
}

function createLauncher(pm: ProcessManager, storage?: MemoryStorage) {
  return new ClaudeLauncher({
    processManager: pm,
    config: createTestConfig(),
    storage,
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
    availableAdapters: Object.keys(adapters) as CliAdapterName[],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("coordinator → runtime: applyPolicyCommandForSession", () => {
  let mgr: SessionCoordinator;
  const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();
  });

  afterEach(async () => {
    await mgr.stop().catch(() => {});
    vi.useRealTimers();
  });

  it("idle_reap policy command routes IDLE_REAP through runtime → lifecycle transitions to closing", async () => {
    const session = await mgr.createSession({ cwd: "/tmp" });

    const policyBridge = (mgr as any).reconnectController.deps.bridge;
    policyBridge.applyPolicyCommand(session.sessionId, { type: "idle_reap" });

    // IDLE_REAP transitions lifecycle from "starting" to "closing"
    const snapshot = mgr.getSessionSnapshot(session.sessionId);
    expect(snapshot?.lifecycle).toBe("closing");
  });

  it("reconnect_timeout policy command routes RECONNECT_TIMEOUT through runtime → lifecycle transitions to degraded", async () => {
    // Need a session in "active" state for RECONNECT_TIMEOUT to take effect
    // (starting → degraded is not an allowed transition)
    const codexAdapter = new MockBackendAdapter();
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const localMgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      adapterResolver: mockResolver({ claude: new MockBackendAdapter(), codex: codexAdapter }),
      launcher: createLauncher(pm, storage),
    });
    await localMgr.start();

    // Create a codex session — backend connects, lifecycle → active
    const session = await localMgr.createSession({ cwd: "/tmp", adapterName: "codex" });
    expect(localMgr.getSessionSnapshot(session.sessionId)?.lifecycle).toBe("active");

    const policyBridge = (localMgr as any).reconnectController.deps.bridge;
    policyBridge.applyPolicyCommand(session.sessionId, { type: "reconnect_timeout" });

    expect(localMgr.getSessionSnapshot(session.sessionId)?.lifecycle).toBe("degraded");
    await localMgr.stop().catch(() => {});
  });

  it("capabilities_timeout policy command routes CAPABILITIES_TIMEOUT → emits capabilities:timeout via bridge emitter", async () => {
    const session = await mgr.createSession({ cwd: "/tmp" });

    // Stop the relay to prevent the capabilities:timeout→relay→applyPolicyCommand
    // feedback loop (relay handler re-dispatches the same policy command)
    (mgr as any).relay.stop();

    const emitted: unknown[] = [];
    // Listen on _bridgeEmitter directly since the relay (which forwards to
    // coordinator emitter) is stopped
    (mgr as any)._bridgeEmitter.on("capabilities:timeout", (payload: unknown) =>
      emitted.push(payload),
    );

    (mgr as any).applyPolicyCommandForSession(session.sessionId, { type: "capabilities_timeout" });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ sessionId: session.sessionId });
  });

  it("applyPolicyCommand with unknown type does not throw", async () => {
    const session = await mgr.createSession({ cwd: "/tmp" });
    expect(() => {
      (mgr as any).applyPolicyCommandForSession(session.sessionId, { type: "unknown_type" });
    }).not.toThrow();
  });
});

describe("coordinator → runtime: withMutableSession lease guard", () => {
  it("fn is NOT called when session does not exist in the store", async () => {
    vi.useFakeTimers();
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    const fn = vi.fn();
    (mgr as any).withMutableSession("nonexistent-session", "test-op", fn);
    expect(fn).not.toHaveBeenCalled();

    await mgr.stop().catch(() => {});
    vi.useRealTimers();
  });
});

describe("coordinator → runtime: closeSessionInternal backend close error", () => {
  it("warns when backend session close() throws during closeSessionInternal", async () => {
    vi.useFakeTimers();
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const failingAdapter = new MockBackendAdapter();
    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger,
      adapterResolver: mockResolver({ claude: new MockBackendAdapter(), codex: failingAdapter }),
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    const session = await mgr.createSession({ cwd: "/tmp", adapterName: "codex" });

    // Get the runtime and make its backend session's close() throw
    const runtime = (mgr as any).runtimes.get(session.sessionId);
    const backendSession = runtime?.getBackendSession?.();
    if (backendSession) {
      backendSession.close = () => Promise.reject(new Error("close boom"));
    }

    await expect((mgr as any).closeSessionInternal(session.sessionId)).resolves.not.toThrow();

    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to close backend session",
      expect.objectContaining({ sessionId: session.sessionId }),
    );

    await mgr.stop().catch(() => {});
    vi.useRealTimers();
  });
});

describe("coordinator: createSession model propagation", () => {
  it("model passed to createSession appears in session snapshot state", async () => {
    vi.useFakeTimers();
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    const result = await mgr.createSession({ cwd: "/tmp", model: "claude-opus-4-6" });
    const snapshot = mgr.getSessionSnapshot(result.sessionId);

    expect(snapshot?.state.model).toBe("claude-opus-4-6");

    await mgr.stop().catch(() => {});
    vi.useRealTimers();
  });
});

describe("coordinator: onProcessSpawned relay handler", () => {
  it("seeds cwd, model, and adapterName from registry into runtime state", async () => {
    vi.useFakeTimers();
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      launcher: createLauncher(pm, storage),
    });
    await mgr.start();

    const info = mgr.launcher.launch({ cwd: "/workspace", model: "claude-opus-4-6" });
    const snapshot = mgr.getSessionSnapshot(info.sessionId);

    expect(snapshot?.state.cwd).toBe("/workspace");
    expect(snapshot?.state.model).toBe("claude-opus-4-6");
    expect(snapshot?.state.adapterName).toBe("claude");

    await mgr.stop().catch(() => {});
    vi.useRealTimers();
  });
});
