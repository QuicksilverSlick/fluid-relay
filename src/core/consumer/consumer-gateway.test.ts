import { describe, expect, it, vi } from "vitest";
import type { ConsumerIdentity } from "../../interfaces/auth.js";
import {
  createMockSession,
  createTestSocket,
  flushPromises,
} from "../../testing/cli-message-factories.js";
import { CONSUMER_PROTOCOL_VERSION } from "../../types/consumer-messages.js";
import type { InboundCommand } from "../interfaces/runtime-commands.js";
import type { Session } from "../session/session-repository.js";
import type { ConsumerGatewayDeps } from "./consumer-gateway.js";
import { ConsumerGateway } from "./consumer-gateway.js";

function createDeps(overrides?: Partial<ConsumerGatewayDeps>): ConsumerGatewayDeps {
  return {
    sessions: {
      get: vi.fn(() => undefined),
    },
    gatekeeper: {
      hasAuthenticator: vi.fn(() => false),
      authenticateAsync: vi.fn(async () => null),
      createAnonymousIdentity: vi.fn(() => ({
        userId: "u1",
        displayName: "User",
        role: "participant",
      })),
      cancelPendingAuth: vi.fn(),
      authorize: vi.fn(() => true),
      createRateLimiter: vi.fn(() => undefined),
    },
    broadcaster: {
      sendTo: vi.fn(),
      broadcastPresence: vi.fn(),
    },
    gitTracker: {
      resolveGitInfo: vi.fn(),
    } as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    metrics: null,
    emit: vi.fn(),
    allocateAnonymousIdentityIndex: vi.fn(() => 1),
    checkRateLimit: vi.fn(() => true),
    getConsumerIdentity: vi.fn(() => undefined),
    getConsumerCount: vi.fn(() => 0),
    getState: vi.fn(),
    getMessageHistory: vi.fn(() => []),
    getPendingPermissions: vi.fn(() => []),
    getQueuedMessage: vi.fn(() => null),
    isBackendConnected: vi.fn(() => false),
    registerConsumer: vi.fn(),
    unregisterConsumer: vi.fn(),
    routeConsumerMessage: vi.fn(),
    maxConsumerMessageSize: 256 * 1024,
    tracer: {
      recv: vi.fn(),
      send: vi.fn(),
      translate: vi.fn(),
      error: vi.fn(),
    } as any,
    ...overrides,
  };
}

