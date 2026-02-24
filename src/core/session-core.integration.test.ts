import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import type { Authenticator, ConsumerIdentity } from "../interfaces/auth.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import {
  type BridgeTestWrapper,
  createBridgeWithAdapter,
  type MockBackendAdapter,
  type MockBackendSession,
  makeAssistantUnifiedMsg,
  makePermissionRequestUnifiedMsg,
  makeSessionInitMsg,
  noopLogger,
  tick,
  translateAndPush,
} from "../testing/adapter-test-helpers.js";
import {
  authContext,
  createTestSocket as createMockSocket,
} from "../testing/cli-message-factories.js";
import type { ConsumerMessage } from "../types/consumer-messages.js";

// ─── Programmatic API ───────────────────────────────────────────────────────

describe("Session Core — Programmatic API", () => {
  let bridge: BridgeTestWrapper;
  let backendSession: MockBackendSession;

  beforeEach(async () => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;

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

  it("restoreFromStorage rehydrates persisted session snapshots", () => {
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

  it("seedSessionState applies seeded and git-resolved fields to consumer session_init", () => {
    const mockGitResolver = {
      resolve: vi.fn().mockReturnValue({
        branch: "develop",
        isWorktree: false,
        repoRoot: "/project",
        ahead: 0,
        behind: 0,
      }),
    };
    const { bridge: seededBridge } = createBridgeWithAdapter({ gitResolver: mockGitResolver });

    seededBridge.seedSessionState("seed-1", { cwd: "/project", model: "opus" });

    const ws = createMockSocket();
    seededBridge.handleConsumerOpen(ws, authContext("seed-1"));

    const parsed = ws.sentMessages.map((m: string) => JSON.parse(m));
    const initMsg = parsed.find((m: any) => m.type === "session_init");
    expect(initMsg).toBeDefined();
    expect(initMsg.session.cwd).toBe("/project");
    expect(initMsg.session.model).toBe("opus");
    expect(initMsg.session.git_branch).toBe("develop");
    expect(mockGitResolver.resolve).toHaveBeenCalledWith("/project");
  });

  it("flushes storage on close when storage exposes flush()", async () => {
    const storage = {
      save: vi.fn(),
      saveSync: vi.fn(),
      load: vi.fn(() => null),
      loadAll: vi.fn(() => []),
      remove: vi.fn(),
      setArchived: vi.fn(() => false),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    const { bridge: flushBridge } = createBridgeWithAdapter({ storage: storage as any });

    await flushBridge.close();

    expect(storage.flush).toHaveBeenCalledTimes(1);
  });
});

// ─── Auth Integration ───────────────────────────────────────────────────────

function createAuthBridge(options?: {
  authenticator?: Authenticator;
  config?: { port: number; authTimeoutMs?: number };
}) {
  const { bridge, adapter } = createBridgeWithAdapter({
    authenticator: options?.authenticator,
    config: options?.config,
  });
  return { bridge, adapter };
}

const flushAuth = () => new Promise((r) => setTimeout(r, 0));

describe("Session Core — auth integration", () => {
  it("synchronous authenticator throw is caught and auth fails", () => {
    const authenticator: Authenticator = {
      authenticate: () => {
        throw new Error("sync boom");
      },
    };
    const { bridge } = createAuthBridge({ authenticator });
    bridge.getOrCreateSession("sess-1");

    const failed = vi.fn();
    bridge.on("consumer:auth_failed", failed);

    const ws = createMockSocket();
    bridge.handleConsumerOpen(ws, authContext("sess-1"));

    expect(failed).toHaveBeenCalledWith({ sessionId: "sess-1", reason: "sync boom" });
    expect(ws.close).toHaveBeenCalledWith(4001, "Authentication failed");
  });

  it("auth timeout rejects slow authenticators", async () => {
    const authenticator: Authenticator = {
      authenticate: () => new Promise(() => {}),
    };
    const { bridge } = createAuthBridge({
      authenticator,
      config: { port: 3456, authTimeoutMs: 50 },
    });
    bridge.getOrCreateSession("sess-1");

    const failed = vi.fn();
    bridge.on("consumer:auth_failed", failed);

    const ws = createMockSocket();
    bridge.handleConsumerOpen(ws, authContext("sess-1"));
    await new Promise((r) => setTimeout(r, 100));

    expect(failed).toHaveBeenCalledWith({
      sessionId: "sess-1",
      reason: "Authentication timed out",
    });
    expect(ws.close).toHaveBeenCalledWith(4001, "Authentication failed");
  });

  it("session removed during async auth rejects consumer", async () => {
    const authenticator: Authenticator = {
      authenticate: vi.fn().mockResolvedValue({
        userId: "u1",
        displayName: "User 1",
        role: "participant",
      }),
    };
    const { bridge } = createAuthBridge({ authenticator });
    bridge.getOrCreateSession("sess-1");

    const failed = vi.fn();
    bridge.on("consumer:auth_failed", failed);

    const ws = createMockSocket();
    bridge.handleConsumerOpen(ws, authContext("sess-1"));
    bridge.removeSession("sess-1");
    await flushAuth();

    expect(failed).toHaveBeenCalledWith({ sessionId: "sess-1", reason: "Session not found" });
    expect(ws.close).toHaveBeenCalledWith(4404, "Session not found");
  });

  it("drops messages during pending auth and routes after auth resolves", async () => {
    let resolveAuth!: (identity: ConsumerIdentity) => void;
    const authenticator: Authenticator = {
      authenticate: () =>
        new Promise<ConsumerIdentity>((resolve) => {
          resolveAuth = resolve;
        }),
    };
    const { bridge, adapter } = createAuthBridge({ authenticator });
    bridge.getOrCreateSession("sess-1");

    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;
    backendSession.pushMessage(makeSessionInitMsg());
    await tick();

    const ws = createMockSocket();
    bridge.handleConsumerOpen(ws, authContext("sess-1"));

    backendSession.sentMessages.length = 0;
    backendSession.sentRawMessages.length = 0;

    bridge.handleConsumerMessage(
      ws,
      "sess-1",
      JSON.stringify({ type: "user_message", content: "too early" }),
    );

    expect(backendSession.sentMessages).toHaveLength(0);
    expect(backendSession.sentRawMessages).toHaveLength(0);

    resolveAuth({ userId: "u1", displayName: "User 1", role: "participant" });
    await flushAuth();

    bridge.handleConsumerMessage(
      ws,
      "sess-1",
      JSON.stringify({ type: "user_message", content: "now it works" }),
    );

    expect(
      backendSession.sentMessages.length + backendSession.sentRawMessages.length,
    ).toBeGreaterThan(0);
  });

  it("observer receives broadcasts but cannot send participant-only messages", async () => {
    const authenticator: Authenticator = {
      authenticate: vi.fn().mockResolvedValue({
        userId: "obs-1",
        displayName: "Observer",
        role: "observer",
      }),
    };
    const { bridge, adapter } = createAuthBridge({ authenticator });
    bridge.getOrCreateSession("sess-1");

    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;
    backendSession.pushMessage(makeSessionInitMsg());
    await tick();

    const ws = createMockSocket();
    bridge.handleConsumerOpen(ws, authContext("sess-1"));
    await flushAuth();

    ws.sentMessages.length = 0;
    backendSession.sentMessages.length = 0;
    backendSession.sentRawMessages.length = 0;

    backendSession.pushMessage(makeAssistantUnifiedMsg());
    await tick();
    expect(ws.sentMessages.map((m) => JSON.parse(m)).some((m: any) => m.type === "assistant")).toBe(
      true,
    );

    ws.sentMessages.length = 0;
    bridge.handleConsumerMessage(
      ws,
      "sess-1",
      JSON.stringify({ type: "user_message", content: "hello" }),
    );

    expect(backendSession.sentMessages).toHaveLength(0);
    expect(backendSession.sentRawMessages).toHaveLength(0);
    const parsed = ws.sentMessages.map((m) => JSON.parse(m));
    const errorMsg = parsed.find((m: any) => m.type === "error");
    expect(errorMsg).toBeDefined();
    expect(errorMsg.message).toContain("Observers cannot send user_message messages");
  });

  it("permission cancellation on disconnect is sent only to participants", async () => {
    const participant: ConsumerIdentity = {
      userId: "part-1",
      displayName: "Participant",
      role: "participant",
    };
    const observer: ConsumerIdentity = {
      userId: "obs-1",
      displayName: "Observer",
      role: "observer",
    };
    let calls = 0;
    const authenticator: Authenticator = {
      authenticate: () => Promise.resolve(calls++ === 0 ? participant : observer),
    };

    const { bridge, adapter } = createAuthBridge({ authenticator });
    bridge.getOrCreateSession("sess-1");

    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;
    backendSession.pushMessage(makeSessionInitMsg());
    await tick();

    const wsParticipant = createMockSocket();
    bridge.handleConsumerOpen(wsParticipant, authContext("sess-1"));
    await flushAuth();

    const wsObserver = createMockSocket();
    bridge.handleConsumerOpen(wsObserver, authContext("sess-1"));
    await flushAuth();

    backendSession.pushMessage(makePermissionRequestUnifiedMsg());
    await tick();

    wsParticipant.sentMessages.length = 0;
    wsObserver.sentMessages.length = 0;

    await bridge.disconnectBackend("sess-1");

    const participantMsgs = wsParticipant.sentMessages.map((m) => JSON.parse(m));
    const observerMsgs = wsObserver.sentMessages.map((m) => JSON.parse(m));

    expect(participantMsgs.some((m: any) => m.type === "permission_cancelled")).toBe(true);
    expect(observerMsgs.some((m: any) => m.type === "cli_disconnected")).toBe(true);
    expect(observerMsgs.some((m: any) => m.type === "permission_cancelled")).toBe(false);
  });
});

// ─── Characterization ────────────────────────────────────────────────────────

function createCharacterizationSocket(): WebSocketLike & {
  sentMessages: string[];
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const sentMessages: string[] = [];
  return {
    send: vi.fn((data: string) => sentMessages.push(data)),
    close: vi.fn(),
    sentMessages,
  };
}

async function setupCharacterizationSession(
  bridge: BridgeTestWrapper,
  adapter: MockBackendAdapter,
  sessionId = "char-session",
) {
  const consumer = createCharacterizationSocket();

  await bridge.connectBackend(sessionId);
  const backendSession = adapter.getSession(sessionId)!;
  bridge.handleConsumerOpen(consumer, { sessionId, transport: {} });

  consumer.sentMessages.length = 0;
  return { backendSession, consumer };
}

function allCharacterizationMessages(socket: { sentMessages: string[] }): ConsumerMessage[] {
  return socket.sentMessages.map((s) => JSON.parse(s));
}

describe("Session Core Characterization", () => {
  let bridge: BridgeTestWrapper;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    adapter = created.adapter;
  });

  it("system.init broadcasts session_init and triggers initialize request", async () => {
    const { backendSession, consumer } = await setupCharacterizationSession(bridge, adapter);

    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "cli-abc",
        model: "claude-sonnet-4-5-20250929",
        cwd: "/home/user",
        tools: ["Bash"],
        permissionMode: "default",
        claude_code_version: "1.2.3",
        mcp_servers: [],
        slash_commands: ["compact", "help"],
        skills: ["tdd"],
        output_style: "normal",
        uuid: "uuid-init",
      }),
    );
    await tick();

    const initMsg = allCharacterizationMessages(consumer).find(
      (m) => m.type === "session_init",
    ) as any;
    expect(initMsg).toBeDefined();
    expect(initMsg.session.model).toBe("claude-sonnet-4-5-20250929");
    expect(initMsg.session.cwd).toBe("/home/user");

    const initializeReq = backendSession.sentRawMessages.find((raw) => {
      const parsed = JSON.parse(raw);
      return parsed.type === "control_request" && parsed.request?.subtype === "initialize";
    });
    expect(initializeReq).toBeDefined();
  });

  it("control_request can_use_tool broadcasts permission_request", async () => {
    const { backendSession, consumer } = await setupCharacterizationSession(bridge, adapter);

    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "control_request",
        request_id: "perm-req-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "ls" },
          permission_suggestions: [{ type: "allow_once" }],
          description: "Run command",
          tool_use_id: "tu-1",
        },
      }),
    );
    await tick();

    const permission = allCharacterizationMessages(consumer).find(
      (m) => m.type === "permission_request",
    ) as any;
    expect(permission).toBeDefined();
    expect(permission.request.request_id).toBe("perm-req-1");
    expect(permission.request.tool_name).toBe("Bash");
    expect(permission.request.input).toEqual({ command: "ls" });
  });

  it("keep_alive is translated to null and produces no consumer message", async () => {
    const { backendSession, consumer } = await setupCharacterizationSession(bridge, adapter);

    const result = translateAndPush(backendSession, JSON.stringify({ type: "keep_alive" }));
    expect(result).toBeNull();
    await tick();

    expect(allCharacterizationMessages(consumer)).toHaveLength(0);
  });

  it("assistant mixed content keeps mapped consumer block shapes", async () => {
    const { backendSession, consumer } = await setupCharacterizationSession(bridge, adapter);

    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-mixed",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [
            { type: "text", text: "Here is the analysis:" },
            { type: "code", language: "python", code: "print('hello')" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ..." },
            },
            { type: "refusal", refusal: "Cannot show private data" },
          ],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 200,
            output_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
    );
    await tick();

    const assistant = allCharacterizationMessages(consumer).find(
      (m) => m.type === "assistant",
    ) as any;
    expect(assistant).toBeDefined();
    expect(assistant.message.content).toEqual([
      { type: "text", text: "Here is the analysis:" },
      { type: "code", language: "python", code: "print('hello')" },
      { type: "image", media_type: "image/jpeg", data: "/9j/4AAQ..." },
      { type: "refusal", refusal: "Cannot show private data" },
    ]);
  });

  it("initialize error fallback still emits capabilities_ready from slash_commands", async () => {
    const { backendSession, consumer } = await setupCharacterizationSession(bridge, adapter);

    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "cli-abc",
        model: "claude-sonnet-4-5-20250929",
        cwd: "/test",
        tools: [],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        slash_commands: ["compact", "help"],
        skills: [],
        output_style: "normal",
      }),
    );
    await tick();

    const initRaw = backendSession.sentRawMessages.find((raw) => {
      const parsed = JSON.parse(raw);
      return parsed.type === "control_request" && parsed.request?.subtype === "initialize";
    });
    const requestId = JSON.parse(initRaw!).request_id;

    consumer.sentMessages.length = 0;
    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: requestId,
          error: "Already initialized",
        },
      }),
    );
    await tick();

    const capabilities = allCharacterizationMessages(consumer).find(
      (m) => m.type === "capabilities_ready",
    ) as any;
    expect(capabilities).toBeDefined();
    expect(capabilities.commands).toEqual([
      { name: "compact", description: "" },
      { name: "help", description: "" },
    ]);
  });
});

