import { describe, expect, it, vi } from "vitest";
import { createMockSession, noopLogger } from "../../testing/cli-message-factories.js";
import { DEFAULT_CONFIG } from "../../types/config.js";
import type { ConsumerBroadcaster } from "../consumer/consumer-broadcaster.js";
import { CapabilitiesPolicy } from "./capabilities-policy.js";

describe("CapabilitiesPolicy", () => {
  it("sends initialize control_request via backend sendRaw", () => {
    const broadcaster = {
      broadcast: vi.fn(),
      broadcastToParticipants: vi.fn(),
      sendTo: vi.fn(),
    } as unknown as ConsumerBroadcaster;

    const policy = new CapabilitiesPolicy(
      DEFAULT_CONFIG,
      noopLogger,
      broadcaster,
      vi.fn(),
      (session: any) => ({
        getState: () => session.data.state,
        setState: (state: any) => {
          session.data.state = state;
        },
        getPendingInitialize: () => session.pendingInitialize,
        setPendingInitialize: (pendingInitialize: any) => {
          session.pendingInitialize = pendingInitialize;
        },
        trySendRawToBackend: (ndjson: string) => {
          if (!session.backendSession) return "no_backend";
          session.backendSession.sendRaw?.(ndjson);
          return "sent";
        },
        registerCLICommands: (commands: any[]) => {
          session.registry.registerFromCLI(commands);
        },
      }),
    );

    const session = createMockSession();
    const sendRaw = vi.fn();
    session.backendSession = {
      sessionId: "backend-1",
      send: vi.fn(),
      sendRaw,
      messages: {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true, value: undefined }),
        }),
      },
      close: vi.fn(),
    } as any;

    policy.sendInitializeRequest(session);

    expect(sendRaw).toHaveBeenCalledOnce();
    const payload = JSON.parse(sendRaw.mock.calls[0][0]);
    expect(payload.type).toBe("control_request");
    expect(payload.request.subtype).toBe("initialize");
    expect(session.pendingInitialize).not.toBeNull();
  });
});
