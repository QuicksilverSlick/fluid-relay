import { describe, expect, it, vi } from "vitest";
import { createMockSession, noopLogger } from "../../testing/cli-message-factories.js";
import { DEFAULT_CONFIG } from "../../types/config.js";
import { CapabilitiesPolicy } from "./capabilities-policy.js";

describe("CapabilitiesPolicy", () => {
  function makeRuntime(session: any) {
    return {
      getState: () => session.data.state,
      setState: (state: any) => {
        session.data.state = state;
      },
      getPendingInitialize: () => session.pendingInitialize,
      setPendingInitialize: (pendingInitialize: any) => {
        session.pendingInitialize = pendingInitialize;
      },
      tryInitializeBackend: (requestId: string) => {
        if (!session.backendSession) return "no_backend";
        session.backendSession.initialize?.(requestId);
        return "sent";
      },
      registerCLICommands: (commands: any[]) => {
        session.registry.registerFromCLI(commands);
      },
    };
  }

  it("sends initialize handshake via backend initialize()", () => {
    const policy = new CapabilitiesPolicy(DEFAULT_CONFIG, noopLogger, (session: any) =>
      makeRuntime(session),
    );

    const session = createMockSession();
    const initialize = vi.fn();
    session.backendSession = {
      sessionId: "backend-1",
      send: vi.fn(),
      initialize,
      messages: {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true, value: undefined }),
        }),
      },
      close: vi.fn(),
    } as any;

    policy.sendInitializeRequest(session);

    expect(initialize).toHaveBeenCalledOnce();
    expect(initialize.mock.calls[0][0]).toBeTypeOf("string"); // requestId UUID
    expect(session.pendingInitialize).not.toBeNull();
    expect(session.pendingInitialize!.requestId).toBe(initialize.mock.calls[0][0]);
  });

  it("cancels pending initialize and warns when backend is not yet connected", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const policy = new CapabilitiesPolicy(DEFAULT_CONFIG, logger as any, (session: any) =>
      makeRuntime(session),
    );

    const session = createMockSession();
    session.backendSession = null;

    policy.sendInitializeRequest(session);

    expect(session.pendingInitialize).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("before backend connected"));
  });
});
