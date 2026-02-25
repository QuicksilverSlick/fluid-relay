/**
 * Additional coverage tests for CloudflaredManager targeting uncovered branches:
 *
 *   - Line 207: scheduleRestart() timer fires when stopped=false → calls spawnProcess()
 *   - Line 130: handleData called again after urlFound=true → early return branch
 *   - Line 152: onError fires after URL already found → skips the reject block
 *   - Line 170: onExit fires after URL found but stopped=true → skips scheduleRestart()
 *   - Line 187: buildArgs in production mode without metricsPort → skips metrics push
 *
 * The existing test suite covers the stopped=true early-return in scheduleRestart,
 * the stopped=false path in onExit (scheduleRestart IS called), the onError path
 * before URL, and production mode WITH metricsPort. This file fills the gaps.
 */

import * as cp from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflaredManager } from "./cloudflared-manager.js";

// Re-use the same vi.mock pattern as the primary test file so spawn is
// controllable per-test without touching the real cloudflared binary.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn().mockImplementation(actual.spawn) };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal mock ChildProcess that keeps event-handling alive. */
function createMockProc() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
    pid: 99999,
  });
}

/** Set up a manager with internal state ready for spawnProcess() without
 *  needing the cloudflared binary (skips detectCloudflared). */
function prepareManager(manager: CloudflaredManager) {
  (manager as any).config = { mode: "development", localPort: 8080 };
  (manager as any).stopped = false;
  (manager as any).restartAttempts = 0;
  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (err: Error) => void;
  const urlPromise = new Promise<string>((res, rej) => {
    resolveUrl = res;
    rejectUrl = rej;
  });
  (manager as any).urlResolve = resolveUrl;
  (manager as any).urlReject = rejectUrl;
  return { urlPromise, resolveUrl, rejectUrl };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CloudflaredManager — uncovered branches (line 130, 152, 170, 187, 207)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Line 207: scheduleRestart() calls spawnProcess() when stopped is false
  // -------------------------------------------------------------------------

  it("scheduleRestart() calls spawnProcess() when stopped is false at timer fire time (line 207)", async () => {
    vi.useFakeTimers();

    const manager = new CloudflaredManager();
    const spawnSpy = vi.spyOn(manager as any, "spawnProcess");

    const firstProc = createMockProc();
    const secondProc = createMockProc();

    vi.mocked(cp.spawn)
      .mockReturnValueOnce(firstProc as any)
      .mockReturnValueOnce(secondProc as any);

    const { urlPromise } = prepareManager(manager);

    // First spawn
    (manager as any).spawnProcess();

    // Emit a URL so urlFound becomes true and the promise resolves
    firstProc.stdout.emit("data", Buffer.from("https://restart-tunnel.trycloudflare.com\n"));
    await vi.advanceTimersByTimeAsync(0);
    await urlPromise;

    spawnSpy.mockClear();

    // Process exits after URL was found; stopped=false → scheduleRestart() fires
    firstProc.emit("exit", 0);
    expect(spawnSpy).not.toHaveBeenCalled();

    // Backoff for restartAttempts=0 is 1000 ms; advance past it
    await vi.advanceTimersByTimeAsync(1500);

    // Line 207: spawnProcess() must have been called by the timer
    expect(spawnSpy).toHaveBeenCalledTimes(1);

    // Tear down
    (manager as any).stopped = true;
    for (const cleanup of (manager as any).processCleanups) cleanup();
    (manager as any).processCleanups = [];
  });

  // -------------------------------------------------------------------------
  // Line 130: handleData called when urlFound is already true → early return
  // -------------------------------------------------------------------------

  it("handleData ignores subsequent data chunks after URL is already found (line 130)", async () => {
    const manager = new CloudflaredManager();
    const mockProc = createMockProc();

    vi.mocked(cp.spawn).mockReturnValueOnce(mockProc as any);

    const { urlPromise } = prepareManager(manager);

    (manager as any).spawnProcess();

    // First chunk: URL found, promise resolves
    mockProc.stdout.emit("data", Buffer.from("https://first-tunnel.trycloudflare.com\n"));
    const url = await urlPromise;
    expect(url).toBe("https://first-tunnel.trycloudflare.com");

    // Store the current tunnelUrl
    const urlBefore = (manager as any)._tunnelUrl;

    // Second chunk with a different URL: should be ignored because urlFound=true (line 130)
    mockProc.stdout.emit("data", Buffer.from("https://second-tunnel.trycloudflare.com\n"));

    // Allow any microtasks to settle
    await new Promise<void>((r) => setImmediate(r));

    // The tunnel URL must not have changed
    expect((manager as any)._tunnelUrl).toBe(urlBefore);

    // Tear down
    (manager as any).stopped = true;
    for (const cleanup of (manager as any).processCleanups) cleanup();
    (manager as any).processCleanups = [];
  });

  // -------------------------------------------------------------------------
  // Line 152: onError fires after URL already found → the if(!urlFound) block
  //           is NOT entered (false branch of the guard)
  // -------------------------------------------------------------------------

  it("onError after URL already found does not reject or clear resolve/reject (line 152)", async () => {
    const manager = new CloudflaredManager();
    const mockProc = createMockProc();

    vi.mocked(cp.spawn).mockReturnValueOnce(mockProc as any);

    const { urlPromise } = prepareManager(manager);

    (manager as any).spawnProcess();

    // URL arrives first
    mockProc.stdout.emit("data", Buffer.from("https://error-after-url.trycloudflare.com\n"));
    const url = await urlPromise;
    expect(url).toBe("https://error-after-url.trycloudflare.com");

    // urlResolve/urlReject are already null at this point (cleared after resolve).
    // Emitting error now should not throw and should not alter _tunnelUrl.
    const tunnelUrlBefore = (manager as any)._tunnelUrl;
    expect(() => {
      mockProc.emit("error", new Error("late error after URL found"));
    }).not.toThrow();

    expect((manager as any)._tunnelUrl).toBe(tunnelUrlBefore);

    // Tear down
    (manager as any).stopped = true;
    for (const cleanup of (manager as any).processCleanups) cleanup();
    (manager as any).processCleanups = [];
  });

  // -------------------------------------------------------------------------
  // Line 170: onExit fires after URL found, but stopped=true → scheduleRestart
  //           is NOT called (false branch of `if (!this.stopped)`)
  // -------------------------------------------------------------------------

  it("onExit after URL found with stopped=true does not call scheduleRestart (line 170)", async () => {
    const manager = new CloudflaredManager();
    const mockProc = createMockProc();

    vi.mocked(cp.spawn).mockReturnValueOnce(mockProc as any);

    const { urlPromise } = prepareManager(manager);

    (manager as any).spawnProcess();

    // URL arrives
    mockProc.stdout.emit("data", Buffer.from("https://stopped-exit.trycloudflare.com\n"));
    await urlPromise;

    // Mark as stopped before the process exits
    (manager as any).stopped = true;
    const scheduleRestartSpy = vi.spyOn(manager as any, "scheduleRestart");

    // Process exits
    mockProc.emit("exit", 0);

    // scheduleRestart must NOT have been called because stopped=true (line 170 false branch)
    expect(scheduleRestartSpy).not.toHaveBeenCalled();

    // Tear down
    for (const cleanup of (manager as any).processCleanups) cleanup();
    (manager as any).processCleanups = [];
  });

  // -------------------------------------------------------------------------
  // Line 187: buildArgs in production mode without metricsPort → does NOT push
  //           --metrics flag (false branch of `if (config.metricsPort)`)
  // -------------------------------------------------------------------------

  it("buildArgs production mode without metricsPort omits --metrics flag (line 187)", () => {
    const manager = new CloudflaredManager();
    const { args, env } = (manager as any).buildArgs({
      mode: "production",
      localPort: 8080,
      tunnelToken: "tok-abc",
      // metricsPort intentionally omitted
    });

    // Should only have ["tunnel", "run"] — no "--metrics" entry
    expect(args).toEqual(["tunnel", "run"]);
    expect(env).toMatchObject({ TUNNEL_TOKEN: "tok-abc" });
    expect(args).not.toContain("--metrics");
  });
});
