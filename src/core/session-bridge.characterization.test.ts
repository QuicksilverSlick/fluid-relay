import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import type { WebSocketLike } from "../interfaces/transport.js";
import {
  createBridgeWithAdapter,
  type MockBackendAdapter,
  tick,
  translateAndPush,
} from "../testing/adapter-test-helpers.js";
import type { ConsumerMessage } from "../types/consumer-messages.js";
import type { SessionBridge } from "./session-bridge.js";

function createMockSocket(): WebSocketLike & {
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

async function setupSession(
  bridge: SessionBridge,
  adapter: MockBackendAdapter,
  sessionId = "char-session",
) {
  const consumer = createMockSocket();

  await bridge.connectBackend(sessionId);
  const backendSession = adapter.getSession(sessionId)!;
  bridge.handleConsumerOpen(consumer, { sessionId, transport: {} });

  consumer.sentMessages.length = 0;
  return { backendSession, consumer };
}

function allMessages(socket: { sentMessages: string[] }): ConsumerMessage[] {
  return socket.sentMessages.map((s) => JSON.parse(s));
}

describe("SessionBridge Characterization", () => {
  let bridge: SessionBridge;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    adapter = created.adapter;
  });

  it("system.init broadcasts session_init and triggers initialize request", async () => {
    const { backendSession, consumer } = await setupSession(bridge, adapter);

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

    const initMsg = allMessages(consumer).find((m) => m.type === "session_init") as any;
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
    const { backendSession, consumer } = await setupSession(bridge, adapter);

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

    const permission = allMessages(consumer).find((m) => m.type === "permission_request") as any;
    expect(permission).toBeDefined();
    expect(permission.request.request_id).toBe("perm-req-1");
    expect(permission.request.tool_name).toBe("Bash");
    expect(permission.request.input).toEqual({ command: "ls" });
  });

  it("keep_alive is translated to null and produces no consumer message", async () => {
    const { backendSession, consumer } = await setupSession(bridge, adapter);

    const result = translateAndPush(backendSession, JSON.stringify({ type: "keep_alive" }));
    expect(result).toBeNull();
    await tick();

    expect(allMessages(consumer)).toHaveLength(0);
  });

  it("assistant mixed content keeps mapped consumer block shapes", async () => {
    const { backendSession, consumer } = await setupSession(bridge, adapter);

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

    const assistant = allMessages(consumer).find((m) => m.type === "assistant") as any;
    expect(assistant).toBeDefined();
    expect(assistant.message.content).toEqual([
      { type: "text", text: "Here is the analysis:" },
      { type: "code", language: "python", code: "print('hello')" },
      { type: "image", media_type: "image/jpeg", data: "/9j/4AAQ..." },
      { type: "refusal", refusal: "Cannot show private data" },
    ]);
  });

  it("initialize error fallback still emits capabilities_ready from slash_commands", async () => {
    const { backendSession, consumer } = await setupSession(bridge, adapter);

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

    const capabilities = allMessages(consumer).find((m) => m.type === "capabilities_ready") as any;
    expect(capabilities).toBeDefined();
    expect(capabilities.commands).toEqual([
      { name: "compact", description: "" },
      { name: "help", description: "" },
    ]);
  });
});