// ─── Event Emission ──────────────────────────────────────────────────────────

describe("Session Core — Event emission", () => {
  let bridge: BridgeTestWrapper;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    adapter = created.adapter;
  });

  it("emits backend connected/disconnected lifecycle events", async () => {
    const connected = vi.fn();
    const disconnected = vi.fn();
    bridge.on("backend:connected", connected);
    bridge.on("backend:disconnected", disconnected);

    await bridge.connectBackend("sess-1");
    expect(connected).toHaveBeenCalledWith({ sessionId: "sess-1" });

    await bridge.disconnectBackend("sess-1");
    expect(disconnected).toHaveBeenCalledWith({
      sessionId: "sess-1",
      code: 1000,
      reason: "normal",
    });
  });

  it("emits message:inbound for every consumer message", async () => {
    await bridge.connectBackend("sess-1");
    const ws = createMockSocket();
    bridge.handleConsumerOpen(ws, authContext("sess-1"));

    const handler = vi.fn();
    bridge.on("message:inbound", handler);

    bridge.handleConsumerMessage(ws, "sess-1", JSON.stringify({ type: "interrupt" }));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        message: { type: "interrupt" },
      }),
    );
  });

  it("emits error when sendToBackend fails", async () => {
    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;

    backendSession.send = () => {
      throw new Error("Backend write failed");
    };

    const handler = vi.fn();
    bridge.on("error", handler);

    bridge.sendToBackend("sess-1", makeAssistantUnifiedMsg());

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "sendToBackend",
        error: expect.any(Error),
        sessionId: "sess-1",
      }),
    );
  });
});

// ─── Behavior lock: connectBackend event ordering ───────────────────────────

describe("Session Core — connectBackend event ordering (behavior lock)", () => {
  let bridge: BridgeTestWrapper;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    adapter = created.adapter;
  });

  it("backend:connected is emitted before backend:session_id", async () => {
    const events: string[] = [];

    bridge.on("backend:connected", () => events.push("backend:connected"));
    bridge.on("backend:session_id", () => events.push("backend:session_id"));

    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;

    expect(events).toEqual(["backend:connected"]);

    backendSession.pushMessage(makeSessionInitMsg({ session_id: "cli-xyz" }));
    await tick();

    expect(events).toEqual(["backend:connected", "backend:session_id"]);
  });
});
