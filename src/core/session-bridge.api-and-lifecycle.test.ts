import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import { TokenBucketLimiter } from "../adapters/token-bucket-limiter.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import {
  createBridgeWithAdapter,
  type MockBackendSession,
  makePermissionRequestUnifiedMsg,
  tick,
} from "../testing/adapter-test-helpers.js";
import type { SessionBridge as SessionBridgeType } from "./session-bridge.js";
import { SessionBridge } from "./session-bridge.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge — Programmatic API", () => {
  let bridge: SessionBridgeType;
  let backendSession: MockBackendSession;

  beforeEach(async () => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;

    // Connect backend (adapter path)
    await bridge.connectBackend("sess-1");
    backendSession = created.adapter.getSession("sess-1")!;
  });

  it("sendUserMessage sends unified user_message to backend", async () => {
    bridge.sendUserMessage("sess-1", "Hello world");

    expect(backendSession.sentMessages).toHaveLength(1);
    const msg = backendSession.sentMessages[0];
    expect(msg.type).toBe("user_message");
    expect(msg.role).toBe("user");
    const textBlock = msg.content.find((b) => b.type === "text");
    expect(textBlock).toBeDefined();
    expect(textBlock!.type === "text" && textBlock!.text).toBe("Hello world");
  });

  it("sendPermissionResponse allows a pending permission", async () => {
    // Push a permission_request via the adapter path
    backendSession.pushMessage(makePermissionRequestUnifiedMsg());
    await tick();
    backendSession.sentMessages.length = 0;

    const resolvedHandler = vi.fn();
    bridge.on("permission:resolved", resolvedHandler);

    bridge.sendPermissionResponse("sess-1", "perm-req-1", "allow");

    expect(backendSession.sentMessages).toHaveLength(1);
    const msg = backendSession.sentMessages[0];
    expect(msg.type).toBe("permission_response");
    expect(msg.metadata.behavior).toBe("allow");
    expect(resolvedHandler).toHaveBeenCalledWith({
      sessionId: "sess-1",
      requestId: "perm-req-1",
      behavior: "allow",
    });
  });
});

// ─── Rate Limiting ────────────────────────────────────────────────────────────

// Mock WebSocket for rate-limiting tests
function createRateLimitSocket(): WebSocketLike {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    send: (_data: string) => {
      // Mock send
    },
    close: () => {
      // Mock close
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    },
  };
}

describe("SessionBridge Integration - Rate Limiting", () => {
  let bridge: SessionBridge;
  const sessionId = "test-session-123";

  beforeEach(() => {
    bridge = new SessionBridge({
      config: {
        port: 3456,
        consumerMessageRateLimit: {
          tokensPerSecond: 10, // 10 messages per second
          burstSize: 5, // Allow 5 burst
        },
      },
      rateLimiterFactory: (burstSize, refillIntervalMs, tokensPerInterval) =>
        new TokenBucketLimiter(burstSize, refillIntervalMs, tokensPerInterval),
    });
  });

  it("rejects messages exceeding rate limit", () => {
    const socket = createRateLimitSocket();
    let rejectionMessage: string | null = null;

    // Override socket.send to capture rejection
    socket.send = (data: string) => {
      const msg = JSON.parse(data);
      if (msg.type === "error") {
        rejectionMessage = msg.message;
      }
    };

    // Simulate consumer connection
    const session = bridge.getOrCreateSession(sessionId);
    session.consumerSockets.set(socket, {
      userId: "user-1",
      displayName: "Test User",
      role: "participant",
    });

    // Send messages to exceed limit
    // With 5 burst size, after 5 messages the next ones should be rejected
    for (let i = 0; i < 10; i++) {
      bridge.handleConsumerMessage(
        socket,
        sessionId,
        JSON.stringify({
          type: "user_message",
          content: `Message ${i}`,
        }),
      );
    }

    // Some messages should have been rejected
    expect(rejectionMessage).toContain("Rate limit exceeded");
  });
});
