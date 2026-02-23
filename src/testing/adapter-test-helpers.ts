/**
 * Shared adapter-path test helpers.
 *
 * Extracted from session-bridge-adapter.test.ts so that migrated test files
 * can use the adapter path (MockBackendAdapter + MockBackendSession) without
 * duplicating ~200 lines of boilerplate.
 *
 * Two layers:
 * - Layer 1 (plumbing): createMessageChannel, MockBackendSession, MockBackendAdapter, tick
 * - Layer 2 (scenario): setupInitializedSession, translateAndPush
 */

import { EventEmitter } from "node:events";
import { translate } from "../adapters/claude/message-translator.js";
import { MemoryStorage } from "../adapters/memory-storage.js";
import type { RateLimiterFactory } from "../core/consumer/consumer-gatekeeper.js";
import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "../core/interfaces/backend-adapter.js";
import type { MessageTracer } from "../core/messaging/message-tracer.js";
import type { Session } from "../core/session/session-repository.js";
import { buildSessionServices } from "../core/session-coordinator/build-services.js";
import type { UnifiedMessage } from "../core/types/unified-message.js";
import { createUnifiedMessage } from "../core/types/unified-message.js";
import type { AuthContext, Authenticator } from "../interfaces/auth.js";
import type { GitInfoResolver } from "../interfaces/git-resolver.js";
import type { Logger } from "../interfaces/logger.js";
import type { SessionStorage } from "../interfaces/storage.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import type { CLIMessage } from "../types/cli-messages.js";
import type { SessionSnapshot } from "../types/session-state.js";

// ─── Layer 1: Plumbing ──────────────────────────────────────────────────────

export function createMessageChannel() {
  const queue: UnifiedMessage[] = [];
  let resolve: ((value: IteratorResult<UnifiedMessage>) => void) | null = null;
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
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((r) => {
            resolve = r;
          });
        },
      };
    },
  };
}

export class MockBackendSession implements BackendSession {
  readonly sessionId: string;
  readonly channel = createMessageChannel();
  readonly sentMessages: UnifiedMessage[] = [];
  readonly sentRawMessages: string[] = [];
  private _closed = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  send(message: UnifiedMessage): void {
    if (this._closed) throw new Error("Session is closed");
    this.sentMessages.push(message);
  }

  sendRaw(ndjson: string): void {
    if (this._closed) throw new Error("Session is closed");
    this.sentRawMessages.push(ndjson);
  }

  get messages(): AsyncIterable<UnifiedMessage> {
    return this.channel;
  }

  async close(): Promise<void> {
    this._closed = true;
    this.channel.close();
  }

  get closed() {
    return this._closed;
  }

  /** Push a message into the channel (simulating backend → bridge). */
  pushMessage(msg: UnifiedMessage) {
    this.channel.push(msg);
  }
}

export class MockBackendAdapter implements BackendAdapter {
  readonly name = "mock";
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: false,
    availability: "local",
    teams: false,
  };

  private sessions = new Map<string, MockBackendSession>();
  private _shouldFail = false;

  setShouldFail(fail: boolean) {
    this._shouldFail = fail;
  }

  async connect(options: ConnectOptions): Promise<BackendSession> {
    if (this._shouldFail) {
      throw new Error("Connection failed");
    }
    const session = new MockBackendSession(options.sessionId);
    this.sessions.set(options.sessionId, session);
    return session;
  }

  getSession(id: string): MockBackendSession | undefined {
    return this.sessions.get(id);
  }
}

/** Wait for async operations (message channel push → for-await → handlers). */
export function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Layer 2: Scenario Helpers ──────────────────────────────────────────────

export const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Minimal bridge-like wrapper returned by createBridgeWithAdapter.
 * Exposes the same surface as SessionBridge for integration tests.
 */
