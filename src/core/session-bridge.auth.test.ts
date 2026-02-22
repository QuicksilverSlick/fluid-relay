import { describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import type { Authenticator, ConsumerIdentity } from "../interfaces/auth.js";
import {
  MockBackendAdapter,
  makeAssistantUnifiedMsg,
  makePermissionRequestUnifiedMsg,
  makeSessionInitMsg,
  noopLogger,
  tick,
} from "../testing/adapter-test-helpers.js";
import {
  authContext,
  createTestSocket as createMockSocket,
} from "../testing/cli-message-factories.js";
import { SessionBridge } from "./session-bridge.js";

function createBridge(options?: {
  authenticator?: Authenticator;
  config?: { port: number; authTimeoutMs?: number };
}) {
  const adapter = new MockBackendAdapter();
  const bridge = new SessionBridge({
    authenticator: options?.authenticator,
    config: options?.config ?? { port: 3456 },
    logger: noopLogger,
    adapter,
  });
  return { bridge, adapter };
}

const flushAuth = () => new Promise((r) => setTimeout(r, 0));

describe("SessionBridge — auth integration", () => {
  it("synchronous authenticator throw is caught and auth fails", () => {
    const authenticator: Authenticator = {
      authenticate: () => {
        throw new Error("sync boom");
      },
    };
    const { bridge } = createBridge({ authenticator });
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
    const { bridge } = createBridge({
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
    const { bridge } = createBridge({ authenticator });
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
    const { bridge, adapter } = createBridge({ authenticator });
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
    const { bridge, adapter } = createBridge({ authenticator });
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

    const { bridge, adapter } = createBridge({ authenticator });
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
