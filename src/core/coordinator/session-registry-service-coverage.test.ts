/**
 * Coverage tests for BackendRecoveryService — targets two uncovered branches:
 *
 *  Line 88  — `info.adapterName ?? "unknown"`:  the nullish-coalesce fallback
 *             when a no-PID session has no adapterName set.
 *
 *  Line 132 — `if (this.stopped) return;` inside the scheduleDedupClear timer
 *             callback: the `true` branch when the service has been stopped but
 *             the timer fires before being garbage-collected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../interfaces/logger.js";
import type { SessionLauncher } from "../interfaces/session-launcher.js";
import type { SessionRegistry } from "../interfaces/session-registry.js";
import { BackendRecoveryService, type RecoveryBridge } from "./backend-recovery-service.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockDeps() {
  const launcher = {
    relaunch: vi.fn().mockResolvedValue(true),
  } as unknown as SessionLauncher;

  const registry = {
    getSession: vi.fn(),
    markConnected: vi.fn(),
  } as unknown as SessionRegistry;

  const bridge = {
    isBackendConnected: vi.fn().mockReturnValue(false),
    connectBackend: vi.fn().mockResolvedValue(undefined),
  } as unknown as RecoveryBridge;

  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  return { launcher, registry, bridge, logger };
}

function createService(overrides?: Partial<ReturnType<typeof createMockDeps>>) {
  const deps = { ...createMockDeps(), ...overrides };
  const service = new BackendRecoveryService({
    ...deps,
    relaunchDedupMs: 5000,
    initializeTimeoutMs: 5000,
    killGracePeriodMs: 5000,
  });
  return { service, ...deps };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("BackendRecoveryService — uncovered branch coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Line 88: adapterName ?? "unknown" ─────────────────────────────────────

  describe("adapterName nullish-coalesce fallback (line 88)", () => {
    it("logs 'unknown' when adapterName is undefined on a no-PID session", async () => {
      const { service, registry, bridge, logger } = createService();

      // Session without adapterName set — exercises `info.adapterName ?? "unknown"`
      vi.mocked(registry.getSession).mockReturnValue({
        sessionId: "no-adapter",
        pid: undefined,
        state: "exited",
        cwd: "/tmp",
        archived: false,
        adapterName: undefined,
        createdAt: Date.now(),
      } as any);
      vi.mocked(bridge.isBackendConnected).mockReturnValue(false);

      void service.handleRelaunchNeeded("no-adapter");
      await vi.advanceTimersByTimeAsync(1);

      // The log message should contain "unknown" (from the ?? fallback)
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("unknown"));
      expect(bridge.connectBackend).toHaveBeenCalledWith("no-adapter", expect.anything());
    });
  });

  // ── Line 132: if (this.stopped) return — true branch ─────────────────────

  describe("scheduleDedupClear timer callback — stopped guard (line 132)", () => {
    it("timer callback returns early when service.stopped is true", async () => {
      const { service, registry, bridge } = createService();

      vi.mocked(registry.getSession).mockReturnValue({
        sessionId: "s1",
        pid: undefined,
        state: "exited",
        cwd: "/tmp",
        archived: false,
        adapterName: "gemini",
        createdAt: Date.now(),
      } as any);
      vi.mocked(bridge.isBackendConnected).mockReturnValue(false);

      // Trigger a reconnect — this schedules the dedup-clear timer internally
      void service.handleRelaunchNeeded("s1");
      await vi.advanceTimersByTimeAsync(1);

      // Prevent stop() from actually cancelling the pending timer so that
      // the timer callback still fires when we advance time.
      const origClearTimeout = globalThis.clearTimeout;
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});

      service.stop(); // sets this.stopped = true; tries (and fails) to clear timer

      clearTimeoutSpy.mockRestore();
      globalThis.clearTimeout = origClearTimeout;

      // Advance past the 5000 ms dedup window — the timer fires while stopped === true,
      // hitting the `if (this.stopped) return` true branch without throwing.
      await expect(vi.advanceTimersByTimeAsync(6000)).resolves.not.toThrow();
    });
  });
});