export type BridgeTestWrapper = {
  connectBackend(
    sessionId: string,
    options?: { resume?: boolean; adapterOptions?: Record<string, unknown> },
  ): Promise<void>;
  disconnectBackend(sessionId: string): Promise<void>;
  sendUserMessage(sessionId: string, content: string, options?: Record<string, unknown>): void;
  sendToBackend(sessionId: string, message: UnifiedMessage): void;
  restoreFromStorage(): number;
  getOrCreateSession(sessionId: string): Session;
  removeSession(sessionId: string): void;
  getSession(sessionId: string): SessionSnapshot | undefined;
  seedSessionState(sessionId: string, params: { cwd?: string; model?: string }): void;
  handleConsumerOpen(ws: WebSocketLike, context: AuthContext): void;
  handleConsumerMessage(ws: WebSocketLike, sessionId: string, data: string | Buffer): void;
  handleConsumerClose(ws: WebSocketLike, sessionId: string): void;
  close(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
};

/**
 * Create session services wired with a MockBackendAdapter.
 * Returns a bridge-like wrapper, storage, and adapter for test assertions.
 */
export function createBridgeWithAdapter(options?: {
  storage?: SessionStorage;
  adapter?: BackendAdapter;
  config?: Record<string, unknown>;
  rateLimiterFactory?: RateLimiterFactory;
  tracer?: MessageTracer;
  gitResolver?: GitInfoResolver;
  authenticator?: Authenticator;
}) {
  const storage = options?.storage ?? new MemoryStorage();
  const adapter = options?.adapter ?? new MockBackendAdapter();
  const emitter = new EventEmitter();
  const services = buildSessionServices(
    {
      storage,
      config: { port: 3456, ...options?.config },
      logger: noopLogger as Logger,
      adapter,
      rateLimiterFactory: options?.rateLimiterFactory,
      tracer: options?.tracer,
      gitResolver: options?.gitResolver,
      authenticator: options?.authenticator,
    },
    (type, payload) => emitter.emit(type, payload),
  );
  const bridge: BridgeTestWrapper = {
    connectBackend: async (sessionId, opts) => {
      const session = services.lifecycleService.getOrCreateSession(sessionId);
      return services.backendConnector.connectBackend(session, opts);
    },
    disconnectBackend: async (sessionId) => {
      const session = services.store.get(sessionId);
      if (!session) return;
      services.capabilitiesPolicy.cancelPendingInitialize(session);
      return services.backendConnector.disconnectBackend(session);
    },
    sendUserMessage: (sessionId, content, opts) =>
      services.runtimeApi.sendUserMessage(sessionId, content, opts as never),
    sendToBackend: (sessionId, message) => services.runtimeApi.sendToBackend(sessionId, message),
    restoreFromStorage: () => {
      const count = services.store.restoreAll();
      return count;
    },
    getOrCreateSession: (sessionId) => services.lifecycleService.getOrCreateSession(sessionId),
    removeSession: (sessionId) => services.lifecycleService.removeSession(sessionId),
    getSession: (sessionId) => {
      const session = services.store.get(sessionId);
      if (!session) return undefined;
      return services.runtimeManager.getOrCreate(session).getSessionSnapshot();
    },
    seedSessionState: (sessionId, params) => {
      const session = services.lifecycleService.getOrCreateSession(sessionId);
      services.runtimeManager.getOrCreate(session).seedSessionState(params);
    },
    handleConsumerOpen: (ws, context) => services.consumerGateway.handleConsumerOpen(ws, context),
    handleConsumerMessage: (ws, sessionId, data) =>
      services.consumerGateway.handleConsumerMessage(ws, sessionId, data),
    handleConsumerClose: (ws, sessionId) =>
      services.consumerGateway.handleConsumerClose(ws, sessionId),
    close: async () => {
      await services.lifecycleService.closeAllSessions();
      const stor = services.store.getStorage();
      if (stor?.flush) {
        try {
          await stor.flush();
        } catch (_) {}
      }
      services.core.tracer.destroy();
    },
    on: (event, listener) => {
      emitter.on(event, listener);
    },
    off: (event, listener) => {
      emitter.off(event, listener);
    },
  };
  return { bridge, storage: storage as MemoryStorage, adapter: adapter as MockBackendAdapter };
}

/**
 * Connect a session via the adapter path and push a session_init message.
 * Returns the backend session ready for pushing more messages.
 */
export async function setupInitializedSession(
  bridge: BridgeTestWrapper,
  adapter: MockBackendAdapter,
  sessionId = "sess-1",
): Promise<MockBackendSession> {
  await bridge.connectBackend(sessionId);
  const backendSession = adapter.getSession(sessionId)!;
  backendSession.pushMessage(makeSessionInitMsg());
  await tick();
  return backendSession;
}

/**
 * Translate an NDJSON string (from CLI message factories) into a UnifiedMessage
 * and push it to the backend session. Returns the translated message.
 */
export function translateAndPush(
  backendSession: MockBackendSession,
  ndjsonString: string,
): UnifiedMessage | null {
  const parsed = JSON.parse(ndjsonString) as CLIMessage;
  const unified = translate(parsed);
  if (unified) {
    backendSession.pushMessage(unified);
  }
  return unified;
}

// ─── UnifiedMessage Factory Helpers ─────────────────────────────────────────

export function makeSessionInitMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "session_init",
    role: "system",
    metadata: {
      session_id: "backend-123",
      model: "claude-sonnet-4-5-20250929",
      cwd: "/test",
      tools: ["Bash", "Read"],
      permissionMode: "default",
      claude_code_version: "1.0",
      mcp_servers: [],
      slash_commands: [],
      skills: [],
      ...overrides,
    },
  });
}

export function makeStatusChangeMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "status_change",
    role: "system",
    metadata: { status: null, ...overrides },
  });
}

