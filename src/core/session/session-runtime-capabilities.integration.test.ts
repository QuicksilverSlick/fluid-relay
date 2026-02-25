import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockSession } from "../../testing/cli-message-factories.js";
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

/** Backend session mock WITH initialize support. */
function createBackendWithInit() {
  return {
    send: vi.fn(),
    initialize: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    get messages() {
      return {
        [Symbol.asyncIterator]() {
          return { next: () => new Promise(() => {}) };
        },
      };
    },
    sessionId: "b1",
  };
}

/** Backend session mock WITHOUT initialize support. */
function createBackendNoInit() {
  return {
    send: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    get messages() {
      return {
        [Symbol.asyncIterator]() {
          return { next: () => new Promise(() => {}) };
        },
      };
    },
    sessionId: "b1",
  };
}

describe("SessionRuntime — capabilities & init flow", () => {
  // ── CAPABILITIES_INIT_REQUESTED ─────────────────────────────────────────

  describe("CAPABILITIES_INIT_REQUESTED", () => {
    it("warns and skips when no backend session is attached", () => {
      const session = createMockSession({ id: "s1" }); // no backendSession
      const deps = makeDeps();
      const runtime = new SessionRuntime(session, deps);

      runtime.process({
        type: "SYSTEM_SIGNAL",
        signal: { kind: "CAPABILITIES_INIT_REQUESTED" },
      });

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("no backend session attached"),
      );
      expect(runtime.getPendingInitialize()).toBeNull();
    });

    it("logs info and skips when adapter does not support initialize", () => {
      const backendSession = createBackendNoInit();
      const session = createMockSession({
        id: "s1",
        backendSession: backendSession as any,
      });
      const deps = makeDeps();
      const runtime = new SessionRuntime(session, deps);

      runtime.process({
        type: "SYSTEM_SIGNAL",
        signal: { kind: "CAPABILITIES_INIT_REQUESTED" },
      });

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("adapter does not support initialize"),
      );
      expect(runtime.getPendingInitialize()).toBeNull();
    });

    it("deduplicates — second signal reuses existing pendingInitialize", () => {
      const backendSession = createBackendWithInit();
      const session = createMockSession({
        id: "s1",
        backendSession: backendSession as any,
      });
      const deps = makeDeps();
      const runtime = new SessionRuntime(session, deps);

      runtime.process({
        type: "SYSTEM_SIGNAL",
        signal: { kind: "CAPABILITIES_INIT_REQUESTED" },
      });
      const first = runtime.getPendingInitialize();
      expect(first).not.toBeNull();

      runtime.process({
        type: "SYSTEM_SIGNAL",
        signal: { kind: "CAPABILITIES_INIT_REQUESTED" },
      });
      const second = runtime.getPendingInitialize();

      expect(second).toBe(first); // exact same object — not replaced
      expect(backendSession.initialize).toHaveBeenCalledTimes(1);
    });

    describe("timer behavior", () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it("clears pendingInitialize and emits capabilities:timeout on timeout", () => {
        const backendSession = createBackendWithInit();
        const session = createMockSession({
          id: "s1",
          backendSession: backendSession as any,
        });
        const deps = makeDeps();
        const runtime = new SessionRuntime(session, deps);

        runtime.process({
          type: "SYSTEM_SIGNAL",
          signal: { kind: "CAPABILITIES_INIT_REQUESTED" },
        });
        expect(runtime.getPendingInitialize()).not.toBeNull();

        // Advance past the 50ms timeout
        vi.advanceTimersByTime(60);

        expect(runtime.getPendingInitialize()).toBeNull();
        // CAPABILITIES_TIMEOUT triggers capabilities:timeout event via EMIT_EVENT effect
        expect(deps.emitEvent).toHaveBeenCalledWith(
          "capabilities:timeout",
          expect.objectContaining({ sessionId: "s1" }),
        );
      });

      it("SESSION_CLOSING clears timer — timeout does not fire afterward", () => {
        const backendSession = createBackendWithInit();
        const session = createMockSession({
          id: "s1",
          backendSession: backendSession as any,
        });
        const deps = makeDeps();
        const runtime = new SessionRuntime(session, deps);

        runtime.process({
          type: "SYSTEM_SIGNAL",
          signal: { kind: "CAPABILITIES_INIT_REQUESTED" },
        });
        expect(runtime.getPendingInitialize()).not.toBeNull();

        // Fire SESSION_CLOSING — should clear the timer
        runtime.process({
          type: "SYSTEM_SIGNAL",
          signal: { kind: "SESSION_CLOSING" },
        });
        expect(runtime.getPendingInitialize()).toBeNull();

        // Reset mock call counts to check no session_closed from the timer
        (deps.broadcaster.broadcast as ReturnType<typeof vi.fn>).mockClear();

        // Advance past timeout — timer should NOT fire
        vi.advanceTimersByTime(100);

        // No broadcast of session_closed from the cleared timer
        const sessionClosedCalls = (
          deps.broadcaster.broadcast as ReturnType<typeof vi.fn>
        ).mock.calls.filter(
          ([, msg]: [unknown, { type: string }]) => msg?.type === "session_closed",
        );
        expect(sessionClosedCalls).toHaveLength(0);
      });
    });
  });

  // ── orchestrateSessionInit ──────────────────────────────────────────────

  describe("orchestrateSessionInit", () => {
    it("calls sendInitializeRequest when metadata has no capabilities", () => {
      const backendSession = createBackendWithInit();
      const session = createMockSession({
        id: "s1",
        backendSession: backendSession as any,
        data: {
          lifecycle: "idle",
          state: {
            ...createMockSession().data.state,
            cwd: "",
          },
        },
      });
      const deps = makeDeps();
      const runtime = new SessionRuntime(session, deps);

      const initMsg = createUnifiedMessage({
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
      });

      runtime.process({ type: "BACKEND_MESSAGE", message: initMsg });

      expect(deps.capabilitiesPolicy.sendInitializeRequest).toHaveBeenCalledWith(
        expect.objectContaining({ id: "s1" }),
      );
      expect(deps.capabilitiesPolicy.applyCapabilities).not.toHaveBeenCalled();
    });

    it("calls applyCapabilities when metadata includes capabilities", () => {
      const backendSession = createBackendWithInit();
      const session = createMockSession({
        id: "s1",
        backendSession: backendSession as any,
        data: {
          lifecycle: "idle",
          state: {
            ...createMockSession().data.state,
            cwd: "",
          },
        },
      });
      const deps = makeDeps();
      const runtime = new SessionRuntime(session, deps);

      const capabilities = {
        commands: [{ name: "/help", description: "Show help" }],
        models: [{ id: "claude-opus-4-6", name: "Opus" }],
        account: { plan: "pro" },
      };

      const initMsg = createUnifiedMessage({
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
          capabilities,
        },
      });

      runtime.process({ type: "BACKEND_MESSAGE", message: initMsg });

      expect(deps.capabilitiesPolicy.applyCapabilities).toHaveBeenCalledWith(
        expect.objectContaining({ id: "s1" }),
        capabilities.commands,
        capabilities.models,
        capabilities.account,
      );
      expect(deps.capabilitiesPolicy.sendInitializeRequest).not.toHaveBeenCalled();
    });

    it("resolves git info and broadcasts session_update when gitResolver is present", () => {
      const backendSession = createBackendWithInit();
      const session = createMockSession({
        id: "s1",
        backendSession: backendSession as any,
        data: {
          lifecycle: "idle",
          state: {
            ...createMockSession().data.state,
            cwd: "/project",
          },
        },
      });

      const gitResolver = {
        resolve: vi.fn(() => ({
          branch: "main",
          isWorktree: false,
          repoRoot: "/project",
          ahead: 0,
          behind: 0,
        })),
      };
      const deps = makeDeps({ gitResolver: gitResolver as any });
      const runtime = new SessionRuntime(session, deps);

      const initMsg = createUnifiedMessage({
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
      });

      runtime.process({ type: "BACKEND_MESSAGE", message: initMsg });

      expect(gitResolver.resolve).toHaveBeenCalledWith("/project");
      // session_update broadcast happens via STATE_PATCHED signal
      expect(deps.broadcaster.broadcast).toHaveBeenCalled();
    });
  });

  // ── CAPABILITIES_APPLIED ────────────────────────────────────────────────

  describe("CAPABILITIES_APPLIED", () => {
    it("registers commands when commands array is non-empty", () => {
      const session = createMockSession({ id: "s1" });
      const registerFromCLI = vi.fn();
      session.registry = { ...session.registry, registerFromCLI } as any;
      const deps = makeDeps();
      const runtime = new SessionRuntime(session, deps);

      const commands = [
        { name: "/help", description: "Show help" },
        { name: "/clear", description: "Clear history" },
      ];
      runtime.process({
        type: "SYSTEM_SIGNAL",
        signal: {
          kind: "CAPABILITIES_APPLIED",
          commands,
          models: [],
          account: null,
        },
      });

      expect(registerFromCLI).toHaveBeenCalledWith(commands);
    });

    it("does not call registerFromCLI when commands array is empty", () => {
      const session = createMockSession({ id: "s1" });
      const registerFromCLI = vi.fn();
      session.registry = { ...session.registry, registerFromCLI } as any;
      const deps = makeDeps();
      const runtime = new SessionRuntime(session, deps);

      runtime.process({
        type: "SYSTEM_SIGNAL",
        signal: {
          kind: "CAPABILITIES_APPLIED",
          commands: [],
          models: [],
          account: null,
        },
      });

      // registerFromCLI is called once during constructor hydration (clearDynamic path),
      // but should NOT be called again for empty commands
      registerFromCLI.mockClear();
      runtime.process({
        type: "SYSTEM_SIGNAL",
        signal: {
          kind: "CAPABILITIES_APPLIED",
          commands: [],
          models: [],
          account: null,
        },
      });
      expect(registerFromCLI).not.toHaveBeenCalled();
    });
  });
});
