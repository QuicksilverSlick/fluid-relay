import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("SessionRuntime orchestration integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── orchestrateResult + git patch ────────────────────────────────────────

  describe("orchestrateResult with git info", () => {
    it("broadcasts session_update with git fields when refreshGitInfo returns a patch", () => {
      const gitPatch = {
        git_branch: "feat/new",
        is_worktree: true,
        git_ahead: 2,
        git_behind: 0,
      };
      const deps = makeDeps({
        gitTracker: {
          resetAttempt: vi.fn(),
          refreshGitInfo: vi.fn(() => gitPatch),
          resolveGitInfo: vi.fn(),
        } as any,
      });
      const session = createMockSession({ id: "s1" });
      const runtime = new SessionRuntime(session, deps);

      runtime.process({
        type: "BACKEND_MESSAGE",
        message: createUnifiedMessage({
          type: "result",
          role: "assistant",
          metadata: { num_turns: 1, is_error: false },
        }),
      });

      // refreshGitInfo was called with the session
      expect(deps.gitTracker.refreshGitInfo).toHaveBeenCalledWith(
        expect.objectContaining({ id: "s1" }),
      );

      // A session_update broadcast should contain the git fields
      const broadcastCalls = (deps.broadcaster.broadcast as ReturnType<typeof vi.fn>).mock.calls;
      const sessionUpdates = broadcastCalls.filter(
        ([, msg]: [unknown, any]) => msg.type === "session_update",
      );
      const gitUpdate = sessionUpdates.find(
        ([, msg]: [unknown, any]) => msg.session?.git_branch === "feat/new",
      );
      expect(gitUpdate).toBeDefined();
      expect(gitUpdate![1].session).toEqual(
        expect.objectContaining({
          git_branch: "feat/new",
          is_worktree: true,
          git_ahead: 2,
          git_behind: 0,
        }),
      );
    });

    it("does not broadcast git session_update when refreshGitInfo returns null", () => {
      const deps = makeDeps({
        gitTracker: {
          resetAttempt: vi.fn(),
          refreshGitInfo: vi.fn(() => null),
          resolveGitInfo: vi.fn(),
        } as any,
      });
      const session = createMockSession({ id: "s1" });
      const runtime = new SessionRuntime(session, deps);

      runtime.process({
        type: "BACKEND_MESSAGE",
        message: createUnifiedMessage({
          type: "result",
          role: "assistant",
          metadata: { num_turns: 1, is_error: false },
        }),
      });

      expect(deps.gitTracker.refreshGitInfo).toHaveBeenCalled();

      // No session_update with git fields should be present
      const broadcastCalls = (deps.broadcaster.broadcast as ReturnType<typeof vi.fn>).mock.calls;
      const gitUpdates = broadcastCalls.filter(
        ([, msg]: [unknown, any]) =>
          msg.type === "session_update" && msg.session?.git_branch !== undefined,
      );
      expect(gitUpdates).toHaveLength(0);
    });
  });

  // ── orchestrateControlResponse ───────────────────────────────────────────

  describe("orchestrateControlResponse", () => {
    it("delegates to capabilitiesPolicy.handleControlResponse with session and message", () => {
      const deps = makeDeps();
      const session = createMockSession({ id: "s1" });
      const runtime = new SessionRuntime(session, deps);

      const controlMsg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        content: [],
        metadata: {
          response: { subtype: "success", request_id: "req-1" },
        },
      });

      runtime.process({
        type: "BACKEND_MESSAGE",
        message: controlMsg,
      });

      expect(deps.capabilitiesPolicy.handleControlResponse).toHaveBeenCalledWith(
        expect.objectContaining({ id: "s1" }),
        controlMsg,
      );
    });
  });

  // ── closeBackendConnection ───────────────────────────────────────────────

  describe("closeBackendConnection", () => {
    it("aborts, closes backend session, and dispatches BACKEND_DISCONNECTED", async () => {
      const abortSpy = vi.fn();
      const closeSpy = vi.fn().mockResolvedValue(undefined);
      const backendSession = {
        send: vi.fn(),
        close: closeSpy,
        get messages() {
          return {
            [Symbol.asyncIterator]() {
              return {
                next() {
                  return new Promise(() => {});
                },
              };
            },
          };
        },
        sessionId: "b1",
      };
      const backendAbort = { abort: abortSpy, signal: new AbortController().signal };
      const session = createMockSession({
        id: "s1",
        backendSession: backendSession as any,
        backendAbort: backendAbort as any,
      });
      const deps = makeDeps();
      const runtime = new SessionRuntime(session, deps);

      expect(runtime.getBackendSession()).not.toBeNull();

      await runtime.closeBackendConnection();

      // abort and close were called
      expect(abortSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);

      // BACKEND_DISCONNECTED was dispatched → cli_disconnected broadcast
      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ id: "s1" }),
        expect.objectContaining({ type: "cli_disconnected" }),
      );

      // Backend session is now null
      expect(runtime.getBackendSession()).toBeNull();
    });

    it("is a no-op when backendSession is already null", async () => {
      const session = createMockSession({ id: "s1" });
      const deps = makeDeps();
      const runtime = new SessionRuntime(session, deps);

      // Should not throw
      await runtime.closeBackendConnection();

      expect(deps.broadcaster.broadcast).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: "cli_disconnected" }),
      );
      expect(runtime.getBackendSession()).toBeNull();
    });
  });

  // ── markDirty debounce ───────────────────────────────────────────────────

  describe("markDirty debounce", () => {
    it("collapses multiple rapid state changes into a single debounced persist call", () => {
      vi.useFakeTimers();
      try {
        const session = createMockSession({ id: "s1" });
        const deps = makeDeps();
        const runtime = new SessionRuntime(session, deps);

        // Use assistant backend messages — they trigger markDirty (state change)
        // but do NOT produce PERSIST_NOW effects, so persist is only called
        // via the debounce timer.
        runtime.process({
          type: "BACKEND_MESSAGE",
          message: createUnifiedMessage({
            type: "assistant",
            role: "assistant",
            content: [{ type: "text", text: "msg1" }],
            metadata: { message_id: "m1" },
          }),
        });
        runtime.process({
          type: "BACKEND_MESSAGE",
          message: createUnifiedMessage({
            type: "assistant",
            role: "assistant",
            content: [{ type: "text", text: "msg2" }],
            metadata: { message_id: "m2" },
          }),
        });

        // persist should NOT have been called yet (debounce is 50ms)
        expect(deps.store.persist).toHaveBeenCalledTimes(0);

        // Advance past the 50ms debounce window
        vi.advanceTimersByTime(100);

        // Now persist should have been called exactly once (collapsed)
        expect(deps.store.persist).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
