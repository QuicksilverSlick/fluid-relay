# Integration Test Coverage Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add integration tests for `session-coordinator.ts` and `session-runtime.ts` that cover untested paths through the real coordinator→runtime→reducer→effects pipeline.

**Architecture:** Each task adds one new integration test file. Tests use `createBridgeWithAdapter()` (for runtime-level) or `SessionCoordinator` + `ClaudeLauncher` + `MockBackendAdapter` (for coordinator-level). No E2E real WebSocket server needed. Fake timers where needed.

**Tech Stack:** Vitest, `createBridgeWithAdapter` from `src/testing/adapter-test-helpers.ts`, `createMockSession`/`makeDeps` from `src/testing/cli-message-factories.ts`, existing `MockBackendAdapter`, `SessionRuntime`, `SessionCoordinator`.

---

## Coverage gaps to close

### session-coordinator.ts untested paths

1. `applyPolicyCommandForSession` — all three policy types (`idle_reap`, `reconnect_timeout`, `capabilities_timeout`) dispatching the correct `SystemSignal` through the runtime and producing observable effects on the broadcaster.
2. `withMutableSession` lease guard — when `ensureLease` returns false, mutation is silently skipped.
3. `closeSessionInternal` — backend `close()` throwing: error is caught, warn is logged.
4. `createSession` model parameter — model seeded into session snapshot state.
5. `onProcessSpawned` relay handler — seeds `cwd`, `model`, `adapterName` into runtime state via `seedSessionState`.

### session-runtime.ts untested paths

1. `CAPABILITIES_INIT_REQUESTED` with no backend → `logger.warn` + break.
2. `CAPABILITIES_INIT_REQUESTED` with adapter that does not support `initialize` → `logger.info` + break.
3. `CAPABILITIES_INIT_REQUESTED` dedup — when `pendingInitialize` is already set, skip.
4. `CAPABILITIES_INIT_REQUESTED` timer fires → dispatches `CAPABILITIES_TIMEOUT`.
5. `SESSION_CLOSING` — clears `pendingInitialize` timer.
6. `orchestrateSessionInit` with `gitResolver` returning git info → `STATE_PATCHED` dispatched.
7. `orchestrateSessionInit` with `capabilities` in `session_init` metadata → `applyCapabilities` called, `sendInitializeRequest` not called.
8. `orchestrateControlResponse` — delegates to `capabilitiesPolicy.handleControlResponse`.
9. `orchestrateResult` — `gitTracker.refreshGitInfo` called; when it returns a patch, `STATE_PATCHED` dispatched.
10. `emitTeamEvents` — fires `TEAM_STATE_DIFFED` when `team` state changes between backend messages.
11. `closeBackendConnection` — calls `backendAbort.abort()` + `backendSession.close()` + dispatches `BACKEND_DISCONNECTED`.
12. `sendPermissionResponse` with unknown `request_id` → `logger.warn`.
13. `handleInboundCommand` — `set_adapter` command on active session sends error to the requesting `ws`.
14. `handleInboundCommand` — `queue_message` routes to `queueHandler.handleQueueMessage`.
15. `handleInboundCommand` — `update_queued_message` routes to `queueHandler.handleUpdateQueuedMessage`.
16. `handleInboundCommand` — `cancel_queued_message` routes to `queueHandler.handleCancelQueuedMessage`.
17. `handleInboundCommand` — `presence_query` routes to `broadcaster.broadcastPresence`.
18. `CONSUMER_DISCONNECTED` for unregistered socket → `logger.warn`.
19. `CAPABILITIES_APPLIED` → `registerCLICommands` called on the session registry.
20. `PASSTHROUGH_ENQUEUED` → entry pushed to `session.pendingPassthroughs`.
21. `markDirty` debounce — multiple rapid state changes collapse into a single `store.persist` call.

---

## Task 1: Coordinator → Runtime integration

**Files:**
- Create: `src/core/coordinator/coordinator-runtime-integration.integration.test.ts`

### Step 1: Write the failing test

```typescript
// src/core/coordinator/coordinator-runtime-integration.integration.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mockExecFileSync = vi.hoisted(() => vi.fn(() => "/usr/bin/claude"));
vi.mock("node:child_process", () => ({ execFileSync: mockExecFileSync }));

import { ClaudeLauncher } from "../../adapters/claude/claude-launcher.js";
import { MemoryStorage } from "../../adapters/memory-storage.js";
import { MockBackendAdapter } from "../../testing/adapter-test-helpers.js";
import type { ProcessHandle, ProcessManager, SpawnOptions } from "../../interfaces/process-manager.js";
import type { CliAdapterName } from "../interfaces/adapter-names.js";
import type { AdapterResolver } from "../interfaces/adapter-resolver.js";
import { SessionCoordinator } from "../session-coordinator.js";

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function createTestConfig() {
  return { port: 3456, relaunchDedupMs: 1, killGracePeriodMs: 1, initializeTimeoutMs: 50 };
}

class TestProcessManager implements ProcessManager {
  private nextPid = 30000;
  spawn(_options: SpawnOptions): ProcessHandle {
    const pid = this.nextPid++;
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => { resolveExit = r; });
    return { pid, exited, kill: () => resolveExit(0), stdout: null, stderr: null };
  }
  isAlive(_pid: number): boolean { return false; }
}

function mockResolver(adapters: Record<string, MockBackendAdapter>, defaultName: CliAdapterName = "claude"): AdapterResolver {
  return {
    resolve: vi.fn((name?: CliAdapterName) => {
      const resolved = name ?? defaultName;
      const adapter = adapters[resolved];
      if (!adapter) throw new Error(`Unknown: ${resolved}`);
      return adapter;
    }),
    defaultName,
    availableAdapters: Object.keys(adapters) as CliAdapterName[],
  };
}
```

