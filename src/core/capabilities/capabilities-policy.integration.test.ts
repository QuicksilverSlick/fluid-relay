import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockSession, noopLogger } from "../../testing/cli-message-factories.js";
import type { ResolvedConfig } from "../../types/config.js";
import { DEFAULT_CONFIG } from "../../types/config.js";
import type { ConsumerBroadcaster } from "../consumer/consumer-broadcaster.js";
import { createUnifiedMessage } from "../types/unified-message.js";
import { CapabilitiesPolicy } from "./capabilities-policy.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockRuntime(session: any, broadcaster: any, emitEvent: any) {
  return {
    getState: () => session.data.state,
    process: (event: any) => {
      if (event.type !== "SYSTEM_SIGNAL") return;
      const signal = event.signal;
      if (signal.kind === "STATE_PATCHED") {
        session.data.state = { ...session.data.state, ...signal.patch };
      } else if (signal.kind === "CAPABILITIES_APPLIED") {
        session.data.state = {
          ...session.data.state,
          capabilities: {
            commands: signal.commands,
            models: signal.models,
            account: signal.account,
            receivedAt: Date.now(),
          },
        };
        broadcaster.broadcast(session, {
          type: "capabilities_ready",
          commands: signal.commands,
          models: signal.models,
          account: signal.account,
          skills: session.data.state.skills,
        });
        emitEvent("capabilities:ready", {
          sessionId: session.id,
          commands: signal.commands,
          models: signal.models,
          account: signal.account,
        });
        // Mirrors SessionRuntime.handleSystemSignal post-reducer hook for CAPABILITIES_APPLIED:
        // registerCLICommands is now called here (in the runtime) rather than in CapabilitiesPolicy.
        if (signal.commands.length > 0) {
          session.registry.registerFromCLI(signal.commands);
        }
      } else if (signal.kind === "CAPABILITIES_TIMEOUT") {
        emitEvent("capabilities:timeout", { sessionId: session.id });
      }
    },
    getPendingInitialize: () => session.pendingInitialize,
    setPendingInitialize: (pi: any) => {
      session.pendingInitialize = pi;
    },
    tryInitializeBackend: (requestId: string) => {
      if (!session.backendSession) return "no_backend";
      if (!session.backendSession.initialize) return "unsupported";
      session.backendSession.initialize(requestId);
      return "sent";
    },
    registerCLICommands: (commands: any[]) => {
      session.registry.registerFromCLI(commands);
    },
  } as any;
}

function createDeps(
  configOverrides?: Partial<ResolvedConfig>,
  runtimeOverrides?: {
    getState?: () => any;
    process?: (event: any) => void;
  },
) {
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  const broadcaster = {
    broadcast: vi.fn(),
    broadcastToParticipants: vi.fn(),
    sendTo: vi.fn(),
  } as unknown as ConsumerBroadcaster;
  const emitEvent = vi.fn();

  const protocol = new CapabilitiesPolicy(config, noopLogger, (session: any) => ({
    ...createMockRuntime(session, broadcaster, emitEvent),
    ...(runtimeOverrides ?? {}),
  }));

  return { protocol, config, broadcaster, emitEvent };
}

function createMockBackendSession() {
  return {
    sessionId: "sess-1",
    send: vi.fn(),
    initialize: vi.fn(),
    messages: {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true, value: undefined }),
      }),
    },
    close: vi.fn(),
  };
}

