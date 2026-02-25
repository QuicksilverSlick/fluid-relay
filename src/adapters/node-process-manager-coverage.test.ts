/**
 * Coverage tests for the uncovered branches in node-process-manager.ts.
 *
 * Specifically targets the internal `waitForProcessGroupDead` helper:
 *   - Lines 22-25: deadline reached while group is still alive (no ESRCH)
 *   - Lines 31-38: EPERM branch — group alive but unpermissioned, keep polling
 *   - Lines 39-41: unexpected error code — resolve immediately to avoid infinite loop
 *
 * Strategy: we cannot import `waitForProcessGroupDead` directly (it is not
 * exported), so we exercise it indirectly through `NodeProcessManager.spawn()`.
 * The `exited` promise on the handle chains through `waitForProcessGroupDead`
 * after the child's "exit" event fires.  We:
 *   1. Spawn a real short-lived child (node -e "process.exit(0)").
 *   2. Spy on `process.kill` to intercept the signal-0 polling calls and
 *      control what error (if any) is thrown.
 *   3. Use `vi.useFakeTimers()` to advance time without real waiting.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mock infrastructure — same pattern as the existing test file so that
// the `node:child_process` mock is in place before the module is imported.
// ---------------------------------------------------------------------------

const { mockSpawn } = vi.hoisted(() => {
  const mockSpawn = vi.fn();
  return { mockSpawn };
});

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: (...args: unknown[]) => {
      if (mockSpawn.getMockImplementation()) {
        return mockSpawn(...args);
      }
      return (original.spawn as (...args: unknown[]) => unknown)(...args);
    },
  };
});

import { NodeProcessManager } from "./node-process-manager.js";

// ---------------------------------------------------------------------------
// Helper — build a minimal fake ChildProcess with a controllable exit event
// ---------------------------------------------------------------------------

function makeFakeChild(pid: number) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdin: null,
    stdout: null,
    stderr: null,
    stdio: [null, null, null, null, null] as const,
    channel: undefined,
    connected: false,
    exitCode: null,
    signalCode: null,
    spawnargs: [] as string[],
    spawnfile: "",
    killed: false,
    kill: vi.fn(),
    send: vi.fn(),
    disconnect: vi.fn(),
    unref: vi.fn(),
    ref: vi.fn(),
    [Symbol.dispose]: vi.fn(),
  });
  return child;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("waitForProcessGroupDead — uncovered branches", () => {
  const manager = new NodeProcessManager();

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    mockSpawn.mockReset();
  });

  // -------------------------------------------------------------------------
  // Test 1: deadline reached while group is still alive (lines 22-25)
  //
  // process.kill(-pgid, 0) does NOT throw (group appears alive) but we never
  // get an ESRCH.  After the timeout elapses the deadline branch resolves.
  // -------------------------------------------------------------------------

  it("resolves when polling deadline is reached before process group exits", async () => {
    const pid = 12345;
    const child = makeFakeChild(pid);
    mockSpawn.mockImplementationOnce(() => child);

    const handle = manager.spawn({ command: "any", args: [], cwd: "/tmp" });

    // process.kill(-pid, 0) should never throw — simulates group still alive.
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((target: number | string, signal?: string | number) => {
        // Allow real kills on anything except our fake pgid (negative of pid)
        if (target === -pid && (signal === 0 || signal === undefined)) {
          // Group is "alive" — do not throw
          return true;
        }
        return true;
      });

    // Fire the child exit event so waitForProcessGroupDead begins polling
    child.emit("exit", 0, null);

    // Advance time well past the 30 000 ms default timeout so the deadline
    // branch (lines 22-25) is hit inside the polling loop.
    await vi.advanceTimersByTimeAsync(35_000);

    // The exited promise must resolve (not hang)
    await expect(handle.exited).resolves.toBe(0);

    expect(killSpy).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 2: EPERM branch — group exists but caller has no permission (lines 31-38)
  //
  // process.kill(-pgid, 0) throws EPERM for several calls, then finally throws
  // ESRCH so the promise resolves via the normal "group gone" path.
  // -------------------------------------------------------------------------

  it("keeps polling when EPERM is received then resolves when ESRCH fires", async () => {
    const pid = 12346;
    const child = makeFakeChild(pid);
    mockSpawn.mockImplementationOnce(() => child);

    const handle = manager.spawn({ command: "any", args: [], cwd: "/tmp" });

    let pollCount = 0;
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((target: number | string, signal?: string | number) => {
        if (target === -pid && (signal === 0 || signal === undefined)) {
          pollCount += 1;
          if (pollCount < 3) {
            // First two polls: EPERM (group alive, no permission)
            const err = Object.assign(new Error("EPERM"), { code: "EPERM" });
            throw err;
          }
          // Third poll: ESRCH (group gone)
          const err = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
          throw err;
        }
        return true;
      });

    child.emit("exit", 0, null);

    // Advance through the first two EPERM poll intervals (50 ms each)
    await vi.advanceTimersByTimeAsync(150);

    await expect(handle.exited).resolves.toBe(0);

    // Should have polled at least 3 times (2x EPERM + 1x ESRCH)
    expect(pollCount).toBeGreaterThanOrEqual(3);
    expect(killSpy).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 3: EPERM at deadline — EPERM thrown but deadline has passed (lines 34-35)
  //
  // process.kill(-pgid, 0) always throws EPERM; we advance past the timeout so
  // the inner deadline check inside the EPERM branch resolves immediately.
  // -------------------------------------------------------------------------

  it("resolves via EPERM deadline branch when deadline is reached during EPERM polling", async () => {
    const pid = 12347;
    const child = makeFakeChild(pid);
    mockSpawn.mockImplementationOnce(() => child);

    const handle = manager.spawn({ command: "any", args: [], cwd: "/tmp" });

    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((target: number | string, signal?: string | number) => {
        if (target === -pid && (signal === 0 || signal === undefined)) {
          const err = Object.assign(new Error("EPERM"), { code: "EPERM" });
          throw err;
        }
        return true;
      });

    child.emit("exit", 0, null);

    // Advance well past the 30 s default timeout so that after the first EPERM
    // is caught, `Date.now() >= deadline` is true and resolve() is called.
    await vi.advanceTimersByTimeAsync(35_000);

    await expect(handle.exited).resolves.toBe(0);

    expect(killSpy).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 4: unexpected error code → resolve immediately (lines 39-41)
  //
  // process.kill(-pgid, 0) throws an error whose code is neither ESRCH nor
  // EPERM.  The else branch resolves immediately to avoid an infinite loop.
  // -------------------------------------------------------------------------

  it("resolves immediately on unexpected error from process.kill to avoid infinite loop", async () => {
    const pid = 12348;
    const child = makeFakeChild(pid);
    mockSpawn.mockImplementationOnce(() => child);

    const handle = manager.spawn({ command: "any", args: [], cwd: "/tmp" });

    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((target: number | string, signal?: string | number) => {
        if (target === -pid && (signal === 0 || signal === undefined)) {
          const err = Object.assign(new Error("EBADF"), { code: "EBADF" });
          throw err;
        }
        return true;
      });

    child.emit("exit", 0, null);

    // No need to advance timers — the unexpected-error branch resolves sync.
    // A small tick flush is enough.
    await vi.advanceTimersByTimeAsync(0);

    await expect(handle.exited).resolves.toBe(0);

    // process.kill should have been called exactly once (the first poll
    // triggers the unexpected error and we resolve immediately — no retries).
    const relevantCalls = killSpy.mock.calls.filter(
      ([target, signal]) => target === -pid && (signal === 0 || signal === undefined),
    );
    expect(relevantCalls).toHaveLength(1);
  });
});
