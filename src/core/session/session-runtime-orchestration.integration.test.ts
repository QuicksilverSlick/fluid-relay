import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockSession } from "../../testing/cli-message-factories.js";
import { makeRuntimeDeps } from "../../testing/session-runtime-test-helpers.js";
import { createUnifiedMessage } from "../types/unified-message.js";
import { SessionRuntime } from "./session-runtime.js";

function makeResultMessage() {
  return createUnifiedMessage({
    type: "result",
    role: "assistant",
    metadata: { num_turns: 1, is_error: false },
  });
}

describe("SessionRuntime orchestration integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("orchestrateResult with git info", () => {
    it("broadcasts session_update with git fields when refreshGitInfo returns a patch", () => {
      const gitPatch = {
        git_branch: "feat/new",
        is_worktree: true,
        git_ahead: 2,
        git_behind: 0,
      };
      const deps = makeRuntimeDeps({
        gitTracker: {
          resetAttempt: vi.fn(),
          refreshGitInfo: vi.fn(() => gitPatch),
          resolveGitInfo: vi.fn(),
        } as any,
      });
      const runtime = new SessionRuntime(createMockSession({ id: "s1" }), deps);

      runtime.process({ type: "BACKEND_MESSAGE", message: makeResultMessage() });

      expect(deps.gitTracker.refreshGitInfo).toHaveBeenCalledWith(
        expect.objectContaining({ id: "s1" }),
      );

      const broadcastCalls = (deps.broadcaster.broadcast as ReturnType<typeof vi.fn>).mock.calls;
      const gitUpdateCall = broadcastCalls.find(
        ([, msg]: [unknown, any]) =>
          msg.type === "session_update" && msg.session?.git_branch === "feat/new",
      );

      expect(gitUpdateCall).toBeDefined();
      expect(gitUpdateCall![1].session).toEqual(
        expect.objectContaining({
          git_branch: "feat/new",
          is_worktree: true,
          git_ahead: 2,
          git_behind: 0,
        }),
      );
    });

    it("does not broadcast git session_update when refreshGitInfo returns null", () => {
      const deps = makeRuntimeDeps();
      const runtime = new SessionRuntime(createMockSession({ id: "s1" }), deps);

      runtime.process({ type: "BACKEND_MESSAGE", message: makeResultMessage() });

      expect(deps.gitTracker.refreshGitInfo).toHaveBeenCalled();

      const broadcastCalls = (deps.broadcaster.broadcast as ReturnType<typeof vi.fn>).mock.calls;
      const gitUpdates = broadcastCalls.filter(
        ([, msg]: [unknown, any]) =>
          msg.type === "session_update" && msg.session?.git_branch !== undefined,
      );
      expect(gitUpdates).toHaveLength(0);
    });
  });

  describe("orchestrateControlResponse", () => {
    it("delegates to capabilitiesPolicy.handleControlResponse", () => {
      const deps = makeRuntimeDeps();
      const runtime = new SessionRuntime(createMockSession({ id: "s1" }), deps);

      const controlMsg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        content: [],
        metadata: {
          response: { subtype: "success", request_id: "req-1" },
        },
      });

      runtime.process({ type: "BACKEND_MESSAGE", message: controlMsg });

      expect(deps.capabilitiesPolicy.handleControlResponse).toHaveBeenCalledWith(
        expect.objectContaining({ id: "s1" }),
        controlMsg,
      );
    });
  });

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
              return { next: () => new Promise(() => {}) };
            },
          };
        },
        sessionId: "b1",
      };
      const session = createMockSession({
        id: "s1",
        backendSession: backendSession as any,
        backendAbort: { abort: abortSpy, signal: new AbortController().signal } as any,
      });
      const deps = makeRuntimeDeps();
      const runtime = new SessionRuntime(session, deps);

      expect(runtime.getBackendSession()).not.toBeNull();
      await runtime.closeBackendConnection();

      expect(abortSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ id: "s1" }),
        expect.objectContaining({ type: "cli_disconnected" }),
      );
      expect(runtime.getBackendSession()).toBeNull();
    });

    it("is a no-op when backendSession is already null", async () => {
      const deps = makeRuntimeDeps();
      const runtime = new SessionRuntime(createMockSession({ id: "s1" }), deps);

      await runtime.closeBackendConnection();

      expect(deps.broadcaster.broadcast).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: "cli_disconnected" }),
      );
      expect(runtime.getBackendSession()).toBeNull();
    });
  });

  describe("markDirty debounce", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("collapses multiple rapid state changes into a single debounced persist call", () => {
      const deps = makeRuntimeDeps();
      const runtime = new SessionRuntime(createMockSession({ id: "s1" }), deps);

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

      expect(deps.store.persist).toHaveBeenCalledTimes(0);

      vi.advanceTimersByTime(100);

      expect(deps.store.persist).toHaveBeenCalledTimes(1);
    });
  });
});