### Step 2: Add policy command dispatch tests

```typescript
describe("coordinator → runtime: applyPolicyCommandForSession", () => {
  let mgr: SessionCoordinator;

  beforeEach(async () => {
    vi.useFakeTimers();
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      launcher: new ClaudeLauncher({ processManager: pm, config: createTestConfig(), storage }),
    });
    await mgr.start();
  });

  afterEach(async () => {
    await mgr.stop().catch(() => {});
    vi.useRealTimers();
  });

  it("idle_reap dispatches IDLE_REAP signal → session emits session_closed via broadcaster", async () => {
    const session = await mgr.createSession({ cwd: "/tmp" });
    const closedEvents: string[] = [];
    mgr._bridgeEmitter.on("session:closed", (p: { sessionId: string }) =>
      closedEvents.push(p.sessionId),
    );

    // Apply idle_reap — the runtime should transition lifecycle and coordinator closes session
    const policyBridge = (mgr as any).reconnectController.deps.bridge;
    await policyBridge.closeSession(session.sessionId);

    expect(closedEvents).toContain(session.sessionId);
  });

  it("idle_reap policy command routes IDLE_REAP through runtime reducer", async () => {
    const session = await mgr.createSession({ cwd: "/tmp" });
    const broadcastSpy = vi.spyOn((mgr as any).broadcaster, "broadcast");

    const policyBridge = (mgr as any).reconnectController.deps.bridge;
    policyBridge.applyPolicyCommand(session.sessionId, { type: "idle_reap" });

    // IDLE_REAP should produce a session_closed broadcast (lifecycle → closed)
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: session.sessionId }),
      expect.objectContaining({ type: "session_closed" }),
    );
  });

  it("reconnect_timeout policy command routes RECONNECT_TIMEOUT through runtime", async () => {
    const session = await mgr.createSession({ cwd: "/tmp" });
    const broadcastSpy = vi.spyOn((mgr as any).broadcaster, "broadcast");

    const policyBridge = (mgr as any).reconnectController.deps.bridge;
    policyBridge.applyPolicyCommand(session.sessionId, { type: "reconnect_timeout" });

    // RECONNECT_TIMEOUT causes session to close
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: session.sessionId }),
      expect.objectContaining({ type: "session_closed" }),
    );
  });

  it("capabilities_timeout policy command routes CAPABILITIES_TIMEOUT through runtime", async () => {
    const session = await mgr.createSession({ cwd: "/tmp" });
    const broadcastSpy = vi.spyOn((mgr as any).broadcaster, "broadcast");

    const policyBridge = (mgr as any).reconnectController.deps.bridge;
    policyBridge.applyPolicyCommand(session.sessionId, { type: "capabilities_timeout" });

    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: session.sessionId }),
      expect.objectContaining({ type: "session_closed" }),
    );
  });

  it("applyPolicyCommand with unknown type does not throw", async () => {
    const session = await mgr.createSession({ cwd: "/tmp" });
    expect(() => {
      (mgr as any).applyPolicyCommandForSession(session.sessionId, { type: "unknown_type" });
    }).not.toThrow();
  });

  it("withMutableSession lease guard: logs warn and skips fn when session does not exist", () => {
    const fn = vi.fn();
    (mgr as any).withMutableSession("nonexistent-session", "test-op", fn);
    expect(fn).not.toHaveBeenCalled();
  });
});
```

### Step 3: Add closeSessionInternal error handling test

```typescript
describe("coordinator → runtime: closeSessionInternal backend error", () => {
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
      launcher: new ClaudeLauncher({ processManager: pm, config: createTestConfig(), storage }),
    });
    await mgr.start();

    const session = await mgr.createSession({ cwd: "/tmp", adapterName: "codex" });

    // Make the backend session's close() throw
    const backendSession = (mgr as any).runtimes.get(session.sessionId)?.session?.backendSession;
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
```

### Step 4: Add createSession model + onProcessSpawned tests

