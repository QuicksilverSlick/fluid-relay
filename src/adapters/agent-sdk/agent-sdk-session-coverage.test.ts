/**
 * AgentSdkSession coverage tests — targets uncovered lines 198, 207-226, 269
 * plus additional branches to reach ≥90% for the file:
 *   Lines 146-150: startQueryLoop resume branch
 *   Lines 166-181: canUseTool callback allow/deny paths
 *   Lines 259-260: createInputIterable next() waiting on inputResolve
 *   Lines 271-273: pushInput() resolves pending inputResolve
 *   Lines 283-285: finishInput() resolves pending inputResolve with done:true
 */

import { describe, expect, it, vi } from "vitest";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import { AgentSdkSession } from "./agent-sdk-session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockQueryGenerator = AsyncGenerator<Record<string, unknown>, void> & {
  close: () => void;
  interrupt: () => Promise<void>;
};

function createMockQueryFromGenerator(
  gen: AsyncGenerator<Record<string, unknown>, void>,
): MockQueryGenerator {
  let closed = false;
  return {
    async next() {
      if (closed)
        return { value: undefined, done: true } as IteratorResult<Record<string, unknown>>;
      return gen.next();
    },
    async return() {
      closed = true;
      return { value: undefined, done: true } as IteratorResult<Record<string, unknown>>;
    },
    async throw(err: unknown) {
      closed = true;
      throw err;
    },
    close() {
      closed = true;
    },
    async interrupt() {},
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level mock — overridden per test via mockImplementation
// ---------------------------------------------------------------------------

const mockQuery = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  get query() {
    return mockQuery;
  },
}));

// ---------------------------------------------------------------------------
// Line 198 — consumeStream() exits immediately when this.query is null
// ---------------------------------------------------------------------------

describe("consumeStream() — line 198: early return when query is null", () => {
  it("calling consumeStream() directly on an instance with null query returns without throwing", async () => {
    // Build a mock that yields nothing so the session is quiet
    mockQuery.mockImplementationOnce(() => {
      async function* empty() {}
      return createMockQueryFromGenerator(empty());
    });

    const session = await AgentSdkSession.create({ sessionId: "test-null-query" });

    // Force query to null to hit the guard on line 198
    (session as any).query = null;

    // Call consumeStream directly — should return without error
    await expect((session as any).consumeStream()).resolves.toBeUndefined();

    await session.close();
  });
});

// ---------------------------------------------------------------------------
// Lines 207-209 — system:init without a session_id (falsy branch)
// ---------------------------------------------------------------------------

describe("consumeStream() — lines 207-209: system:init with no session_id", () => {
  it("does not set backendSessionId when session_id is absent from system:init", async () => {
    mockQuery.mockImplementationOnce(() => {
      async function* messages() {
        // system:init without session_id — hits the `if (sessionId)` false branch
        yield {
          type: "system",
          subtype: "init",
          cwd: "/test",
          // session_id intentionally omitted
          tools: [],
          mcp_servers: [],
          model: "claude-sonnet-4-6",
          permissionMode: "default",
          apiKeySource: "user",
          claude_code_version: "1.0.0",
          slash_commands: [],
          skills: [],
          output_style: "concise",
          uuid: "uuid-no-session-id",
        };
      }
      return createMockQueryFromGenerator(messages());
    });

    const session = await AgentSdkSession.create({ sessionId: "test-no-session-id" });

    // Drain the message stream
    for await (const _ of session.messages) {
      // consume until done
    }

    // backendSessionId should remain undefined because session_id was absent
    expect(session.backendSessionId).toBeUndefined();

    await session.close();
  });

  it("does not set backendSessionId when session_id is an empty string (falsy)", async () => {
    mockQuery.mockImplementationOnce(() => {
      async function* messages() {
        yield {
          type: "system",
          subtype: "init",
          cwd: "/test",
          session_id: "", // empty string is falsy
          tools: [],
          mcp_servers: [],
          model: "claude-sonnet-4-6",
          permissionMode: "default",
          apiKeySource: "user",
          claude_code_version: "1.0.0",
          slash_commands: [],
          skills: [],
          output_style: "concise",
          uuid: "uuid-empty-session-id",
        };
      }
      return createMockQueryFromGenerator(messages());
    });

    const session = await AgentSdkSession.create({ sessionId: "test-empty-session-id" });

    for await (const _ of session.messages) {
      // consume until done
    }

    expect(session.backendSessionId).toBeUndefined();

    await session.close();
  });
});

