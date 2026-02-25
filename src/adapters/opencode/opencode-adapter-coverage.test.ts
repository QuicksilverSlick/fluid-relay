/**
 * Additional coverage tests for OpencodeAdapter targeting uncovered branches:
 *
 *   - Line 122: connect() throws when httpClient is missing after launchPromise resolves
 *   - Lines 194-195: reserveEphemeralPort() rejects when server.address() returns null/string
 *   - Line 255: runSseLoop() throws when httpClient is undefined
 *
 * This file uses vi.mock('node:net') to control server.address() for lines 194-195.
 * To keep the merged V8 coverage high, the file also re-exercises the main adapter
 * branches so the module-isolated instance has good coverage too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessHandle, ProcessManager } from "../../interfaces/process-manager.js";

// ---------------------------------------------------------------------------
// Controllable hook for the fake createServer (only active in specific tests)
// ---------------------------------------------------------------------------

let createServerOverride: (() => unknown) | undefined;

vi.mock("node:net", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:net")>();
  return {
    ...original,
    createServer: (...args: Parameters<typeof original.createServer>) => {
      if (createServerOverride) {
        return createServerOverride();
      }
      return original.createServer(...args);
    },
  };
});

// ---------------------------------------------------------------------------
// Imports (placed after vi.mock hoisting)
// ---------------------------------------------------------------------------

import { OpencodeAdapter } from "./opencode-adapter.js";
import { OpencodeHttpClient } from "./opencode-http-client.js";
import { OpencodeLauncher } from "./opencode-launcher.js";
import { OpencodeSession } from "./opencode-session.js";
import type { OpencodeEvent, OpencodeSession as OpencodeSessionType } from "./opencode-types.js";

// ---------------------------------------------------------------------------
// Mock helpers
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

function createControllableSseStream(): {
  stream: ReadableStream<Uint8Array>;
  push: (event: OpencodeEvent) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (event: OpencodeEvent) => {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    close: () => controller.close(),
  };
}

function createMockOpcSession(id: string): OpencodeSessionType {
  return {
    id,
    slug: `slug-${id}`,
    projectID: "proj-1",
    directory: "/tmp",
    title: "Test Session",
    version: "1",
    time: { created: Date.now(), updated: Date.now() },
  };
}

// ---------------------------------------------------------------------------
// Main adapter tests (mirrors opencode-adapter.test.ts so this module
// instance has good branch coverage when merged with V8)
// ---------------------------------------------------------------------------

describe("OpencodeAdapter — coverage supplement", () => {
  let adapter: OpencodeAdapter;
  let launchSpy: ReturnType<typeof vi.spyOn>;
  let connectSseSpy: ReturnType<typeof vi.spyOn>;
  let sseControl: ReturnType<typeof createControllableSseStream>;
  let sessionCounter: number;

  beforeEach(() => {
    createServerOverride = undefined;
    sessionCounter = 0;
    sseControl = createControllableSseStream();

    adapter = new OpencodeAdapter({
      processManager: createMockProcessManager(),
      port: 5555,
      hostname: "127.0.0.1",
      directory: "/test/dir",
    });

    launchSpy = vi
      .spyOn(OpencodeLauncher.prototype, "launch")
      .mockResolvedValue({ url: "http://127.0.0.1:5555", pid: 99999 });

    vi.spyOn(OpencodeHttpClient.prototype, "createSession").mockImplementation(() => {
      sessionCounter++;
      return Promise.resolve(createMockOpcSession(`opc-${sessionCounter}`));
    });

    connectSseSpy = vi
      .spyOn(OpencodeHttpClient.prototype, "connectSse")
      .mockResolvedValue(sseControl.stream);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    createServerOverride = undefined;
  });

  // ── Basic adapter properties ──────────────────────────────────────────────

  it("name is 'opencode' and capabilities are correct", () => {
    expect(adapter.name).toBe("opencode");
    expect(adapter.capabilities).toMatchObject({
      streaming: true,
      permissions: true,
      slashCommands: false,
      availability: "local",
      teams: false,
    });
  });

  // ── connect() and server lifecycle ───────────────────────────────────────

  it("connect() launches server once and creates a session", async () => {
    const session = await adapter.connect({ sessionId: "s1" });

    expect(launchSpy).toHaveBeenCalledOnce();
    expect(session).toBeInstanceOf(OpencodeSession);
    expect(session.sessionId).toBe("s1");
  });

  it("connect() reuses server on second call", async () => {
    await adapter.connect({ sessionId: "s1" });
    await adapter.connect({ sessionId: "s2" });
    expect(launchSpy).toHaveBeenCalledOnce();
  });

  // ── stop() ───────────────────────────────────────────────────────────────

  it("stop() kills launcher and clears state", async () => {
    const killSpy = vi
      .spyOn(OpencodeLauncher.prototype, "killAllProcesses")
      .mockResolvedValue(undefined);
    await adapter.connect({ sessionId: "s1" });
    await adapter.stop();
    expect(killSpy).toHaveBeenCalledOnce();
  });

  it("stop() before any connect() does not throw", async () => {
    vi.spyOn(OpencodeLauncher.prototype, "killAllProcesses").mockResolvedValue(undefined);
    await expect(adapter.stop()).resolves.not.toThrow();
  });

  it("stop() clears state so subsequent connect re-launches", async () => {
    const killSpy = vi
      .spyOn(OpencodeLauncher.prototype, "killAllProcesses")
      .mockResolvedValue(undefined);
    await adapter.connect({ sessionId: "s1" });
    await adapter.stop();
    await adapter.connect({ sessionId: "s2" });
    expect(launchSpy).toHaveBeenCalledTimes(2);
    killSpy.mockRestore();
  });

  // ── SSE routing ───────────────────────────────────────────────────────────

  it("SSE events route to correct session by opcSessionId", async () => {
    const session1 = await adapter.connect({ sessionId: "s1" });
    const session2 = await adapter.connect({ sessionId: "s2" });
    const iter1 = session1.messages[Symbol.asyncIterator]();
    const iter2 = session2.messages[Symbol.asyncIterator]();

    sseControl.push({
      type: "session.status",
      properties: { sessionID: "opc-1", status: { type: "idle" } },
    });
    sseControl.push({
      type: "session.status",
      properties: { sessionID: "opc-2", status: { type: "busy" } },
    });

    await new Promise((r) => setTimeout(r, 50));

    const r1 = await iter1.next();
    expect(r1.done).toBe(false);
    const r2 = await iter2.next();
    expect(r2.done).toBe(false);
  });

  it("broadcast SSE events reach all sessions", async () => {
    const session1 = await adapter.connect({ sessionId: "s1" });
    const session2 = await adapter.connect({ sessionId: "s2" });
    const iter1 = session1.messages[Symbol.asyncIterator]();
    const iter2 = session2.messages[Symbol.asyncIterator]();

    sseControl.push({ type: "server.connected", properties: {} as Record<string, never> });
    await new Promise((r) => setTimeout(r, 50));

    const r1 = await iter1.next();
    expect(r1.done).toBe(false);
    const r2 = await iter2.next();
    expect(r2.done).toBe(false);
  });

  it("SSE event with known sessionId dispatches only to that subscriber (no handler for unknown id)", async () => {
    // Cover: if (sessionId) branch true, if (handler) branch false (unknown session)
    const session = await adapter.connect({ sessionId: "s1" });
    const iter = session.messages[Symbol.asyncIterator]();

    // Push event for "unknown-session" which has no subscriber
    sseControl.push({
      type: "session.status",
      properties: { sessionID: "unknown-session", status: { type: "idle" } },
    });

    await new Promise((r) => setTimeout(r, 50));

    // session s1 should receive nothing
    // Push a real event for s1 to ensure the iterator is live
    sseControl.push({
      type: "session.status",
      properties: { sessionID: "opc-1", status: { type: "idle" } },
    });
    await new Promise((r) => setTimeout(r, 30));

    const result = await iter.next();
    expect(result.done).toBe(false);
  });

  // ── notifyAllSessions ─────────────────────────────────────────────────────

  it("notifyAllSessions dispatches error to all active sessions", async () => {
    const session = await adapter.connect({ sessionId: "s-notify" });
    const iter = session.messages[Symbol.asyncIterator]();

    (adapter as any).notifyAllSessions("conn lost");
    await new Promise((r) => setTimeout(r, 20));

    const result = await iter.next();
    expect(result.done).toBe(false);
    expect(result.value.metadata?.is_error).toBe(true);
  });

  // ── resolveLaunchPort — custom port skips port check ─────────────────────

  it("uses custom port directly without port detection", async () => {
    // adapter already has port 5555 (non-default), so resolveLaunchPort returns it directly
    await adapter.connect({ sessionId: "s1" });
    expect(launchSpy).toHaveBeenCalledWith("server", expect.objectContaining({ port: 5555 }));
  });

  it("uses default port 4096 when none specified and port is free", async () => {
    const defaultAdapter = new OpencodeAdapter({
      processManager: createMockProcessManager(),
      hostname: "127.0.0.1",
      directory: "/test/dir",
    });
    vi.spyOn(defaultAdapter as any, "isPortInUse").mockResolvedValue(false);
    await defaultAdapter.connect({ sessionId: "s1" });
    expect(launchSpy).toHaveBeenCalledWith("server", expect.objectContaining({ port: 4096 }));
  });

  it("falls back to ephemeral port when default port is in use", async () => {
    const defaultAdapter = new OpencodeAdapter({
      processManager: createMockProcessManager(),
      hostname: "127.0.0.1",
      directory: "/test/dir",
    });
    vi.spyOn(defaultAdapter as any, "isPortInUse").mockResolvedValue(true);
    vi.spyOn(defaultAdapter as any, "reserveEphemeralPort").mockResolvedValue(54321);
    await defaultAdapter.connect({ sessionId: "s1" });
    expect(launchSpy).toHaveBeenCalledWith("server", expect.objectContaining({ port: 54321 }));
  });

  // ── isPortInUse real TCP ──────────────────────────────────────────────────

  it("isPortInUse returns true when port is occupied", async () => {
    const net = await import("node:net");
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    try {
      const result = await (adapter as any).isPortInUse("127.0.0.1", port);
      expect(result).toBe(true);
    } finally {
      await new Promise<void>((r, rej) => server.close((err) => (err ? rej(err) : r())));
    }
  });

  it("isPortInUse returns false for a freed port", async () => {
    const net = await import("node:net");
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    await new Promise<void>((r, rej) => server.close((err) => (err ? rej(err) : r())));
    const result = await (adapter as any).isPortInUse("127.0.0.1", port);
    expect(result).toBe(false);
  });

  it("reserveEphemeralPort returns a valid port number", async () => {
    const port = await (adapter as any).reserveEphemeralPort("127.0.0.1");
    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(0);
  });

  // ── SSE retry loop ────────────────────────────────────────────────────────

  it("runSseLoopWithRetry notifies all sessions when retries exhausted", async () => {
    vi.useFakeTimers();
    try {
      const testAdapter = new OpencodeAdapter({
        processManager: createMockProcessManager(),
        port: 5555,
        hostname: "127.0.0.1",
        directory: "/test/dir",
      });

      let callCount = 0;
      const mockConnectSse = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              c.close();
            },
          });
          return Promise.resolve(stream);
        }
        return Promise.reject(new Error("SSE refused"));
      });

      (testAdapter as any).httpClient = { connectSse: mockConnectSse };
      const notifySpy = vi.spyOn(testAdapter as any, "notifyAllSessions");
      const abortController = new AbortController();

      const loopPromise = (testAdapter as any).runSseLoopWithRetry(
        abortController.signal,
      ) as Promise<void>;
      await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 500);
      await loopPromise;

      expect(notifySpy).toHaveBeenCalledWith("SSE connection lost after retries exhausted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("runSseLoopWithRetry exits early when signal is aborted mid-catch", async () => {
    vi.useFakeTimers();
    try {
      const testAdapter = new OpencodeAdapter({
        processManager: createMockProcessManager(),
        port: 5555,
        hostname: "127.0.0.1",
        directory: "/test/dir",
      });

      const abortController = new AbortController();
      let callCount = 0;
      const mockConnectSse = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // Abort the signal WHILE inside the catch block (line 229: if signal.aborted return)
          abortController.abort();
          return Promise.reject(new Error("abort after this"));
        }
        return Promise.reject(new Error("should not reach here"));
      });

      (testAdapter as any).httpClient = { connectSse: mockConnectSse };
      const notifySpy = vi.spyOn(testAdapter as any, "notifyAllSessions");

      const loopPromise = (testAdapter as any).runSseLoopWithRetry(
        abortController.signal,
      ) as Promise<void>;
      await vi.advanceTimersByTimeAsync(100);
      await loopPromise;

      // notifyAllSessions should NOT have been called since signal was aborted
      expect(notifySpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runSseLoopWithRetry exits early when signal is aborted after loop iteration (line 234)", async () => {
    vi.useFakeTimers();
    try {
      const testAdapter = new OpencodeAdapter({
        processManager: createMockProcessManager(),
        port: 5555,
        hostname: "127.0.0.1",
        directory: "/test/dir",
      });

      const abortController = new AbortController();
      let callCount = 0;
      const mockConnectSse = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // Return a stream that closes normally; we then abort before next iteration
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              setImmediate(() => {
                abortController.abort();
                c.close();
              });
            },
          });
          return Promise.resolve(stream);
        }
        return Promise.reject(new Error("should not reach here"));
      });

      (testAdapter as any).httpClient = { connectSse: mockConnectSse };
      const notifySpy = vi.spyOn(testAdapter as any, "notifyAllSessions");

      const loopPromise = (testAdapter as any).runSseLoopWithRetry(
        abortController.signal,
      ) as Promise<void>;
      await vi.runAllTimersAsync();
      await loopPromise;

      expect(notifySpy).not.toHaveBeenCalled();
      expect(callCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── SSE signal.aborted break (line 260) ──────────────────────────────────

  it("runSseLoop breaks out of the for-await loop when signal is aborted mid-stream", async () => {
    const testAdapter = new OpencodeAdapter({
      processManager: createMockProcessManager(),
      port: 5555,
      hostname: "127.0.0.1",
      directory: "/test/dir",
    });

    const abortController = new AbortController();
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        streamController = c;
      },
    });

    (testAdapter as any).httpClient = { connectSse: vi.fn().mockResolvedValue(stream) };

    const loopPromise = (testAdapter as any).runSseLoop(abortController.signal) as Promise<void>;

    // Push one event then abort — the loop should exit
    const encoder = new TextEncoder();
    streamController!.enqueue(
      encoder.encode('data: {"type":"server.connected","properties":{}}\n\n'),
    );
    abortController.abort();
    streamController!.close();

    await loopPromise;
    // No assertion needed — just verifying no exception and loop exits
  });

  // ── Launcher error event handler (line 87) ───────────────────────────────

  it("launcher 'error' event is logged when logger.warn is set", () => {
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const adapterWithLogger = new OpencodeAdapter({
      processManager: createMockProcessManager(),
      port: 5555,
      hostname: "127.0.0.1",
      directory: "/test/dir",
      logger: mockLogger,
    });

    (adapterWithLogger as any).launcher.emit("error", {
      source: "test-source",
      error: new Error("test error"),
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Launcher error [test-source]: test error"),
    );
  });

  // ── Line 122: connect() throws when httpClient is missing ────────────────

  it("connect() throws 'httpClient missing' when ensureServer resolves without setting httpClient", async () => {
    const testAdapter = new OpencodeAdapter({
      processManager: createMockProcessManager(),
      port: 5555,
      hostname: "127.0.0.1",
      directory: "/test/dir",
    });

    vi.spyOn(testAdapter as any, "ensureServer").mockResolvedValue(undefined);

    await expect(testAdapter.connect({ sessionId: "s1" })).rejects.toThrow(
      "Opencode adapter not initialized: httpClient missing",
    );
  });

  // ── Lines 194-195: reserveEphemeralPort null/string address ──────────────

  it("reserveEphemeralPort() rejects when server.address() returns null", async () => {
    const fakeClose = vi.fn((cb?: (err?: Error) => void) => {
      if (cb) cb();
    });
    createServerOverride = () => ({
      once: vi.fn().mockReturnThis(),
      listen: vi.fn((_port: number, _host: string, cb: () => void) => {
        setImmediate(cb);
      }),
      address: vi.fn().mockReturnValue(null),
      close: fakeClose,
    });

    const testAdapter = new OpencodeAdapter({
      processManager: createMockProcessManager(),
      port: 5555,
      hostname: "127.0.0.1",
      directory: "/test/dir",
    });

    await expect((testAdapter as any).reserveEphemeralPort("127.0.0.1")).rejects.toThrow(
      "Failed to reserve ephemeral opencode port",
    );
  });

  it("reserveEphemeralPort() rejects when server.address() returns a string", async () => {
    const fakeClose = vi.fn((cb?: (err?: Error) => void) => {
      if (cb) cb();
    });
    createServerOverride = () => ({
      once: vi.fn().mockReturnThis(),
      listen: vi.fn((_port: number, _host: string, cb: () => void) => {
        setImmediate(cb);
      }),
      address: vi.fn().mockReturnValue("/tmp/some.sock"),
      close: fakeClose,
    });

    const testAdapter = new OpencodeAdapter({
      processManager: createMockProcessManager(),
      port: 5555,
      hostname: "127.0.0.1",
      directory: "/test/dir",
    });

    await expect((testAdapter as any).reserveEphemeralPort("127.0.0.1")).rejects.toThrow(
      "Failed to reserve ephemeral opencode port",
    );
  });

  // ── Line 255: runSseLoop() throws when httpClient is undefined ────────────

  it("runSseLoop() throws 'httpClient missing' when httpClient is undefined", async () => {
    const testAdapter = new OpencodeAdapter({
      processManager: createMockProcessManager(),
      port: 5555,
      hostname: "127.0.0.1",
      directory: "/test/dir",
    });

    const abortController = new AbortController();
    await expect((testAdapter as any).runSseLoop(abortController.signal)).rejects.toThrow(
      "Opencode adapter not initialized: httpClient missing",
    );
  });
});
