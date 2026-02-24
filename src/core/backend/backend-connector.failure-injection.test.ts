import { describe, expect, it, vi } from "vitest";
import { FailureInjectionBackendAdapter } from "../../testing/failure-injection-adapter.js";
import { BackendConnector } from "./backend-connector.js";

function createSession(id: string) {
  const s = {
    id,
    adapterName: undefined,
    backendSession: null,
    backendAbort: null,
    backendSessionId: undefined,
    adapterSupportsSlashPassthrough: false,
    adapterSlashExecutor: null,
    pendingMessages: [],
    pendingPassthroughs: [],
    pendingPermissions: new Map(),
    state: {
      slash_commands: [],
      skills: [],
    },
    registry: {
      registerFromCLI: vi.fn(),
    },
    lastActivity: 0,
  } as any;
  if (!s.data) s.data = s;
  return s;
}

function makePassthrough(command: string, requestId = "req-1") {
  return { command, requestId, slashRequestId: "slash-1", traceId: "trace-1", startedAtMs: 0 };
}

function createMockRuntime(session: any) {
  return {
    attachBackendConnection: (params: any) => {
      session.backendSession = params.backendSession;
      session.backendAbort = params.backendAbort;
      session.data.adapterSupportsSlashPassthrough = params.supportsSlashPassthrough;
      session.adapterSlashExecutor = params.slashExecutor;
    },
    resetBackendConnectionState: () => {
      session.backendSession = null;
      session.backendAbort = null;
      session.data.backendSessionId = undefined;
      session.data.adapterSupportsSlashPassthrough = false;
      session.adapterSlashExecutor = null;
    },
    getBackendSession: () => session.backendSession ?? null,
    getBackendAbort: () => session.backendAbort ?? null,
    drainPendingMessages: () => {
      const p = session.data.pendingMessages;
      session.data.pendingMessages = [];
      return p;
    },
    drainPendingPermissionIds: () => {
      const ids = Array.from(session.data.pendingPermissions.keys());
      session.data.pendingPermissions.clear();
      return ids;
    },
    peekPendingPassthrough: () => session.pendingPassthroughs[0],
    shiftPendingPassthrough: () => session.pendingPassthroughs.shift(),
    getState: () => session.data.state,
    setState: (state: any) => {
      session.data.state = state;
    },
    registerSlashCommandNames: (commands: string[]) => {
      session.registry.registerFromCLI(commands.map((name: string) => ({ name, description: "" })));
    },
  } as any;
}

function buildConnectorDeps(
  adapter: InstanceType<typeof FailureInjectionBackendAdapter>,
  session: any,
  emitEvent = vi.fn(),
  broadcaster = { broadcast: vi.fn(), broadcastToParticipants: vi.fn(), sendTo: vi.fn() } as any,
) {
  const routeSystemSignal = vi.fn();
  const manager = new BackendConnector({
    adapter,
    adapterResolver: null,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    metrics: null,
    broadcaster,
    routeUnifiedMessage: vi.fn(),
    routeSystemSignal,
    emitEvent,
    getRuntime: () => createMockRuntime(session),
  });
  return { manager, emitEvent, broadcaster, routeSystemSignal };
}

async function waitForAssertion(assertFn: () => void, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      assertFn();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

describe("BackendConnector failure injection", () => {
  it("emits disconnect and error events when backend stream fails", async () => {
    const adapter = new FailureInjectionBackendAdapter();
    const emitEvent = vi.fn();
    const broadcaster = {
      broadcast: vi.fn(),
      broadcastToParticipants: vi.fn(),
      sendTo: vi.fn(),
    } as any;

    const session = createSession("sess-fi");
    const { manager, routeSystemSignal } = buildConnectorDeps(
      adapter,
      session,
      emitEvent,
      broadcaster,
    );

    await manager.connectBackend(session);

    adapter.failStream("sess-fi", new Error("Injected stream failure"));

    await waitForAssertion(() => {
      expect(routeSystemSignal).toHaveBeenCalledWith(session, {
        kind: "BACKEND_DISCONNECTED",
        reason: "stream ended",
      });
    });

    expect(emitEvent).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        source: "backendConsumption",
        sessionId: "sess-fi",
      }),
    );
  });

  it("drains pending passthroughs with slash_command_error when stream fails (lines 594-605)", async () => {
    const adapter = new FailureInjectionBackendAdapter();
    const emitEvent = vi.fn();
    const broadcaster = {
      broadcast: vi.fn(),
      broadcastToParticipants: vi.fn(),
      sendTo: vi.fn(),
    } as any;
    const session = createSession("sess-drain-fail");
    const { manager, routeSystemSignal } = buildConnectorDeps(
      adapter,
      session,
      emitEvent,
      broadcaster,
    );

    // Pre-populate pending passthrough entries
    session.pendingPassthroughs.push(makePassthrough("/compact", "req-compact"));

    await manager.connectBackend(session);
    adapter.failStream("sess-drain-fail", new Error("Backend crashed"));

    await waitForAssertion(() => {
      expect(routeSystemSignal).toHaveBeenCalledWith(
        session,
        expect.objectContaining({
          kind: "SLASH_PASSTHROUGH_ERROR",
          command: "/compact",
          error: "Backend crashed",
        }),
      );
    });
  });

  it("drains pending passthroughs with slash_command_error when stream ends unexpectedly (lines 619-630)", async () => {
    const adapter = new FailureInjectionBackendAdapter();
    const emitEvent = vi.fn();
    const broadcaster = {
      broadcast: vi.fn(),
      broadcastToParticipants: vi.fn(),
      sendTo: vi.fn(),
    } as any;
    const session = createSession("sess-drain-end");
    const { manager, routeSystemSignal } = buildConnectorDeps(
      adapter,
      session,
      emitEvent,
      broadcaster,
    );

    session.pendingPassthroughs.push(makePassthrough("/status", "req-status"));

    await manager.connectBackend(session);
    adapter.endStream("sess-drain-end");

    await waitForAssertion(() => {
      expect(routeSystemSignal).toHaveBeenCalledWith(
        session,
        expect.objectContaining({
          kind: "SLASH_PASSTHROUGH_ERROR",
          command: "/status",
          error: "Backend stream ended unexpectedly",
        }),
      );
    });
  });
});