// ---------------------------------------------------------------------------
// Lines 217-226 — catch block: stream throws while session is open
// ---------------------------------------------------------------------------

describe("consumeStream() — lines 217-226: catch block when stream throws", () => {
  it("enqueues a failed result message when the SDK stream throws and session is open", async () => {
    const boom = new Error("SDK stream exploded");

    mockQuery.mockImplementationOnce(() => {
      async function* messages() {
        yield {
          type: "assistant",
          message: {
            id: "msg-err",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "before error" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          parent_tool_use_id: null,
          uuid: "uuid-err-1",
          session_id: "err-session",
        };
        throw boom;
      }
      return createMockQueryFromGenerator(messages());
    });

    const session = await AgentSdkSession.create({ sessionId: "test-stream-error" });

    const collected: unknown[] = [];
    for await (const msg of session.messages) {
      collected.push(msg);
    }

    // The last message should be the synthetic failed result injected by catch
    const last = collected[collected.length - 1] as Record<string, unknown>;
    expect(last).toBeDefined();
    expect(last.type).toBe("result");

    const metadata = last.metadata as Record<string, unknown>;
    expect(metadata.status).toBe("failed");
    expect(metadata.is_error).toBe(true);
    expect(metadata.error).toBe("SDK stream exploded");

    await session.close();
  });

  it("does NOT enqueue an error message when the SDK stream throws after session is closed", async () => {
    const boom = new Error("late throw after close");

    // Use a generator that throws only after we close the session
    let throwNow = false;
    const mockGen: MockQueryGenerator = {
      async next() {
        if (throwNow) throw boom;
        return { value: undefined, done: true } as IteratorResult<Record<string, unknown>>;
      },
      async return() {
        return { value: undefined, done: true } as IteratorResult<Record<string, unknown>>;
      },
      async throw(err: unknown) {
        throw err;
      },
      close() {
        throwNow = true;
      },
      async interrupt() {},
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    mockQuery.mockImplementationOnce(() => mockGen);

    const session = await AgentSdkSession.create({ sessionId: "test-closed-before-throw" });

    // Close immediately — sets this.closed = true before consumeStream hits catch
    await session.close();

    // Give the async consumeStream loop a tick to process the throw
    await new Promise((r) => setTimeout(r, 10));

    // The queue should be finished (from close()), but no extra error message
    const iter = session.messages[Symbol.asyncIterator]();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Line 269 — pushInput() early return when inputDone is true
// ---------------------------------------------------------------------------

describe("pushInput() — line 269: early return when inputDone is true", () => {
  it("calling pushInput() after inputDone is true is a no-op", async () => {
    mockQuery.mockImplementationOnce(() => {
      async function* empty() {}
      return createMockQueryFromGenerator(empty());
    });

    const session = await AgentSdkSession.create({ sessionId: "test-push-after-done" });

    // Set inputDone = true to simulate finishInput() having been called
    (session as any).inputDone = true;

    const queueBefore = [...(session as any).inputQueue];

    // pushInput should hit the early return on line 269
    (session as any).pushInput({ type: "user", message: { role: "user", content: "ignored" } });

    // Queue must be unchanged
    expect((session as any).inputQueue).toEqual(queueBefore);

    await session.close();
  });

  it("pushInput() after close() (which calls finishInput()) is a no-op", async () => {
    mockQuery.mockImplementationOnce(() => {
      async function* empty() {}
      return createMockQueryFromGenerator(empty());
    });

    const session = await AgentSdkSession.create({ sessionId: "test-push-after-close" });

    await session.close(); // sets inputDone = true via finishInput()

    // inputDone should now be true
    expect((session as any).inputDone).toBe(true);

    // This should trigger the line 269 early return without throwing
    expect(() =>
      (session as any).pushInput({ type: "user", message: { role: "user", content: "noop" } }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Lines 271-273 — pushInput() resolves a pending inputResolve promise
// ---------------------------------------------------------------------------

describe("pushInput() — lines 271-273: resolves pending inputResolve", () => {
  it("pushInput() calls inputResolve when it is set (consumer is waiting)", async () => {
    mockQuery.mockImplementationOnce(() => {
      async function* empty() {}
      return createMockQueryFromGenerator(empty());
    });

    const session = await AgentSdkSession.create({ sessionId: "test-push-resolves" });

    // Simulate a consumer waiting on the input iterable: set inputResolve manually
    let resolvedValue: IteratorResult<{ type: "user"; message: unknown }> | undefined;
    (session as any).inputResolve = (val: IteratorResult<{ type: "user"; message: unknown }>) => {
      resolvedValue = val;
    };

    const msg = { type: "user" as const, message: { role: "user", content: "direct resolve" } };
    (session as any).pushInput(msg);

    // inputResolve should have been called and cleared
    expect((session as any).inputResolve).toBeNull();
    expect(resolvedValue).toBeDefined();
    expect(resolvedValue!.done).toBe(false);
    expect(resolvedValue!.value).toEqual(msg);

    await session.close();
  });
});

// ---------------------------------------------------------------------------
// Lines 283-285 — finishInput() resolves pending inputResolve with done:true
// ---------------------------------------------------------------------------

describe("finishInput() — lines 283-285: resolves pending inputResolve with done", () => {
  it("finishInput() calls inputResolve with done:true when consumer is waiting", async () => {
    mockQuery.mockImplementationOnce(() => {
      async function* empty() {}
      return createMockQueryFromGenerator(empty());
    });

    const session = await AgentSdkSession.create({ sessionId: "test-finish-resolves" });

    // Simulate a consumer waiting on the input iterable
    let resolvedValue: IteratorResult<{ type: "user"; message: unknown }> | undefined;
    (session as any).inputResolve = (val: IteratorResult<{ type: "user"; message: unknown }>) => {
      resolvedValue = val;
    };

    // finishInput() should call inputResolve with { done: true }
    (session as any).finishInput();

    expect((session as any).inputDone).toBe(true);
    expect((session as any).inputResolve).toBeNull();
    expect(resolvedValue).toBeDefined();
    expect(resolvedValue!.done).toBe(true);

    await session.close();
  });
});

// ---------------------------------------------------------------------------
// Lines 146-150 — startQueryLoop: resume branch (options.resume + backendSessionId)
// ---------------------------------------------------------------------------

describe("startQueryLoop() — lines 146-150: resume option", () => {
  it("passes resume backendSessionId to sdkOptions when options.resume is true", async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    mockQuery.mockImplementationOnce(
      ({ options }: { prompt: unknown; options?: Record<string, unknown> }) => {
        capturedOptions = options;
        async function* empty() {}
        return createMockQueryFromGenerator(empty());
      },
    );

    const session = await AgentSdkSession.create({
      sessionId: "test-resume",
      resume: true,
      adapterOptions: {
        backendSessionId: "resume-backend-123",
      },
    });

    await session.close();

    // sdkOptions.resume should be set to the backendSessionId
    expect(capturedOptions?.resume).toBe("resume-backend-123");
  });

  it("does NOT set sdkOptions.resume when resume is true but backendSessionId is missing", async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    mockQuery.mockImplementationOnce(
      ({ options }: { prompt: unknown; options?: Record<string, unknown> }) => {
        capturedOptions = options;
        async function* empty() {}
        return createMockQueryFromGenerator(empty());
      },
    );

    const session = await AgentSdkSession.create({
      sessionId: "test-resume-no-id",
      resume: true,
      // adapterOptions omitted — backendSessionId undefined
    });

    await session.close();

    // resume key should not be present in sdkOptions
    expect(capturedOptions?.resume).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Lines 166-181 — canUseTool callback: allow and deny decision paths
// ---------------------------------------------------------------------------

describe("canUseTool callback — lines 166-181: allow and deny paths", () => {
  it("resolves with allow behavior when permission_response is approved", async () => {
    let capturedCanUseTool:
      | ((
          toolName: string,
          input: Record<string, unknown>,
          opts: { signal: AbortSignal; toolUseID: string; agentID?: string },
        ) => Promise<unknown>)
      | undefined;

    mockQuery.mockImplementationOnce(
      ({ options }: { prompt: unknown; options?: Record<string, unknown> }) => {
        capturedCanUseTool = options?.canUseTool as typeof capturedCanUseTool;
        async function* empty() {}
        return createMockQueryFromGenerator(empty());
      },
    );

    const session = await AgentSdkSession.create({ sessionId: "test-can-use-tool-allow" });

    expect(capturedCanUseTool).toBeDefined();

    // Invoke the callback and schedule an approved permission_response
    const callbackPromise = capturedCanUseTool!(
      "Bash",
      { command: "ls" },
      { signal: new AbortController().signal, toolUseID: "tool-use-allow-1" },
    );

    // Respond with approved = true via session.send()
    session.send(
      createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: {
          request_id: "tool-use-allow-1",
          approved: true,
          updated_input: { command: "ls -la" },
        },
      }),
    );

    const result = await callbackPromise;
    expect((result as Record<string, unknown>).behavior).toBe("allow");

    await session.close();
  });

  it("resolves with deny behavior when permission_response is not approved", async () => {
    let capturedCanUseTool:
      | ((
          toolName: string,
          input: Record<string, unknown>,
          opts: { signal: AbortSignal; toolUseID: string; agentID?: string },
        ) => Promise<unknown>)
      | undefined;

    mockQuery.mockImplementationOnce(
      ({ options }: { prompt: unknown; options?: Record<string, unknown> }) => {
        capturedCanUseTool = options?.canUseTool as typeof capturedCanUseTool;
        async function* empty() {}
        return createMockQueryFromGenerator(empty());
      },
    );

    const session = await AgentSdkSession.create({ sessionId: "test-can-use-tool-deny" });

    expect(capturedCanUseTool).toBeDefined();

    const callbackPromise = capturedCanUseTool!(
      "Bash",
      { command: "rm -rf /" },
      { signal: new AbortController().signal, toolUseID: "tool-use-deny-1" },
    );

    // Respond with approved = false
    session.send(
      createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: {
          request_id: "tool-use-deny-1",
          approved: false,
          message: "Not allowed",
        },
      }),
    );

    const result = await callbackPromise;
    expect((result as Record<string, unknown>).behavior).toBe("deny");
    expect((result as Record<string, unknown>).message).toBe("Not allowed");

    await session.close();
  });
});

// ---------------------------------------------------------------------------
// Line 83-84 — send() interrupt branch: query?.interrupt() optional chain
// ---------------------------------------------------------------------------

describe("send() — lines 83-84: interrupt when query is null", () => {
  it("send(interrupt) with query=null does not throw (optional chain short-circuits)", async () => {
    mockQuery.mockImplementationOnce(() => {
      async function* empty() {}
      return createMockQueryFromGenerator(empty());
    });

    const session = await AgentSdkSession.create({ sessionId: "test-interrupt-null-query" });

    // Force query to null to exercise the null branch of query?.interrupt()
    (session as any).query = null;

    expect(() =>
      session.send(
        createUnifiedMessage({
          type: "interrupt",
          role: "user",
        }),
      ),
    ).not.toThrow();

    await session.close();
  });
});

// ---------------------------------------------------------------------------
// Lines 259-260 — createInputIterable next(): waiting branch (sets inputResolve)
// ---------------------------------------------------------------------------

describe("createInputIterable next() — lines 259-260: waits when no item queued", () => {
  it("next() returns a pending promise that resolves when pushInput() is called", async () => {
    mockQuery.mockImplementationOnce(() => {
      async function* empty() {}
      return createMockQueryFromGenerator(empty());
    });

    const session = await AgentSdkSession.create({ sessionId: "test-input-wait" });

    // Get an iterator from createInputIterable (not the public one)
    const iter = (session as any).createInputIterable()[Symbol.asyncIterator]();

    // inputQueue is empty and inputDone is false — next() should suspend and set inputResolve
    const nextPromise = iter.next();

    // Give a microtask tick for the Promise constructor to run
    await Promise.resolve();

    // inputResolve should now be set
    expect((session as any).inputResolve).not.toBeNull();

    // Resolve it by pushing a message
    const msg = { type: "user" as const, message: { role: "user", content: "deferred" } };
    (session as any).pushInput(msg);

    const result = await nextPromise;
    expect(result.done).toBe(false);
    expect(result.value).toEqual(msg);

    await session.close();
  });
});
