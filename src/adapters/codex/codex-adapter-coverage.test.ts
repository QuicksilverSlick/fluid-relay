/**
 * Coverage tests targeting the two uncovered branches in codex-adapter.ts:
 *
 *  Line 87 : logger?.warn called when the CodexLauncher emits an "error" event
 *            after connect() has set up the listener.
 *  Line 115: createSlashExecutor returns a CodexSlashExecutor instance
 *            when the session IS a CodexSession.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import type { ProcessHandle, ProcessManager } from "../../interfaces/process-manager.js";
import { CodexAdapter } from "./codex-adapter.js";
import { CodexLauncher } from "./codex-launcher.js";
import { CodexSession } from "./codex-session.js";
import { CodexSlashExecutor } from "./codex-slash-executor.js";

// ---------------------------------------------------------------------------
// Mock WebSocket (minimal, mirrors the one in codex-adapter.test.ts)
// ---------------------------------------------------------------------------

class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  terminate(): void {
    this.readyState = 3;
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    return super.removeListener(event, listener);
  }
}

// ---------------------------------------------------------------------------
// Mock `ws` module
// ---------------------------------------------------------------------------

let mockWsFactory: (...args: any[]) => MockWebSocket;

const MockWsClass = vi.hoisted(() => {
  function WsConstructor(this: any, ...args: any[]) {
    return mockWsFactory(...args);
  }
  WsConstructor.OPEN = 1;
  WsConstructor.CLOSED = 3;
  WsConstructor.CONNECTING = 0;
  WsConstructor.CLOSING = 2;
  return WsConstructor;
});

vi.mock("ws", () => ({
  default: MockWsClass,
  __esModule: true,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockProcessManager(): ProcessManager {
  const exitPromise = new Promise<number | null>(() => {});
  return {
    spawn: vi.fn().mockReturnValue({
      pid: 12345,
      exited: exitPromise,
      kill: vi.fn(),
      stdout: null,
      stderr: null,
    } satisfies ProcessHandle),
    isAlive: vi.fn().mockReturnValue(true),
  };
}

function makeOpenableWs(): MockWebSocket {
  const ws = new MockWebSocket();
  mockWsFactory = () => {
    queueMicrotask(() => ws.emit("open"));
    return ws;
  };
  return ws;
}

function interceptInitialize(ws: MockWebSocket, replyFn: (requestId: number) => void): void {
  const origSend = ws.send.bind(ws);
  ws.send = vi.fn((data: string) => {
    origSend(data);
    const parsed = JSON.parse(data);
    if (parsed.method === "initialize") {
      queueMicrotask(() => replyFn(parsed.id));
    }
  });
}

function sendInitSuccess(ws: MockWebSocket, id: number): void {
  ws.emit(
    "message",
    Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { capabilities: {}, version: "1.0.0" },
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CodexAdapter — uncovered branch coverage", () => {
  let adapter: CodexAdapter;
  let launchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    adapter = new CodexAdapter({
      processManager: createMockProcessManager(),
      connectRetries: 1,
      connectRetryDelayMs: 0,
    });
    launchSpy = vi
      .spyOn(CodexLauncher.prototype, "launch")
      .mockResolvedValue({ url: "ws://127.0.0.1:9999", pid: 12345 });
  });

  afterEach(() => {
    launchSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Line 115 — createSlashExecutor returns CodexSlashExecutor for CodexSession
  // -------------------------------------------------------------------------

  describe("createSlashExecutor (line 115)", () => {
    it("returns a CodexSlashExecutor instance when session is a CodexSession", () => {
      const ws = new MockWebSocket();
      const launcher = new CodexLauncher({ processManager: createMockProcessManager() });
      const session = new CodexSession({
        sessionId: "slash-session",
        ws: ws as unknown as WebSocket,
        launcher,
      });

      const executor = adapter.createSlashExecutor(session);

      expect(executor).toBeInstanceOf(CodexSlashExecutor);
    });

    it("returns null for a non-CodexSession (existing branch — confirms both branches reachable)", () => {
      const fakeSession = {
        sessionId: "x",
        send: vi.fn(),
        close: vi.fn(),
        messages: [] as any,
      };
      expect(adapter.createSlashExecutor(fakeSession)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Line 87 — logger.warn triggered by CodexLauncher "error" event
  // -------------------------------------------------------------------------

  describe("launcher error event handler (line 87)", () => {
    it("calls logger.warn when CodexLauncher emits an error event after connect", async () => {
      const warnSpy = vi.fn();
      const adapterWithLogger = new CodexAdapter({
        processManager: createMockProcessManager(),
        connectRetries: 1,
        connectRetryDelayMs: 0,
        logger: {
          info: vi.fn(),
          debug: vi.fn(),
          warn: warnSpy,
          error: vi.fn(),
        },
      });

      // Capture the launcher instance created inside connect() by spying on
      // the CodexLauncher constructor, then replaying the error event after
      // connect resolves.
      let capturedLauncher: CodexLauncher | undefined;
      const origLaunch = CodexLauncher.prototype.launch;
      vi.spyOn(CodexLauncher.prototype, "launch").mockImplementation(async function (
        this: CodexLauncher,
        ...args: Parameters<typeof origLaunch>
      ) {
        capturedLauncher = this;
        return { url: "ws://127.0.0.1:9999", pid: 12345 };
      });

      const ws = makeOpenableWs();
      interceptInitialize(ws, (id) => sendInitSuccess(ws, id));

      await adapterWithLogger.connect({ sessionId: "logger-test" });

      expect(capturedLauncher).toBeDefined();

      // Emit the error event that the adapter's listener on line 86-88 handles.
      capturedLauncher!.emit("error", {
        source: "stderr",
        error: new Error("unexpected eof"),
      });

      expect(warnSpy).toHaveBeenCalledWith("Launcher error [stderr]: unexpected eof");
    });

    it("does not throw when logger is absent and launcher emits error", async () => {
      // adapter has no logger — optional chaining on line 87 must not throw
      let capturedLauncher: CodexLauncher | undefined;
      const origLaunch = CodexLauncher.prototype.launch;
      vi.spyOn(CodexLauncher.prototype, "launch").mockImplementation(async function (
        this: CodexLauncher,
        ...args: Parameters<typeof origLaunch>
      ) {
        capturedLauncher = this;
        return { url: "ws://127.0.0.1:9999", pid: 12345 };
      });

      const ws = makeOpenableWs();
      interceptInitialize(ws, (id) => sendInitSuccess(ws, id));

      await adapter.connect({ sessionId: "no-logger-test" });

      expect(() =>
        capturedLauncher!.emit("error", {
          source: "process",
          error: new Error("crash"),
        }),
      ).not.toThrow();
    });
  });
});
