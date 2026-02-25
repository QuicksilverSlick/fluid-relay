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

function makeConfigWithoutRateLimit(): ResolvedConfig {
  return {
    ...DEFAULT_CONFIG,
    port: 3456,
    consumerMessageRateLimit: undefined,
  } as unknown as ResolvedConfig;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ConsumerGatekeeper — coverage gap tests", () => {
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
      const gk = new ConsumerGatekeeper(
        authenticator,
        resolveConfig({ port: 3456, authTimeoutMs: 60_000 }),
        defaultRateLimiterFactory,
      );
      const ws = createTestSocket();

      const promise = gk.authenticateAsync(ws, authContext("sess-1"));
      await flushPromises();
      const result = await promise;

      expect(result).toEqual(id);
      expect(clearTimeoutSpy).toHaveBeenCalled();

      vi.advanceTimersByTime(70_000);
      clearTimeoutSpy.mockRestore();
    });
  });

  describe("socket closed during auth (error path)", () => {
    it("returns null when socket closes before auth rejects", async () => {
      let rejectAuth!: (err: Error) => void;
      const authenticator: Authenticator = {
        authenticate: () =>
          new Promise<ConsumerIdentity>((_resolve, reject) => {
            rejectAuth = reject;
          }),
      };
      const gk = new ConsumerGatekeeper(
        authenticator,
        resolveConfig({ port: 3456 }),
        defaultRateLimiterFactory,
      );
      const ws = createTestSocket();

      const promise = gk.authenticateAsync(ws, authContext("sess-1"));
      gk.cancelPendingAuth(ws);
      rejectAuth(new Error("connection reset"));

      expect(await promise).toBeNull();
    });
  });

  describe("createRateLimiter fallback config", () => {
    it("calls factory with default burstSize:20 / tokensPerSecond:50 when consumerMessageRateLimit is absent", () => {
      const factorySpy = vi.fn(
        (burstSize: number, refillIntervalMs: number, tokensPerInterval: number) =>
          new TokenBucketLimiter(burstSize, refillIntervalMs, tokensPerInterval),
      );
      const gk = new ConsumerGatekeeper(null, makeConfigWithoutRateLimit(), factorySpy);

      const limiter = gk.createRateLimiter();

      expect(limiter).toBeDefined();
      expect(factorySpy).toHaveBeenCalledWith(20, 1000, 50);
    });

    it("returns a working limiter using the fallback defaults", () => {
      const gk = new ConsumerGatekeeper(
        null,
        makeConfigWithoutRateLimit(),
        defaultRateLimiterFactory,
      );

      const limiter = gk.createRateLimiter();

      expect(limiter).toBeDefined();
      expect(limiter!.tryConsume()).toBe(true);
    });
  });
});