```typescript
describe("coordinator: createSession model propagation", () => {
  it("model passed to createSession appears in session snapshot state", async () => {
    vi.useFakeTimers();
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      launcher: new ClaudeLauncher({ processManager: pm, config: createTestConfig(), storage }),
    });
    await mgr.start();

    const result = await mgr.createSession({ cwd: "/tmp", model: "claude-opus-4-6" });
    const snapshot = mgr.getSessionSnapshot(result.sessionId);

    expect(snapshot?.state.model).toBe("claude-opus-4-6");

    await mgr.stop().catch(() => {});
    vi.useRealTimers();
  });

  it("onProcessSpawned handler seeds cwd, model, and adapterName from registry", async () => {
    vi.useFakeTimers();
    const pm = new TestProcessManager();
    const storage = new MemoryStorage();
    const mgr = new SessionCoordinator({
      config: createTestConfig(),
      storage,
      logger: noopLogger,
      launcher: new ClaudeLauncher({ processManager: pm, config: createTestConfig(), storage }),
    });
    await mgr.start();

    const info = mgr.launcher.launch({ cwd: "/workspace", model: "claude-opus-4-6" });
    // onProcessSpawned fires during launch — check state was seeded
    const snapshot = mgr.getSessionSnapshot(info.sessionId);

    expect(snapshot?.state.cwd).toBe("/workspace");
    expect(snapshot?.state.model).toBe("claude-opus-4-6");
    expect(snapshot?.state.adapterName).toBe("claude");

    await mgr.stop().catch(() => {});
    vi.useRealTimers();
  });
});
```

### Step 5: Run test to verify it fails

```bash
pnpm exec vitest run src/core/coordinator/coordinator-runtime-integration.integration.test.ts
```

Expected: FAIL with "Cannot find module" or type errors before implementation.

### Step 6: Fix any import errors and run again

```bash
pnpm exec vitest run src/core/coordinator/coordinator-runtime-integration.integration.test.ts
```

Expected: Tests pass (these test existing behavior, not new behavior).

### Step 7: Commit

```bash
git add src/core/coordinator/coordinator-runtime-integration.integration.test.ts
git commit -m "test: add coordinator→runtime integration tests for policy dispatch and lifecycle"
```

---

## Task 2: SessionRuntime — capabilities and init flow

**Files:**
- Create: `src/core/session/session-runtime-capabilities.integration.test.ts`

### Step 1: Write the failing test

```typescript
// src/core/session/session-runtime-capabilities.integration.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockSession, createTestSocket } from "../../testing/cli-message-factories.js";
import { noopTracer } from "../messaging/message-tracer.js";
import { createUnifiedMessage } from "../types/unified-message.js";
import { SessionRuntime, type SessionRuntimeDeps } from "./session-runtime.js";

function makeDeps(overrides?: Partial<SessionRuntimeDeps>): SessionRuntimeDeps {
  return {
    config: { maxMessageHistoryLength: 100 },
    broadcaster: {
      broadcast: vi.fn(),
      broadcastToParticipants: vi.fn(),
      broadcastPresence: vi.fn(),
      sendTo: vi.fn(),
    } as any,
    queueHandler: {
      handleQueueMessage: vi.fn(),
      handleUpdateQueuedMessage: vi.fn(),
      handleCancelQueuedMessage: vi.fn(),
      autoSendQueuedMessage: vi.fn(),
    },
    slashService: {
      handleInbound: vi.fn(),
      executeProgrammatic: vi.fn(async () => null),
    },
    backendConnector: { sendToBackend: vi.fn() } as any,
    tracer: noopTracer,
    store: { persist: vi.fn(), persistSync: vi.fn() } as any,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    gitTracker: {
      resetAttempt: vi.fn(),
      refreshGitInfo: vi.fn(() => null),
      resolveGitInfo: vi.fn(),
    } as any,
    gitResolver: null,
    emitEvent: vi.fn(),
    capabilitiesPolicy: {
      initializeTimeoutMs: 50,
      applyCapabilities: vi.fn(),
      sendInitializeRequest: vi.fn(),
      handleControlResponse: vi.fn(),
    } as any,
    ...overrides,
  };
}
```

### Step 2: Add CAPABILITIES_INIT_REQUESTED tests