export function makeAssistantUnifiedMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "assistant",
    role: "assistant",
    content: [{ type: "text", text: "Hello world" }],
    metadata: {
      message_id: "msg-1",
      model: "claude-sonnet-4-5-20250929",
      stop_reason: "end_turn",
      parent_tool_use_id: null,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      ...overrides,
    },
  });
}

export function makeResultUnifiedMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "result",
    role: "system",
    metadata: {
      subtype: "success",
      is_error: false,
      result: "Done",
      duration_ms: 1000,
      duration_api_ms: 800,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      ...overrides,
    },
  });
}

export function makeStreamEventUnifiedMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "stream_event",
    role: "system",
    metadata: {
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      parent_tool_use_id: null,
      ...overrides,
    },
  });
}

export function makePermissionRequestUnifiedMsg(
  overrides: Record<string, unknown> = {},
): UnifiedMessage {
  return createUnifiedMessage({
    type: "permission_request",
    role: "system",
    metadata: {
      request_id: "perm-req-1",
      tool_name: "Bash",
      input: { command: "ls" },
      tool_use_id: "tu-1",
      ...overrides,
    },
  });
}

export function makeToolProgressUnifiedMsg(
  overrides: Record<string, unknown> = {},
): UnifiedMessage {
  return createUnifiedMessage({
    type: "tool_progress",
    role: "system",
    metadata: {
      tool_use_id: "tu-1",
      tool_name: "Bash",
      elapsed_time_seconds: 5,
      ...overrides,
    },
  });
}

export function makeToolUseSummaryUnifiedMsg(
  overrides: Record<string, unknown> = {},
): UnifiedMessage {
  return createUnifiedMessage({
    type: "tool_use_summary",
    role: "system",
    metadata: {
      summary: "Ran bash command",
      tool_use_ids: ["tu-1", "tu-2"],
      ...overrides,
    },
  });
}

export function makeAuthStatusUnifiedMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "auth_status",
    role: "system",
    metadata: {
      isAuthenticating: true,
      output: ["Authenticating..."],
      ...overrides,
    },
  });
}

// ─── Specialized Mock Adapters ───────────────────────────────────────────────

/**
 * A session whose async iterator rejects immediately — used for stream error tests.
 */
export class ErrorBackendSession implements BackendSession {
  readonly sessionId: string;
  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }
  send(): void {}
  sendRaw(_ndjson: string): void {
    throw new Error("ErrorBackendSession does not support raw NDJSON");
  }
  get messages(): AsyncIterable<UnifiedMessage> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<UnifiedMessage> {
        return {
          next: () => Promise.reject(new Error("Stream error")),
        };
      },
    };
  }
  async close(): Promise<void> {}
}

export class ErrorBackendAdapter implements BackendAdapter {
  readonly name = "error-mock";
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: false,
    availability: "local",
    teams: false,
  };
  async connect(options: ConnectOptions): Promise<BackendSession> {
    return new ErrorBackendSession(options.sessionId);
  }
}

export class PassthroughBackendSession implements BackendSession {
  readonly sessionId: string;
  readonly sentMessages: UnifiedMessage[] = [];
  private passthroughHandler: ((rawMsg: any) => boolean) | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  send(message: UnifiedMessage): void {
    this.sentMessages.push(message);
  }

  sendRaw(): void {}

  get messages(): AsyncIterable<UnifiedMessage> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<UnifiedMessage> {
        return {
          next: () => new Promise<IteratorResult<UnifiedMessage>>(() => {}),
        };
      },
    };
  }

  async close(): Promise<void> {}

  setPassthroughHandler(handler: ((rawMsg: any) => boolean) | null): void {
    this.passthroughHandler = handler;
  }

  emitUserEcho(content: unknown): void {
    this.passthroughHandler?.({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    });
  }
}

export class PassthroughBackendAdapter implements BackendAdapter {
  readonly name = "passthrough-mock";
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: true,
    availability: "local",
    teams: false,
  };

  private sessions = new Map<string, PassthroughBackendSession>();

  async connect(options: ConnectOptions): Promise<BackendSession> {
    const session = new PassthroughBackendSession(options.sessionId);
    this.sessions.set(options.sessionId, session);
    return session;
  }

  getSession(id: string): PassthroughBackendSession | undefined {
    return this.sessions.get(id);
  }
}

// ─── UnifiedMessage Factory Helpers (control_response) ──────────────────────

export function makeControlResponseUnifiedMsg(
  overrides: Record<string, unknown> = {},
): UnifiedMessage {
  return createUnifiedMessage({
    type: "control_response",
    role: "system",
    metadata: {
      request_id: "test-uuid",
      subtype: "success",
      response: {
        commands: [{ name: "/help", description: "Get help" }],
        models: [{ value: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5" }],
        account: { email: "test@example.com" },
      },
      ...overrides,
    },
  });
}
