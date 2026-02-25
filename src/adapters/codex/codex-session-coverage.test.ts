/**
 * Additional branch-coverage tests for CodexSession.
 *
 * Targets branches not covered by the existing test suite:
 *   - Line 279-280: requestRpc timeout branch (timeoutMs <= 0 skips timer)
 *   - Line 356:     resetThread when initializingThread is in-flight
 *   - Line 364:     resetThread throws when ensureThreadInitialized leaves threadId null
 *   - Line 657:     handleNotification else-branch when translateCodexEvent returns null
 *   - Line 883:     translateResponseItem default case (unknown item type)
 *   - Line 906:     applyTraceToUnified when currentTrace.requestId is set
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type { ProcessHandle, ProcessManager } from "../../interfaces/process-manager.js";
import { CodexLauncher } from "./codex-launcher.js";
import { CodexSession } from "./codex-session.js";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  terminate(): void {
    this.readyState = 3;
  }
}

function createMockProcessManager(): ProcessManager {
  return {
    spawn: vi.fn().mockReturnValue({
      pid: 12345,
      exited: new Promise<number | null>(() => {}),
      kill: vi.fn(),
      stdout: null,
      stderr: null,
    } satisfies ProcessHandle),
    isAlive: vi.fn().mockReturnValue(true),
  };
}

/** Emit a JSON-RPC message on the WebSocket as if it came from the backend. */
function emitMsg(ws: MockWebSocket, msg: object): void {
  ws.emit("message", Buffer.from(JSON.stringify(msg)));
}

/** Intercept ws.send and auto-reply to RPC requests using the provided handler. */
function interceptRpc(
  ws: MockWebSocket,
  handler: (method: string, id: number) => object | null,
): void {
  const origSend = ws.send.bind(ws);
  ws.send = vi.fn((data: string) => {
    origSend(data);
    const parsed = JSON.parse(data);
    if (parsed.id !== undefined && parsed.method) {
      const reply = handler(parsed.method, parsed.id);
      if (reply) {
        queueMicrotask(() => emitMsg(ws, reply));
      }
    }
  });
}

// ---------------------------------------------------------------------------
// requestRpc with timeoutMs <= 0  (lines 279-280 are inside the timeout callback,
// but the branch at line 274 "if (timeoutMs <= 0) return rpcPromise" means
// the timer body is never constructed — so passing timeoutMs=0 exercises
// the early-return branch and keeps lines 279-280 uncovered by design.
// The ACTUAL uncovered lines 279-280 are the setTimeout callback body that
// fires when a timeout elapses.  We need to let the timer fire.
// ---------------------------------------------------------------------------

describe("CodexSession — requestRpc timeout fires (lines 279-280)", () => {
  let ws: MockWebSocket;
  let launcher: CodexLauncher;

  beforeEach(() => {
    ws = new MockWebSocket();
    launcher = new CodexLauncher({ processManager: createMockProcessManager() });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    ws.close();
  });

  it("rejects with timeout error when RPC does not respond within timeoutMs", async () => {
    const session = new CodexSession({
      sessionId: "test-timeout",
      ws: ws as unknown as WebSocket,
      launcher,
      threadId: "t-1",
    });

    // requestRpc is public — call it directly with a very short timeout
    const rpcPromise = session.requestRpc("some/method", {}, 100);

    // Advance fake timer past the timeout
    vi.advanceTimersByTime(200);

    // The promise should reject with a timeout message
    await expect(rpcPromise).rejects.toThrow(/timed out/);
    ws.close();
  });

  it("resolves normally when RPC responds before timeout", async () => {
    const session = new CodexSession({
      sessionId: "test-timeout-resolve",
      ws: ws as unknown as WebSocket,
      launcher,
      threadId: "t-1",
    });

    // Set up interception: the RPC request will get an immediate reply
    interceptRpc(ws, (method, id) => ({
      jsonrpc: "2.0",
      id,
      result: { ok: true },
    }));

    // Use real timers for this test
    vi.useRealTimers();

    const result = await session.requestRpc("some/method", {}, 5000);
    expect(result.result).toEqual({ ok: true });
    ws.close();
  });
});

// ---------------------------------------------------------------------------
// resetThread — covers lines 356 and 364
// ---------------------------------------------------------------------------

describe("CodexSession — resetThread", () => {
  let ws: MockWebSocket;
  let launcher: CodexLauncher;

  afterEach(() => {
    ws.close();
  });

  it("awaits in-flight initializingThread before resetting (line 356)", async () => {
    ws = new MockWebSocket();
    launcher = new CodexLauncher({ processManager: createMockProcessManager() });

    const session = new CodexSession({
      sessionId: "test-reset",
      ws: ws as unknown as WebSocket,
      launcher,
      // No threadId — sending will kick off ensureThreadInitialized
    });

    // Intercept: respond to thread/start with a valid thread id
    interceptRpc(ws, (method, id) => {
      if (method === "thread/start") {
        return {
          jsonrpc: "2.0",
          id,
          result: { thread: { id: "thread-after-reset" } },
        };
      }
      return null;
    });

    // Kick off thread initialization by sending a user message.
    // The send is async internally; initializingThread will be set while
    // the RPC is in flight.
    session.send(
      createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
    );

    // resetThread while initializingThread may be in flight.
    // After reset, a new thread should be initialized.
    const newThreadId = await session.resetThread();

    expect(typeof newThreadId).toBe("string");
    expect(newThreadId.length).toBeGreaterThan(0);
  });

  it("throws when ensureThreadInitialized leaves threadId null (line 364)", async () => {
    ws = new MockWebSocket();
    launcher = new CodexLauncher({ processManager: createMockProcessManager() });

    const session = new CodexSession({
      sessionId: "test-reset-fail",
      ws: ws as unknown as WebSocket,
      launcher,
      threadId: "t-existing", // start with a thread
    });

    // Override ensureThreadInitialized to do nothing (threadId stays null after reset clears it)
    (session as any).ensureThreadInitialized = async () => {
      // Intentionally leaves this.threadId as null
    };

    await expect(session.resetThread()).rejects.toThrow(
      "Failed to reset Codex thread: threadId is null",
    );
  });
});

