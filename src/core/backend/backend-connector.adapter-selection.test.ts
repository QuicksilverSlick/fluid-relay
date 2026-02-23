import { describe, expect, it, vi } from "vitest";
import type { AdapterResolver } from "../../adapters/adapter-resolver.js";
import type { BackendAdapter, BackendSession } from "../interfaces/backend-adapter.js";
import { BackendConnector } from "./backend-connector.js";

function mockAdapter(name: string): BackendAdapter {
  return {
    name,
    capabilities: {
      streaming: true,
      permissions: true,
      slashCommands: false,
      availability: "local",
      teams: false,
    },
    connect: vi.fn().mockResolvedValue({
      sessionId: "test-session",
      send: vi.fn(),
      sendRaw: vi.fn(),
      messages: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as BackendSession),
  };
}

function mockResolver(adapters: Record<string, BackendAdapter>): AdapterResolver {
  const claude = adapters.claude ?? mockAdapter("claude");
  return {
    resolve: vi.fn((name) => {
      const resolved = name ?? "claude";
      const adapter = adapters[resolved];
      if (!adapter) throw new Error(`Unknown adapter: ${resolved}`);
      return adapter;
    }),
    defaultName: "claude" as any,
    availableAdapters: ["claude", "codex", "acp", "gemini", "opencode"] as any,
  };
}

/**
 * Creates a session-aware mock runtime that mutates the session directly,
 * mirroring the real SessionRuntime behavior.
 */
function createSessionAwareRuntime(session: any) {
  return {
    attachBackendConnection: vi.fn((params: any) => {
      session.backendSession = params.backendSession;
      session.backendAbort = params.backendAbort;
      if (session.data)
        session.data.adapterSupportsSlashPassthrough = params.supportsSlashPassthrough;
      session.adapterSlashExecutor = params.slashExecutor;
    }),
    resetBackendConnectionState: vi.fn(() => {
      session.backendSession = null;
      session.backendAbort = null;
      if (session.data) {
        session.data.backendSessionId = undefined;
        session.data.adapterSupportsSlashPassthrough = false;
      }
      session.adapterSlashExecutor = null;
    }),
    getBackendSession: vi.fn(() => session.backendSession ?? null),
    getBackendAbort: vi.fn(() => session.backendAbort ?? null),
    drainPendingMessages: vi.fn(() => {
      const pending = session.data?.pendingMessages ?? [];
      if (session.data) session.data.pendingMessages = [];
      return pending;
    }),
    drainPendingPermissionIds: vi.fn(() => {
      const pendingPermissions = session.data?.pendingPermissions ?? new Map();
      const ids = Array.from(pendingPermissions.keys());
      pendingPermissions.clear();
      if (session.data) session.data.pendingPermissions = pendingPermissions;
      return ids;
    }),
    peekPendingPassthrough: vi.fn(() => session.pendingPassthroughs?.[0]),
    shiftPendingPassthrough: vi.fn(() => session.pendingPassthroughs?.shift()),
    getState: vi.fn(() => {
      const state = session.data?.state ?? session.state ?? {};
      return state;
    }),
    setState: vi.fn((state: any) => {
      if (session.data) session.data.state = state;
      else session.state = state;
    }),
    registerSlashCommandNames: vi.fn((commands: string[]) => {
      session.registry?.registerFromCLI?.(
        commands.map((name: string) => ({ name, description: "" })),
      );
    }),
  };
}

describe("BackendConnector per-session adapter", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

  function makeBaseDeps(sessionRef: { current: any }) {
    const runtimeCache = new WeakMap<object, ReturnType<typeof createSessionAwareRuntime>>();
    return {
      logger,
      metrics: null,
      broadcaster: { broadcast: vi.fn(), sendTo: vi.fn() } as any,
      routeUnifiedMessage: vi.fn(),
      emitEvent: vi.fn(),
      getRuntime: (session: any) => {
        if (!runtimeCache.has(session)) {
          runtimeCache.set(session, createSessionAwareRuntime(session));
        }
        return runtimeCache.get(session) as any;
      },
    };
  }

  it("resolves adapter from resolver using session.data.adapterName", async () => {
    const codex = mockAdapter("codex");
    const resolver = mockResolver({ codex, claude: mockAdapter("claude") });
    const sessionRef = { current: null as any };
    const blm = new BackendConnector({
      ...makeBaseDeps(sessionRef),
      adapter: null,
      adapterResolver: resolver,
    });

    const session = {
      id: "s1",
      adapterName: "codex",
      backendSession: null,
      backendAbort: null,
      pendingMessages: [],
    } as any;
    session.data = session;
    sessionRef.current = session;

    await blm.connectBackend(session);
    expect(resolver.resolve).toHaveBeenCalledWith("codex");
    expect(codex.connect).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1" }));
  });

  it("falls back to global adapter when no adapterName", async () => {
    const globalAdapter = mockAdapter("claude");
    const sessionRef = { current: null as any };
    const blm = new BackendConnector({
      ...makeBaseDeps(sessionRef),
      adapter: globalAdapter,
      adapterResolver: null,
    });

    const session = {
      id: "s2",
      adapterName: undefined,
      backendSession: null,
      backendAbort: null,
      pendingMessages: [],
    } as any;
    session.data = session;
    sessionRef.current = session;

    await blm.connectBackend(session);
    expect(globalAdapter.connect).toHaveBeenCalled();
  });

  it("falls back to global adapter when adapterName is set but no resolver", async () => {
    const globalAdapter = mockAdapter("claude");
    const sessionRef = { current: null as any };
    const blm = new BackendConnector({
      ...makeBaseDeps(sessionRef),
      adapter: globalAdapter,
      adapterResolver: null,
    });

    const session = {
      id: "s3",
      adapterName: "codex",
      backendSession: null,
      backendAbort: null,
      pendingMessages: [],
    } as any;
    session.data = session;
    sessionRef.current = session;

    await blm.connectBackend(session);
    expect(globalAdapter.connect).toHaveBeenCalled();
  });

  it("falls back to global adapter for invalid adapterName", async () => {
    const globalAdapter = mockAdapter("claude");
    const resolver = mockResolver({ claude: mockAdapter("claude") });
    const sessionRef = { current: null as any };
    const blm = new BackendConnector({
      ...makeBaseDeps(sessionRef),
      adapter: globalAdapter,
      adapterResolver: resolver,
    });

    const session = {
      id: "s4",
      adapterName: "bogus-invalid",
      backendSession: null,
      backendAbort: null,
      pendingMessages: [],
    } as any;
    session.data = session;
    sessionRef.current = session;

    await blm.connectBackend(session);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Invalid adapter name"));
    expect(globalAdapter.connect).toHaveBeenCalled();
  });

  it("hasAdapter is true when resolver is set", () => {
    const sessionRef = { current: null as any };
    const blm = new BackendConnector({
      ...makeBaseDeps(sessionRef),
      adapter: null,
      adapterResolver: mockResolver({ claude: mockAdapter("claude") }),
    });
    expect(blm.hasAdapter).toBe(true);
  });

  it("hasAdapter is true when global adapter is set", () => {
    const sessionRef = { current: null as any };
    const blm = new BackendConnector({
      ...makeBaseDeps(sessionRef),
      adapter: mockAdapter("claude"),
      adapterResolver: null,
    });
    expect(blm.hasAdapter).toBe(true);
  });

  it("hasAdapter is false when neither resolver nor adapter is set", () => {
    const sessionRef = { current: null as any };
    const blm = new BackendConnector({
      ...makeBaseDeps(sessionRef),
      adapter: null,
      adapterResolver: null,
    });
    expect(blm.hasAdapter).toBe(false);
  });

  it("throws when no adapter or resolver is configured", async () => {
    const sessionRef = { current: null as any };
    const blm = new BackendConnector({
      ...makeBaseDeps(sessionRef),
      adapter: null,
      adapterResolver: null,
    });

    const session = {
      id: "s5",
      adapterName: undefined,
      backendSession: null,
      backendAbort: null,
      pendingMessages: [],
    } as any;
    session.data = session;
    sessionRef.current = session;

    await expect(blm.connectBackend(session)).rejects.toThrow("No BackendAdapter configured");
  });

  it("calls setState with slash commands when slash executor is available", async () => {
    const sessionImpl = {
      sessionId: "test-session",
      send: vi.fn(),
      sendRaw: vi.fn(),
      messages: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as BackendSession;

    const adapter: BackendAdapter = {
      name: "codex",
      capabilities: {
        streaming: true,
        permissions: true,
        slashCommands: true,
        availability: "local",
        teams: false,
      },
      connect: vi.fn().mockResolvedValue(sessionImpl),
      createSlashExecutor: () => ({
        handles: () => true,
        execute: vi.fn(async () => null),
        supportedCommands: () => ["/compact", "/status"],
      }),
    };

    const session = {
      id: "s6",
      adapterName: "codex",
      backendSession: null,
      backendAbort: null,
      pendingMessages: [],
      pendingPermissions: new Map(),
      pendingPassthroughs: [],
      state: { slash_commands: [] },
      registry: { registerFromCLI: vi.fn() },
    } as any;
    session.data = session;

    // Create a runtime that tracks setState calls
    const mockRuntime = createSessionAwareRuntime(session);
    const setStateSpy = mockRuntime.setState;

    const blm = new BackendConnector({
      adapter,
      adapterResolver: null,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      metrics: null,
      broadcaster: { broadcast: vi.fn(), sendTo: vi.fn() } as any,
      routeUnifiedMessage: vi.fn(),
      emitEvent: vi.fn(),
      getRuntime: () => mockRuntime as any,
    });

    await blm.connectBackend(session);

    // setState should have been called with updated slash_commands
    expect(setStateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ slash_commands: ["/compact", "/status"] }),
    );
    // registerSlashCommandNames should have triggered registerFromCLI
    expect(session.registry.registerFromCLI).toHaveBeenCalledWith([
      { name: "/compact", description: "" },
      { name: "/status", description: "" },
    ]);
  });
});