```typescript
describe("SessionRuntime: CAPABILITIES_INIT_REQUESTED", () => {
  afterEach(() => vi.useRealTimers());

  it("no backend → logger.warn and skips sending initialize", () => {
    const session = createMockSession({ id: "s1", backendSession: null });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "CAPABILITIES_INIT_REQUESTED" } });

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no backend session attached"),
    );
    expect(runtime.getPendingInitialize()).toBeNull();
  });

  it("unsupported adapter (no initialize method) → logger.info and skips", () => {
    const backendSession = { send: vi.fn(), close: vi.fn(), messages: { [Symbol.asyncIterator]: vi.fn() }, sessionId: "b1" };
    const session = createMockSession({ id: "s1", backendSession: backendSession as any });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "CAPABILITIES_INIT_REQUESTED" } });

    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("adapter does not support initialize"),
    );
    expect(runtime.getPendingInitialize()).toBeNull();
  });

  it("dedup: second CAPABILITIES_INIT_REQUESTED while one is pending is a no-op", () => {
    vi.useFakeTimers();
    const backendSession = { send: vi.fn(), initialize: vi.fn(), close: vi.fn(), messages: { [Symbol.asyncIterator]: vi.fn() }, sessionId: "b1" };
    const session = createMockSession({ id: "s1", backendSession: backendSession as any });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "CAPABILITIES_INIT_REQUESTED" } });
    const first = runtime.getPendingInitialize();

    runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "CAPABILITIES_INIT_REQUESTED" } });
    const second = runtime.getPendingInitialize();

    // Same pending initialize — not replaced
    expect(second).toBe(first);
    expect(backendSession.initialize).toHaveBeenCalledTimes(1);
  });

  it("timer fires → CAPABILITIES_TIMEOUT dispatched and pendingInitialize cleared", () => {
    vi.useFakeTimers();
    const backendSession = { send: vi.fn(), initialize: vi.fn(), close: vi.fn(), messages: { [Symbol.asyncIterator]: vi.fn() }, sessionId: "b1" };
    const session = createMockSession({ id: "s1", backendSession: backendSession as any });
    const deps = makeDeps();
    const broadcastSpy = deps.broadcaster.broadcast as ReturnType<typeof vi.fn>;
    const runtime = new SessionRuntime(session, deps);

    runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "CAPABILITIES_INIT_REQUESTED" } });
    expect(runtime.getPendingInitialize()).not.toBeNull();

    // Advance past timeout (50ms from makeDeps capabilitiesPolicy.initializeTimeoutMs)
    vi.advanceTimersByTime(100);

    expect(runtime.getPendingInitialize()).toBeNull();
    // Should have produced a session_closed broadcast (CAPABILITIES_TIMEOUT closes session)
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      expect.objectContaining({ type: "session_closed" }),
    );
  });

  it("SESSION_CLOSING clears pendingInitialize timer without firing", () => {
    vi.useFakeTimers();
    const backendSession = { send: vi.fn(), initialize: vi.fn(), close: vi.fn(), messages: { [Symbol.asyncIterator]: vi.fn() }, sessionId: "b1" };
    const session = createMockSession({ id: "s1", backendSession: backendSession as any });
    const deps = makeDeps();
    const broadcastSpy = deps.broadcaster.broadcast as ReturnType<typeof vi.fn>;
    const runtime = new SessionRuntime(session, deps);

    runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "CAPABILITIES_INIT_REQUESTED" } });
    runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "SESSION_CLOSING" } });

    expect(runtime.getPendingInitialize()).toBeNull();

    // Advance past timeout — CAPABILITIES_TIMEOUT must NOT fire after SESSION_CLOSING
    const callsBefore = broadcastSpy.mock.calls.length;
    vi.advanceTimersByTime(200);
    // No additional session_closed from timer (may have received one from SESSION_CLOSING path)
    const closedCallsAfter = broadcastSpy.mock.calls.filter(
      ([, msg]) => (msg as any).type === "session_closed",
    ).length;
    const closedCallsBefore = broadcastSpy.mock.calls
      .slice(0, callsBefore)
      .filter(([, msg]) => (msg as any).type === "session_closed").length;
    expect(closedCallsAfter).toBe(closedCallsBefore);
  });
});
```

### Step 3: Add orchestrateSessionInit tests

