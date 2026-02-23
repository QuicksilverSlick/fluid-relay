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

function buildConnectorDeps(
  adapter: InstanceType<typeof FailureInjectionBackendAdapter>,
  emitEvent = vi.fn(),
  broadcaster = { broadcast: vi.fn(), broadcastToParticipants: vi.fn(), sendTo: vi.fn() } as any,
) {
  const manager = new BackendConnector({
    adapter,
    adapterResolver: null,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    metrics: null,
    broadcaster,
    routeUnifiedMessage: vi.fn(),
    emitEvent,
    onBackendConnectedState: (runtimeSession: any, params: any) => {
      runtimeSession.backendSession = params.backendSession;
      runtimeSession.backendAbort = params.backendAbort;
      runtimeSession.data.adapterSupportsSlashPassthrough = params.supportsSlashPassthrough;
      runtimeSession.adapterSlashExecutor = params.slashExecutor;
    },
    onBackendDisconnectedState: (runtimeSession: any) => {
      runtimeSession.backendSession = null;
      runtimeSession.backendAbort = null;
      runtimeSession.data.backendSessionId = undefined;
      runtimeSession.data.adapterSupportsSlashPassthrough = false;
      runtimeSession.adapterSlashExecutor = null;
    },
    getBackendSession: (runtimeSession: any) => runtimeSession.backendSession ?? null,
    getBackendAbort: (runtimeSession: any) => runtimeSession.backendAbort ?? null,
    drainPendingMessages: (runtimeSession: any) => {
      const p = runtimeSession.data.pendingMessages;
      runtimeSession.data.pendingMessages = [];
      return p;
    },
    drainPendingPermissionIds: (runtimeSession: any) => {
      const ids = Array.from(runtimeSession.data.pendingPermissions.keys());
      runtimeSession.data.pendingPermissions.clear();
      return ids;
    },
    peekPendingPassthrough: (runtimeSession: any) => runtimeSession.pendingPassthroughs[0],
    shiftPendingPassthrough: (runtimeSession: any) => runtimeSession.pendingPassthroughs.shift(),
    setSlashCommandsState: (runtimeSession: any, commands: string[]) => {
      runtimeSession.data.state = { ...runtimeSession.data.state, slash_commands: commands };
    },
    registerCLICommands: (runtimeSession: any, commands: string[]) => {
      runtimeSession.registry.registerFromCLI(
        commands.map((name: string) => ({ name, description: "" })),
      );
    },
  });
  return { manager, emitEvent, broadcaster };
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

    const manager = new BackendConnector({
      adapter,
      adapterResolver: null,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      metrics: null,
      broadcaster,
      routeUnifiedMessage: vi.fn(),
      emitEvent,
      onBackendConnectedState: (runtimeSession, params) => {
        runtimeSession.backendSession = params.backendSession;
        runtimeSession.backendAbort = params.backendAbort;
        runtimeSession.data.adapterSupportsSlashPassthrough = params.supportsSlashPassthrough;
        runtimeSession.adapterSlashExecutor = params.slashExecutor;
      },
      onBackendDisconnectedState: (runtimeSession) => {
        runtimeSession.backendSession = null;
        runtimeSession.backendAbort = null;
        runtimeSession.data.backendSessionId = undefined;
        runtimeSession.data.adapterSupportsSlashPassthrough = false;
        runtimeSession.adapterSlashExecutor = null;
      },
      getBackendSession: (runtimeSession) => runtimeSession.backendSession ?? null,
      getBackendAbort: (runtimeSession) => runtimeSession.backendAbort ?? null,
      drainPendingMessages: (runtimeSession) => {
        const pending = runtimeSession.data.pendingMessages;
        runtimeSession.data.pendingMessages = [];
        return pending;
      },
      drainPendingPermissionIds: (runtimeSession) => {
        const ids = Array.from(runtimeSession.data.pendingPermissions.keys());
        runtimeSession.data.pendingPermissions.clear();
        return ids;
      },
      peekPendingPassthrough: (runtimeSession) => runtimeSession.pendingPassthroughs[0],
      shiftPendingPassthrough: (runtimeSession) => runtimeSession.pendingPassthroughs.shift(),
      setSlashCommandsState: (runtimeSession, commands) => {
        runtimeSession.data.state = { ...runtimeSession.data.state, slash_commands: commands };
      },
      registerCLICommands: (runtimeSession, commands) => {
        runtimeSession.registry.registerFromCLI(
          commands.map((name) => ({ name, description: "" })),
        );
      },
    });

    const session = createSession("sess-fi");
    await manager.connectBackend(session);

    adapter.failStream("sess-fi", new Error("Injected stream failure"));

    await waitForAssertion(() => {
      expect(emitEvent).toHaveBeenCalledWith(
        "backend:disconnected",
        expect.objectContaining({ sessionId: "sess-fi" }),
      );
    });

    expect(emitEvent).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        source: "backendConsumption",
        sessionId: "sess-fi",
      }),
    );
    expect(broadcaster.broadcast).toHaveBeenCalledWith(session, { type: "cli_disconnected" });
  });

  it("drains pending passthroughs with slash_command_error when stream fails (lines 594-605)", async () => {
    const adapter = new FailureInjectionBackendAdapter();
    const emitEvent = vi.fn();
    const broadcaster = {
      broadcast: vi.fn(),
      broadcastToParticipants: vi.fn(),
      sendTo: vi.fn(),
    } as any;
    const { manager } = buildConnectorDeps(adapter, emitEvent, broadcaster);

    const session = createSession("sess-drain-fail");
    // Pre-populate pending passthrough entries
    session.pendingPassthroughs.push(makePassthrough("/compact", "req-compact"));

    await manager.connectBackend(session);
    adapter.failStream("sess-drain-fail", new Error("Backend crashed"));

    await waitForAssertion(() => {
      expect(broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "slash_command_error", command: "/compact" }),
      );
    });

    expect(emitEvent).toHaveBeenCalledWith(
      "slash_command:failed",
      expect.objectContaining({ command: "/compact", error: "Backend crashed" }),
    );
  });

  it("drains pending passthroughs with slash_command_error when stream ends unexpectedly (lines 619-630)", async () => {
    const adapter = new FailureInjectionBackendAdapter();
    const emitEvent = vi.fn();
    const broadcaster = {
      broadcast: vi.fn(),
      broadcastToParticipants: vi.fn(),
      sendTo: vi.fn(),
    } as any;
    const { manager } = buildConnectorDeps(adapter, emitEvent, broadcaster);

    const session = createSession("sess-drain-end");
    session.pendingPassthroughs.push(makePassthrough("/status", "req-status"));

    await manager.connectBackend(session);
    adapter.endStream("sess-drain-end");

    await waitForAssertion(() => {
      expect(broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({
          type: "slash_command_error",
          command: "/status",
          error: "Backend stream ended unexpectedly",
        }),
      );
    });

    expect(emitEvent).toHaveBeenCalledWith(
      "slash_command:failed",
      expect.objectContaining({ command: "/status", error: "Backend stream ended unexpectedly" }),
    );
  });
});