/** Session pre-wired with a backendSession — needed for tests that call sendInitializeRequest. */
function createSessionWithBackend() {
  const session = createMockSession();
  session.backendSession = createMockBackendSession() as any;
  return session;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("CapabilitiesPolicy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── sendInitializeRequest ─────────────────────────────────────────────

  describe("sendInitializeRequest", () => {
    it("sends a control_request with subtype initialize", () => {
      const { protocol } = createDeps();
      const session = createMockSession();
      const backendSession = createMockBackendSession();
      session.backendSession = backendSession as any;

      protocol.sendInitializeRequest(session);

      expect(backendSession.initialize).toHaveBeenCalledOnce();
      const requestId = backendSession.initialize.mock.calls[0][0];
      expect(requestId).toBeTypeOf("string");
      expect(session.pendingInitialize!.requestId).toBe(requestId);
    });

    it("sets pendingInitialize on the session", () => {
      const { protocol } = createDeps();
      const session = createSessionWithBackend();

      protocol.sendInitializeRequest(session);

      expect(session.pendingInitialize).not.toBeNull();
      expect(session.pendingInitialize!.requestId).toBeTypeOf("string");
      expect(session.pendingInitialize!.timer).toBeDefined();
    });

    it("deduplicates if already pending", () => {
      const { protocol } = createDeps();
      const session = createMockSession();
      const backendSession = createMockBackendSession();
      session.backendSession = backendSession as any;

      protocol.sendInitializeRequest(session);
      protocol.sendInitializeRequest(session);

      expect(backendSession.initialize).toHaveBeenCalledOnce();
    });

    it("emits capabilities:timeout after initializeTimeoutMs", () => {
      vi.useFakeTimers();
      const { protocol, emitEvent } = createDeps({ initializeTimeoutMs: 3000 });
      const session = createSessionWithBackend();

      protocol.sendInitializeRequest(session);

      vi.advanceTimersByTime(3001);

      expect(emitEvent).toHaveBeenCalledWith("capabilities:timeout", {
        sessionId: session.id,
      });
      expect(session.pendingInitialize).toBeNull();
    });

    it("does not emit timeout if request was already handled", () => {
      vi.useFakeTimers();
      const { protocol, emitEvent } = createDeps({ initializeTimeoutMs: 3000 });
      const session = createSessionWithBackend();

      protocol.sendInitializeRequest(session);
      const requestId = session.pendingInitialize!.requestId;

      // Simulate successful response clearing pendingInitialize
      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: requestId,
          response: { commands: [], models: [] },
        },
      });
      protocol.handleControlResponse(session, msg);

      vi.advanceTimersByTime(5000);

      expect(emitEvent).not.toHaveBeenCalledWith("capabilities:timeout", expect.anything());
    });
  });

  // ── cancelPendingInitialize ───────────────────────────────────────────

  describe("cancelPendingInitialize", () => {
    it("clears the pending timer and nulls pendingInitialize", () => {
      vi.useFakeTimers();
      const { protocol, emitEvent } = createDeps({ initializeTimeoutMs: 3000 });
      const session = createSessionWithBackend();

      protocol.sendInitializeRequest(session);
      expect(session.pendingInitialize).not.toBeNull();

      protocol.cancelPendingInitialize(session);

      expect(session.pendingInitialize).toBeNull();

      // Timer should not fire
      vi.advanceTimersByTime(5000);
      expect(emitEvent).not.toHaveBeenCalled();
    });

    it("is a no-op if no pending initialize", () => {
      const { protocol } = createDeps();
      const session = createMockSession();

      expect(() => protocol.cancelPendingInitialize(session)).not.toThrow();
      expect(session.pendingInitialize).toBeNull();
    });
  });

  // ── handleControlResponse ─────────────────────────────────────────────

  describe("handleControlResponse", () => {
    it("applies capabilities on successful response", () => {
      const { protocol, broadcaster, emitEvent } = createDeps();
      const session = createSessionWithBackend();

      protocol.sendInitializeRequest(session);
      const requestId = session.pendingInitialize!.requestId;

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: requestId,
          response: {
            commands: [{ name: "/help", description: "Show help" }],
            models: [{ value: "claude-sonnet-4-5-20250929", displayName: "Sonnet 4.5" }],
            account: { email: "user@test.com" },
          },
        },
      });

      protocol.handleControlResponse(session, msg);

      // Capabilities stored
      expect(session.data.state.capabilities).toBeDefined();
      expect(session.data.state.capabilities!.commands).toHaveLength(1);
      expect(session.data.state.capabilities!.models).toHaveLength(1);
      expect(session.data.state.capabilities!.account).toEqual({ email: "user@test.com" });

      // Broadcast sent
      expect(broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({
          type: "capabilities_ready",
          commands: [{ name: "/help", description: "Show help" }],
          models: [{ value: "claude-sonnet-4-5-20250929", displayName: "Sonnet 4.5" }],
          account: { email: "user@test.com" },
        }),
      );

      // Event emitted
      expect(emitEvent).toHaveBeenCalledWith(
        "capabilities:ready",
        expect.objectContaining({
          sessionId: session.id,
          commands: expect.arrayContaining([expect.objectContaining({ name: "/help" })]),
        }),
      );

      // Pending cleared
      expect(session.pendingInitialize).toBeNull();
    });

    it("registers commands in the slash command registry", () => {
      const { protocol } = createDeps();
      const session = createSessionWithBackend();

      protocol.sendInitializeRequest(session);
      const requestId = session.pendingInitialize!.requestId;

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: requestId,
          response: {
            commands: [
              { name: "/help", description: "Show help" },
              { name: "/compact", description: "Compact context" },
            ],
            models: [],
          },
        },
      });

      protocol.handleControlResponse(session, msg);

      expect(session.registry.registerFromCLI).toHaveBeenCalledWith([
        { name: "/help", description: "Show help" },
        { name: "/compact", description: "Compact context" },
      ]);
    });

    it("does not register commands when commands array is empty", () => {
      const { protocol } = createDeps();
      const session = createSessionWithBackend();

      protocol.sendInitializeRequest(session);
      const requestId = session.pendingInitialize!.requestId;

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: requestId,
          response: { commands: [], models: [] },
        },
      });

      protocol.handleControlResponse(session, msg);

      expect(session.registry.registerFromCLI).not.toHaveBeenCalled();
    });

    it("ignores response with unknown request_id", () => {
      const { protocol, broadcaster, emitEvent } = createDeps();
      const session = createMockSession();

      protocol.sendInitializeRequest(session);

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: "unknown-id",
          response: { commands: [], models: [] },
        },
      });

      protocol.handleControlResponse(session, msg);

      expect(session.data.state.capabilities).toBeUndefined();
      expect(broadcaster.broadcast).not.toHaveBeenCalled();
      expect(emitEvent).not.toHaveBeenCalledWith("capabilities:ready", expect.anything());
    });

    it("ignores response when no pending initialize", () => {
      const { protocol, broadcaster } = createDeps();
      const session = createMockSession();

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: "some-id",
          response: { commands: [], models: [] },
        },
      });

      protocol.handleControlResponse(session, msg);

      expect(broadcaster.broadcast).not.toHaveBeenCalled();
    });

    it("handles error response without capabilities", () => {
      const { protocol } = createDeps();
      const session = createSessionWithBackend();

      protocol.sendInitializeRequest(session);
      const requestId = session.pendingInitialize!.requestId;

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "error",
          request_id: requestId,
          error: "Not supported",
        },
      });

      protocol.handleControlResponse(session, msg);

      // No capabilities set (no slash_commands to synthesize from)
      expect(session.data.state.capabilities).toBeUndefined();
      expect(session.pendingInitialize).toBeNull();
    });

    it("synthesizes capabilities from slash_commands on error fallback", () => {
      const { protocol, broadcaster, emitEvent } = createDeps();
      const session = createSessionWithBackend();
      session.data.state.slash_commands = ["/help", "/compact"];

      protocol.sendInitializeRequest(session);
      const requestId = session.pendingInitialize!.requestId;

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "error",
          request_id: requestId,
          error: "Already initialized",
        },
      });

      protocol.handleControlResponse(session, msg);

      // Capabilities synthesized from slash_commands
      expect(session.data.state.capabilities).toBeDefined();
      expect(session.data.state.capabilities!.commands).toEqual([
        { name: "/help", description: "" },
        { name: "/compact", description: "" },
      ]);
      expect(session.data.state.capabilities!.models).toEqual([]);
      expect(session.data.state.capabilities!.account).toBeNull();

      // Broadcast and emit still fire
      expect(broadcaster.broadcast).toHaveBeenCalled();
      expect(emitEvent).toHaveBeenCalledWith("capabilities:ready", expect.anything());
    });

    it("golden: Already initialized synthesizes capabilities from slash_commands", () => {
      const { protocol } = createDeps();
      const session = createSessionWithBackend();
      session.data.state.slash_commands = ["/help", "/compact"];

      protocol.sendInitializeRequest(session);
      const requestId = session.pendingInitialize!.requestId;

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "error",
          request_id: requestId,
          error: "Already initialized",
        },
      });

      protocol.handleControlResponse(session, msg);

      const golden = {
        error: msg.metadata.error,
        commands: session.data.state.capabilities?.commands ?? [],
        models: session.data.state.capabilities?.models ?? [],
        account: session.data.state.capabilities?.account ?? null,
      };
      expect(golden).toMatchInlineSnapshot(`
        {
          "account": null,
          "commands": [
            {
              "description": "",
              "name": "/help",
            },
            {
              "description": "",
              "name": "/compact",
            },
          ],
          "error": "Already initialized",
          "models": [],
        }
      `);
    });

    it("does not synthesize on error if capabilities already exist", () => {
      const { protocol, broadcaster } = createDeps();
      const session = createSessionWithBackend();
      session.data.state.slash_commands = ["/help"];
      session.data.state.capabilities = {
        commands: [{ name: "/existing", description: "Existing" }],
        models: [],
        account: null,
        receivedAt: Date.now(),
      };

      protocol.sendInitializeRequest(session);
      const requestId = session.pendingInitialize!.requestId;

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "error",
          request_id: requestId,
          error: "Already initialized",
        },
      });

      protocol.handleControlResponse(session, msg);

      // Original capabilities remain unchanged
      expect(session.data.state.capabilities!.commands).toEqual([
        { name: "/existing", description: "Existing" },
      ]);
      expect(broadcaster.broadcast).not.toHaveBeenCalled();
    });

    it("handles response with missing response body gracefully", () => {
      const { protocol, broadcaster } = createDeps();
      const session = createSessionWithBackend();

      protocol.sendInitializeRequest(session);
      const requestId = session.pendingInitialize!.requestId;

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: requestId,
          // no response field
        },
      });

      protocol.handleControlResponse(session, msg);

      expect(session.data.state.capabilities).toBeUndefined();
      expect(broadcaster.broadcast).not.toHaveBeenCalled();
      expect(session.pendingInitialize).toBeNull();
    });

    it("handles partial capabilities (only commands)", () => {
      const { protocol } = createDeps();
      const session = createSessionWithBackend();

      protocol.sendInitializeRequest(session);
      const requestId = session.pendingInitialize!.requestId;

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: requestId,
          response: {
            commands: [{ name: "/help", description: "Help" }],
            // no models or account
          },
        },
      });

      protocol.handleControlResponse(session, msg);

      expect(session.data.state.capabilities!.commands).toHaveLength(1);
      expect(session.data.state.capabilities!.models).toEqual([]);
      expect(session.data.state.capabilities!.account).toBeNull();
    });
  });

  // ── applyCapabilities ─────────────────────────────────────────────────

  describe("applyCapabilities", () => {
    it("stores capabilities with receivedAt timestamp", () => {
      const { protocol } = createDeps();
      const session = createMockSession();
      const before = Date.now();

      protocol.applyCapabilities(session, [{ name: "/test", description: "Test" }], [], null);

      expect(session.data.state.capabilities!.receivedAt).toBeGreaterThanOrEqual(before);
      expect(session.data.state.capabilities!.receivedAt).toBeLessThanOrEqual(Date.now());
    });

    it("includes skills from session state in broadcast", () => {
      const { protocol, broadcaster } = createDeps();
      const session = createMockSession();
      session.data.state.skills = ["commit", "review-pr"];

      protocol.applyCapabilities(session, [], [], null);

      expect(broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({
          type: "capabilities_ready",
          skills: ["commit", "review-pr"],
        }),
      );
    });

    it("uses callback-backed state accessors when provided", () => {
      const session = createMockSession();
      let state = { ...session.data.state, skills: ["commit"] };
      const { protocol, broadcaster, emitEvent } = createDeps(undefined, {
        getState: () => state,
        process: (event: any) => {
          if (event.type !== "SYSTEM_SIGNAL") return;
          const signal = event.signal;
          if (signal.kind === "CAPABILITIES_APPLIED") {
            state = {
              ...state,
              capabilities: {
                commands: signal.commands,
                models: signal.models,
                account: signal.account,
                receivedAt: Date.now(),
              },
            };
            broadcaster.broadcast(session, {
              type: "capabilities_ready",
              commands: signal.commands,
              models: signal.models,
              account: signal.account,
              skills: state.skills,
            });
            emitEvent("capabilities:ready", {
              sessionId: session.id,
              commands: signal.commands,
              models: signal.models,
              account: signal.account,
            });
          }
        },
      });

      protocol.applyCapabilities(session, [{ name: "/help", description: "Help" }], [], null);

      expect(state.capabilities).toBeDefined();
      expect(state.capabilities!.commands).toEqual([{ name: "/help", description: "Help" }]);
      expect(session.data.state.capabilities).toBeUndefined();
      expect(broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ skills: ["commit"] }),
      );
    });
  });
});
