/**
 * Focused tests for BackendConnector branch coverage.
 *
 * Targets: cliUserEchoToText, passthrough handler, connect with
 * existing session, sendToBackend with no session
 * during flush, and unexpected backend disconnection.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CLIMessage } from "../../types/cli-messages.js";
import type {
  BackendAdapter,
  BackendSession,
  ConnectOptions,
} from "../interfaces/backend-adapter.js";
import { MessageTracerImpl, type TraceEvent } from "../messaging/message-tracer.js";
import type { Session } from "../session/session-repository.js";
import type { UnifiedMessage } from "../types/unified-message.js";
import { createUnifiedMessage } from "../types/unified-message.js";
import type { BackendConnectorDeps } from "./backend-connector.js";
import { BackendConnector } from "./backend-connector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createMessageChannel() {
  const queue: UnifiedMessage[] = [];
  let resolve: ((v: IteratorResult<UnifiedMessage>) => void) | null = null;
  let done = false;

  return {
    push(msg: UnifiedMessage) {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: msg, done: false });
      } else {
        queue.push(msg);
      }
    },
    close() {
      done = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<UnifiedMessage> {
      return {
        next(): Promise<IteratorResult<UnifiedMessage>> {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((r) => {
            resolve = r;
          });
        },
      };
    },
  };
}

class TestBackendSession implements BackendSession {
  readonly sessionId: string;
  readonly channel = createMessageChannel();
  readonly sentMessages: UnifiedMessage[] = [];
  readonly sentInitializeRequestIds: string[] = [];
  closed = false;
  private _passthroughHandler: ((msg: CLIMessage) => boolean) | null = null;

  constructor(sessionId: string, opts?: { passthrough?: boolean }) {
    this.sessionId = sessionId;
    if (opts?.passthrough) {
      // Add setPassthroughHandler to make supportsPassthroughHandler return true
      (this as any).setPassthroughHandler = (handler: ((msg: CLIMessage) => boolean) | null) => {
        this._passthroughHandler = handler;
      };
    }
  }

  send(msg: UnifiedMessage): void {
    this.sentMessages.push(msg);
  }

  initialize(requestId: string): void {
    this.sentInitializeRequestIds.push(requestId);
  }

  get messages(): AsyncIterable<UnifiedMessage> {
    return this.channel;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.channel.close();
  }

  pushMessage(msg: UnifiedMessage) {
    this.channel.push(msg);
  }

  endStream() {
    this.channel.close();
  }

  get passthroughHandler() {
    return this._passthroughHandler;
  }
}

class TestAdapter implements BackendAdapter {
  readonly name = "test";
  readonly capabilities = {
    streaming: true,
    permissions: true,
    slashCommands: false,
    availability: "local" as const,
    teams: false,
  };

  nextSession: TestBackendSession | null = null;

  async connect(options: ConnectOptions): Promise<BackendSession> {
    if (!this.nextSession) {
      this.nextSession = new TestBackendSession(options.sessionId);
    }
    return this.nextSession;
  }
}

function createSession(overrides?: Partial<Session>): Session {
  const s = {
    id: "sess-1",
    name: "test",
    state: "idle",
    backendSession: null,
    backendAbort: null,
    pendingMessages: [],
    pendingPermissions: new Map(),
    pendingPassthroughs: [],
    consumers: new Set(),
    lastActivity: Date.now(),
    ...overrides,
  } as any;
  if (!s.data) s.data = s;
  return s as Session;
}

function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Creates a mock runtime that operates on the session object directly,
 * mimicking what the real SessionRuntime does via its state-mutating methods.
 */
