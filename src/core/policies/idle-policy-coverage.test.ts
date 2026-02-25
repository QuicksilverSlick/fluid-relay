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
  return { on: vi.fn(), off: vi.fn() };
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

  it("start() is idempotent — second call is a no-op", () => {
    const domainEvents = makeDomainEvents();
    const policy = new IdlePolicy({
      bridge: makeBridge([]),
      logger: makeLogger(),
      idleSessionTimeoutMs: 10_000,
      domainEvents,
    });

    policy.start();
    policy.start();

    // ensureDomainSubscriptions registers 3 listeners; a second start() must not add more.
    expect(domainEvents.on).toHaveBeenCalledTimes(3);

    policy.stop();
  });

  it("subscribeToEvents() is idempotent — does not add duplicate listeners", () => {
    const domainEvents = makeDomainEvents();
    const policy = new IdlePolicy({
      bridge: makeBridge([]),
      logger: makeLogger(),
      idleSessionTimeoutMs: 10_000,
      domainEvents,
    });

    policy.start();
    const callsAfterFirst = domainEvents.on.mock.calls.length; // 3

    policy.stop();
    policy.start(); // re-registers (cleanups empty again)
    policy.start(); // hits both guards: running=true AND eventCleanups.length > 0

    // Total .on() calls must be 6 (3 per valid start), not 9.
    expect(domainEvents.on).toHaveBeenCalledTimes(callsAfterFirst * 2);

    policy.stop();
  });

  it("runSweep() exits immediately when stop() is called before sweep fires", async () => {
    const bridge = makeBridge([{ session_id: "s-a" }, { session_id: "s-b" }], (id) => ({
      id,
      cliConnected: false,
      consumerCount: 0,
      lastActivity: Date.now() - 20_000,
    }));

    const policy = new IdlePolicy({
      bridge,
      logger: makeLogger(),
      idleSessionTimeoutMs: 5_000,
      domainEvents: makeDomainEvents(),
    });

    policy.start();

    // stop() clears the timer before it fires; the sweep never runs.
    await vi.advanceTimersByTimeAsync(499);
    policy.stop();
    await vi.advanceTimersByTimeAsync(600);

    expect(bridge.closeSession).not.toHaveBeenCalled();
    expect(bridge.applyPolicyCommand).not.toHaveBeenCalled();
  });

  it("runSweep() guard (line 103) is hit when sweep was enqueued but stop() called first", async () => {
    // Fire the periodic-sweep timer callback synchronously (does NOT drain microtasks),
    // then call stop() before draining. When microtasks finally run, runSweep() hits
    // `if (!this.running)` and bails out without touching the bridge.
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
      logger: makeLogger(),
      idleSessionTimeoutMs: 5_000,
      domainEvents: makeDomainEvents(),
    });

    policy.start();
    vi.advanceTimersByTime(1_000); // synchronous — does NOT drain microtasks
    policy.stop();

    await Promise.resolve();
    await Promise.resolve(); // two ticks: sweepChain.then wraps runSweep

    expect(bridge.getAllSessions).not.toHaveBeenCalled();
    expect(bridge.closeSession).not.toHaveBeenCalled();
  });

  it("skips sessions that disappear from the snapshot during sweep", async () => {
    const bridge = {
      getAllSessions: vi.fn(() => [{ session_id: "ghost" }, { session_id: "alive" }]),
      getSession: vi.fn((id: string) => {
        if (id === "ghost") return null;
        return { id, cliConnected: false, consumerCount: 0, lastActivity: Date.now() - 20_000 };
      }),
      closeSession: vi.fn(async () => undefined),
      applyPolicyCommand: vi.fn(),
    } as any;

    const policy = new IdlePolicy({
      bridge,
      logger: makeLogger(),
      idleSessionTimeoutMs: 5_000,
    });

    policy.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(bridge.closeSession).toHaveBeenCalledTimes(1);
    expect(bridge.closeSession).toHaveBeenCalledWith("alive");
    expect(bridge.applyPolicyCommand).toHaveBeenCalledWith("alive", { type: "idle_reap" });
    expect(bridge.applyPolicyCommand).not.toHaveBeenCalledWith("ghost", expect.anything());

    policy.stop();
  });

  it("treats sessions with no lastActivity as maximally idle and reaps them", async () => {
    const bridge = {
      getAllSessions: vi.fn(() => [{ session_id: "no-activity" }]),
      getSession: vi.fn(() => ({
        id: "no-activity",
        cliConnected: false,
        consumerCount: 0,
        // lastActivity deliberately absent — coerces to undefined → ?? 0
      })),
      closeSession: vi.fn(async () => undefined),
      applyPolicyCommand: vi.fn(),
    } as any;

    const policy = new IdlePolicy({
      bridge,
      logger: makeLogger(),
      idleSessionTimeoutMs: 5_000,
    });

    policy.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(bridge.closeSession).toHaveBeenCalledWith("no-activity");
    expect(bridge.applyPolicyCommand).toHaveBeenCalledWith("no-activity", { type: "idle_reap" });

    policy.stop();
  });

  it("works without domainEvents — no subscription, periodic sweep still runs", async () => {
    const bridge = {
      getAllSessions: vi.fn(() => [{ session_id: "nodomain" }]),
      getSession: vi.fn(() => ({
        id: "nodomain",
        cliConnected: false,
        consumerCount: 0,
        lastActivity: Date.now() - 20_000,
      })),
      closeSession: vi.fn(async () => undefined),
      applyPolicyCommand: vi.fn(),
    } as any;

    const policy = new IdlePolicy({
      bridge,
      logger: makeLogger(),
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
