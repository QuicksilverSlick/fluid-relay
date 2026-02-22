/**
 * Tests for OpencodeAdapter.
 *
 * Mocks the OpencodeLauncher, OpencodeHttpClient, and SSE stream to verify
 * the full adapter contract: server lifecycle, session creation, SSE demuxing,
 * and broadcast events.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessHandle, ProcessManager } from "../../interfaces/process-manager.js";
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

/**
 * Create a controllable SSE stream that allows pushing events after creation.
 * Returns the stream and a push function.
 */
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
      const data = `data: ${JSON.stringify(event)}\n\n`;
      controller.enqueue(encoder.encode(data));
    },
    close: () => {
      controller.close();
    },
  };
}

/** Dummy opencode session response from POST /session. */
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
// Test suite
// ---------------------------------------------------------------------------

describe("OpencodeAdapter", () => {
  let adapter: OpencodeAdapter;
  let launchSpy: ReturnType<typeof vi.spyOn>;
  let createSessionSpy: ReturnType<typeof vi.spyOn>;
  let connectSseSpy: ReturnType<typeof vi.spyOn>;
  let sseControl: ReturnType<typeof createControllableSseStream>;
  let sessionCounter: number;

  beforeEach(() => {
    sessionCounter = 0;
    sseControl = createControllableSseStream();

    adapter = new OpencodeAdapter({
      processManager: createMockProcessManager(),
      port: 5555,
      hostname: "127.0.0.1",
      directory: "/test/dir",
    });

    // Mock the launcher to avoid real process spawning
    launchSpy = vi
      .spyOn(OpencodeLauncher.prototype, "launch")
      .mockResolvedValue({ url: "http://127.0.0.1:5555", pid: 99999 });

    // Mock OpencodeHttpClient prototype methods so that any instance created
    // inside connect() uses our mocks.
    createSessionSpy = vi
      .spyOn(OpencodeHttpClient.prototype, "createSession")
      .mockImplementation(() => {
        sessionCounter++;
        return Promise.resolve(createMockOpcSession(`opc-${sessionCounter}`));
      });

    connectSseSpy = vi
      .spyOn(OpencodeHttpClient.prototype, "connectSse")
      .mockResolvedValue(sseControl.stream);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // name and capabilities
  // -------------------------------------------------------------------------

  it("name property is 'opencode'", () => {
    expect(adapter.name).toBe("opencode");
  });

  it("capabilities are correct", () => {
    expect(adapter.capabilities).toEqual({
      streaming: true,
      permissions: true,
      slashCommands: false,
      availability: "local",
      teams: false,
    });
  });

  // -------------------------------------------------------------------------
  // connect() — server launch
  // -------------------------------------------------------------------------

  it("connect() launches server on first call", async () => {
    await adapter.connect({ sessionId: "beamcode-1" });

    expect(launchSpy).toHaveBeenCalledOnce();
    expect(launchSpy).toHaveBeenCalledWith(
      "server",
      expect.objectContaining({
        port: 5555,
        hostname: "127.0.0.1",
      }),
    );
  });

  it("connect() reuses server on second call (does not launch again)", async () => {
    await adapter.connect({ sessionId: "beamcode-1" });
    await adapter.connect({ sessionId: "beamcode-2" });

    expect(launchSpy).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // connect() — session creation
  // -------------------------------------------------------------------------

  it("connect() creates a session via POST /session", async () => {
    await adapter.connect({ sessionId: "beamcode-1" });

    expect(createSessionSpy).toHaveBeenCalledOnce();
    expect(createSessionSpy).toHaveBeenCalledWith({ title: "beamcode-1" });
  });

  it("connect() returns a BackendSession with the correct sessionId", async () => {
    const session = await adapter.connect({ sessionId: "beamcode-1" });

    expect(session).toBeInstanceOf(OpencodeSession);
    expect(session.sessionId).toBe("beamcode-1");
  });

  // -------------------------------------------------------------------------
  // Multiple sessions
  // -------------------------------------------------------------------------

  it("two sessions operate independently with distinct sessionIds", async () => {
    const session1 = await adapter.connect({ sessionId: "beamcode-1" });
    const session2 = await adapter.connect({ sessionId: "beamcode-2" });

    expect(session1.sessionId).toBe("beamcode-1");
    expect(session2.sessionId).toBe("beamcode-2");
    expect(session1).not.toBe(session2);
  });

  // -------------------------------------------------------------------------
  // SSE event routing
  // -------------------------------------------------------------------------

  it("SSE events are routed to the correct session by opcSessionId", async () => {
    const session1 = await adapter.connect({ sessionId: "beamcode-1" });
    const session2 = await adapter.connect({ sessionId: "beamcode-2" });

    const iter1 = session1.messages[Symbol.asyncIterator]();
    const iter2 = session2.messages[Symbol.asyncIterator]();

    // Push an event targeting opc-1 (session1)
    sseControl.push({
      type: "session.status",
      properties: {
        sessionID: "opc-1",
        status: { type: "idle" },
      },
    });

    // Push an event targeting opc-2 (session2)
    sseControl.push({
      type: "session.status",
      properties: {
        sessionID: "opc-2",
        status: { type: "busy" },
      },
    });

    // Allow the SSE loop microtasks to drain
    await new Promise((r) => setTimeout(r, 50));

    const r1 = await iter1.next();
    expect(r1.done).toBe(false);
    expect(r1.value.type).toBe("result");
    expect(r1.value.metadata.status).toBe("completed");

    const r2 = await iter2.next();
    expect(r2.done).toBe(false);
    expect(r2.value.type).toBe("status_change");
    expect(r2.value.metadata.busy).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Broadcast events
  // -------------------------------------------------------------------------

  it("broadcast events (server.connected) reach all sessions", async () => {
    const session1 = await adapter.connect({ sessionId: "beamcode-1" });
    const session2 = await adapter.connect({ sessionId: "beamcode-2" });

    const iter1 = session1.messages[Symbol.asyncIterator]();
    const iter2 = session2.messages[Symbol.asyncIterator]();

    // Push a broadcast event (no session scope)
    sseControl.push({
      type: "server.connected",
      properties: {} as Record<string, never>,
    });

    // Allow the SSE loop microtasks to drain
    await new Promise((r) => setTimeout(r, 50));

    const r1 = await iter1.next();
    expect(r1.done).toBe(false);
    expect(r1.value.type).toBe("session_init");

    const r2 = await iter2.next();
    expect(r2.done).toBe(false);
    expect(r2.value.type).toBe("session_init");
  });

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------

  it("stop() aborts the SSE loop and kills the launcher", async () => {
    const killSpy = vi
      .spyOn(OpencodeLauncher.prototype, "killAllProcesses")
      .mockResolvedValue(undefined);

    await adapter.connect({ sessionId: "beamcode-1" });
    await adapter.stop();

    expect(killSpy).toHaveBeenCalledOnce();
  });

  it("stop() clears internal state so a subsequent connect re-launches", async () => {
    const killSpy = vi
      .spyOn(OpencodeLauncher.prototype, "killAllProcesses")
      .mockResolvedValue(undefined);

    await adapter.connect({ sessionId: "beamcode-1" });
    await adapter.stop();

    // After stop, connect() should trigger a new launch
    await adapter.connect({ sessionId: "beamcode-2" });

    expect(launchSpy).toHaveBeenCalledTimes(2);
    killSpy.mockRestore();
  });

  it("stop() before any connect() does not throw", async () => {
    vi.spyOn(OpencodeLauncher.prototype, "killAllProcesses").mockResolvedValue(undefined);
    await expect(adapter.stop()).resolves.not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Subscriber cleanup
  // -------------------------------------------------------------------------

  it("closing a session removes it from subscriber map (unsubscribe is called)", async () => {
    const session = await adapter.connect({ sessionId: "beamcode-1" });

    await session.close();

    // After close the session is no longer subscribed — push a broadcast event
    // and it should NOT appear in the closed session's iterator (queue is finished)
    sseControl.push({
      type: "server.connected",
      properties: {} as Record<string, never>,
    });

    // The iterator should be done since queue was finished on close
    const iter = session.messages[Symbol.asyncIterator]();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  // -------------------------------------------------------------------------
  // SSE — malformed event data is silently skipped
  // -------------------------------------------------------------------------

  it("malformed SSE JSON is silently skipped and subsequent valid events still arrive", async () => {
    const session = await adapter.connect({ sessionId: "beamcode-1" });
    const iter = session.messages[Symbol.asyncIterator]();

    // First push garbage that can't be parsed
    const encoder = new TextEncoder();
    const junkChunk = encoder.encode("data: {not valid json at all!!!\n\n");

    // Inject directly into the current SSE stream via the controller
    // We push the raw encoded bytes to the SSE stream underlying the mock.
    // Since createControllableSseStream exposes `push(event)`, we workaround
    // by using a second controllable stream for this test.
    const encoder2 = new TextEncoder();
    let ctrl: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
    connectSseSpy.mockResolvedValueOnce(stream);

    // Stop to allow a reconnect that uses the new stream
    vi.spyOn(OpencodeLauncher.prototype, "killAllProcesses").mockResolvedValue(undefined);
    await adapter.stop();

    const session2 = await adapter.connect({ sessionId: "beamcode-2" });
    const iter2 = session2.messages[Symbol.asyncIterator]();

    // Push malformed JSON, then a valid event
    ctrl!.enqueue(junkChunk);
    const validEvent: OpencodeEvent = {
      type: "session.status",
      properties: { sessionID: "opc-2", status: { type: "idle" } },
    };
    ctrl!.enqueue(encoder2.encode(`data: ${JSON.stringify(validEvent)}\n\n`));

    await new Promise((r) => setTimeout(r, 80));

    // Valid event (after the garbage) must still be delivered
    const r = await iter2.next();
    expect(r.done).toBe(false);
    expect(r.value.type).toBe("result");

    void iter; // silence unused warning
  });

  // -------------------------------------------------------------------------
  // SSE — retries exhausted notifies all sessions
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // resolveLaunchPort — default port detection
  // -------------------------------------------------------------------------

  it("uses default port when none specified and port is free", async () => {
    const defaultAdapter = new OpencodeAdapter({
      processManager: createMockProcessManager(),
      hostname: "127.0.0.1",
      directory: "/test/dir",
      // no port → uses DEFAULT_PORT (4096)
    });

    vi.spyOn(defaultAdapter as any, "isPortInUse").mockResolvedValue(false);

    await defaultAdapter.connect({ sessionId: "beamcode-def" });

    expect(launchSpy).toHaveBeenCalledWith(
      "server",
      expect.objectContaining({ port: 4096 }),
    );
  });

  it("falls back to ephemeral port when default port is in use", async () => {
    const defaultAdapter = new OpencodeAdapter({
      processManager: createMockProcessManager(),
      hostname: "127.0.0.1",
      directory: "/test/dir",
    });

    vi.spyOn(defaultAdapter as any, "isPortInUse").mockResolvedValue(true);
    vi.spyOn(defaultAdapter as any, "reserveEphemeralPort").mockResolvedValue(54321);

    await defaultAdapter.connect({ sessionId: "beamcode-def" });

    expect(launchSpy).toHaveBeenCalledWith(
      "server",
      expect.objectContaining({ port: 54321 }),
    );
  });

  // -------------------------------------------------------------------------
  // isPortInUse and reserveEphemeralPort — real TCP
  // -------------------------------------------------------------------------

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

  it("isPortInUse returns false for a recently freed port", async () => {
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
    expect(port).toBeLessThan(65536);
  });

  // -------------------------------------------------------------------------
  // notifyAllSessions
  // -------------------------------------------------------------------------

  it("notifyAllSessions dispatches session.error to all active sessions", async () => {
    const session = await adapter.connect({ sessionId: "beamcode-notify" });
    const iter = session.messages[Symbol.asyncIterator]();

    // Directly invoke the private method
    (adapter as any).notifyAllSessions("connection lost after retries");

    await new Promise((r) => setTimeout(r, 20));

    const result = await iter.next();
    expect(result.done).toBe(false);
    expect(result.value.type).toBe("result");
    expect(result.value.metadata.is_error).toBe(true);
    expect(result.value.metadata.error_message).toBe("connection lost after retries");
  });

  // ─── SSE retry loop internals (lines 223, 233-234) ─────────────────────────
  //
  // Instead of relying on real timers (which would take 7+ seconds), we call
  // runSseLoopWithRetry directly with fake timers so we can advance past the
  // exponential backoff delays deterministically.

  it("runSseLoopWithRetry resets failure counter on normal stream end (line 223) and notifies when retries exhausted (lines 233-234)", async () => {
    vi.useFakeTimers();

    try {
      // Build a minimal adapter with a manually controlled httpClient
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
          // First call: stream closes immediately → runSseLoop ends normally → line 223
          const stream = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
          return Promise.resolve(stream);
        }
        // Subsequent calls: fail → triggers retry backoff → eventually exhausts
        return Promise.reject(new Error("SSE connection refused"));
      });

      (testAdapter as any).httpClient = { connectSse: mockConnectSse };

      const notifySpy = vi.spyOn(testAdapter as any, "notifyAllSessions");
      const abortController = new AbortController();

      // Start the retry loop directly (no connect() needed)
      const loopPromise = (testAdapter as any).runSseLoopWithRetry(
        abortController.signal,
      ) as Promise<void>;

      // Advance past all exponential backoff delays:
      //   call 1 → normal end (line 223) → 0ms delay
      //   call 2 → fail → 1000ms delay
      //   call 3 → fail → 2000ms delay
      //   call 4 → fail → 4000ms delay
      //   call 5 → fail → consecutiveFailures=4 > MAX_RETRIES=3 → lines 233-234
      await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 500);

      await loopPromise;

      expect(notifySpy).toHaveBeenCalledWith("SSE connection lost after retries exhausted");
      expect(callCount).toBeGreaterThanOrEqual(5);
    } finally {
      vi.useRealTimers();
    }
  });
});
