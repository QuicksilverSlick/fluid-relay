import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import {
  createBridgeWithAdapter,
  type MockBackendAdapter,
  type MockBackendSession,
  makeAssistantUnifiedMsg,
  makePermissionRequestUnifiedMsg,
  makeResultUnifiedMsg,
  makeSessionInitMsg,
  noopLogger,
  tick,
} from "../testing/adapter-test-helpers.js";
import {
  authContext,
  createTestSocket as createMockSocket,
} from "../testing/cli-message-factories.js";
import type { SessionBridge } from "./session-bridge.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge", () => {
  let bridge: SessionBridge;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    adapter = created.adapter;
  });
  describe("Session management", () => {
    it("closeSession closes backend session, consumer sockets, removes session, and emits event", async () => {
      await bridge.connectBackend("sess-1");
      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      const closedHandler = vi.fn();
      bridge.on("session:closed", closedHandler);

      await bridge.closeSession("sess-1");

      expect(consumerSocket.close).toHaveBeenCalled();
      expect(bridge.getSession("sess-1")).toBeUndefined();
      expect(closedHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });

    it("closeSession is a no-op for nonexistent sessions", async () => {
      await expect(bridge.closeSession("nonexistent")).resolves.toBeUndefined();
    });

    it("close shuts down all sessions and removes all listeners", async () => {
      await bridge.connectBackend("sess-1");
      await bridge.connectBackend("sess-2");

      await bridge.close();

      expect(bridge.getAllSessions()).toHaveLength(0);
    });
  });

  // ── 2. Backend connection handlers ──────────────────────────────────────

  describe("Backend connection handlers", () => {
    it("connectBackend broadcasts cli_connected to consumers", async () => {
      bridge.getOrCreateSession("sess-1");
      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      // Clear messages sent during consumer open
      consumerSocket.sentMessages.length = 0;

      await bridge.connectBackend("sess-1");

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "cli_connected")).toBe(true);
    });

    it("connectBackend flushes queued pending messages", async () => {
      bridge.getOrCreateSession("sess-1");

      // Queue a message while backend is not connected
      bridge.sendUserMessage("sess-1", "Hello");

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      // The queued user message should have been flushed via send()
      expect(backendSession.sentMessages.length).toBeGreaterThanOrEqual(1);
      const flushed = backendSession.sentMessages.some((m) => m.type === "user_message");
      expect(flushed).toBe(true);
    });

    it("backend message routes correctly to consumers", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      consumerSocket.sentMessages.length = 0;

      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "session_init")).toBe(true);
    });

    it("multiple backend messages in sequence are all routed", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      consumerSocket.sentMessages.length = 0;

      backendSession.pushMessage(makeSessionInitMsg());
      await tick();
      backendSession.pushMessage(makeAssistantUnifiedMsg());
      await tick();

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "session_init")).toBe(true);
      expect(parsed.some((m: any) => m.type === "assistant")).toBe(true);
    });

    it("disconnectBackend clears backend session, emits event, and cancels pending permissions", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      // Add a pending permission
      backendSession.pushMessage(makePermissionRequestUnifiedMsg());
      await tick();

      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      consumerSocket.sentMessages.length = 0;

      const handler = vi.fn();
      bridge.on("backend:disconnected", handler);

      await bridge.disconnectBackend("sess-1");

      expect(bridge.isCliConnected("sess-1")).toBe(false);
      expect(handler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        code: 1000,
        reason: "normal",
      });

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "cli_disconnected")).toBe(true);
      expect(parsed.some((m: any) => m.type === "permission_cancelled")).toBe(true);
    });
  });

  // ── 3. Consumer WebSocket handlers ─────────────────────────────────────

  describe("Consumer WebSocket handlers", () => {
    it("handleConsumerMessage routes user_message to backend", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "Hello from consumer" }),
      );

      // In the adapter path, sendUserMessage sends a UnifiedMessage via backendSession.send()
      const userMsg = backendSession.sentMessages.find((m) => m.type === "user_message");
      expect(userMsg).toBeDefined();
      expect(
        userMsg!.content.some((b) => b.type === "text" && b.text === "Hello from consumer"),
      ).toBe(true);
    });
  });

  // ── 6. Consumer message routing ────────────────────────────────────────

  describe("Consumer message routing", () => {
    let backendSession: MockBackendSession;
    let consumerWs: ReturnType<typeof createMockSocket>;

    beforeEach(async () => {
      await bridge.connectBackend("sess-1");
      backendSession = adapter.getSession("sess-1")!;
      consumerWs = createMockSocket();
      bridge.handleConsumerOpen(consumerWs, authContext("sess-1"));
      backendSession.sentMessages.length = 0;
    });

    it("user_message routes through sendUserMessage to backend", () => {
      bridge.handleConsumerMessage(
        consumerWs,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "Hello!" }),
      );

      const userMsg = backendSession.sentMessages.find((m) => m.type === "user_message");
      expect(userMsg).toBeDefined();
      expect(userMsg!.content.some((b) => b.type === "text" && b.text === "Hello!")).toBe(true);
    });

    it("set_adapter returns an error message to the consumer", () => {
      bridge.handleConsumerMessage(
        consumerWs,
        "sess-1",
        JSON.stringify({ type: "set_adapter", adapter: "codex" }),
      );
      const errorMsg = (consumerWs.send as ReturnType<typeof vi.fn>).mock.calls.find(
        ([raw]: [string]) => {
          const parsed = JSON.parse(raw);
          return parsed.type === "error";
        },
      );
      expect(errorMsg).toBeDefined();
      const parsed = JSON.parse(errorMsg![0]);
      expect(parsed.message).toMatch(/cannot be changed/i);
    });
  });
});