function createSessionAwareRuntime(session: any) {
  return {
    getBackendSession: vi.fn(() => session.backendSession ?? null),
    getBackendAbort: vi.fn(() => session.backendAbort ?? null),
    peekPendingPassthrough: vi.fn(() => (session as any).pendingPassthroughs?.[0]),
    shiftPendingPassthrough: vi.fn(() => (session as any).pendingPassthroughs?.shift()),
    getState: vi.fn(() => {
      const current = (session as any).state;
      if (current && typeof current === "object") return current;
      return { slash_commands: [] };
    }),
    setState: vi.fn((state: any) => {
      const current = (session as any).state;
      if (current && typeof current === "object") {
        (session as any).state = state;
        if (session.data && typeof session.data.state === "object") {
          session.data.state = state;
        }
      }
    }),
    registerSlashCommandNames: vi.fn((commands: string[]) => {
      const registry = (session as any).registry;
      if (!registry || typeof registry.registerFromCLI !== "function") return;
      registry.registerFromCLI(commands.map((name: string) => ({ name, description: "" })));
    }),
  };
}

function createDeps(overrides?: Partial<BackendConnectorDeps>): BackendConnectorDeps {
  // We use a proxy-based getRuntime so each session gets its own runtime instance
  // that mutates the session's own fields (mirroring the real SessionRuntime behavior).
  const runtimeCache = new WeakMap<object, ReturnType<typeof createSessionAwareRuntime>>();
  // routeSystemSignal mock applies BACKEND_CONNECTED and BACKEND_DISCONNECTED handle mutations
  // (mirroring the real SessionRuntime post-reducer hook behavior).
  const routeSystemSignal = vi.fn((session: any, signal: any) => {
    if (signal.kind === "BACKEND_CONNECTED") {
      session.backendSession = signal.backendSession;
      session.backendAbort = signal.backendAbort;
      if (!session.data) session.data = session;
      session.data.adapterSupportsSlashPassthrough = signal.supportsSlashPassthrough;
      session.adapterSlashExecutor = signal.slashExecutor;
    } else if (signal.kind === "BACKEND_DISCONNECTED") {
      session.backendSession = null;
      session.backendAbort = null;
      if (!session.data) session.data = session;
      session.data.backendSessionId = undefined;
      session.data.adapterSupportsSlashPassthrough = false;
      session.adapterSlashExecutor = null;
    }
  });
  return {
    adapter: new TestAdapter(),
    adapterResolver: null,
    logger: noopLogger,
    metrics: null,
    routeUnifiedMessage: vi.fn(),
    routeSystemSignal,
    emitEvent: vi.fn(),
    getRuntime: (session) => {
      if (!runtimeCache.has(session)) {
        runtimeCache.set(session, createSessionAwareRuntime(session));
      }
      return runtimeCache.get(session) as any;
    },
    ...overrides,
  };
}

