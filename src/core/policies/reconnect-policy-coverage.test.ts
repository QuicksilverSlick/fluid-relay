/**
 * Coverage tests for ReconnectPolicy — targets the two previously uncovered branches:
 *   1. Lines 73-76: the rejected-result path inside Promise.allSettled
 *   2. Lines 99-104: teardownDomainSubscriptions called via stop()
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ReconnectPolicy } from "./reconnect-policy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal set of mocked deps that satisfies ReconnectPolicyDeps.
 * `domainEvents` is a plain object with spied `on`/`off` so we can intercept
 * the cleanup functions that `ensureDomainSubscriptions` registers.
 */
function makeDeps(
  overrides: {
    relaunch?: (sessionId: string) => Promise<unknown>;
    starting?: Array<{ sessionId: string; archived?: boolean }>;
  } = {},
) {
  const starting = overrides.starting ?? [
    { sessionId: "s1", state: "starting", cwd: "/tmp", createdAt: 1 },
  ];

  const relaunch = overrides.relaunch ?? vi.fn(async () => true);

  const launcher = {
    getStartingSessions: vi.fn(() => starting as any[]),
    relaunch: typeof relaunch === "function" ? relaunch : vi.fn(relaunch),
  } as any;

  const bridge = {
    broadcastWatchdogState: vi.fn(),
    applyPolicyCommand: vi.fn(),
  } as any;

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  } as any;

  // Track listeners so we can verify cleanup calls
  const listeners: Map<string, Set<Function>> = new Map();
  const domainEvents = {
    on: vi.fn(<K extends string>(event: K, listener: Function) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    }),
    off: vi.fn(<K extends string>(event: K, listener: Function) => {
      listeners.get(event)?.delete(listener);
    }),
    // Helper — emit an event to registered listeners (not part of the real interface, just for tests)
    _emit(event: string, payload: unknown) {
      for (const fn of listeners.get(event) ?? []) fn(payload);
    },
    _listeners: listeners,
  };

  return { launcher, bridge, logger, domainEvents, relaunch };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReconnectPolicy — uncovered branches", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Test 1: lines 73-76 — logger.warn is called when a batch relaunch rejects
  // -------------------------------------------------------------------------
  it("logs a warning when a batch relaunch fails (rejected Promise.allSettled result)", async () => {
    vi.useFakeTimers();

    const relaunchError = new Error("relaunch exploded");
    const { launcher, bridge, logger, domainEvents } = makeDeps({
      starting: [
        { sessionId: "s-fail", state: "starting", cwd: "/tmp", createdAt: 1 } as any,
        { sessionId: "s-ok", state: "starting", cwd: "/tmp", createdAt: 1 } as any,
      ],
      relaunch: vi.fn(async (sessionId: string) => {
        if (sessionId === "s-fail") throw relaunchError;
        return true;
      }),
    });

    const policy = new ReconnectPolicy({
      launcher,
      bridge,
      logger,
      reconnectGracePeriodMs: 1000,
      domainEvents,
    });

    policy.start();

    // Advance time past the grace period so the watchdog fires
    await vi.advanceTimersByTimeAsync(1000);
    // Allow the async relaunchStaleSessions promise chain to settle
    await Promise.resolve();
    await Promise.resolve();

    // The warning must reference the failing session and carry the error
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("s-fail"),
      expect.objectContaining({ error: relaunchError }),
    );

    // The successful session must still have been attempted — allSettled, not Promise.all
    expect(launcher.relaunch).toHaveBeenCalledWith("s-fail");
    expect(launcher.relaunch).toHaveBeenCalledWith("s-ok");

    // logger.warn must NOT have been called for the succeeding session
    const warnCalls: string[] = logger.warn.mock.calls.map((c: any[]) => c[0] as string);
    expect(warnCalls.every((msg) => !msg.includes("s-ok"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2: lines 99-104 — teardownDomainSubscriptions called from stop()
  // -------------------------------------------------------------------------
  it("stop() calls all registered cleanup functions (teardownDomainSubscriptions via stop)", () => {
    vi.useFakeTimers();

    const { launcher, bridge, logger, domainEvents } = makeDeps({
      starting: [{ sessionId: "s-stop", state: "starting", cwd: "/tmp", createdAt: 1 } as any],
    });

    const policy = new ReconnectPolicy({
      launcher,
      bridge,
      logger,
      reconnectGracePeriodMs: 5000,
      domainEvents,
    });

    // start() registers three domain-event subscriptions
    policy.start();
    expect(domainEvents.on).toHaveBeenCalledTimes(3);

    // stop() must call the three matching off() teardowns
    policy.stop();
    expect(domainEvents.off).toHaveBeenCalledTimes(3);

    // The three events that were subscribed to
    const subscribedEvents = domainEvents.on.mock.calls.map((c: any[]) => c[0] as string);
    const unsubscribedEvents = domainEvents.off.mock.calls.map((c: any[]) => c[0] as string);
    expect(subscribedEvents.sort()).toEqual(unsubscribedEvents.sort());
  });

  it("stop() is idempotent — calling it twice does not double-unsubscribe", () => {
    vi.useFakeTimers();

    const { launcher, bridge, logger, domainEvents } = makeDeps({
      starting: [{ sessionId: "s-idem", state: "starting", cwd: "/tmp", createdAt: 1 } as any],
    });

    const policy = new ReconnectPolicy({
      launcher,
      bridge,
      logger,
      reconnectGracePeriodMs: 5000,
      domainEvents,
    });

    policy.start();
    policy.stop();
    const offCallsAfterFirstStop = domainEvents.off.mock.calls.length;

    // Second stop() is a no-op — reconnectTimer is already null
    policy.stop();
    expect(domainEvents.off).toHaveBeenCalledTimes(offCallsAfterFirstStop);
  });

  // -------------------------------------------------------------------------
  // Test 3: stop() is safe when never started (edge case)
  // -------------------------------------------------------------------------
  it("stop() is safe when called without start()", () => {
    const { launcher, bridge, logger, domainEvents } = makeDeps();

    const policy = new ReconnectPolicy({
      launcher,
      bridge,
      logger,
      reconnectGracePeriodMs: 5000,
      domainEvents,
    });

    // Should not throw
    expect(() => policy.stop()).not.toThrow();

    // No subscriptions were made, so nothing should be torn down
    expect(domainEvents.on).not.toHaveBeenCalled();
    expect(domainEvents.off).not.toHaveBeenCalled();
  });
});