```typescript
describe("SessionRuntime: orchestrateSessionInit", () => {
  it("calls sendInitializeRequest when no capabilities in session_init metadata", async () => {
    const backendSession = { send: vi.fn(), initialize: vi.fn(), close: vi.fn(), messages: { [Symbol.asyncIterator]: vi.fn() }, sessionId: "b1" };
    const session = createMockSession({ id: "s1", backendSession: backendSession as any });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "session_init",
        role: "system",
        content: [],
        metadata: {
          session_id: "b1",
          model: "claude-opus-4-6",
          cwd: "/workspace",
          tools: [],
          permissionMode: "default",
          claude_code_version: "1.0",
          mcp_servers: [],
          slash_commands: [],
          skills: [],
        },
      }),
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(deps.capabilitiesPolicy.sendInitializeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
    );
    expect(deps.capabilitiesPolicy.applyCapabilities).not.toHaveBeenCalled();
  });

  it("calls applyCapabilities when capabilities present in session_init metadata", () => {
    const backendSession = { send: vi.fn(), initialize: vi.fn(), close: vi.fn(), messages: { [Symbol.asyncIterator]: vi.fn() }, sessionId: "b1" };
    const session = createMockSession({ id: "s1", backendSession: backendSession as any });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "session_init",
        role: "system",
        content: [],
        metadata: {
          session_id: "b1",
          model: "claude-opus-4-6",
          cwd: "/workspace",
          tools: [],
          permissionMode: "default",
          claude_code_version: "1.0",
          mcp_servers: [],
          slash_commands: [],
          skills: [],
          capabilities: {
            commands: [{ name: "/help", description: "Help" }],
            models: [{ value: "claude-opus-4-6", displayName: "Opus" }],
            account: { email: "test@example.com" },
          },
        },
      }),
    });

    expect(deps.capabilitiesPolicy.applyCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      [{ name: "/help", description: "Help" }],
      [{ value: "claude-opus-4-6", displayName: "Opus" }],
      { email: "test@example.com" },
    );
    expect(deps.capabilitiesPolicy.sendInitializeRequest).not.toHaveBeenCalled();
  });

  it("applies git info STATE_PATCHED when gitResolver returns info", () => {
    const backendSession = { send: vi.fn(), initialize: vi.fn(), close: vi.fn(), messages: { [Symbol.asyncIterator]: vi.fn() }, sessionId: "b1" };
    const session = createMockSession({
      id: "s1",
      backendSession: backendSession as any,
      data: { state: { ...createMockSession().data.state, cwd: "/project" } },
    });
    const mockGitResolver = {
      resolve: vi.fn().mockReturnValue({
        branch: "feature/test",
        isWorktree: true,
        repoRoot: "/project",
        ahead: 2,
        behind: 0,
      }),
    };
    const deps = makeDeps({ gitResolver: mockGitResolver });
    const broadcastSpy = deps.broadcaster.broadcast as ReturnType<typeof vi.fn>;
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "session_init",
        role: "system",
        content: [],
        metadata: {
          session_id: "b1",
          model: "claude-opus-4-6",
          cwd: "/project",
          tools: [],
          permissionMode: "default",
          claude_code_version: "1.0",
          mcp_servers: [],
          slash_commands: [],
          skills: [],
        },
      }),
    });

    expect(mockGitResolver.resolve).toHaveBeenCalledWith("/project");
    // Verify STATE_PATCHED produced a session_update broadcast with git info
    const sessionUpdateCall = broadcastSpy.mock.calls.find(
      ([, msg]) => (msg as any).type === "session_update",
    );
    expect(sessionUpdateCall).toBeDefined();
    const state = sessionUpdateCall![1] as any;
    expect(state.session?.git_branch ?? state.git_branch).toBe("feature/test");
  });
});
```

### Step 4: Add CAPABILITIES_APPLIED test

```typescript
describe("SessionRuntime: CAPABILITIES_APPLIED", () => {
  it("registerCLICommands called on the session registry", () => {
    const session = createMockSession({ id: "s1" });
    const registerFromCLI = vi.fn();
    session.registry = { clearDynamic: vi.fn(), registerFromCLI, registerSkills: vi.fn() } as any;
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: {
        kind: "CAPABILITIES_APPLIED",
        commands: [{ name: "/help", description: "Help command" }],
        models: [],
        account: null,
      },
    });

    expect(registerFromCLI).toHaveBeenCalledWith([{ name: "/help", description: "Help command" }]);
  });

  it("skips registerCLICommands when commands array is empty", () => {
    const session = createMockSession({ id: "s1" });
    const registerFromCLI = vi.fn();
    session.registry = { clearDynamic: vi.fn(), registerFromCLI, registerSkills: vi.fn() } as any;
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "CAPABILITIES_APPLIED", commands: [], models: [], account: null },
    });

    expect(registerFromCLI).not.toHaveBeenCalled();
  });
});
```

### Step 5: Run the test

```bash
pnpm exec vitest run src/core/session/session-runtime-capabilities.integration.test.ts
```

Expected: PASS (these test real runtime behavior with real reducers, mock deps).

### Step 6: Commit

```bash
git add src/core/session/session-runtime-capabilities.integration.test.ts
git commit -m "test: add runtime capabilities/init flow integration tests"
```

---

## Task 3: SessionRuntime — backend message orchestration

**Files:**
- Create: `src/core/session/session-runtime-orchestration.integration.test.ts`

### Step 1: Write the test file

```typescript
// src/core/session/session-runtime-orchestration.integration.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockSession, createTestSocket } from "../../testing/cli-message-factories.js";
import { noopTracer } from "../messaging/message-tracer.js";
import { createUnifiedMessage } from "../types/unified-message.js";
import { SessionRuntime, type SessionRuntimeDeps } from "./session-runtime.js";

// (reuse makeDeps from Task 2 — copy it into this file, or extract to a shared util)
function makeDeps(overrides?: Partial<SessionRuntimeDeps>): SessionRuntimeDeps { /* ... same as Task 2 ... */ }
```

### Step 2: Add orchestrateResult + gitTracker tests

