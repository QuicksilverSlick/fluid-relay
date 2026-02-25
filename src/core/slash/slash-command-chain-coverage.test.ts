/**
 * Additional coverage tests for slash-command-chain.ts.
 *
 * Targets the three previously uncovered branches:
 *
 *  • Line 112  — LocalHandler catch: `String(err)` when rejection value is not an Error instance
 *  • Line 164  — AdapterNativeHandler.execute(): early return when adapterSlashExecutor is null
 *  • Line 180  — AdapterNativeHandler.execute(): `if (!result) return` when executor resolves null
 */

import { describe, expect, it, vi } from "vitest";
import { createMockSession, flushPromises } from "../../testing/cli-message-factories.js";
import {
  AdapterNativeHandler,
  type CommandHandlerContext,
  LocalHandler,
} from "./slash-command-chain.js";
import { SlashCommandExecutor } from "./slash-command-executor.js";

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

// ─── LocalHandler — non-Error rejection (line 112 String(err) branch) ─────────

describe("LocalHandler — non-Error rejection branch (line 112)", () => {
  it("uses String(err) for the error message when executor rejects with a non-Error value", async () => {
    const executor = new SlashCommandExecutor();
    // Reject with a plain string, not an Error instance
    vi.spyOn(executor, "executeLocal").mockRejectedValue("something went wrong");
    const processSignal = vi.fn();
    const handler = new LocalHandler({ executor, processSignal });
    const session = createMockSession();

    handler.execute(slashCtx(session, "/help", "r1"));
    await flushPromises();

    expect(processSignal).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        kind: "SLASH_LOCAL_ERROR",
        command: "/help",
        requestId: "r1",
        error: "something went wrong",
      }),
    );
  });

  it("uses String(err) for numeric rejection values", async () => {
    const executor = new SlashCommandExecutor();
    vi.spyOn(executor, "executeLocal").mockRejectedValue(42);
    const processSignal = vi.fn();
    const handler = new LocalHandler({ executor, processSignal });
    const session = createMockSession();

    handler.execute(slashCtx(session, "/help", "r2"));
    await flushPromises();

    expect(processSignal).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        kind: "SLASH_LOCAL_ERROR",
        error: "42",
      }),
    );
  });
});

// ─── AdapterNativeHandler — early return when adapterSlashExecutor is null (line 164) ──

describe("AdapterNativeHandler.execute() — null adapterSlashExecutor guard (line 164)", () => {
  it("returns without calling processSignal when adapterSlashExecutor is null at execute time", async () => {
    const processSignal = vi.fn();
    const handler = new AdapterNativeHandler({ processSignal });
    const session = createMockSession();
    // adapterSlashExecutor is null (default from createMockSession)
    expect(session.adapterSlashExecutor).toBeNull();

    // Call execute() directly — bypasses the handles() check
    handler.execute(slashCtx(session, "/compact", "r1"));
    await flushPromises();

    expect(processSignal).not.toHaveBeenCalled();
  });
});

// ─── AdapterNativeHandler — null result branch (line 180) ────────────────────

describe("AdapterNativeHandler.execute() — null result from executor (line 180)", () => {
  it("returns without calling processSignal when adapter executor resolves null", async () => {
    const processSignal = vi.fn();
    const session = createMockSession();
    session.adapterSlashExecutor = {
      handles: vi.fn().mockReturnValue(true),
      // Resolves with null — hits the `if (!result) return` guard
      execute: vi.fn().mockResolvedValue(null),
      supportedCommands: vi.fn().mockReturnValue(["/compact"]),
    };
    const handler = new AdapterNativeHandler({ processSignal });

    handler.execute(slashCtx(session, "/compact", "r1"));
    await flushPromises();

    expect(processSignal).not.toHaveBeenCalled();
  });

  it("returns without calling processSignal when adapter executor resolves undefined", async () => {
    const processSignal = vi.fn();
    const session = createMockSession();
    session.adapterSlashExecutor = {
      handles: vi.fn().mockReturnValue(true),
      execute: vi.fn().mockResolvedValue(undefined),
      supportedCommands: vi.fn().mockReturnValue(["/compact"]),
    };
    const handler = new AdapterNativeHandler({ processSignal });

    handler.execute(slashCtx(session, "/compact", "r1"));
    await flushPromises();

    expect(processSignal).not.toHaveBeenCalled();
  });
});
