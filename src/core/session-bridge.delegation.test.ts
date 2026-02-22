import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import {
  createBridgeWithAdapter,
  ErrorBackendAdapter,
  MockBackendAdapter,
  type MockBackendSession,
  makeResultUnifiedMsg,
  makeSessionInitMsg,
  makeStatusChangeMsg,
  makeStreamEventUnifiedMsg,
  noopLogger,
  setupInitializedSession,
  tick,
} from "../testing/adapter-test-helpers.js";
import {
  authContext,
  createTestSocket as createMockSocket,
  findMessage,
} from "../testing/cli-message-factories.js";
import { SessionBridge } from "./session-bridge.js";

// ─── Local Helpers ────────────────────────────────────────────────────────────

/** Check whether the backend received a user_message with the given text content. */
function backendReceivedUserMessage(backendSession: MockBackendSession, text: string): boolean {
  return backendSession.sentMessages.some(
    (m) =>
      m.type === "user_message" &&
      m.content.some((c) => c.type === "text" && "text" in c && c.text === text),
  );
}

/** Set up a session via the adapter path with a consumer connected. */
async function setupSessionWithConsumer(bridge: SessionBridge, adapter: MockBackendAdapter) {
  const backendSession = await setupInitializedSession(bridge, adapter, "sess-1");

  const consumerSocket = createMockSocket();
  bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
  consumerSocket.sentMessages.length = 0;

  return { backendSession, consumerSocket };
}

/** Simulate a status change coming from the backend. */
async function simulateStatusChange(backendSession: MockBackendSession, status: string | null) {
  backendSession.pushMessage(makeStatusChangeMsg({ status }));
  await tick();
}

/** Simulate the backend starting a response (stream_event message_start). */
async function simulateMessageStart(backendSession: MockBackendSession) {
  backendSession.pushMessage(
    makeStreamEventUnifiedMsg({
      event: { type: "message_start" },
      parent_tool_use_id: null,
    }),
  );
  await tick();
}