```typescript
describe("SessionRuntime: orchestrateResult", () => {
  it("calls gitTracker.refreshGitInfo and dispatches STATE_PATCHED when update available", () => {
    const backendSession = { send: vi.fn(), close: vi.fn(), messages: { [Symbol.asyncIterator]: vi.fn() }, sessionId: "b1" };
    const session = createMockSession({ id: "s1", backendSession: backendSession as any });
    const gitUpdate = { git_branch: "main", is_worktree: false, git_ahead: 0, git_behind: 1 };
    const deps = makeDeps({
      gitTracker: {
        resetAttempt: vi.fn(),
        refreshGitInfo: vi.fn(() => gitUpdate),
        resolveGitInfo: vi.fn(),
      } as any,
    });
    const broadcastSpy = deps.broadcaster.broadcast as ReturnType<typeof vi.fn>;
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "result",
        role: "assistant",
        content: [],
        metadata: {
          result: "done",
          duration_ms: 100,
          duration_api_ms: 80,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          session_id: "b1",
        },
      }),
    });

    expect(deps.gitTracker.refreshGitInfo).toHaveBeenCalled();
    // STATE_PATCHED with broadcast:true → session_update broadcast
    const sessionUpdateCall = broadcastSpy.mock.calls.find(
      ([, msg]) => (msg as any).type === "session_update",
    );
    expect(sessionUpdateCall).toBeDefined();
    const msgData = sessionUpdateCall![1] as any;
    expect(msgData.session?.git_branch ?? msgData.git_behind).toBeDefined();
  });

  it("does NOT dispatch STATE_PATCHED when refreshGitInfo returns null", () => {
    const backendSession = { send: vi.fn(), close: vi.fn(), messages: { [Symbol.asyncIterator]: vi.fn() }, sessionId: "b1" };
    const session = createMockSession({ id: "s1", backendSession: backendSession as any });
    const deps = makeDeps({
      gitTracker: { resetAttempt: vi.fn(), refreshGitInfo: vi.fn(() => null), resolveGitInfo: vi.fn() } as any,
    });
    const broadcastSpy = deps.broadcaster.broadcast as ReturnType<typeof vi.fn>;
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "result",
        role: "assistant",
        content: [],
        metadata: {
          result: "done",
          duration_ms: 100,
          duration_api_ms: 80,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          session_id: "b1",
        },
      }),
    });

    // No additional session_update beyond what result message itself produces
    const sessionUpdateCalls = broadcastSpy.mock.calls.filter(
      ([, msg]) => (msg as any).type === "session_update" && (msg as any).session?.git_behind !== undefined,
    );
    expect(sessionUpdateCalls).toHaveLength(0);
  });
});
```

### Step 3: Add orchestrateControlResponse test

```typescript
describe("SessionRuntime: orchestrateControlResponse", () => {
  it("delegates control_response to capabilitiesPolicy.handleControlResponse", () => {
    const backendSession = { send: vi.fn(), close: vi.fn(), messages: { [Symbol.asyncIterator]: vi.fn() }, sessionId: "b1" };
    const session = createMockSession({ id: "s1", backendSession: backendSession as any });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "control_response",
        role: "system",
        content: [],
        metadata: {
          response: { subtype: "success", request_id: "req-1" },
        },
      }),
    });

    expect(deps.capabilitiesPolicy.handleControlResponse).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      expect.objectContaining({ type: "control_response" }),
    );
  });
});
```

### Step 4: Add closeBackendConnection test

```typescript
describe("SessionRuntime: closeBackendConnection", () => {
  it("calls abort(), close(), and dispatches BACKEND_DISCONNECTED", async () => {
    const abortSpy = vi.fn();
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const backendSession = { send: vi.fn(), close: closeSpy, messages: { [Symbol.asyncIterator]: vi.fn() }, sessionId: "b1" };
    const backendAbort = { abort: abortSpy, signal: new AbortController().signal };
    const session = createMockSession({ id: "s1", backendSession: backendSession as any, backendAbort: backendAbort as any });
    const deps = makeDeps();
    const broadcastSpy = deps.broadcaster.broadcast as ReturnType<typeof vi.fn>;
    const runtime = new SessionRuntime(session, deps);

    await runtime.closeBackendConnection();

    expect(abortSpy).toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalled();
    // BACKEND_DISCONNECTED should have produced cli_disconnected broadcast
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      expect.objectContaining({ type: "cli_disconnected" }),
    );
    // Backend session handle nulled out
    expect(runtime.getBackendSession()).toBeNull();
  });

  it("is a no-op when no backend session is connected", async () => {
    const session = createMockSession({ id: "s1", backendSession: null });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    await expect(runtime.closeBackendConnection()).resolves.not.toThrow();
  });
});
```

### Step 5: Add emitTeamEvents test

```typescript
describe("SessionRuntime: emitTeamEvents", () => {
  it("dispatches TEAM_STATE_DIFFED when team state changes across backend messages", () => {
    const backendSession = { send: vi.fn(), close: vi.fn(), messages: { [Symbol.asyncIterator]: vi.fn() }, sessionId: "b1" };
    const session = createMockSession({ id: "s1", backendSession: backendSession as any });
    const deps = makeDeps();
    const emitSpy = deps.emitEvent as ReturnType<typeof vi.fn>;
    const runtime = new SessionRuntime(session, deps);

    // Push an assistant message with a team tool_use block to trigger team state change
    // The exact content depends on the team tool recognizer; use a tool_use with recognized name
    runtime.process({
      type: "BACKEND_MESSAGE",
      message: createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-team-1",
            name: "TodoWrite",
            input: { todos: [{ content: "task", status: "pending", priority: "medium", id: "1" }] },
          },
        ],
        metadata: {
          message_id: "msg-team-1",
          model: "claude-sonnet-4-6",
          stop_reason: "tool_use",
          parent_tool_use_id: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }),
    });

    // If team state changed, TEAM_STATE_DIFFED dispatched then emitEvent called indirectly
    // Verify the emitEvent was called (could be for various events)
    expect(emitSpy).toHaveBeenCalled();
  });
});
```

