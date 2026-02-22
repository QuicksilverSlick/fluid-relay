import { describe, expect, it, vi } from "vitest";
import { createMockSession } from "../../testing/cli-message-factories.js";
import type { Session } from "../session/session-repository.js";
import { composeRuntimePlane } from "./compose-runtime-plane.js";

describe("composeRuntimePlane", () => {
  it("creates runtime services and resolves lazy collaborators on first runtime", () => {
    const route = vi.fn();
    const resolveGitInfo = vi.fn();
    const sendToBackend = vi.fn();
    const emitPermissionResolved = vi.fn();
    const getBroadcaster = vi.fn(() => ({
      broadcast: vi.fn(),
      broadcastPresence: vi.fn(),
      sendTo: vi.fn(),
    }));
    const getQueueHandler = vi.fn(() => ({
      handleQueueMessage: vi.fn(),
      handleUpdateQueuedMessage: vi.fn(),
      handleCancelQueuedMessage: vi.fn(),
      autoSendQueuedMessage: vi.fn(),
    }));
    const getSlashService = vi.fn(() => ({
      handleInbound: vi.fn(),
      executeProgrammatic: vi.fn().mockResolvedValue(null),
    }));
    const getBackendConnector = vi.fn(() => ({ sendToBackend }));
    const getMessageRouter = vi.fn(() => ({ route }));
    const getGitTracker = vi.fn(() => ({ resolveGitInfo }));

    let runtimePlane: ReturnType<typeof composeRuntimePlane>;
    runtimePlane = composeRuntimePlane({
      options: {
        config: { port: 9414, maxMessageHistoryLength: 222 },
      },
      emitPermissionResolved,
      getOrCreateSession: (sessionId: string) => runtimePlane.store.getOrCreate(sessionId),
      getBroadcaster,
      getQueueHandler,
      getSlashService,
      getBackendConnector,
      getPersistenceService: () => runtimePlane.persistenceService,
      getGitTracker,
      getMessageRouter,
    });

    expect(runtimePlane.core.config.maxMessageHistoryLength).toBe(222);
    expect(getBroadcaster).not.toHaveBeenCalled();
    expect(getBackendConnector).not.toHaveBeenCalled();

    const session = createMockSession({ id: "s-runtime" });
    const runtime = runtimePlane.runtimeManager.getOrCreate(session) as {
      deps: {
        sendToBackend: (session: Session, message: unknown) => void;
        routeBackendMessage: (session: Session, message: unknown) => void;
        onSessionSeeded: (session: Session) => void;
        emitPermissionResolved: (
          sessionId: string,
          requestId: string,
          behavior: "allow" | "deny",
        ) => void;
      };
    };

    runtime.deps.sendToBackend(session, { type: "noop" });
    runtime.deps.routeBackendMessage(session, { type: "backend_noop" });
    runtime.deps.onSessionSeeded(session);
    runtime.deps.emitPermissionResolved("s-runtime", "req-1", "allow");

    expect(getBroadcaster).toHaveBeenCalledTimes(1);
    expect(getQueueHandler).toHaveBeenCalledTimes(1);
    expect(getSlashService).toHaveBeenCalledTimes(1);
    expect(getBackendConnector).toHaveBeenCalledTimes(1);
    expect(getMessageRouter).toHaveBeenCalledTimes(1);
    expect(getGitTracker).toHaveBeenCalledTimes(1);
    expect(sendToBackend).toHaveBeenCalledWith(session, { type: "noop" });
    expect(route).toHaveBeenCalledWith(session, { type: "backend_noop" });
    expect(resolveGitInfo).toHaveBeenCalledWith(session);
    expect(emitPermissionResolved).toHaveBeenCalledWith("s-runtime", "req-1", "allow");
  });
});