/** Simulate the backend completing a turn (result message). */
async function simulateResult(backendSession: MockBackendSession) {
  backendSession.pushMessage(makeResultUnifiedMsg());
  await tick();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge — delegation integration", () => {
  // ── Backend stream error handling ───────────────────────────────────

  describe("backend stream error handling", () => {
    it("emits error on stream error", async () => {
      const errorAdapter = new ErrorBackendAdapter();
      const { bridge: errorBridge } = createBridgeWithAdapter({ adapter: errorAdapter });

      const errorHandler = vi.fn();
      errorBridge.on("error", errorHandler);

      await errorBridge.connectBackend("sess-1");
      await tick(50);

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "backendConsumption",
          sessionId: "sess-1",
        }),
      );
    });
  });

  // ── Queue multi-consumer authorship ─────────────────────────────────

  describe("queue multi-consumer authorship", () => {
    let bridge: SessionBridge;
    let adapter: MockBackendAdapter;

    beforeEach(() => {
      const created = createBridgeWithAdapter();
      bridge = created.bridge;
      adapter = created.adapter;
    });

    it("rejects update from a different user", async () => {
      const { consumerSocket, backendSession } = await setupSessionWithConsumer(bridge, adapter);

      await simulateStatusChange(backendSession, "running");
      consumerSocket.sentMessages.length = 0;

      // Queue a message from the first consumer
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "original" }),
      );

      // Create a second consumer
      const consumer2 = createMockSocket();
      bridge.handleConsumerOpen(consumer2, authContext("sess-1"));
      consumer2.sentMessages.length = 0;

      // Try to update from the second consumer
      bridge.handleConsumerMessage(
        consumer2,
        "sess-1",
        JSON.stringify({ type: "update_queued_message", content: "hacked" }),
      );

      const errorMsg = findMessage(consumer2, "error");
      expect(errorMsg).toBeDefined();
      expect(errorMsg.message).toContain("Only the message author");
    });

    it("rejects cancel from a different user", async () => {
      const { consumerSocket, backendSession } = await setupSessionWithConsumer(bridge, adapter);

      await simulateStatusChange(backendSession, "running");
      consumerSocket.sentMessages.length = 0;

      // Queue a message from the first consumer
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "mine" }),
      );

      // Create a second consumer
      const consumer2 = createMockSocket();
      bridge.handleConsumerOpen(consumer2, authContext("sess-1"));
      consumer2.sentMessages.length = 0;

      // Try to cancel from the second consumer
      bridge.handleConsumerMessage(
        consumer2,
        "sess-1",
        JSON.stringify({ type: "cancel_queued_message" }),
      );

      const errorMsg = findMessage(consumer2, "error");
      expect(errorMsg).toBeDefined();
      expect(errorMsg.message).toContain("Only the message author");
    });
  });

  // ── Queue realistic CLI flow ────────────────────────────────────────

  describe("queue realistic CLI flow", () => {
    let bridge: SessionBridge;
    let adapter: MockBackendAdapter;

    beforeEach(() => {
      const created = createBridgeWithAdapter();
      bridge = created.bridge;
      adapter = created.adapter;
    });

    it("queues message when CLI is streaming (message_start sets running)", async () => {
      const { consumerSocket, backendSession } = await setupSessionWithConsumer(bridge, adapter);

      await simulateMessageStart(backendSession);
      consumerSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "queued via stream" }),
      );

      const queued = findMessage(consumerSocket, "message_queued");
      expect(queued).toBeDefined();
      expect(queued.content).toBe("queued via stream");
    });

    it("auto-sends queued message when CLI sends result", async () => {
      const { backendSession, consumerSocket } = await setupSessionWithConsumer(bridge, adapter);

      await simulateMessageStart(backendSession);
      consumerSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "send on idle" }),
      );
      backendSession.sentMessages.length = 0;
      consumerSocket.sentMessages.length = 0;

      await simulateResult(backendSession);

      const sent = findMessage(consumerSocket, "queued_message_sent");
      expect(sent).toBeDefined();

      expect(backendReceivedUserMessage(backendSession, "send on idle")).toBe(true);
    });

    it("queues message sent right after user_message (optimistic running)", async () => {
      const { backendSession, consumerSocket } = await setupSessionWithConsumer(bridge, adapter);

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "first message" }),
      );
      backendSession.sentMessages.length = 0;
      consumerSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "follow-up" }),
      );

      const queued = findMessage(consumerSocket, "message_queued");
      expect(queued).toBeDefined();
      expect(queued.content).toBe("follow-up");
    });
  });

  // ── Git info refresh on result ──────────────────────────────────────

  describe("git info refresh on result", () => {
    it("result message refreshes git info and broadcasts session_update if changed", async () => {
      const mockGitResolver = {
        resolve: vi.fn().mockReturnValue({
          branch: "main",
          isWorktree: false,
          repoRoot: "/repo",
          ahead: 0,
          behind: 0,
        }),
      };
      const gitAdapter = new MockBackendAdapter();
      const gitBridge = new SessionBridge({
        gitResolver: mockGitResolver,
        config: { port: 3456 },
        logger: noopLogger,
        adapter: gitAdapter,
      });

      await gitBridge.connectBackend("sess-1");
      const gitBackendSession = gitAdapter.getSession("sess-1")!;

      const gitConsumerSocket = createMockSocket();
      gitBridge.handleConsumerOpen(gitConsumerSocket, authContext("sess-1"));

      gitBackendSession.pushMessage(makeSessionInitMsg());
      await tick();
      gitConsumerSocket.sentMessages.length = 0;

      mockGitResolver.resolve.mockReturnValue({
        branch: "main",
        isWorktree: false,
        repoRoot: "/repo",
        ahead: 3,
        behind: 0,
      });

      gitBackendSession.pushMessage(makeResultUnifiedMsg());
      await tick();

      const parsed = gitConsumerSocket.sentMessages.map((m: string) => JSON.parse(m));
      const updateMsg = parsed.find(
        (m: any) => m.type === "session_update" && m.session?.git_ahead !== undefined,
      );
      expect(updateMsg).toBeDefined();
      expect(updateMsg.session.git_ahead).toBe(3);
      expect(updateMsg.session.git_branch).toBe("main");

      const state = gitBridge.getSession("sess-1")!.state;
      expect(state.git_ahead).toBe(3);
    });

    it("result message does not broadcast session_update when git info unchanged", async () => {
      const mockGitResolver = {
        resolve: vi.fn().mockReturnValue({
          branch: "main",
          isWorktree: false,
          repoRoot: "/repo",
          ahead: 0,
          behind: 0,
        }),
      };
      const gitAdapter = new MockBackendAdapter();
      const gitBridge = new SessionBridge({
        gitResolver: mockGitResolver,
        config: { port: 3456 },
        logger: noopLogger,
        adapter: gitAdapter,
      });

      await gitBridge.connectBackend("sess-1");
      const gitBackendSession = gitAdapter.getSession("sess-1")!;
      const gitConsumerSocket = createMockSocket();
      gitBridge.handleConsumerOpen(gitConsumerSocket, authContext("sess-1"));

      gitBackendSession.pushMessage(makeSessionInitMsg());
      await tick();
      gitConsumerSocket.sentMessages.length = 0;

      gitBackendSession.pushMessage(makeResultUnifiedMsg());
      await tick();

      const parsed = gitConsumerSocket.sentMessages.map((m: string) => JSON.parse(m));
      const updateMsg = parsed.find(
        (m: any) => m.type === "session_update" && m.session?.git_ahead !== undefined,
      );
      expect(updateMsg).toBeUndefined();
    });
  });
});