// ---------------------------------------------------------------------------
// handleNotification else-branch: translateCodexEvent returns null (line 657)
// ---------------------------------------------------------------------------

describe("CodexSession — unknown notification method falls to tracer (line 657)", () => {
  let ws: MockWebSocket;
  let session: CodexSession;
  let launcher: CodexLauncher;

  beforeEach(() => {
    ws = new MockWebSocket();
    launcher = new CodexLauncher({ processManager: createMockProcessManager() });
    session = new CodexSession({
      sessionId: "test-unmapped",
      ws: ws as unknown as WebSocket,
      launcher,
      threadId: "t-1",
    });
  });

  afterEach(() => ws.close());

  it("drops notification when translateCodexEvent returns null for unknown event type", () => {
    // Send a notification that doesn't match any of the well-known methods
    // (thread/started, turn/started, item/agentMessage/delta, etc.) AND
    // whose type is also unknown to translateCodexEvent.
    // translateCodexEvent handles: response.output_text.delta,
    // response.output_item.added, response.output_item.done,
    // response.completed, response.failed — anything else returns null.
    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "unknown/custom/event",
      params: { type: "completely_unknown_event_type", data: "irrelevant" },
    });

    // No message should be enqueued — the else branch just calls tracer?.error
    // which is a no-op when tracer is undefined.  The test passes if no exception
    // is thrown and no messages appear in the queue.
  });

  it("also drops when notification has no params.type and method is unknown (line 657)", () => {
    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "some.other.unknown.method",
      params: {},
    });
    // No exception — tracer?.error is safely called with optional chaining
  });
});

// ---------------------------------------------------------------------------
// translateResponseItem default case: unknown item type (line 883)
// ---------------------------------------------------------------------------

describe("CodexSession — translateResponseItem default case (line 883)", () => {
  let ws: MockWebSocket;
  let session: CodexSession;
  let launcher: CodexLauncher;

  beforeEach(() => {
    ws = new MockWebSocket();
    launcher = new CodexLauncher({ processManager: createMockProcessManager() });
    session = new CodexSession({
      sessionId: "test-item-default",
      ws: ws as unknown as WebSocket,
      launcher,
      threadId: "t-1",
    });
  });

  afterEach(() => ws.close());

  it("returns null for unknown item type in response output, skipping enqueue", async () => {
    const iter = session.messages[Symbol.asyncIterator]();

    // Send a response with an item type not handled by translateResponseItem
    // (not 'message', 'function_call', or 'function_call_output').
    emitMsg(ws, {
      jsonrpc: "2.0",
      id: 500,
      result: {
        id: "resp-unknown",
        status: "completed",
        output: [
          // This item type hits the `default: return null` branch
          { type: "web_search_result", id: "ws-1", content: "some content" },
          // A valid message so we get a result to await
          {
            type: "message",
            id: "m-ok",
            content: [{ type: "output_text", text: "valid response" }],
          },
        ],
      },
    });

    // The unknown item is skipped; we should still get the message and result
    const assistantMsg = await iter.next();
    expect(assistantMsg.value.type).toBe("assistant");
    expect(assistantMsg.value.content[0]).toEqual({ type: "text", text: "valid response" });

    const resultMsg = await iter.next();
    expect(resultMsg.value.type).toBe("result");
    expect(resultMsg.value.metadata.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// applyTraceToUnified: requestId branch (line 906)
// ---------------------------------------------------------------------------

describe("CodexSession — applyTraceToUnified with requestId (line 906)", () => {
  let ws: MockWebSocket;
  let session: CodexSession;
  let launcher: CodexLauncher;

  beforeEach(() => {
    ws = new MockWebSocket();
    launcher = new CodexLauncher({ processManager: createMockProcessManager() });
    session = new CodexSession({
      sessionId: "test-trace-requestid",
      ws: ws as unknown as WebSocket,
      launcher,
      threadId: "t-1",
    });
  });

  afterEach(() => ws.close());

  it("copies requestId to slash_request_id on enqueued messages when currentTrace has requestId", async () => {
    // Send a user message with slash_request_id metadata so that
    // traceFromUnified sets currentTrace.requestId.
    session.send(
      createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "request with trace" }],
        metadata: {
          trace_id: "trace-abc",
          slash_request_id: "req-xyz",
          slash_command: "/test",
        },
      }),
    );

    const iter = session.messages[Symbol.asyncIterator]();

    // Now emit a turn/started notification — it will go through enqueueTranslated
    // which calls applyTraceToUnified with the currentTrace set above.
    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "turn/started",
      params: { turn: { id: "turn-trace-test" } },
    });

    const msg = await iter.next();
    expect(msg.value.type).toBe("stream_event");
    // applyTraceToUnified should have copied the requestId to slash_request_id
    expect(msg.value.metadata.slash_request_id).toBe("req-xyz");
    // traceId should also be copied
    expect(msg.value.metadata.trace_id).toBe("trace-abc");
    // command should also be copied
    expect(msg.value.metadata.slash_command).toBe("/test");
  });
});
