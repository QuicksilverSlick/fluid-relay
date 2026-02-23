import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../interfaces/logger.js";
import type { SessionStorage } from "../../interfaces/storage.js";
import {
  createMockSession,
  createTestSocket,
  noopLogger,
} from "../../testing/cli-message-factories.js";
import { ConsumerBroadcaster } from "../consumer/consumer-broadcaster.js";
import { noopTracer } from "../messaging/message-tracer.js";
import type { Session } from "../session/session-repository.js";
import { SessionRepository } from "../session/session-repository.js";
import { SlashCommandRegistry } from "../slash/slash-command-registry.js";
import { TeamToolCorrelationBuffer } from "../team/team-tool-correlation.js";
import { composeMessagePlane } from "./compose-message-plane.js";

describe("composeMessagePlane", () => {
  it("creates queue/slash/router/lifecycle services and queue handler forwards to sendUserMessage", () => {
    const store = new SessionRepository(null as SessionStorage | null, {
      createCorrelationBuffer: () => new TeamToolCorrelationBuffer(),
      createRegistry: () => new SlashCommandRegistry(),
    });
    const session = createMockSession({ id: "s-message" });
    const ws = createTestSocket();
    const sendUserMessage = vi.fn();
    const emitEvent = vi.fn();
    const emitSessionClosed = vi.fn();
    const persisted: unknown[] = [];
    const persistedSync: unknown[] = [];

    let lastStatus: "compacting" | "idle" | "running" | null = null;
    let queuedMessage: Session["queuedMessage"] = null;
    const runtime = {
      getState: vi.fn(() => session.data.state),
      setState: vi.fn((state) => {
        session.data.state = state;
      }),
      getPendingInitialize: vi.fn(() => session.pendingInitialize),
      setPendingInitialize: vi.fn((pending) => {
        session.pendingInitialize = pending;
      }),
      trySendRawToBackend: vi.fn(() => "unsupported"),
      registerCLICommands: vi.fn(),
      getLastStatus: vi.fn(() => lastStatus),
      setLastStatus: vi.fn((status) => {
        lastStatus = status;
      }),
      getQueuedMessage: vi.fn(() => queuedMessage),
      setQueuedMessage: vi.fn((queued) => {
        queuedMessage = queued;
      }),
      getConsumerIdentity: vi.fn(() => ({
        userId: "u1",
        displayName: "User 1",
        role: "participant",
      })),
      enqueuePendingPassthrough: vi.fn(),
      setBackendSessionId: vi.fn(),
      getMessageHistory: vi.fn(() => session.data.messageHistory),
      setMessageHistory: vi.fn((history) => {
        session.data.messageHistory = history;
      }),
      storePendingPermission: vi.fn(),
      clearDynamicSlashRegistry: vi.fn(),
      registerSkillCommands: vi.fn(),
    };

    const plane = composeMessagePlane({
      config: {
        port: 9414,
        maxMessageHistoryLength: 200,
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
      logger: noopLogger as Logger,
      metrics: null,
      store,
      runtimeManager: {
        getOrCreate: vi.fn(),
        getLifecycleState: vi.fn(),
        delete: vi.fn(),
        clear: vi.fn(),
      } as any,
      tracer: noopTracer,
      gitResolver: null,
      broadcaster: new ConsumerBroadcaster(noopLogger as Logger, undefined, noopTracer),
      gitTracker: { resolveGitInfo: vi.fn() } as any,
      persistenceService: {
        persist: (s) => persisted.push(s),
        persistSync: (s) => persistedSync.push(s),
        restoreFromStorage: vi.fn(),
      } as any,
      runtime: () => runtime as any,
      emitEvent,
      emitSessionClosed,
      sendUserMessage,
    });

    expect(plane.lifecycleService).toBeDefined();
    expect(plane.slashService).toBeDefined();
    expect(plane.queueHandler).toBeDefined();

    plane.queueHandler.handleQueueMessage(
      session as any,
      { type: "queue_message", content: "ship" },
      ws,
    );

    expect(sendUserMessage).toHaveBeenCalledWith("s-message", "ship", { images: undefined });
    expect(lastStatus).toBe("running");
    expect(persistedSync).toEqual([]);
  });

  it("persists queued-message changes synchronously when queue slot mutates", () => {
    const store = new SessionRepository(null as SessionStorage | null, {
      createCorrelationBuffer: () => new TeamToolCorrelationBuffer(),
      createRegistry: () => new SlashCommandRegistry(),
    });
    const session = createMockSession({ id: "s-message" });
    const ws = createTestSocket();
    session.consumerSockets.set(ws, {
      userId: "u1",
      displayName: "User 1",
      role: "participant",
    });
    const sendUserMessage = vi.fn();
    const persistedSync: unknown[] = [];

    let lastStatus: "compacting" | "idle" | "running" | null = "running";
    let queuedMessage: Session["queuedMessage"] = null;
    const runtime = {
      getState: vi.fn(() => session.data.state),
      setState: vi.fn((state) => {
        session.data.state = state;
      }),
      getPendingInitialize: vi.fn(() => session.pendingInitialize),
      setPendingInitialize: vi.fn((pending) => {
        session.pendingInitialize = pending;
      }),
      trySendRawToBackend: vi.fn(() => "unsupported"),
      registerCLICommands: vi.fn(),
      getLastStatus: vi.fn(() => lastStatus),
      setLastStatus: vi.fn((status) => {
        lastStatus = status;
      }),
      getQueuedMessage: vi.fn(() => queuedMessage),
      setQueuedMessage: vi.fn((queued) => {
        queuedMessage = queued;
      }),
      getConsumerIdentity: vi.fn((incomingWs) => session.consumerSockets.get(incomingWs)),
      enqueuePendingPassthrough: vi.fn(),
      setBackendSessionId: vi.fn(),
      getMessageHistory: vi.fn(() => session.data.messageHistory),
      setMessageHistory: vi.fn((history) => {
        session.data.messageHistory = history;
      }),
      storePendingPermission: vi.fn(),
      clearDynamicSlashRegistry: vi.fn(),
      registerSkillCommands: vi.fn(),
    };

    const plane = composeMessagePlane({
      config: {
        port: 9414,
        maxMessageHistoryLength: 200,
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
      logger: noopLogger as Logger,
      metrics: null,
      store,
      runtimeManager: {
        getOrCreate: vi.fn(),
        getLifecycleState: vi.fn(),
        delete: vi.fn(),
        clear: vi.fn(),
      } as any,
      tracer: noopTracer,
      gitResolver: null,
      broadcaster: new ConsumerBroadcaster(noopLogger as Logger, undefined, noopTracer),
      gitTracker: { resolveGitInfo: vi.fn() } as any,
      persistenceService: {
        persist: vi.fn(),
        persistSync: (s) => persistedSync.push(s),
        restoreFromStorage: vi.fn(),
      } as any,
      runtime: () => runtime as any,
      emitEvent: vi.fn(),
      emitSessionClosed: vi.fn(),
      sendUserMessage,
    });

    plane.queueHandler.handleQueueMessage(
      session as any,
      { type: "queue_message", content: "wait" },
      ws,
    );

    expect(queuedMessage).toEqual(expect.objectContaining({ content: "wait" }));
    expect(persistedSync).toEqual([session]);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });
});
