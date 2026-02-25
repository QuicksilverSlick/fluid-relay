/**
 * Coverage tests for ReconnectPolicy — targets two previously uncovered branches:
 *   1. Lines 73-76: the rejected-result path inside Promise.allSettled
 *   2. Lines 99-104: teardownDomainSubscriptions called via stop()
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "../../testing/cli-message-factories.js";
import { ReconnectPolicy } from "./reconnect-policy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal set of mocked deps that satisfies ReconnectPolicyDeps.
 * `domainEvents` tracks registered listeners so we can verify cleanup calls.
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

  const listeners: Map<string, Set<Function>> = new Map();
  const domainEvents = {
    on: vi.fn(<K extends string>(event: K, listener: Function) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    }),
    off: vi.fn(<K extends string>(event: K, listener: Function) => {
      listeners.get(event)?.delete(listener);
    }),
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
    await vi.advanceTimersByTimeAsync(1000);
    // The relaunchStaleSessions chain has multiple async hops:
    // timer callback → relaunch() (rejects) → Promise.allSettled() → result iteration → logger.warn.
    // Flush 4 microtask queue turns to ensure all hops have settled.
    await flushPromises();
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("s-fail"),
      expect.objectContaining({ error: relaunchError }),
    );
    expect(launcher.relaunch).toHaveBeenCalledWith("s-fail");
    expect(launcher.relaunch).toHaveBeenCalledWith("s-ok");

    const warnMessages: string[] = logger.warn.mock.calls.map((c: any[]) => c[0] as string);
    expect(warnMessages.every((msg) => !msg.includes("s-ok"))).toBe(true);
  });

  it("stop() calls all registered cleanup functions (teardownDomainSubscriptions)", () => {
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

    policy.start();
    expect(domainEvents.on).toHaveBeenCalledTimes(3);

    policy.stop();
    expect(domainEvents.off).toHaveBeenCalledTimes(3);

    const subscribedEvents = domainEvents.on.mock.calls.map((c: any[]) => c[0] as string);
    const unsubscribedEvents = domainEvents.off.mock.calls.map((c: any[]) => c[0] as string);
    expect(subscribedEvents.sort()).toEqual(unsubscribedEvents.sort());
  });

  it("stop() is idempotent — second call exits early because reconnectTimer is already null", () => {
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

    // Guard fires: stop() checks this.reconnectTimer === null and returns early.
    // teardownDomainSubscriptions is NOT called again because stop() never reaches it.
    policy.stop();
    expect(domainEvents.off).toHaveBeenCalledTimes(offCallsAfterFirstStop);
  });

  it("stop() is safe when called without start()", () => {
    const { launcher, bridge, logger, domainEvents } = makeDeps();

    const policy = new ReconnectPolicy({
      launcher,
      bridge,
      logger,
      reconnectGracePeriodMs: 5000,
      domainEvents,
    });

    expect(() => policy.stop()).not.toThrow();
    expect(domainEvents.on).not.toHaveBeenCalled();
    expect(domainEvents.off).not.toHaveBeenCalled();
  });
});
