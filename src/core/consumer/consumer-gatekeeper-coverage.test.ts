/**
 * Additional branch-coverage tests for ConsumerGatekeeper.
 *
 * Targets three previously-uncovered lines:
 *   - Line 102: `if (timeoutHandle) clearTimeout(timeoutHandle)` — timeout cleanup
 *   - Line 112: `if (!cleanup()) return null` inside `.catch()` — socket closed during auth error
 *   - Line 137: fallback rate-limit config when `consumerMessageRateLimit` is absent from config
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TokenBucketLimiter } from "../../adapters/token-bucket-limiter.js";
import type { Authenticator, ConsumerIdentity } from "../../interfaces/auth.js";
import {
  authContext,
  createTestSocket,
  flushPromises,
} from "../../testing/cli-message-factories.js";
import type { ResolvedConfig } from "../../types/config.js";
import { DEFAULT_CONFIG, resolveConfig } from "../../types/config.js";
import { ConsumerGatekeeper, type RateLimiterFactory } from "./consumer-gatekeeper.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const defaultRateLimiterFactory: RateLimiterFactory = (
  burstSize,
  refillIntervalMs,
  tokensPerInterval,
) => new TokenBucketLimiter(burstSize, refillIntervalMs, tokensPerInterval);

function makeIdentity(role: "participant" | "observer" = "participant"): ConsumerIdentity {
  return { userId: "u1", displayName: "Alice", role };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ConsumerGatekeeper — coverage gap tests", () => {
  // ─── Test 1: auth timeout cleanup (line 102) ──────────────────────────────

  describe("auth timeout cleanup", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("clears the auth timeout when auth completes before timeout", async () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

      const id = makeIdentity();
      const authenticator: Authenticator = {
        authenticate: vi.fn().mockResolvedValue(id),
      };

      // Use a very long auth timeout so the timer is still pending when auth resolves
      const longTimeoutConfig = resolveConfig({ port: 3456, authTimeoutMs: 60_000 });
      const gk = new ConsumerGatekeeper(
        authenticator,
        longTimeoutConfig,
        defaultRateLimiterFactory,
      );
      const ws = createTestSocket();

      const promise = gk.authenticateAsync(ws, authContext("sess-1"));

      // Flush the microtask queue so the auth promise resolves and cleanup() runs
      await flushPromises();

      const result = await promise;

      expect(result).toEqual(id);
      // clearTimeout must have been called to cancel the pending timeout
      expect(clearTimeoutSpy).toHaveBeenCalled();

      // Advance past the original timeout period — no error should be thrown
      vi.advanceTimersByTime(70_000);

      clearTimeoutSpy.mockRestore();
    });
  });

  // ─── Test 2: socket closed during auth — .catch() path (line 112) ─────────

  describe("socket closed during auth (error path)", () => {
    it("returns null when socket closes before auth rejects", async () => {
      let rejectAuth!: (err: Error) => void;
      const authenticator: Authenticator = {
        authenticate: () =>
          new Promise<ConsumerIdentity>((_resolve, reject) => {
            rejectAuth = reject;
          }),
      };

      const config = resolveConfig({ port: 3456 });
      const gk = new ConsumerGatekeeper(authenticator, config, defaultRateLimiterFactory);
      const ws = createTestSocket();

      // Start auth — the promise hangs until we reject it
      const promise = gk.authenticateAsync(ws, authContext("sess-1"));

      // Simulate the socket closing before auth completes
      gk.cancelPendingAuth(ws);

      // Now make the authenticator reject — cleanup() will return false (already deleted)
      rejectAuth(new Error("connection reset"));

      // The promise should resolve to null rather than rejecting
      const result = await promise;
      expect(result).toBeNull();
    });
  });

  // ─── Test 3: fallback rate-limit config (line 137) ────────────────────────

  describe("createRateLimiter fallback config", () => {
    it("uses default burstSize:20 / tokensPerSecond:50 when consumerMessageRateLimit is not set on the config object", () => {
      // Build a ResolvedConfig where consumerMessageRateLimit is absent by casting.
      // This exercises the `?? { burstSize: 20, tokensPerSecond: 50 }` fallback on line 137.
      const configWithoutRateLimit = {
        ...DEFAULT_CONFIG,
        port: 3456,
        consumerMessageRateLimit: undefined,
      } as unknown as ResolvedConfig;

      const factorySpy = vi.fn(
        (burstSize: number, refillIntervalMs: number, tokensPerInterval: number) =>
          new TokenBucketLimiter(burstSize, refillIntervalMs, tokensPerInterval),
      );

      const gk = new ConsumerGatekeeper(null, configWithoutRateLimit, factorySpy);

      const limiter = gk.createRateLimiter();

      expect(limiter).toBeDefined();
      // The factory must have been called with the fallback defaults
      expect(factorySpy).toHaveBeenCalledWith(
        20, // burstSize fallback
        1000, // refillIntervalMs (always 1000)
        50, // tokensPerSecond fallback
      );
    });

    it("does not throw and returns a working limiter using the fallback defaults", () => {
      const configWithoutRateLimit = {
        ...DEFAULT_CONFIG,
        port: 3456,
        consumerMessageRateLimit: undefined,
      } as unknown as ResolvedConfig;

      const gk = new ConsumerGatekeeper(null, configWithoutRateLimit, defaultRateLimiterFactory);

      const limiter = gk.createRateLimiter();

      expect(limiter).toBeDefined();
      // A fresh limiter with burstSize:20 should allow at least one consume
      expect(limiter!.tryConsume()).toBe(true);
    });
  });
});
