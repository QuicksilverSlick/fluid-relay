/**
 * Coverage tests for uncovered branches in IdlePolicy.
 *
 * Targets:
 *  - Line 32:  double-start guard (`if (this.running) return;`)
 *  - Line 53:  double-subscribe guard (`if (!this.deps.domainEvents || this.eventCleanups.length > 0) return;`)
 *  - Lines 103-113: guard against stop() during sweep + session-disappeared mid-sweep
 *  - Line 119:  null-coalescing for lastActivity (`snapshot.lastActivity ?? 0`)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdlePolicy } from "./idle-policy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDomainEvents() {
  return {
    on: vi.fn(),
    off: vi.fn(),
  };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function makeBridge(
  sessions: Array<{ session_id: string }>,
  snapshotFactory?: (id: string) => object | null,
) {
  const defaultSnapshot = (id: string) => ({
    id,
    cliConnected: false,
    consumerCount: 0,
    lastActivity: Date.now() - 10_000,
  });

  return {
    getAllSessions: vi.fn(() => sessions),
    getSession: vi.fn((id: string) => (snapshotFactory ?? defaultSnapshot)(id)),
    closeSession: vi.fn(async () => undefined),
    applyPolicyCommand: vi.fn(),
    broadcastWatchdogState: vi.fn(),
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IdlePolicy — uncovered branch coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Test 1 — Line 32: double-start guard
  // -------------------------------------------------------------------------
  it("start() is idempotent — second call is a no-op", () => {
    const domainEvents = makeDomainEvents();
    const bridge = makeBridge([]);
    const logger = makeLogger();

    const policy = new IdlePolicy({
      bridge,
      logger,
      idleSessionTimeoutMs: 10_000,
      domainEvents,
    });

    policy.start();
    policy.start(); // second call must hit `if (this.running) return;`

    // ensureDomainSubscriptions registers 3 listeners (consumer:disconnected,
    // backend:disconnected, backend:connected).  If start() were not guarded
    // it would register 6.
    expect(domainEvents.on).toHaveBeenCalledTimes(3);

    policy.stop();
  });

  // -------------------------------------------------------------------------
  // Test 2 — Line 53: double-subscribe guard
  //
  // ensureDomainSubscriptions is private but is called from start(). Calling
  // start() twice is sufficient to drive both sides of the guard:
  //   - first call: eventCleanups.length === 0 → registers listeners
  //   - second call: eventCleanups.length > 0  → returns early (the guard)
  // -------------------------------------------------------------------------
  it("subscribeToEvents() is idempotent — does not add duplicate listeners", () => {
    const domainEvents = makeDomainEvents();
    const bridge = makeBridge([]);
    const logger = makeLogger();

    const policy = new IdlePolicy({
      bridge,
      logger,
      idleSessionTimeoutMs: 10_000,
      domainEvents,
    });

    // First start registers listeners; running flag set to true.
    policy.start();
    const callsAfterFirst = domainEvents.on.mock.calls.length; // should be 3

    // Force a second ensureDomainSubscriptions call by stopping (clears
    // running + cleanups) and starting again — then call start() a third time
    // while still running to hit the eventCleanups.length > 0 path.
    policy.stop(); // resets running=false and empties eventCleanups
    policy.start(); // re-registers (eventCleanups empty again)
    policy.start(); // this call hits both guards: running=true AND eventCleanups.length > 0

    // Total .on() calls should be exactly 6 (3 per valid start), not 9.
    expect(domainEvents.on).toHaveBeenCalledTimes(callsAfterFirst * 2);

    policy.stop();
  });

  // -------------------------------------------------------------------------
  // Test 3 — Lines 103-113: stop() called during an active sweep halts
  // mid-iteration processing.
  //
  // We give the policy two sessions.  When closeSession is called for the
  // first, we call stop().  The second session must NOT be reaped because
  // runSweep() will return early at line 103 on any subsequent entrance (the
  // sweep runs atomically inside a single async call, so we rely on the
  // for-loop itself finishing — but we can observe that stop() prevents the
  // timer from re-scheduling and the bridge callbacks for the second session
  // are not invoked).
  //
  // To truly hit line 103 (`if (!this.running) return;`) we need a sweep
  // that was enqueued while running, then stop() is called before it fires.
  // -------------------------------------------------------------------------
  it("runSweep() exits immediately when stop() is called before sweep fires", async () => {
    const bridge = makeBridge([{ session_id: "s-a" }, { session_id: "s-b" }], (id) => ({
      id,
      cliConnected: false,
      consumerCount: 0,
      lastActivity: Date.now() - 20_000,
    }));

    const logger = makeLogger();
    const domainEvents = makeDomainEvents();

    const policy = new IdlePolicy({
      bridge,
      logger,
      idleSessionTimeoutMs: 5_000,
      domainEvents,
    });

    policy.start();

    // Advance to just before sweep fires, stop the policy, then advance past it.
    // The sweep callback has been scheduled but stop() clears the timer before
    // it can fire, so runSweep (and its `if (!this.running)` guard) is never
    // even called.
    await vi.advanceTimersByTimeAsync(499);
    policy.stop(); // clears idleReaperTimer before it fires
    await vi.advanceTimersByTimeAsync(600); // past where the sweep would have fired

    // No sessions should have been closed.
    expect(bridge.closeSession).not.toHaveBeenCalled();
    expect(bridge.applyPolicyCommand).not.toHaveBeenCalled();
  });

  it("runSweep() guard (line 103) is hit when sweep was enqueued while running but stop() called first", async () => {
    // We need the sweep to be enqueued (via enqueueSweep) while running=true,
    // but stop() must flip running=false BEFORE the async runSweep body starts.
    //
    // The trick: use synchronous vi.advanceTimersByTime() (not the async variant)
    // so that the setTimeout callback fires and enqueueSweep() queues a promise,
    // but the microtask queue is NOT drained.  Then call stop() — which sets
    // running=false — before draining microtasks.  When Promise.resolve() finally
    // lets the microtask queue run, runSweep() hits line 103 (`if (!this.running)
    // return;`) and bails out without touching the bridge.

    const logger = makeLogger();
    const domainEvents = makeDomainEvents();

    const bridge = {
      getAllSessions: vi.fn(() => [{ session_id: "concurrent-s" }]),
      getSession: vi.fn(() => ({
        id: "concurrent-s",
        cliConnected: false,
        consumerCount: 0,
        lastActivity: Date.now() - 50_000,
      })),
      closeSession: vi.fn(async () => undefined),
      applyPolicyCommand: vi.fn(),
    } as any;

    const policy = new IdlePolicy({
      bridge,
      logger,
      idleSessionTimeoutMs: 5_000,
      domainEvents,
    });

    policy.start();

    // Fire the periodic-sweep timer callback synchronously so that
    // enqueueSweep() is called (appending runSweep to the promise chain),
    // but the async body of runSweep() has not yet started because no
    // microtasks have drained.
    vi.advanceTimersByTime(1_000); // synchronous — does NOT drain microtasks

    // Now stop() while runSweep is waiting to be pulled off the microtask queue.
    policy.stop(); // sets this.running = false

    // Let the microtask queue drain — runSweep() wakes up, checks
    // `if (!this.running)` at line 103 and returns immediately.
    await Promise.resolve();
    await Promise.resolve(); // two ticks to be safe (sweepChain.then wraps runSweep)

    // runSweep exited at the guard, so the bridge must never be touched.
    expect(bridge.getAllSessions).not.toHaveBeenCalled();
    expect(bridge.closeSession).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 4 — Line 113: `if (!snapshot) continue;`
  // getSession returns null for one session mid-sweep → no crash, reap skipped
  // -------------------------------------------------------------------------
  it("skips sessions that disappear from the snapshot during sweep", async () => {
    const logger = makeLogger();

    const bridge = {
      getAllSessions: vi.fn(() => [{ session_id: "ghost" }, { session_id: "alive" }]),
      getSession: vi.fn((id: string) => {
        if (id === "ghost") return null; // disappeared
        return {
          id,
          cliConnected: false,
          consumerCount: 0,
          lastActivity: Date.now() - 20_000,
        };
      }),
      closeSession: vi.fn(async () => undefined),
      applyPolicyCommand: vi.fn(),
    } as any;

    const policy = new IdlePolicy({
      bridge,
      logger,
      idleSessionTimeoutMs: 5_000,
    });

    policy.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    // "ghost" should be skipped (no crash), "alive" should be reaped.
    expect(bridge.closeSession).toHaveBeenCalledTimes(1);
    expect(bridge.closeSession).toHaveBeenCalledWith("alive");
    expect(bridge.applyPolicyCommand).toHaveBeenCalledWith("alive", { type: "idle_reap" });
    expect(bridge.applyPolicyCommand).not.toHaveBeenCalledWith("ghost", expect.anything());

    policy.stop();
  });

  // -------------------------------------------------------------------------
  // Test 5 — Line 119: `snapshot.lastActivity ?? 0`
  // A session with lastActivity=undefined is treated as maximally idle (age
  // is computed as `now - 0 = now`), so it must be reaped once idleMs >=
  // idleSessionTimeoutMs.
  // -------------------------------------------------------------------------
  it("treats sessions with no lastActivity as maximally idle and reaps them", async () => {
    const logger = makeLogger();
    const now = Date.now();

    const bridge = {
      getAllSessions: vi.fn(() => [{ session_id: "no-activity" }]),
      getSession: vi.fn((_id: string) => ({
        id: "no-activity",
        cliConnected: false,
        consumerCount: 0,
        // lastActivity deliberately omitted — coerces to undefined → ?? 0
      })),
      closeSession: vi.fn(async () => undefined),
      applyPolicyCommand: vi.fn(),
    } as any;

    const policy = new IdlePolicy({
      bridge,
      logger,
      idleSessionTimeoutMs: 5_000,
    });

    policy.start();
    await vi.advanceTimersByTimeAsync(1_000); // triggers periodic sweep
    await Promise.resolve();

    // idleMs = now - 0 = now (≈ epoch), which is enormously larger than 5 s.
    expect(bridge.closeSession).toHaveBeenCalledWith("no-activity");
    expect(bridge.applyPolicyCommand).toHaveBeenCalledWith("no-activity", { type: "idle_reap" });

    policy.stop();
  });

  // -------------------------------------------------------------------------
  // Bonus: verify domainEvents being absent (undefined) does not prevent
  // start() from working (covers the first half of the line-53 guard:
  // `if (!this.deps.domainEvents || ...)`)
  // -------------------------------------------------------------------------
  it("works without domainEvents — no subscription, periodic sweep still runs", async () => {
    const logger = makeLogger();

    const bridge = {
      getAllSessions: vi.fn(() => [{ session_id: "nodomain" }]),
      getSession: vi.fn((_id: string) => ({
        id: "nodomain",
        cliConnected: false,
        consumerCount: 0,
        lastActivity: Date.now() - 20_000,
      })),
      closeSession: vi.fn(async () => undefined),
      applyPolicyCommand: vi.fn(),
    } as any;

    // No domainEvents passed — exercises `!this.deps.domainEvents` path in line 53
    const policy = new IdlePolicy({
      bridge,
      logger,
      idleSessionTimeoutMs: 5_000,
      // domainEvents intentionally absent
    });

    policy.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(bridge.closeSession).toHaveBeenCalledWith("nodomain");

    policy.stop();
  });
});
