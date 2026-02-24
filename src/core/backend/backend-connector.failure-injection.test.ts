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
    getBackendSession: () => session.backendSession ?? null,
    getBackendAbort: () => session.backendAbort ?? null,
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
) {
  const routeSystemSignal = vi.fn((sess: any, signal: any) => {
    if (signal.kind === "BACKEND_CONNECTED") {
      sess.backendSession = signal.backendSession;
      sess.backendAbort = signal.backendAbort;
      sess.data.adapterSupportsSlashPassthrough = signal.supportsSlashPassthrough;
      sess.adapterSlashExecutor = signal.slashExecutor;
    } else if (signal.kind === "BACKEND_DISCONNECTED") {
      sess.backendSession = null;
      sess.backendAbort = null;
      sess.data.backendSessionId = undefined;
      sess.data.adapterSupportsSlashPassthrough = false;
      sess.adapterSlashExecutor = null;
    }
  });
  const manager = new BackendConnector({
    adapter,
    adapterResolver: null,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    metrics: null,
    routeUnifiedMessage: vi.fn(),
    routeSystemSignal,
    emitEvent,
    getRuntime: () => createMockRuntime(session),
  });
  return { manager, emitEvent, routeSystemSignal };
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

    const session = createSession("sess-fi");
    const { manager, routeSystemSignal } = buildConnectorDeps(adapter, session, emitEvent);

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
    const session = createSession("sess-drain-fail");
    const { manager, routeSystemSignal } = buildConnectorDeps(adapter, session, emitEvent);

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
    const session = createSession("sess-drain-end");
    const { manager, routeSystemSignal } = buildConnectorDeps(adapter, session, emitEvent);

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
