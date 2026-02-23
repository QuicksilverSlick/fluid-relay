import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../interfaces/logger.js";
import type { SessionStorage } from "../../interfaces/storage.js";
import { authContext, createTestSocket, noopLogger } from "../../testing/cli-message-factories.js";
import { noopTracer } from "../messaging/message-tracer.js";
import { SessionRepository } from "../session/session-repository.js";
import { SlashCommandRegistry } from "../slash/slash-command-registry.js";
import { TeamToolCorrelationBuffer } from "../team/team-tool-correlation.js";
import { composeConsumerPlane } from "./compose-consumer-plane.js";

describe("composeConsumerPlane", () => {
  it("creates gateway stack and routes authorized inbound messages to runtime callback", () => {
    const store = new SessionRepository(null as SessionStorage | null, {
      createCorrelationBuffer: () => new TeamToolCorrelationBuffer(),
      createRegistry: () => new SlashCommandRegistry(),
    });
    const session = store.getOrCreate("s-consumer");
    const ws = createTestSocket();
    const routeConsumerMessage = vi.fn();
    const emit = vi.fn();

    const runtime = {
      allocateAnonymousIdentityIndex: vi.fn(() => 0),
      addConsumer: vi.fn((socket, identity) => session.consumerSockets.set(socket, identity)),
      removeConsumer: vi.fn((socket) => session.consumerSockets.delete(socket)),
      getConsumerSockets: vi.fn(() => session.consumerSockets),
      getConsumerIdentity: vi.fn((socket) => session.consumerSockets.get(socket)),
      getConsumerCount: vi.fn(() => session.consumerSockets.size),
      getState: vi.fn(() => session.data.state),
      getMessageHistory: vi.fn(() => []),
      getPendingPermissions: vi.fn(() => []),
      getQueuedMessage: vi.fn(() => null),
      isBackendConnected: vi.fn(() => true),
      checkRateLimit: vi.fn(() => true),
    };

    const plane = composeConsumerPlane({
      store,
      logger: noopLogger as Logger,
      tracer: noopTracer,
      config: {
        port: 9414,
        maxMessageHistoryLength: 300,
        authTimeoutMs: 10000,
        allowOrigins: [],
        blockedEnvVars: [],
        showRawErrors: false,
        trace: false,
        traceDir: ".",
        traceLevel: "smart",
        traceAllowSensitive: false,
        maxInterruptsPerSecond: 5,
      },
      metrics: null,
      gitResolver: null,
      authenticator: undefined,
      rateLimiterFactory: undefined,
      runtime: () => runtime as any,
      routeConsumerMessage,
      emit: emit as any,
    });

    plane.consumerGateway.handleConsumerOpen(ws, authContext("s-consumer"));
    plane.consumerGateway.handleConsumerMessage(
      ws,
      "s-consumer",
      JSON.stringify({ type: "user_message", content: "hello" }),
    );

    expect(runtime.addConsumer).toHaveBeenCalledTimes(1);
    expect(routeConsumerMessage).toHaveBeenCalledWith(
      session,
      { type: "user_message", content: "hello" },
      ws,
    );
    expect(emit).toHaveBeenCalledWith("message:inbound", {
      sessionId: "s-consumer",
      message: { type: "user_message", content: "hello" },
    });
  });

  it("removes failing consumer sockets through runtime accessors", () => {
    const store = new SessionRepository(null as SessionStorage | null, {
      createCorrelationBuffer: () => new TeamToolCorrelationBuffer(),
      createRegistry: () => new SlashCommandRegistry(),
    });
    const session = store.getOrCreate("s-consumer-fail");
    const emit = vi.fn();

    const failingSocket = {
      send: vi.fn(() => {
        throw new Error("send failed");
      }),
      close: vi.fn(),
      bufferedAmount: 0,
    };
    session.consumerSockets.set(failingSocket as any, {
      userId: "u-fail",
      displayName: "Failing Socket",
      role: "participant",
    });

    const runtime = {
      allocateAnonymousIdentityIndex: vi.fn(() => 0),
      addConsumer: vi.fn((socket, identity) => session.consumerSockets.set(socket, identity)),
      removeConsumer: vi.fn((socket) => {
        const identity = session.consumerSockets.get(socket);
        session.consumerSockets.delete(socket);
        return identity;
      }),
      getConsumerSockets: vi.fn(() => session.consumerSockets),
      getConsumerIdentity: vi.fn((socket) => session.consumerSockets.get(socket)),
      getConsumerCount: vi.fn(() => session.consumerSockets.size),
      getState: vi.fn(() => session.data.state),
      getMessageHistory: vi.fn(() => []),
      getPendingPermissions: vi.fn(() => []),
      getQueuedMessage: vi.fn(() => null),
      isBackendConnected: vi.fn(() => true),
      checkRateLimit: vi.fn(() => true),
    };

    const plane = composeConsumerPlane({
      store,
      logger: noopLogger as Logger,
      tracer: noopTracer,
      config: {
        port: 9414,
        maxMessageHistoryLength: 300,
        authTimeoutMs: 10000,
        allowOrigins: [],
        blockedEnvVars: [],
        showRawErrors: false,
        trace: false,
        traceDir: ".",
        traceLevel: "smart",
        traceAllowSensitive: false,
        maxInterruptsPerSecond: 5,
      },
      metrics: null,
      gitResolver: null,
      authenticator: undefined,
      rateLimiterFactory: undefined,
      runtime: () => runtime as any,
      routeConsumerMessage: vi.fn(),
      emit: emit as any,
    });

    plane.broadcaster.broadcast(session, {
      type: "error",
      message: "broadcast failure path",
    });

    expect(runtime.removeConsumer).toHaveBeenCalledWith(failingSocket);
    expect(session.consumerSockets.has(failingSocket as any)).toBe(false);
    expect(emit).toHaveBeenCalledWith("message:outbound", {
      sessionId: "s-consumer-fail",
      message: { type: "error", message: "broadcast failure path" },
    });
  });
});
