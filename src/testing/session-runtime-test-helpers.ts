/**
 * Shared test helpers for SessionRuntime unit and integration tests.
 *
 * Extracted from the duplicated `makeDeps()` factory that appeared in
 * session-runtime-capabilities, session-runtime-commands, and
 * session-runtime-orchestration integration tests.
 */

import { vi } from "vitest";
import { noopTracer } from "../core/messaging/message-tracer.js";
import type { SessionRuntimeDeps } from "../core/session/session-runtime.js";

/**
 * Build a fully-mocked SessionRuntimeDeps object.
 * All methods are vitest spies. Pass overrides to replace individual deps.
 */
export function makeRuntimeDeps(overrides?: Partial<SessionRuntimeDeps>): SessionRuntimeDeps {
  return {
    config: { maxMessageHistoryLength: 100 },
    broadcaster: {
      broadcast: vi.fn(),
      broadcastToParticipants: vi.fn(),
      broadcastPresence: vi.fn(),
      sendTo: vi.fn(),
    } as any,
    queueHandler: {
      handleQueueMessage: vi.fn(),
      handleUpdateQueuedMessage: vi.fn(),
      handleCancelQueuedMessage: vi.fn(),
      autoSendQueuedMessage: vi.fn(),
    },
    slashService: {
      handleInbound: vi.fn(),
      executeProgrammatic: vi.fn(async () => null),
    },
    backendConnector: { sendToBackend: vi.fn() } as any,
    tracer: noopTracer,
    store: { persist: vi.fn(), persistSync: vi.fn() } as any,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    gitTracker: {
      resetAttempt: vi.fn(),
      refreshGitInfo: vi.fn(() => null),
      resolveGitInfo: vi.fn(),
    } as any,
    gitResolver: null,
    emitEvent: vi.fn(),
    capabilitiesPolicy: {
      initializeTimeoutMs: 50,
      applyCapabilities: vi.fn(),
      sendInitializeRequest: vi.fn(),
      handleControlResponse: vi.fn(),
    } as any,
    ...overrides,
  };
}

/** Backend session mock with initialize support. */
export function createBackendWithInit(): {
  send: ReturnType<typeof vi.fn>;
  initialize: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any;
  sessionId: string;
} {
  return {
    send: vi.fn(),
    initialize: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    get messages() {
      return {
        [Symbol.asyncIterator]() {
          return { next: () => new Promise(() => {}) };
        },
      };
    },
    sessionId: "b1",
  };
}

/** Backend session mock without initialize support. */
export function createBackendNoInit(): {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any;
  sessionId: string;
} {
  return {
    send: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    get messages() {
      return {
        [Symbol.asyncIterator]() {
          return { next: () => new Promise(() => {}) };
        },
      };
    },
    sessionId: "b1",
  };
}
