import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainEventBus } from "../events/domain-event-bus.js";
import { ReconnectPolicy } from "./reconnect-policy.js";

describe("ReconnectPolicy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("relaunches stale starting sessions after grace period", async () => {
    vi.useFakeTimers();
    const domainEvents = new DomainEventBus();
    const relaunch = vi.fn(async () => true);
    const starting = [{ sessionId: "s1", state: "starting", cwd: "/tmp", createdAt: 1 }] as any[];
    const launcher = {
      getStartingSessions: vi.fn(() => starting),
      relaunch,
    } as any;
    const bridge = {
      broadcastWatchdogState: vi.fn(),
      applyPolicyCommand: vi.fn(),
    } as any;
    const logger = { info: vi.fn(), warn: vi.fn() } as any;

    const policy = new ReconnectPolicy({
      launcher,
      bridge,
      logger,
      reconnectGracePeriodMs: 5000,
      domainEvents,
    });

    policy.start();
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.resolve();

    expect(bridge.applyPolicyCommand).toHaveBeenCalledWith("s1", { type: "reconnect_timeout" });
    expect(relaunch).toHaveBeenCalledWith("s1");
  });

  it("session:closed event clears watchdog for that session", async () => {
    vi.useFakeTimers();
    const domainEvents = new DomainEventBus();
    const starting = [{ sessionId: "s1", state: "starting", cwd: "/tmp", createdAt: 1 }] as any[];
    const launcher = {
      getStartingSessions: vi.fn(() => starting),
      relaunch: vi.fn(async () => true),
    } as any;
    const bridge = {
      broadcastWatchdogState: vi.fn(),
      applyPolicyCommand: vi.fn(),
    } as any;
    const logger = { info: vi.fn(), warn: vi.fn() } as any;

    const policy = new ReconnectPolicy({
      launcher,
      bridge,
      logger,
      reconnectGracePeriodMs: 5000,
      domainEvents,
    });

    policy.start();

    // Firing session:closed should clear the watchdog for s1
    domainEvents.emit("session:closed", { payload: { sessionId: "s1" } } as any);

    expect(bridge.broadcastWatchdogState).toHaveBeenCalledWith("s1", null);

    policy.stop();
  });
});