function createTraceCollector() {
  const lines: string[] = [];
  const tracer = new MessageTracerImpl({
    level: "smart",
    allowSensitive: false,
    write: (line) => lines.push(line),
    staleTimeoutMs: 60_000,
  });
  const events = () => lines.map((line) => JSON.parse(line) as TraceEvent);
  return { tracer, events };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BackendConnector", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("connectBackend", () => {
    it("connects and broadcasts events", async () => {
      const deps = createDeps();
      const mgr = new BackendConnector(deps);
      const session = createSession();

      await mgr.connectBackend(session);

      expect(session.backendSession).not.toBeNull();
      expect(deps.routeSystemSignal).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ kind: "BACKEND_CONNECTED" }),
      );
    });

    it("closes existing backend session on reconnect", async () => {
      const deps = createDeps();
      const mgr = new BackendConnector(deps);

      const oldSession = new TestBackendSession("sess-1");
      const oldAbort = new AbortController();
      const abortSpy = vi.spyOn(oldAbort, "abort");

      const session = createSession({
        backendSession: oldSession,
        backendAbort: oldAbort,
      });

      await mgr.connectBackend(session);

      expect(oldSession.closed).toBe(true);
      expect(abortSpy).toHaveBeenCalled();
    });

    it("records metrics when metrics collector is provided", async () => {
      const metrics = { recordEvent: vi.fn() };
      const deps = createDeps({ metrics });
      const mgr = new BackendConnector(deps);
      const session = createSession();

      await mgr.connectBackend(session);

      expect(metrics.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "backend:connected", sessionId: "sess-1" }),
      );
    });

    it("routes BACKEND_CONNECTED signal (pending messages are drained via reducer effects)", async () => {
      const testSession = new TestBackendSession("sess-1");
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const msg1 = createUnifiedMessage({ type: "user_message", role: "user" });
      const msg2 = createUnifiedMessage({ type: "user_message", role: "user" });

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession({ pendingMessages: [msg1, msg2] as any });

      await mgr.connectBackend(session);

      // The connector routes BACKEND_CONNECTED — the reducer drains pending messages
      // via SEND_TO_BACKEND effects executed by SessionRuntime.
      expect(deps.routeSystemSignal).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ kind: "BACKEND_CONNECTED", backendSession: testSession }),
      );
    });

    it("sets up passthrough handler when session supports it", async () => {
      const testSession = new TestBackendSession("sess-1", { passthrough: true });
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession({
        pendingPassthroughs: [{ command: "/test", requestId: "req-1" }],
      });

      await mgr.connectBackend(session);

      // Verify passthrough handler was installed
      expect(testSession.passthroughHandler).not.toBeNull();

      // Trigger the passthrough handler with a user message
      const result = testSession.passthroughHandler!({
        type: "user",
        message: { content: "echo result" },
      } as CLIMessage);

      expect(result).toBe(true);
      expect(deps.routeSystemSignal).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ kind: "SLASH_PASSTHROUGH_RESULT", content: "echo result" }),
      );
      expect(session.pendingPassthroughs).toHaveLength(0);
    });

    it("passthrough handler returns false for non-user messages", async () => {
      const testSession = new TestBackendSession("sess-1", { passthrough: true });
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession();

      await mgr.connectBackend(session);

      const result = testSession.passthroughHandler!({
        type: "assistant",
        message: { content: "hello" },
      } as CLIMessage);
      expect(result).toBe(false);
    });

    it("passthrough handler returns false when no pending passthrough", async () => {
      const testSession = new TestBackendSession("sess-1", { passthrough: true });
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession({ pendingPassthroughs: [] });

      await mgr.connectBackend(session);

      const result = testSession.passthroughHandler!({
        type: "user",
        message: { content: "hello" },
      } as CLIMessage);
      expect(result).toBe(false);
    });

    it("throws when no adapter configured", async () => {
      const deps = createDeps({ adapter: null });
      const mgr = new BackendConnector(deps);
      const session = createSession();

      await expect(mgr.connectBackend(session)).rejects.toThrow("No BackendAdapter configured");
    });

    it("sets adapterSupportsSlashPassthrough true when adapter capabilities.slashCommands is true", async () => {
      const deps = createDeps();
      // Override slashCommands on the TestAdapter's capabilities
      (deps.adapter as TestAdapter).capabilities = {
        ...(deps.adapter as TestAdapter).capabilities,
        slashCommands: true,
      };
      const manager = new BackendConnector(deps);
      const session = createSession();
      await manager.connectBackend(session);
      expect(session.data.adapterSupportsSlashPassthrough).toBe(true);
    });

    it("sets adapterSupportsSlashPassthrough false when adapter capabilities.slashCommands is false", async () => {
      const deps = createDeps(); // TestAdapter has slashCommands: false by default
      const manager = new BackendConnector(deps);
      const session = createSession();
      await manager.connectBackend(session);
      expect(session.data.adapterSupportsSlashPassthrough).toBe(false);
    });
  });

  describe("sendToBackend", () => {
    it("warns and returns when no backend session", () => {
      const deps = createDeps();
      const mgr = new BackendConnector(deps);
      const session = createSession();

      const msg = createUnifiedMessage({ type: "user_message", role: "user" });
      mgr.sendToBackend(session, msg);

      expect(noopLogger.warn).toHaveBeenCalledWith(expect.stringContaining("No backend session"));
    });

    it("emits error event when send throws", () => {
      const deps = createDeps();
      const mgr = new BackendConnector(deps);
      const badSession = {
        send: () => {
          throw new Error("send failed");
        },
      } as unknown as BackendSession;
      const session = createSession({ backendSession: badSession });

      const msg = createUnifiedMessage({ type: "user_message", role: "user" });
      mgr.sendToBackend(session, msg);

      expect(deps.emitEvent).toHaveBeenCalledWith(
        "error",
        expect.objectContaining({
          source: "sendToBackend",
        }),
      );
    });
  });

  describe("disconnectBackend", () => {
    it("disconnects and routes BACKEND_DISCONNECTED signal (permission cancellation handled by reducer)", async () => {
      const deps = createDeps();
      const mgr = new BackendConnector(deps);
      const testSession = new TestBackendSession("sess-1");
      const session = createSession({
        backendSession: testSession,
        backendAbort: new AbortController(),
        pendingPermissions: new Map([["perm-1", {} as any]]),
      });

      await mgr.disconnectBackend(session);

      expect(testSession.closed).toBe(true);
      expect(session.backendSession).toBeNull();
      expect(session.backendAbort).toBeNull();
      // Permission cancellation is now handled via BACKEND_DISCONNECTED reducer effects
      // (BROADCAST_TO_PARTICIPANTS effects executed by SessionRuntime.executeEffects).
      expect(deps.routeSystemSignal).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ kind: "BACKEND_DISCONNECTED" }),
      );
    });

    it("is a no-op when no backend session", async () => {
      const deps = createDeps();
      const mgr = new BackendConnector(deps);
      const session = createSession();

      await mgr.disconnectBackend(session);

      // Should not route signals for disconnection
      expect(deps.routeSystemSignal).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kind: "BACKEND_DISCONNECTED" }),
      );
    });

    it("records metrics when disconnecting", async () => {
      const metrics = { recordEvent: vi.fn() };
      const deps = createDeps({ metrics });
      const mgr = new BackendConnector(deps);
      const session = createSession({
        backendSession: new TestBackendSession("sess-1"),
        backendAbort: new AbortController(),
      });

      await mgr.disconnectBackend(session);

      expect(metrics.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "backend:disconnected" }),
      );
    });

    it("resets adapterSupportsSlashPassthrough to false on disconnect", async () => {
      const deps = createDeps();
      (deps.adapter as TestAdapter).capabilities = {
        ...(deps.adapter as TestAdapter).capabilities,
        slashCommands: true,
      };
      const manager = new BackendConnector(deps);
      const session = createSession();
      await manager.connectBackend(session);
      expect(session.data.adapterSupportsSlashPassthrough).toBe(true);
      await manager.disconnectBackend(session);
      expect(session.data.adapterSupportsSlashPassthrough).toBe(false);
    });

    it("clears backendSessionId on disconnect to avoid stale resume ids", async () => {
      const deps = createDeps();
      const manager = new BackendConnector(deps);
      const session = createSession({
        backendSession: new TestBackendSession("sess-1"),
        backendAbort: new AbortController(),
        backendSessionId: "stale-session-id",
      });

      await manager.disconnectBackend(session);
      expect(session.data.backendSessionId).toBeUndefined();
    });
  });

  describe("backend message consumption", () => {
    it("routes incoming messages to routeUnifiedMessage", async () => {
      const routeUnifiedMessage = vi.fn();
      const testSession = new TestBackendSession("sess-1");
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter, routeUnifiedMessage });
      const mgr = new BackendConnector(deps);
      const session = createSession();

      await mgr.connectBackend(session);

      const msg = createUnifiedMessage({ type: "assistant", role: "assistant" });
      testSession.pushMessage(msg);

      await tick();

      expect(routeUnifiedMessage).toHaveBeenCalledWith(session, msg);
    });

    it("emits backend:message for each backend message", async () => {
      const testSession = new TestBackendSession("sess-1");
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession();

      await mgr.connectBackend(session);

      const msg = createUnifiedMessage({ type: "assistant", role: "assistant" });
      testSession.pushMessage(msg);
      await tick();

      expect(deps.emitEvent).toHaveBeenCalledWith("backend:message", {
        sessionId: "sess-1",
        message: msg,
      });
    });

    it("converts pending passthrough assistant output into slash_command_result", async () => {
      const testSession = new TestBackendSession("sess-1");
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession({
        pendingPassthroughs: [{ command: "/context", requestId: "req-ctx" }],
      });

      await mgr.connectBackend(session);

      testSession.pushMessage(
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [{ type: "text", text: "Context: 23% used" }],
        }),
      );

      await tick();

      expect(deps.routeSystemSignal).toHaveBeenCalledWith(
        session,
        expect.objectContaining({
          kind: "SLASH_PASSTHROUGH_RESULT",
          command: "/context",
          requestId: "req-ctx",
          content: "Context: 23% used",
          source: "cli",
        }),
      );
      expect(session.pendingPassthroughs).toHaveLength(0);
    });

    it("converts pending passthrough result output into slash_command_result", async () => {
      const testSession = new TestBackendSession("sess-1");
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession({
        pendingPassthroughs: [{ command: "/context", requestId: "req-ctx" }],
      });

      await mgr.connectBackend(session);

      testSession.pushMessage(
        createUnifiedMessage({
          type: "result",
          role: "system",
          metadata: { result: "Context summary line" },
        }),
      );

      await tick();

      expect(deps.routeSystemSignal).toHaveBeenCalledWith(
        session,
        expect.objectContaining({
          kind: "SLASH_PASSTHROUGH_RESULT",
          command: "/context",
          requestId: "req-ctx",
          content: "Context summary line",
          source: "cli",
        }),
      );
      expect(session.pendingPassthroughs).toHaveLength(0);
    });

    it("converts pending passthrough stream text + empty result into slash_command_result", async () => {
      const testSession = new TestBackendSession("sess-1");
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession({
        pendingPassthroughs: [{ command: "/context", requestId: "req-ctx" }],
      });

      await mgr.connectBackend(session);

      testSession.pushMessage(
        createUnifiedMessage({
          type: "stream_event",
          role: "system",
          metadata: {
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Context Usage\nTokens: 43.5k / 200k (22%)" },
            },
          },
        }),
      );
      testSession.pushMessage(
        createUnifiedMessage({
          type: "result",
          role: "system",
          metadata: { result: "" },
        }),
      );

      await tick();

      expect(deps.routeSystemSignal).toHaveBeenCalledWith(
        session,
        expect.objectContaining({
          kind: "SLASH_PASSTHROUGH_RESULT",
          command: "/context",
          requestId: "req-ctx",
          content: "Context Usage\nTokens: 43.5k / 200k (22%)",
          source: "cli",
        }),
      );
      expect(session.pendingPassthroughs).toHaveLength(0);
    });

    it("golden: empty /context result emits empty_result summary", async () => {
      const trace = createTraceCollector();
      const testSession = new TestBackendSession("sess-1");
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter, tracer: trace.tracer });
      const mgr = new BackendConnector(deps);
      const session = createSession({
        pendingPassthroughs: [
          {
            command: "/context",
            requestId: "req-ctx",
            slashRequestId: "req-ctx",
            traceId: "t_ctx",
            startedAtMs: Date.now(),
          },
        ],
      });

      await mgr.connectBackend(session);

      testSession.pushMessage(
        createUnifiedMessage({
          type: "result",
          role: "system",
          metadata: { result: "" },
        }),
      );

      await tick();

      expect(deps.routeSystemSignal).toHaveBeenCalledWith(
        session,
        expect.objectContaining({
          kind: "SLASH_PASSTHROUGH_ERROR",
          command: "/context",
          requestId: "req-ctx",
        }),
      );
      expect(session.pendingPassthroughs).toHaveLength(0);

      const golden = trace
        .events()
        .filter(
          (e) =>
            e.messageType === "slash_command_error" || e.messageType === "slash_decision_summary",
        )
        .map((e) => ({
          messageType: e.messageType,
          requestId: e.requestId,
          command: e.command,
          phase: e.phase,
          outcome: e.outcome,
          matched_path:
            e.messageType === "slash_decision_summary"
              ? ((e.body as { matched_path?: string } | undefined)?.matched_path ?? null)
              : null,
        }));
      expect(golden).toMatchInlineSnapshot(`
        [
          {
            "command": "/context",
            "matched_path": null,
            "messageType": "slash_command_error",
            "outcome": "empty_result",
            "phase": "finalize_passthrough",
            "requestId": "req-ctx",
          },
          {
            "command": "/context",
            "matched_path": "none",
            "messageType": "slash_decision_summary",
            "outcome": "empty_result",
            "phase": "summary",
            "requestId": "req-ctx",
          },
        ]
      `);
    });

    it("routes BACKEND_DISCONNECTED signal when stream ends unexpectedly", async () => {
      const testSession = new TestBackendSession("sess-1");
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession();

      await mgr.connectBackend(session);

      // End the stream (simulating unexpected backend disconnect)
      testSession.endStream();

      await tick(50);

      expect(deps.routeSystemSignal).toHaveBeenCalledWith(session, {
        kind: "BACKEND_DISCONNECTED",
        reason: "stream ended",
      });
      expect(session.backendSession).toBeNull();
    });

    it("clears backendSessionId when stream ends unexpectedly", async () => {
      const testSession = new TestBackendSession("sess-1");
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession({ backendSessionId: "stale-session-id" });

      await mgr.connectBackend(session);
      testSession.endStream();
      await tick(50);

      expect(session.data.backendSessionId).toBeUndefined();
    });

    it("emits backendConsumption error when backend stream iterator throws", async () => {
      const adapter = new TestAdapter();
      adapter.nextSession = {
        sessionId: "sess-1",
        send: vi.fn(),
        initialize: vi.fn(),
        messages: {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              throw new Error("stream boom");
            },
          }),
        },
        close: vi.fn(),
      } as any;

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession();

      await mgr.connectBackend(session);
      await tick(30);

      expect(deps.emitEvent).toHaveBeenCalledWith(
        "error",
        expect.objectContaining({
          source: "backendConsumption",
          sessionId: "sess-1",
          error: expect.any(Error),
        }),
      );
      expect(deps.routeSystemSignal).toHaveBeenCalledWith(session, {
        kind: "BACKEND_DISCONNECTED",
        reason: "stream ended",
      });
      expect(session.backendSession).toBeNull();
    });
  });

  describe("isBackendConnected", () => {
    it("returns true when backend session exists", () => {
      const deps = createDeps();
      const mgr = new BackendConnector(deps);
      const session = createSession({ backendSession: new TestBackendSession("sess-1") });

      expect(mgr.isBackendConnected(session)).toBe(true);
    });

    it("returns false when no backend session", () => {
      const deps = createDeps();
      const mgr = new BackendConnector(deps);
      const session = createSession();

      expect(mgr.isBackendConnected(session)).toBe(false);
    });
  });

  describe("hasAdapter", () => {
    it("returns true when adapter is configured", () => {
      const deps = createDeps();
      const mgr = new BackendConnector(deps);
      expect(mgr.hasAdapter).toBe(true);
    });

    it("returns false when adapter is null", () => {
      const deps = createDeps({ adapter: null });
      const mgr = new BackendConnector(deps);
      expect(mgr.hasAdapter).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// cliUserEchoToText (accessed via passthrough handler)
// ---------------------------------------------------------------------------

describe("BackendConnector — cliUserEchoToText via passthrough", () => {
  async function setupWithPassthrough() {
    const testSession = new TestBackendSession("sess-1", { passthrough: true });
    const adapter = new TestAdapter();
    adapter.nextSession = testSession;
    const deps = createDeps({ adapter });
    const mgr = new BackendConnector(deps);
    const session = createSession({
      pendingPassthroughs: [{ command: "/test", requestId: "req-1" }],
    });

    await mgr.connectBackend(session);
    return { testSession, session, deps };
  }

  it("handles array content with mixed items", async () => {
    const { testSession, session, deps } = await setupWithPassthrough();

    testSession.passthroughHandler!({
      type: "user",
      message: {
        content: [
          "plain string",
          { type: "text", text: " and object" },
          { type: "image", url: "ignored" },
        ],
      },
    } as unknown as CLIMessage);

    expect(deps.routeSystemSignal).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ content: "plain string and object" }),
    );
  });

  it("handles object content with text property", async () => {
    const { testSession, deps } = await setupWithPassthrough();

    // Reset pendingPassthroughs for another call
    const session2 = createSession({
      pendingPassthroughs: [{ command: "/test2", requestId: "req-2" }],
    });
    // Re-connect with a new session that has passthrough pending
    const testSession2 = new TestBackendSession("sess-2", { passthrough: true });
    const adapter2 = new TestAdapter();
    adapter2.nextSession = testSession2;
    const deps2 = createDeps({ adapter: adapter2 });
    const mgr2 = new BackendConnector(deps2);
    await mgr2.connectBackend(session2);

    testSession2.passthroughHandler!({
      type: "user",
      message: { content: { text: "object text" } },
    } as unknown as CLIMessage);

    expect(deps2.routeSystemSignal).toHaveBeenCalledWith(
      session2,
      expect.objectContaining({ content: "object text" }),
    );
  });

  it("handles null content", async () => {
    const { testSession, session, deps } = await setupWithPassthrough();

    testSession.passthroughHandler!({
      type: "user",
      message: { content: null },
    } as unknown as CLIMessage);

    expect(deps.routeSystemSignal).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ content: "" }),
    );
  });

  it("handles object content without text property", async () => {
    const testSession = new TestBackendSession("sess-1", { passthrough: true });
    const adapter = new TestAdapter();
    adapter.nextSession = testSession;
    const deps = createDeps({ adapter });
    const mgr = new BackendConnector(deps);
    const session = createSession({
      pendingPassthroughs: [{ command: "/x", requestId: "r-1" }],
    });
    await mgr.connectBackend(session);

    testSession.passthroughHandler!({
      type: "user",
      message: { content: { notText: "value" } },
    } as unknown as CLIMessage);

    expect(deps.routeSystemSignal).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ content: "" }),
    );
  });

  it("handles object content with non-string text property", async () => {
    const testSession = new TestBackendSession("sess-1", { passthrough: true });
    const adapter = new TestAdapter();
    adapter.nextSession = testSession;
    const deps = createDeps({ adapter });
    const mgr = new BackendConnector(deps);
    const session = createSession({
      pendingPassthroughs: [{ command: "/x", requestId: "r-1" }],
    });
    await mgr.connectBackend(session);

    testSession.passthroughHandler!({
      type: "user",
      message: { content: { text: 42 } },
    } as unknown as CLIMessage);

    expect(deps.routeSystemSignal).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ content: "" }),
    );
  });

  it("strips local-command-stdout wrapper from passthrough content", async () => {
    const testSession = new TestBackendSession("sess-1", { passthrough: true });
    const adapter = new TestAdapter();
    adapter.nextSession = testSession;
    const deps = createDeps({ adapter });
    const mgr = new BackendConnector(deps);
    const session = createSession({
      pendingPassthroughs: [{ command: "/context", requestId: "r-1" }],
    });
    await mgr.connectBackend(session);

    testSession.passthroughHandler!({
      type: "user",
      message: { content: "<local-command-stdout>Context Usage</local-command-stdout>" },
    } as unknown as CLIMessage);

    expect(deps.routeSystemSignal).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ content: "Context Usage" }),
    );
  });
});
