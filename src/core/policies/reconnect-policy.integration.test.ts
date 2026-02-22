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

    const controller = new ReconnectPolicy({
      launcher,
      bridge,
      logger,
      reconnectGracePeriodMs: 5000,
      domainEvents,
    });

    controller.start();
    expect(bridge.broadcastWatchdogState).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ gracePeriodMs: 5000 }),
    );

    await vi.advanceTimersByTimeAsync(5000);
    await Promise.resolve();

    expect(bridge.applyPolicyCommand).toHaveBeenCalledWith("s1", { type: "reconnect_timeout" });
    expect(relaunch).toHaveBeenCalledWith("s1");
    expect(bridge.broadcastWatchdogState).toHaveBeenCalledWith("s1", null);
  });

  it("clears watchdog on process:connected and skips relaunch if no stale sessions remain", async () => {
    vi.useFakeTimers();
    const domainEvents = new DomainEventBus();
    const relaunch = vi.fn(async () => true);
    let starting = [{ sessionId: "s2", state: "starting", cwd: "/tmp", createdAt: 1 }] as any[];
    const launcher = {
      getStartingSessions: vi.fn(() => starting),
      relaunch,
    } as any;
    const bridge = {
      broadcastWatchdogState: vi.fn(),
      applyPolicyCommand: vi.fn(),
    } as any;
    const logger = { info: vi.fn(), warn: vi.fn() } as any;

    const controller = new ReconnectPolicy({
      launcher,
      bridge,
      logger,
      reconnectGracePeriodMs: 5000,
      domainEvents,
    });

    controller.start();
    domainEvents.publishLauncher("process:connected", { sessionId: "s2" });
    starting = [];

    expect(bridge.broadcastWatchdogState).toHaveBeenCalledWith("s2", null);

    await vi.advanceTimersByTimeAsync(5000);
    await Promise.resolve();
    expect(bridge.applyPolicyCommand).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("clears watchdogs when stopped", () => {
    vi.useFakeTimers();
    const domainEvents = new DomainEventBus();
    const launcher = {
      getStartingSessions: vi.fn(
        () => [{ sessionId: "s3", state: "starting", cwd: "/tmp", createdAt: 1 }] as any[],
      ),
      relaunch: vi.fn(async () => true),
    } as any;
    const bridge = {
      broadcastWatchdogState: vi.fn(),
      applyPolicyCommand: vi.fn(),
    } as any;
    const logger = { info: vi.fn(), warn: vi.fn() } as any;

    const controller = new ReconnectPolicy({
      launcher,
      bridge,
      logger,
      reconnectGracePeriodMs: 5000,
      domainEvents,
    });

    controller.start();
    controller.stop();

    expect(bridge.broadcastWatchdogState).toHaveBeenCalledWith("s3", null);
  });

  it("skips relaunch for archived sessions", async () => {
    vi.useFakeTimers();
    const domainEvents = new DomainEventBus();
    const relaunch = vi.fn(async () => true);
    const launcher = {
      getStartingSessions: vi.fn(() => [
        { sessionId: "s4", state: "starting", cwd: "/tmp", createdAt: 1, archived: true },
      ]),
      relaunch,
    } as any;
    const bridge = {
      broadcastWatchdogState: vi.fn(),
      applyPolicyCommand: vi.fn(),
    } as any;
    const logger = { info: vi.fn(), warn: vi.fn() } as any;

    const controller = new ReconnectPolicy({
      launcher,
      bridge,
      logger,
      reconnectGracePeriodMs: 5000,
      domainEvents,
    });

    controller.start();
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.resolve();

    expect(bridge.applyPolicyCommand).toHaveBeenCalledWith("s4", { type: "reconnect_timeout" });
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("continues relaunching remaining sessions when one relaunch fails", async () => {
    vi.useFakeTimers();
    const domainEvents = new DomainEventBus();
    const relaunch = vi.fn(async (sessionId: string) => {
      if (sessionId === "s5-a") throw new Error("boom");
      return true;
    });
    const launcher = {
      getStartingSessions: vi.fn(
        () =>
          [
            { sessionId: "s5-a", state: "starting", cwd: "/tmp", createdAt: 1 },
            { sessionId: "s5-b", state: "starting", cwd: "/tmp", createdAt: 1 },
          ] as any[],
      ),
      relaunch,
    } as any;
    const bridge = {
      broadcastWatchdogState: vi.fn(),
      applyPolicyCommand: vi.fn(),
    } as any;
    const logger = { info: vi.fn(), warn: vi.fn() } as any;

    const controller = new ReconnectPolicy({
      launcher,
      bridge,
      logger,
      reconnectGracePeriodMs: 5000,
      domainEvents,
    });

    controller.start();
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.resolve();

    expect(relaunch).toHaveBeenCalledWith("s5-a");
    expect(relaunch).toHaveBeenCalledWith("s5-b");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Watchdog relaunch failed for session s5-a"),
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it("is a no-op when there are no starting sessions", async () => {
    vi.useFakeTimers();
    const domainEvents = new DomainEventBus();
    const launcher = {
      getStartingSessions: vi.fn(() => []),
      relaunch: vi.fn(async () => true),
    } as any;
    const bridge = {
      broadcastWatchdogState: vi.fn(),
      applyPolicyCommand: vi.fn(),
    } as any;
    const logger = { info: vi.fn(), warn: vi.fn() } as any;

    const controller = new ReconnectPolicy({
      launcher,
      bridge,
      logger,
      reconnectGracePeriodMs: 5000,
      domainEvents,
    });

    controller.start();
    await vi.advanceTimersByTimeAsync(6000);
    await Promise.resolve();

    expect(bridge.broadcastWatchdogState).not.toHaveBeenCalled();
    expect(bridge.applyPolicyCommand).not.toHaveBeenCalled();
    expect(launcher.relaunch).not.toHaveBeenCalled();
  });
});