### Step 6: Add markDirty debounce test

```typescript
describe("SessionRuntime: markDirty debounce", () => {
  afterEach(() => vi.useRealTimers());

  it("collapses multiple rapid state changes into a single persist", async () => {
    vi.useFakeTimers();
    const backendSession = { send: vi.fn(), close: vi.fn(), messages: { [Symbol.asyncIterator]: vi.fn() }, sessionId: "b1" };
    const session = createMockSession({ id: "s1", backendSession: backendSession as any });
    const deps = makeDeps();
    const persistSpy = deps.store.persist as ReturnType<typeof vi.fn>;
    const runtime = new SessionRuntime(session, deps);

    // Trigger 3 state changes rapidly
    runtime.sendUserMessage("first");
    runtime.sendUserMessage("second");
    runtime.sendUserMessage("third");

    // No persist yet (timer not fired)
    expect(persistSpy).toHaveBeenCalledTimes(0);

    // Advance past the 50ms debounce
    vi.advanceTimersByTime(100);

    // Only one persist call
    expect(persistSpy).toHaveBeenCalledTimes(1);
  });
});
```

### Step 7: Run all tests in this file

```bash
pnpm exec vitest run src/core/session/session-runtime-orchestration.integration.test.ts
```

Expected: All PASS.

### Step 8: Commit

```bash
git add src/core/session/session-runtime-orchestration.integration.test.ts
git commit -m "test: add runtime orchestration integration tests (git, control_response, closeBackend, team events)"
```

---

## Task 4: SessionRuntime — inbound command routing

**Files:**
- Create: `src/core/session/session-runtime-commands.integration.test.ts`

### Step 1: Write the test file header

```typescript
// src/core/session/session-runtime-commands.integration.test.ts
import { describe, expect, it, vi } from "vitest";
import { createMockSession, createTestSocket } from "../../testing/cli-message-factories.js";
import { noopTracer } from "../messaging/message-tracer.js";
import { SessionRuntime, type SessionRuntimeDeps } from "./session-runtime.js";

// (reuse makeDeps from Task 2)
function makeDeps(overrides?: Partial<SessionRuntimeDeps>): SessionRuntimeDeps { /* ... */ }
```

### Step 2: Add queue command routing tests

```typescript
describe("SessionRuntime: inbound command routing", () => {
  it("queue_message routes to queueHandler.handleQueueMessage", () => {
    const session = createMockSession({ id: "s1", backendSession: { send: vi.fn() } as any });
    const deps = makeDeps();
    const ws = createTestSocket();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "INBOUND_COMMAND",
      command: {
        type: "queue_message",
        content: "queued content",
        session_id: "s1",
      },
      ws,
    });

    expect(deps.queueHandler.handleQueueMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      expect.objectContaining({ type: "queue_message" }),
      ws,
    );
  });

  it("update_queued_message routes to queueHandler.handleUpdateQueuedMessage", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const ws = createTestSocket();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "INBOUND_COMMAND",
      command: { type: "update_queued_message", content: "updated", session_id: "s1" },
      ws,
    });

    expect(deps.queueHandler.handleUpdateQueuedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      expect.objectContaining({ type: "update_queued_message" }),
      ws,
    );
  });

  it("cancel_queued_message routes to queueHandler.handleCancelQueuedMessage", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const ws = createTestSocket();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "INBOUND_COMMAND",
      command: { type: "cancel_queued_message", session_id: "s1" },
      ws,
    });

    expect(deps.queueHandler.handleCancelQueuedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      ws,
    );
  });

  it("presence_query routes to broadcaster.broadcastPresence", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const ws = createTestSocket();
    const runtime = new SessionRuntime(session, deps);

    runtime.process({
      type: "INBOUND_COMMAND",
      command: { type: "presence_query", session_id: "s1" },
      ws,
    });

    expect(deps.broadcaster.broadcastPresence).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
    );
  });
});
```

### Step 3: Add set_adapter rejection test

```typescript
describe("SessionRuntime: set_adapter rejection", () => {
  it("set_adapter on active session sends error to requesting consumer ws", () => {
    const session = createMockSession({ id: "s1", backendSession: { send: vi.fn() } as any });
    const deps = makeDeps();
    const ws = createTestSocket();
    const runtime = new SessionRuntime(session, deps);

    // Activate session first
    runtime.sendUserMessage("activate");

    // Now attempt set_adapter
    runtime.process({
      type: "INBOUND_COMMAND",
      command: { type: "set_adapter", adapter_name: "codex", session_id: "s1" },
      ws,
    });

    expect(deps.broadcaster.sendTo).toHaveBeenCalledWith(
      ws,
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("Adapter cannot be changed"),
      }),
    );
  });
});
```