describe("ConsumerGateway", () => {
  function createHarness(options?: {
    sessionExists?: boolean;
    hasAuthenticator?: boolean;
    backendConnected?: boolean;
    identity?: ConsumerIdentity;
    authorize?: boolean;
    rateLimited?: boolean;
    state?: Session["state"];
    history?: Session["messageHistory"];
    pendingPermissions?: any[];
    queuedMessage?: Session["queuedMessage"];
  }) {
    const session = createMockSession({ id: "s1" });
    if (options?.state) session.data.state = options.state;
    if (options?.history) session.data.messageHistory = options.history;
    if (options?.queuedMessage !== undefined) session.data.queuedMessage = options.queuedMessage;
    if (options?.pendingPermissions) {
      session.data.pendingPermissions.clear();
      for (const p of options.pendingPermissions) {
        session.data.pendingPermissions.set(p.request_id, p);
      }
    }

    const sockets = new Map<any, ConsumerIdentity>();
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const identity =
      options?.identity ?? ({ userId: "u1", displayName: "User 1", role: "participant" } as const);

    const metrics = { recordEvent: vi.fn() } as any;
    const deps = createDeps({
      sessions: {
        get: vi.fn((sessionId: string) =>
          options?.sessionExists === false ? undefined : sessionId === "s1" ? session : undefined,
        ),
      },
      gatekeeper: {
        hasAuthenticator: vi.fn(() => options?.hasAuthenticator ?? false),
        authenticateAsync: vi.fn(async () => identity),
        createAnonymousIdentity: vi.fn(() => identity),
        cancelPendingAuth: vi.fn(),
        authorize: vi.fn(() => options?.authorize ?? true),
        createRateLimiter: vi.fn(() => undefined),
      },
      metrics,
      emit: vi.fn((event, payload) => {
        emitted.push({ event, payload });
      }),
      checkRateLimit: vi.fn(() => !(options?.rateLimited ?? false)),
      getConsumerIdentity: vi.fn((_, ws) => sockets.get(ws)),
      getConsumerCount: vi.fn(() => sockets.size),
      getState: vi.fn((s) => s.data.state),
      getMessageHistory: vi.fn((s) => s.data.messageHistory),
      getPendingPermissions: vi.fn((s) => Array.from(s.data.pendingPermissions.values())),
      getQueuedMessage: vi.fn((s) => s.data.queuedMessage),
      isBackendConnected: vi.fn(() => options?.backendConnected ?? false),
      registerConsumer: vi.fn((_, ws, acceptedIdentity) => {
        sockets.set(ws, acceptedIdentity);
      }),
      unregisterConsumer: vi.fn((_, ws) => {
        const existing = sockets.get(ws);
        sockets.delete(ws);
        return existing;
      }),
      routeConsumerMessage: vi.fn(),
    });

    const gateway = new ConsumerGateway(deps);
    const ws = createTestSocket();
    const sentToWs = () =>
      vi
        .mocked(deps.broadcaster.sendTo)
        .mock.calls.filter(([target]) => target === ws)
        .map(([, message]) => message as Record<string, unknown>);

    return { gateway, deps, ws, session, emitted, sentToWs, identity, metrics };
  }

  it("rejects consumer open for unknown session", () => {
    const { gateway, deps, ws, emitted, metrics } = createHarness({ sessionExists: false });

    gateway.handleConsumerOpen(ws, { sessionId: "s1" } as any);

    expect(ws.close).toHaveBeenCalledWith(4404, "Session not found");
    expect(vi.mocked(deps.registerConsumer)).not.toHaveBeenCalled();
    expect(emitted.some((e) => e.event === "consumer:auth_failed")).toBe(true);
    expect(metrics.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "auth:failed",
        sessionId: "s1",
        reason: "Session not found",
      }),
    );
  });

  it("accepts anonymous consumer and sends identity + session_init + cli_disconnected", () => {
    const { gateway, deps, ws, sentToWs, emitted } = createHarness({
      backendConnected: false,
      history: [],
      pendingPermissions: [],
      queuedMessage: null,
    });

    gateway.handleConsumerOpen(ws, { sessionId: "s1" } as any);

    expect(vi.mocked(deps.registerConsumer)).toHaveBeenCalled();
    expect(vi.mocked(deps.gitTracker.resolveGitInfo)).toHaveBeenCalled();
    const sent = sentToWs();
    expect(sent[0]).toEqual(
      expect.objectContaining({
        type: "identity",
        userId: "u1",
        displayName: "User 1",
        role: "participant",
      }),
    );
    expect(sent[1]).toEqual(
      expect.objectContaining({
        type: "session_init",
        protocol_version: CONSUMER_PROTOCOL_VERSION,
      }),
    );
    expect(sent.some((m) => m.type === "cli_disconnected")).toBe(true);
    expect(emitted.some((e) => e.event === "backend:relaunch_needed")).toBe(true);
  });

  it("sends message history, capabilities, pending permissions, and queued message on open", () => {
    const state = {
      ...createMockSession({ id: "s1" }).state,
      capabilities: {
        commands: [{ name: "/help", description: "help" }],
        models: [{ id: "m1", display_name: "model" }],
        account: { email: "user@example.com" },
      },
      skills: ["commit"],
    } as Session["state"];
    const permission = {
      request_id: "perm-1",
      tool_name: "Bash",
      options: [],
      expires_at: Date.now() + 1000,
      tool_use_id: "tu-1",
      safety_risk: null,
    };
    const queued = {
      consumerId: "u1",
      displayName: "User 1",
      content: "queued message",
      queuedAt: 1,
    };
    const { gateway, ws, sentToWs } = createHarness({
      state,
      history: [{ type: "user_message", content: "hi", timestamp: 1 }] as any,
      pendingPermissions: [permission],
      queuedMessage: queued as any,
    });

    gateway.handleConsumerOpen(ws, { sessionId: "s1" } as any);

    const sent = sentToWs();
    expect(sent.some((m) => m.type === "message_history")).toBe(true);
    expect(sent.some((m) => m.type === "capabilities_ready")).toBe(true);
    expect(sent.some((m) => m.type === "permission_request")).toBe(true);
    expect(sent.some((m) => m.type === "message_queued")).toBe(true);
  });

  it("does not send pending permissions to observers", () => {
    const { gateway, ws, sentToWs } = createHarness({
      identity: { userId: "obs-1", displayName: "Observer", role: "observer" },
      pendingPermissions: [
        {
          request_id: "perm-1",
          tool_name: "Bash",
          options: [],
          expires_at: Date.now() + 1000,
          tool_use_id: "tu-1",
          safety_risk: null,
        },
      ],
    });

    gateway.handleConsumerOpen(ws, { sessionId: "s1" } as any);
    expect(sentToWs().some((m) => m.type === "permission_request")).toBe(false);
  });

  it("sends cli_connected when backend is already connected", () => {
    const { gateway, ws, sentToWs, emitted } = createHarness({
      backendConnected: true,
      history: [],
      pendingPermissions: [],
      queuedMessage: null,
    });

    gateway.handleConsumerOpen(ws, { sessionId: "s1" } as any);
    expect(sentToWs().some((m) => m.type === "cli_connected")).toBe(true);
    expect(emitted.some((e) => e.event === "backend:relaunch_needed")).toBe(false);
  });

  it("authenticator path accepts asynchronously", async () => {
    const { gateway, deps, ws } = createHarness({ hasAuthenticator: true });

    gateway.handleConsumerOpen(ws, { sessionId: "s1" } as any);
    await flushPromises();

    expect(vi.mocked(deps.gatekeeper.authenticateAsync)).toHaveBeenCalled();
    expect(vi.mocked(deps.registerConsumer)).toHaveBeenCalled();
  });

  it("routes valid consumer messages after auth + rate limit checks", () => {
    const { gateway, deps, ws, session } = createHarness();
    gateway.handleConsumerOpen(ws, { sessionId: "s1" } as any);
    vi.mocked(deps.routeConsumerMessage).mockClear();

    gateway.handleConsumerMessage(
      ws,
      "s1",
      JSON.stringify({ type: "user_message", content: "hello" } satisfies InboundCommand),
    );

    expect(vi.mocked(deps.routeConsumerMessage)).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ type: "user_message", content: "hello" }),
      ws,
    );
    expect(vi.mocked(deps.emit)).toHaveBeenCalledWith(
      "message:inbound",
      expect.objectContaining({
        sessionId: "s1",
        message: expect.objectContaining({ type: "user_message", content: "hello" }),
      }),
    );
    expect(vi.mocked(deps.tracer.recv)).toHaveBeenCalled();
  });

  it("parses Buffer payloads and routes them", () => {
    const { gateway, deps, ws, session } = createHarness();
    gateway.handleConsumerOpen(ws, { sessionId: "s1" } as any);
    vi.mocked(deps.routeConsumerMessage).mockClear();

    gateway.handleConsumerMessage(ws, "s1", Buffer.from(JSON.stringify({ type: "interrupt" })));

    expect(vi.mocked(deps.routeConsumerMessage)).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ type: "interrupt" }),
      ws,
    );
  });

  it("drops malformed JSON without routing", () => {
    const { gateway, deps, ws } = createHarness();
    gateway.handleConsumerOpen(ws, { sessionId: "s1" } as any);
    vi.mocked(deps.routeConsumerMessage).mockClear();

    gateway.handleConsumerMessage(ws, "s1", "{not-json");
    expect(vi.mocked(deps.routeConsumerMessage)).not.toHaveBeenCalled();
  });

  it("rejects oversized payload with code 1009", () => {
    const { gateway, ws } = createHarness();
    const oversized = Buffer.from("x".repeat(262_145), "utf-8");

    gateway.handleConsumerMessage(ws, "s1", oversized);
    expect(ws.close).toHaveBeenCalledWith(1009, "Message Too Big");
  });

  it("blocks unauthorized observers from sending messages", () => {
    const { gateway, deps, ws } = createHarness({
      identity: { userId: "obs-1", displayName: "Observer", role: "observer" },
      authorize: false,
    });
    gateway.handleConsumerOpen(ws, { sessionId: "s1" } as any);

    gateway.handleConsumerMessage(ws, "s1", JSON.stringify({ type: "interrupt" }));

    expect(vi.mocked(deps.broadcaster.sendTo)).toHaveBeenCalledWith(
      ws,
      expect.objectContaining({
        type: "error",
      }),
    );
    expect(vi.mocked(deps.routeConsumerMessage)).not.toHaveBeenCalled();
  });

  it("blocks rate-limited messages and records metric", () => {
    const { gateway, deps, ws, metrics } = createHarness({ rateLimited: true });
    gateway.handleConsumerOpen(ws, { sessionId: "s1" } as any);

    gateway.handleConsumerMessage(ws, "s1", JSON.stringify({ type: "interrupt" }));

    expect(vi.mocked(deps.routeConsumerMessage)).not.toHaveBeenCalled();
    expect(metrics.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ratelimit:exceeded",
        sessionId: "s1",
      }),
    );
  });

  it("ignores messages for missing sessions", () => {
    const { gateway, deps, ws } = createHarness({ sessionExists: false });
    gateway.handleConsumerMessage(ws, "s1", JSON.stringify({ type: "interrupt" }));
    expect(vi.mocked(deps.routeConsumerMessage)).not.toHaveBeenCalled();
  });

  it("handleConsumerClose unregisters consumer, emits event, and broadcasts presence", () => {
    const { gateway, deps, ws, emitted } = createHarness();
    gateway.handleConsumerOpen(ws, { sessionId: "s1" } as any);

    gateway.handleConsumerClose(ws, "s1");

    expect(vi.mocked(deps.gatekeeper.cancelPendingAuth)).toHaveBeenCalledWith(ws);
    expect(vi.mocked(deps.unregisterConsumer)).toHaveBeenCalled();
    expect(vi.mocked(deps.broadcaster.broadcastPresence)).toHaveBeenCalled();
    expect(emitted.some((e) => e.event === "consumer:disconnected")).toBe(true);
  });

  it("handleConsumerClose is safe when session is missing", () => {
    const { gateway, deps, ws } = createHarness({ sessionExists: false });
    gateway.handleConsumerClose(ws, "s1");
    expect(vi.mocked(deps.unregisterConsumer)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.gatekeeper.cancelPendingAuth)).toHaveBeenCalledWith(ws);
  });
});
