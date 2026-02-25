/**
 * Coverage tests for the uncovered branches in node-process-manager.ts.
 *
 * Targets the internal `waitForProcessGroupDead` helper, exercised indirectly
 * through `NodeProcessManager.spawn()`. The `exited` promise chains through
 * `waitForProcessGroupDead` after the child's "exit" event fires.
 *
 * Strategy:
 *   1. Spawn a real short-lived child (node -e "process.exit(0)").
 *   2. Spy on `process.kill` to control what error (if any) is thrown.
 *   3. Use `vi.useFakeTimers()` to advance time without real waiting.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  return Object.assign(new EventEmitter(), {
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

  it("resolves when polling deadline is reached before process group exits", async () => {
    const pid = 12345;
    const child = makeFakeChild(pid);
    mockSpawn.mockImplementationOnce(() => child);

    const handle = manager.spawn({ command: "any", args: [], cwd: "/tmp" });

    const killSpy = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      // Group is "alive" — never throw ESRCH
      void target;
      void signal;
      return true;
    });

    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(35_000);

    await expect(handle.exited).resolves.toBe(0);

    const pollingCalls = killSpy.mock.calls.filter(
      ([target, signal]) => target === -pid && (signal === 0 || signal === undefined),
    );
    expect(pollingCalls.length).toBeGreaterThan(0); // polling loop ran
  });

  it("keeps polling when EPERM is received then resolves when ESRCH fires", async () => {
    const pid = 12346;
    const child = makeFakeChild(pid);
    mockSpawn.mockImplementationOnce(() => child);

    const handle = manager.spawn({ command: "any", args: [], cwd: "/tmp" });

    let pollCount = 0;
    vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target === -pid && (signal === 0 || signal === undefined)) {
        pollCount += 1;
        const code = pollCount < 3 ? "EPERM" : "ESRCH";
        throw Object.assign(new Error(code), { code });
      }
      return true;
    });

    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(150);

    await expect(handle.exited).resolves.toBe(0);
    expect(pollCount).toBeGreaterThanOrEqual(3);
  });

  it("resolves via EPERM deadline branch when deadline is reached during EPERM polling", async () => {
    const pid = 12347;
    const child = makeFakeChild(pid);
    mockSpawn.mockImplementationOnce(() => child);

    const handle = manager.spawn({ command: "any", args: [], cwd: "/tmp" });

    const killSpy = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target === -pid && (signal === 0 || signal === undefined)) {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }
      return true;
    });

    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(35_000);

    await expect(handle.exited).resolves.toBe(0);

    const pollingCalls = killSpy.mock.calls.filter(
      ([target, signal]) => target === -pid && (signal === 0 || signal === undefined),
    );
    expect(pollingCalls.length).toBeGreaterThanOrEqual(1); // EPERM polling branch ran
  });

  it("resolves immediately on unexpected error from process.kill to avoid infinite loop", async () => {
    const pid = 12348;
    const child = makeFakeChild(pid);
    mockSpawn.mockImplementationOnce(() => child);

    const handle = manager.spawn({ command: "any", args: [], cwd: "/tmp" });

    const killSpy = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target === -pid && (signal === 0 || signal === undefined)) {
        throw Object.assign(new Error("EBADF"), { code: "EBADF" });
      }
      return true;
    });

    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);

    await expect(handle.exited).resolves.toBe(0);

    const relevantCalls = killSpy.mock.calls.filter(
      ([target, signal]) => target === -pid && (signal === 0 || signal === undefined),
    );
    expect(relevantCalls).toHaveLength(1);
  });
});