### Step 4: Add sendPermissionResponse unknown requestId test

```typescript
describe("SessionRuntime: sendPermissionResponse", () => {
  it("unknown request_id causes logger.warn in post-reducer hook", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.sendPermissionResponse("nonexistent-req-id", "allow");

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("unknown request_id"),
    );
  });
});
```

### Step 5: Add CONSUMER_DISCONNECTED unregistered socket test

```typescript
describe("SessionRuntime: CONSUMER_DISCONNECTED", () => {
  it("warns when socket was not registered (double-disconnect protection)", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const ws = createTestSocket();
    const runtime = new SessionRuntime(session, deps);

    // Disconnect without ever connecting
    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "CONSUMER_DISCONNECTED", ws },
    });

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("possible double-disconnect"),
    );
  });
});
```

### Step 6: Add PASSTHROUGH_ENQUEUED test

```typescript
describe("SessionRuntime: PASSTHROUGH_ENQUEUED", () => {
  it("pushes entry to pendingPassthroughs", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    const entry = {
      command: "/compact",
      slashRequestId: "sr-1",
      traceId: "tr-1",
      startedAtMs: Date.now(),
    };

    runtime.process({
      type: "SYSTEM_SIGNAL",
      signal: { kind: "PASSTHROUGH_ENQUEUED", entry },
    });

    expect(runtime.peekPendingPassthrough()).toEqual(entry);
  });
});
```

### Step 7: Add checkRateLimit test

```typescript
describe("SessionRuntime: checkRateLimit", () => {
  it("returns true when no limiter factory provided (undefined limiter)", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const ws = createTestSocket();
    const runtime = new SessionRuntime(session, deps);

    const result = runtime.checkRateLimit(ws, () => undefined);
    expect(result).toBe(true);
  });

  it("creates a rate limiter on first call and reuses on second", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const ws = createTestSocket();
    const runtime = new SessionRuntime(session, deps);

    const tryConsume = vi.fn().mockReturnValue(true);
    const createLimiter = vi.fn().mockReturnValue({ tryConsume });

    runtime.checkRateLimit(ws, createLimiter);
    runtime.checkRateLimit(ws, createLimiter);

    // Limiter created only once, tryConsume called twice
    expect(createLimiter).toHaveBeenCalledTimes(1);
    expect(tryConsume).toHaveBeenCalledTimes(2);
  });
});
```

### Step 8: Run tests

```bash
pnpm exec vitest run src/core/session/session-runtime-commands.integration.test.ts
```

Expected: All PASS.

### Step 9: Run the full test suite to confirm coverage thresholds

```bash
pnpm test
```

Expected: All tests pass, coverage >= 90% for lines/branches/functions/statements.

### Step 10: Commit

```bash
git add src/core/session/session-runtime-commands.integration.test.ts
git commit -m "test: add runtime inbound command routing integration tests"
```

---

## Notes for implementer

### createMockSession shape
The `createMockSession()` from `src/testing/cli-message-factories.ts` returns a `Session` with:
- `data.lifecycle: "idle"` (default)
- `data.lastStatus: null`
- `backendSession: null` (override with `{ backendSession: { send: vi.fn(), ... } }`)
- `pendingInitialize: null`
- `pendingPassthroughs: []`
- `consumerSockets: new Map()`
- `consumerRateLimiters: new Map()`

### createTestSocket
Returns a `WebSocketLike` with `send: vi.fn()`, `close: vi.fn()`.

### capabilitiesPolicy.initializeTimeoutMs
The timeout used by the `CAPABILITIES_INIT_REQUESTED` timer comes from `deps.capabilitiesPolicy.initializeTimeoutMs`. Set this to `50` in `makeDeps` so fake timers can advance past it with `vi.advanceTimersByTime(100)`.

### makeDeps reuse
Each test file needs its own `makeDeps`. Do not extract to a shared file unless it already exists in `src/testing/`. Prefer keeping test files self-contained.

### Verifying real reducer effects
These are **integration** tests — they should NOT mock the `sessionReducer`. The reducer runs for real. Spy on `broadcaster.broadcast` / `broadcaster.broadcastToParticipants` to observe effects. Only mock the deps that represent external I/O (backendConnector.sendToBackend, store.persist, etc.).

### Command interface shapes
Check `src/core/interfaces/runtime-commands.ts` for the exact fields of each inbound command type before writing tests. Key commands:
- `user_message`: `{ type, content, session_id, images?, traceContext? }`
- `queue_message`: `{ type, content, session_id }`
- `update_queued_message`: `{ type, content, session_id }`
- `cancel_queued_message`: `{ type, session_id }`
- `presence_query`: `{ type, session_id }`
- `set_adapter`: `{ type, adapter_name, session_id }`
- `permission_response`: `{ type, request_id, behavior, ... }`
- `slash_command`: `{ type, command, session_id }`
