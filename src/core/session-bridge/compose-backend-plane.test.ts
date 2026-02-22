import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../interfaces/logger.js";
import type { SessionStorage } from "../../interfaces/storage.js";
import { noopLogger } from "../../testing/cli-message-factories.js";
import { ConsumerBroadcaster } from "../consumer/consumer-broadcaster.js";
import { noopTracer } from "../messaging/message-tracer.js";
import { SessionRepository } from "../session/session-repository.js";
import { SlashCommandRegistry } from "../slash/slash-command-registry.js";
import { TeamToolCorrelationBuffer } from "../team/team-tool-correlation.js";
import { composeBackendPlane } from "./compose-backend-plane.js";

describe("composeBackendPlane", () => {
  it("creates backend connector/api and reflects adapter availability", () => {
    const store = new SessionRepository(null as SessionStorage | null, {
      createCorrelationBuffer: () => new TeamToolCorrelationBuffer(),
      createRegistry: () => new SlashCommandRegistry(),
    });
    const broadcaster = new ConsumerBroadcaster(noopLogger as Logger, undefined, noopTracer);
    const runtime = {
      handleBackendMessage: vi.fn(),
      attachBackendConnection: vi.fn(),
      resetBackendConnectionState: vi.fn(),
      getBackendSession: vi.fn(() => null),
      getBackendAbort: vi.fn(() => null),
      drainPendingMessages: vi.fn(() => []),
      drainPendingPermissionIds: vi.fn(() => []),
      peekPendingPassthrough: vi.fn(() => null),
      shiftPendingPassthrough: vi.fn(() => null),
      getState: vi.fn(() => ({ slash_commands: [] })),
      setState: vi.fn(),
      registerSlashCommandNames: vi.fn(),
    };

    const withoutAdapter = composeBackendPlane({
      options: {},
      store,
      logger: noopLogger as Logger,
      metrics: null,
      tracer: noopTracer,
      broadcaster,
      capabilitiesPolicy: { cancelPendingInitialize: vi.fn() } as any,
      runtime: () => runtime as any,
      routeBackendMessage: vi.fn(),
      emitEvent: vi.fn(),
      getOrCreateSession: (sessionId) => store.getOrCreate(sessionId),
    });
    expect(withoutAdapter.backendApi.hasAdapter).toBe(false);

    const withAdapter = composeBackendPlane({
      options: { adapter: {} as any },
      store,
      logger: noopLogger as Logger,
      metrics: null,
      tracer: noopTracer,
      broadcaster,
      capabilitiesPolicy: { cancelPendingInitialize: vi.fn() } as any,
      runtime: () => runtime as any,
      routeBackendMessage: vi.fn(),
      emitEvent: vi.fn(),
      getOrCreateSession: (sessionId) => store.getOrCreate(sessionId),
    });
    expect(withAdapter.backendApi.hasAdapter).toBe(true);
  });
});
