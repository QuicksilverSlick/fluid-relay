import { describe, expect, it, vi } from "vitest";
import { createMockSession, flushPromises } from "../../testing/cli-message-factories.js";
import {
  AdapterNativeHandler,
  type CommandHandler,
  type CommandHandlerContext,
  LocalHandler,
  PassthroughHandler,
  SlashCommandChain,
  UnsupportedHandler,
} from "./slash-command-chain.js";
import { SlashCommandExecutor } from "./slash-command-executor.js";

function makeHandler(handles: boolean, name = "test"): CommandHandler {
  return {
    handles: vi.fn().mockReturnValue(handles),
    execute: vi.fn(),
    name,
  };
}

function makeContext(): CommandHandlerContext {
  return {
    command: "/compact",
    requestId: "req-1",
    slashRequestId: "sr-1",
    traceId: "t-1",
    startedAtMs: Date.now(),
    session: createMockSession(),
  };
}

function slashCtx(
  session: ReturnType<typeof createMockSession>,
  command: string,
  requestId?: string,
): CommandHandlerContext {
  return {
    command,
    requestId,
    slashRequestId: requestId ?? "sr-generated",
    traceId: "t-test",
    startedAtMs: Date.now(),
    session,
  };
}

describe("SlashCommandChain", () => {
  it("calls execute on the first handler that handles the command", () => {
    const h1 = makeHandler(false, "h1");
    const h2 = makeHandler(true, "h2");
    const h3 = makeHandler(true, "h3");
    const chain = new SlashCommandChain([h1, h2, h3]);
    const ctx = makeContext();

    chain.dispatch(ctx);

    expect(h1.execute).not.toHaveBeenCalled();
    expect(h2.execute).toHaveBeenCalledWith(ctx);
    expect(h3.execute).not.toHaveBeenCalled();
  });

  it("skips handlers that return false from handles()", () => {
    const h1 = makeHandler(false);
    const h2 = makeHandler(false);
    const chain = new SlashCommandChain([h1, h2]);
    const ctx = makeContext();

    // No crash — falls off end (UnsupportedHandler prevents this in practice)
    expect(() => chain.dispatch(ctx)).not.toThrow();
  });

  it("passes handles() the command and session", () => {
    const handler = makeHandler(true);
    const chain = new SlashCommandChain([handler]);
    const ctx = makeContext();

    chain.dispatch(ctx);

    expect(handler.handles).toHaveBeenCalledWith(ctx);
  });
});

// ─── LocalHandler ─────────────────────────────────────────────────────────────

function makeLocalSetup() {
  const executor = new SlashCommandExecutor();
  const processSignal = vi.fn();
  const handler = new LocalHandler({ executor, processSignal });
  const session = createMockSession();
  return { handler, session, processSignal };
}

describe("LocalHandler", () => {
  it("handles /help", () => {
    const { handler, session } = makeLocalSetup();
    expect(handler.handles(slashCtx(session, "/help"))).toBe(true);
  });

  it("does not handle /compact", () => {
    const { handler, session } = makeLocalSetup();
    expect(handler.handles(slashCtx(session, "/compact"))).toBe(false);
  });

  it("dispatches SLASH_LOCAL_RESULT signal on /help success", async () => {
    const { handler, session, processSignal } = makeLocalSetup();
    handler.execute(slashCtx(session, "/help", "r1"));
    await flushPromises();
    expect(processSignal).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        kind: "SLASH_LOCAL_RESULT",
        command: "/help",
        requestId: "r1",
        source: "emulated",
      }),
    );
    const signal = processSignal.mock.calls[0][1];
    expect(signal.content).toContain("Available commands:");
  });

  it("dispatches SLASH_LOCAL_ERROR signal when executor rejects", async () => {
    const executor = new SlashCommandExecutor();
    vi.spyOn(executor, "executeLocal").mockRejectedValue(new Error("boom"));
    const processSignal = vi.fn();
    const handler = new LocalHandler({ executor, processSignal });
    const session = createMockSession();
    handler.execute(slashCtx(session, "/help", "r1"));
    await flushPromises();
    expect(processSignal).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ kind: "SLASH_LOCAL_ERROR", error: "boom" }),
    );
  });

  it("executeLocal() returns content and source directly", async () => {
    const { handler, session } = makeLocalSetup();
    const result = await handler.executeLocal(slashCtx(session, "/help"));
    expect(result.source).toBe("emulated");
    expect(result.content).toContain("Available commands:");
  });
});

// ─── AdapterNativeHandler ─────────────────────────────────────────────────────

