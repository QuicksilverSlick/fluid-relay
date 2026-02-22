import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import type { MemoryStorage } from "../adapters/memory-storage.js";
import {
  createBridgeWithAdapter,
  type MockBackendAdapter,
  makeAssistantUnifiedMsg,
  makeSessionInitMsg,
  setupInitializedSession,
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
  let storage: MemoryStorage;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    storage = created.storage;
    adapter = created.adapter;
  });
  describe("Persistence", () => {
    it("restoreFromStorage loads persisted sessions", () => {
      // Persist a session manually into storage
      storage.save({
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

      const count = bridge.restoreFromStorage();
      expect(count).toBe(1);

      const snapshot = bridge.getSession("restored-sess");
      expect(snapshot).toBeDefined();
      expect(snapshot!.state.model).toBe("claude-sonnet-4-5-20250929");
      expect(snapshot!.state.cwd).toBe("/restored");
      expect(snapshot!.messageHistoryLength).toBe(1);
    });

    it("restoreFromStorage does not overwrite live sessions", async () => {
      const backendSession = await setupInitializedSession(bridge, adapter, "sess-1");

      // Push a session_init with a specific cwd to establish state
      // (setupInitializedSession already pushes session_init with cwd: "/test")

      // Now put a different version in storage
      storage.save({
        id: "sess-1",
        state: {
          session_id: "sess-1",
          model: "old-model",
          cwd: "/old",
          tools: [],
          permissionMode: "default",
          claude_code_version: "0.1",
          mcp_servers: [],
          slash_commands: [],
          skills: [],
          total_cost_usd: 0,
          num_turns: 0,
          context_used_percent: 0,
          is_compacting: false,
          git_branch: "",
          is_worktree: false,
          repo_root: "",
          git_ahead: 0,
          git_behind: 0,
          total_lines_added: 0,
          total_lines_removed: 0,
        },
        messageHistory: [],
        pendingMessages: [],
        pendingPermissions: [],
      });

      const count = bridge.restoreFromStorage();
      expect(count).toBe(0);
      // Live session should still have the current cwd
      expect(bridge.getSession("sess-1")!.state.cwd).toBe("/test");
    });
  });

  // ── 10. Edge cases ─────────────────────────────────────────────────────

  describe("Edge cases", () => {
    it("consumer socket that throws on send is removed from the set", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      const failSocket = createMockSocket();
      failSocket.send = vi.fn(() => {
        throw new Error("Write failed");
      });
      bridge.handleConsumerOpen(failSocket, authContext("sess-1"));

      // Trigger a broadcast that will cause failSocket to throw
      backendSession.pushMessage(makeAssistantUnifiedMsg());
      await tick();

      // After the failed send, the consumer count should be reduced
      expect(bridge.getSession("sess-1")!.consumerCount).toBe(0);
    });

    it("multiple consumers all receive the same broadcast", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      const consumer1 = createMockSocket();
      const consumer2 = createMockSocket();
      const consumer3 = createMockSocket();
      bridge.handleConsumerOpen(consumer1, authContext("sess-1"));
      bridge.handleConsumerOpen(consumer2, authContext("sess-1"));
      bridge.handleConsumerOpen(consumer3, authContext("sess-1"));

      consumer1.sentMessages.length = 0;
      consumer2.sentMessages.length = 0;
      consumer3.sentMessages.length = 0;

      backendSession.pushMessage(makeAssistantUnifiedMsg());
      await tick();

      for (const consumer of [consumer1, consumer2, consumer3]) {
        const parsed = consumer.sentMessages.map((m) => JSON.parse(m));
        expect(parsed.some((m: any) => m.type === "assistant")).toBe(true);
      }
    });

    it("closeSession handles consumer socket close error gracefully", async () => {
      bridge.getOrCreateSession("sess-1");
      const consumerSocket = createMockSocket();
      consumerSocket.close = vi.fn(() => {
        throw new Error("Already closed");
      });
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      await expect(bridge.closeSession("sess-1")).resolves.toBeUndefined();
      expect(bridge.getSession("sess-1")).toBeUndefined();
    });

    it("sendUserMessage with user_message via consumer includes session_id override", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      // First populate the backend session_id via init
      backendSession.pushMessage(makeSessionInitMsg({ session_id: "cli-real-id" }));
      await tick();

      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      backendSession.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "test", session_id: "cli-real-id" }),
      );

      const userMsg = backendSession.sentMessages.find((m) => m.type === "user_message");
      expect(userMsg).toBeDefined();
      expect(userMsg!.metadata.session_id).toBe("cli-real-id");
    });
  });

  // ── 13. Presence ────────────────────────────────────────────────────────

  describe("Presence", () => {
    it("presence_update broadcast on connect", () => {
      bridge.getOrCreateSession("sess-1");
      const ws1 = createMockSocket();
      bridge.handleConsumerOpen(ws1, authContext("sess-1"));

      const parsed = ws1.sentMessages.map((m) => JSON.parse(m));
      const presenceMsg = parsed.find((m: any) => m.type === "presence_update");
      expect(presenceMsg).toBeDefined();
      expect(presenceMsg.consumers).toHaveLength(1);
      expect(presenceMsg.consumers[0].userId).toBe("anonymous-1");
    });

    it("presence_update broadcast on disconnect", () => {
      bridge.getOrCreateSession("sess-1");
      const ws1 = createMockSocket();
      const ws2 = createMockSocket();
      bridge.handleConsumerOpen(ws1, authContext("sess-1"));
      bridge.handleConsumerOpen(ws2, authContext("sess-1"));

      ws1.sentMessages.length = 0;
      ws2.sentMessages.length = 0;

      bridge.handleConsumerClose(ws2, "sess-1");

      // ws1 should receive a presence_update with only 1 consumer
      const parsed = ws1.sentMessages.map((m) => JSON.parse(m));
      const presenceMsg = parsed.find((m: any) => m.type === "presence_update");
      expect(presenceMsg).toBeDefined();
      expect(presenceMsg.consumers).toHaveLength(1);
    });

    it("presence_update contains all connected consumers with roles", () => {
      bridge.getOrCreateSession("sess-1");
      const ws1 = createMockSocket();
      const ws2 = createMockSocket();
      bridge.handleConsumerOpen(ws1, authContext("sess-1"));
      bridge.handleConsumerOpen(ws2, authContext("sess-1"));

      // Check last presence_update sent to ws1 (triggered by ws2 connecting)
      const allMsgs = ws1.sentMessages.map((m) => JSON.parse(m));
      const presenceMsgs = allMsgs.filter((m: any) => m.type === "presence_update");
      const lastPresence = presenceMsgs[presenceMsgs.length - 1];
      expect(lastPresence.consumers).toHaveLength(2);
      expect(lastPresence.consumers[0]).toEqual(
        expect.objectContaining({ userId: "anonymous-1", role: "participant" }),
      );
      expect(lastPresence.consumers[1]).toEqual(
        expect.objectContaining({ userId: "anonymous-2", role: "participant" }),
      );
    });

    it("presence_query triggers presence broadcast", () => {
      bridge.getOrCreateSession("sess-1");
      const ws1 = createMockSocket();
      const ws2 = createMockSocket();
      bridge.handleConsumerOpen(ws1, authContext("sess-1"));
      bridge.handleConsumerOpen(ws2, authContext("sess-1"));
      ws1.sentMessages.length = 0;
      ws2.sentMessages.length = 0;

      bridge.handleConsumerMessage(ws1, "sess-1", JSON.stringify({ type: "presence_query" }));

      // Both consumers should get presence_update
      for (const ws of [ws1, ws2]) {
        const parsed = ws.sentMessages.map((m) => JSON.parse(m));
        expect(parsed.some((m: any) => m.type === "presence_update")).toBe(true);
      }
    });

    it("getSession includes consumers array", () => {
      bridge.getOrCreateSession("sess-1");
      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("sess-1"));

      const snapshot = bridge.getSession("sess-1")!;
      expect(snapshot.consumers).toHaveLength(1);
      expect(snapshot.consumers[0]).toEqual({
        userId: "anonymous-1",
        displayName: "User 1",
        role: "participant",
      });
    });
  });
});
