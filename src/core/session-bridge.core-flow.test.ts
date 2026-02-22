import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import {
  createBridgeWithAdapter,
  type MockBackendAdapter,
  type MockBackendSession,
  makePermissionRequestUnifiedMsg,
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
    it("close shuts down all sessions and removes all listeners", async () => {
      await bridge.connectBackend("sess-1");
      await bridge.connectBackend("sess-2");

      await bridge.close();

      expect(bridge.getAllSessions()).toHaveLength(0);
    });

    it("restoreFromStorage loads persisted sessions into bridge snapshots", () => {
      const created = createBridgeWithAdapter();
      const localBridge = created.bridge;
      const localStorage = created.storage;

      localStorage.save({
        id: "restored-sess",
        state: {
          session_id: "restored-sess",
          model: "claude-sonnet-4-5-20250929",
          cwd: "/restored",
          tools: ["Bash"],
          permissionMode: "default",
          claude_code_version: "1.0",
          mcp_servers: [],
          slash_commands: [],
          skills: [],
          total_cost_usd: 0.5,
          num_turns: 10,
          context_used_percent: 25,
          is_compacting: false,
          git_branch: "main",
          is_worktree: false,
          repo_root: "/repo",
          git_ahead: 0,
          git_behind: 0,
          total_lines_added: 100,
          total_lines_removed: 50,
        },
        messageHistory: [{ type: "user_message", content: "hi", timestamp: 12345 }],
        pendingMessages: [],
        pendingPermissions: [],
      });

      expect(localBridge.restoreFromStorage()).toBe(1);
      const snapshot = localBridge.getSession("restored-sess");
      expect(snapshot).toBeDefined();
      expect(snapshot!.state.model).toBe("claude-sonnet-4-5-20250929");
      expect(snapshot!.state.cwd).toBe("/restored");
      expect(snapshot!.messageHistoryLength).toBe(1);
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

  // ── 3. Consumer message routing ────────────────────────────────────────

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
  });
});