describe("AdapterNativeHandler", () => {
  it("handles command when adapterSlashExecutor handles it", () => {
    const session = createMockSession();
    session.adapterSlashExecutor = {
      handles: vi.fn().mockReturnValue(true),
      execute: vi.fn().mockResolvedValue({ content: "ok", source: "emulated", durationMs: 10 }),
      supportedCommands: vi.fn().mockReturnValue(["/compact"]),
    };
    const handler = new AdapterNativeHandler({ processSignal: vi.fn() });
    expect(handler.handles(slashCtx(session, "/compact"))).toBe(true);
  });

  it("does not handle when adapterSlashExecutor is null", () => {
    const session = createMockSession();
    session.adapterSlashExecutor = null;
    const handler = new AdapterNativeHandler({ processSignal: vi.fn() });
    expect(handler.handles(slashCtx(session, "/compact"))).toBe(false);
  });

  it("dispatches SLASH_LOCAL_RESULT signal from adapter executor", async () => {
    const session = createMockSession();
    session.adapterSlashExecutor = {
      handles: vi.fn().mockReturnValue(true),
      execute: vi
        .fn()
        .mockResolvedValue({ content: "compact done", source: "emulated", durationMs: 5 }),
      supportedCommands: vi.fn().mockReturnValue(["/compact"]),
    };
    const processSignal = vi.fn();
    const handler = new AdapterNativeHandler({ processSignal });
    handler.execute(slashCtx(session, "/compact", "r1"));
    await flushPromises();
    expect(processSignal).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        kind: "SLASH_LOCAL_RESULT",
        command: "/compact",
        requestId: "r1",
        content: "compact done",
      }),
    );
  });

  it("dispatches SLASH_LOCAL_ERROR signal when adapter executor rejects", async () => {
    const session = createMockSession();
    session.adapterSlashExecutor = {
      handles: vi.fn().mockReturnValue(true),
      execute: vi.fn().mockRejectedValue(new Error("adapter exploded")),
      supportedCommands: vi.fn().mockReturnValue(["/compact"]),
    };
    const processSignal = vi.fn();
    const handler = new AdapterNativeHandler({ processSignal });
    handler.execute(slashCtx(session, "/compact", "r1"));
    await flushPromises();
    expect(processSignal).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        kind: "SLASH_LOCAL_ERROR",
        command: "/compact",
        error: "adapter exploded",
      }),
    );
  });

  it("handles non-Error thrown from adapter executor (String(err) branch)", async () => {
    const session = createMockSession();
    session.adapterSlashExecutor = {
      handles: vi.fn().mockReturnValue(true),
      execute: vi.fn().mockRejectedValue("plain string error"),
      supportedCommands: vi.fn().mockReturnValue(["/compact"]),
    };
    const processSignal = vi.fn();
    const handler = new AdapterNativeHandler({ processSignal });
    handler.execute(slashCtx(session, "/compact", "r1"));
    await flushPromises();
    expect(processSignal).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ kind: "SLASH_LOCAL_ERROR", error: "plain string error" }),
    );
  });
});

// ─── PassthroughHandler ───────────────────────────────────────────────────────

describe("PassthroughHandler", () => {
  it("handles any command when adapter supports passthrough", () => {
    const session = createMockSession();
    session.data.adapterSupportsSlashPassthrough = true;
    const handler = new PassthroughHandler({
      sendUserMessage: vi.fn(),
      registerPendingPassthrough: (targetSession, entry) => {
        targetSession.pendingPassthroughs.push(entry);
      },
    });
    expect(handler.handles(slashCtx(session, "/any-cmd"))).toBe(true);
  });

  it("does not handle when adapter does not support passthrough", () => {
    const session = createMockSession();
    session.data.adapterSupportsSlashPassthrough = false;
    const handler = new PassthroughHandler({
      sendUserMessage: vi.fn(),
      registerPendingPassthrough: (targetSession, entry) => {
        targetSession.pendingPassthroughs.push(entry);
      },
    });
    expect(handler.handles(slashCtx(session, "/compact"))).toBe(false);
  });

  it("pushes to pendingPassthroughs queue and calls sendUserMessage", () => {
    const sendUserMessage = vi.fn();
    const session = createMockSession();
    session.data.adapterSupportsSlashPassthrough = true;
    const handler = new PassthroughHandler({
      sendUserMessage,
      registerPendingPassthrough: (targetSession, entry) => {
        targetSession.pendingPassthroughs.push(entry);
      },
    });
    handler.execute(slashCtx(session, "/compact arg", "r1"));
    expect(session.pendingPassthroughs).toEqual([
      expect.objectContaining({
        command: "/compact",
        requestId: "r1",
        slashRequestId: "r1",
      }),
    ]);
    expect(sendUserMessage).toHaveBeenCalledWith(
      "sess-1",
      "/compact arg",
      expect.objectContaining({ requestId: "r1", command: "/compact" }),
    );
  });

  it("uses injected passthrough registration callback when provided", () => {
    const sendUserMessage = vi.fn();
    const registerPendingPassthrough = vi.fn();
    const session = createMockSession();
    session.data.adapterSupportsSlashPassthrough = true;
    const handler = new PassthroughHandler({
      sendUserMessage,
      registerPendingPassthrough,
    });

    handler.execute(slashCtx(session, "/compact arg", "r1"));

    expect(registerPendingPassthrough).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        command: "/compact",
        requestId: "r1",
        slashRequestId: "r1",
      }),
    );
    expect(session.pendingPassthroughs).toEqual([]);
  });
});

// ─── UnsupportedHandler ───────────────────────────────────────────────────────

describe("UnsupportedHandler", () => {
  it("always handles any command", () => {
    const session = createMockSession();
    const handler = new UnsupportedHandler({ processSignal: vi.fn() });
    expect(handler.handles(slashCtx(session, "/anything"))).toBe(true);
  });

  it("dispatches SLASH_LOCAL_ERROR signal for unsupported command", () => {
    const processSignal = vi.fn();
    const handler = new UnsupportedHandler({ processSignal });
    const session = createMockSession();
    handler.execute(slashCtx(session, "/unknown", "r1"));
    expect(processSignal).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        kind: "SLASH_LOCAL_ERROR",
        command: "/unknown",
        requestId: "r1",
      }),
    );
    const signal = processSignal.mock.calls[0][1];
    expect(signal.error).toContain("/unknown");
    expect(signal.error).toContain("not supported");
  });
});
