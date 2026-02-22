import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainEventBus } from "../events/domain-event-bus.js";
import { IdlePolicy } from "./idle-policy.js";

describe("IdlePolicy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes idle sessions and emits idle_reap policy command", async () => {
    vi.useFakeTimers();
    const domainEvents = new DomainEventBus();
    const bridge = {
      getAllSessions: vi.fn(() => [{ session_id: "s1" }]),
      getSession: vi.fn(() => ({
        id: "s1",
        cliConnected: false,
        consumerCount: 0,
        lastActivity: Date.now() - 20_000,
      })),
      closeSession: vi.fn(async () => undefined),
      applyPolicyCommand: vi.fn(),
      broadcastWatchdogState: vi.fn(),
    } as any;
    const logger = { info: vi.fn(), warn: vi.fn() } as any;

    const policy = new IdlePolicy({
      bridge,
      logger,
      idleSessionTimeoutMs: 5_000,
      domainEvents,
    });

    policy.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(bridge.applyPolicyCommand).toHaveBeenCalledWith("s1", { type: "idle_reap" });
    expect(bridge.closeSession).toHaveBeenCalledWith("s1");
    policy.stop();
  });

  it("stop() clears eventSweepTimer if pending", async () => {
    vi.useFakeTimers();
    const domainEvents = new DomainEventBus();
    const bridge = {
      getAllSessions: vi.fn(() => []),
      getSession: vi.fn(() => null),
      closeSession: vi.fn(async () => undefined),
      applyPolicyCommand: vi.fn(),
    } as any;
    const logger = { info: vi.fn(), warn: vi.fn() } as any;

    const policy = new IdlePolicy({
      bridge,
      logger,
      idleSessionTimeoutMs: 10_000,
      domainEvents,
    });

    policy.start();

    // Trigger a domain event to schedule eventSweepTimer (via requestEventSweep)
    domainEvents.emit("consumer:disconnected", { payload: {} } as any);

    // stop() before the eventSweepTimer fires — should clear it without crashing
    policy.stop();

    // Advance time — no sweep should run (policy is stopped)
    await vi.advanceTimersByTimeAsync(100);

    // Verify no sessions were processed (bridge not called with sessions)
    expect(bridge.closeSession).not.toHaveBeenCalled();
  });
});
