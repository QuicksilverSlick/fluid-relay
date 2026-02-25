import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockSession } from "../../testing/cli-message-factories.js";
import {
  createBackendNoInit,
  createBackendWithInit,
  makeRuntimeDeps,
} from "../../testing/session-runtime-test-helpers.js";
import { createUnifiedMessage } from "../types/unified-message.js";
import { SessionRuntime } from "./session-runtime.js";

describe("SessionRuntime capabilities and init flow", () => {
  describe("CAPABILITIES_INIT_REQUESTED", () => {
    it("warns and skips when no backend session is attached", () => {
      const deps = makeRuntimeDeps();
      const runtime = new SessionRuntime(createMockSession({ id: "s1" }), deps);

      runtime.process({
        type: "SYSTEM_SIGNAL",
        signal: { kind: "CAPABILITIES_INIT_REQUESTED" },
      });

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("no backend session attached"),
      );
      expect(runtime.getPendingInitialize()).toBeNull();
    });

    it("logs info and skips when adapter does not support initialize", () => {
      const deps = makeRuntimeDeps();
      const runtime = new SessionRuntime(
        createMockSession({ id: "s1", backendSession: createBackendNoInit() as any }),
        deps,
      );

      runtime.process({
        type: "SYSTEM_SIGNAL",
        signal: { kind: "CAPABILITIES_INIT_REQUESTED" },
      });

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("adapter does not support initialize"),
      );
      expect(runtime.getPendingInitialize()).toBeNull();
    });

    it("deduplicates -- second signal reuses existing pendingInitialize", () => {
      const backendSession = createBackendWithInit();
      const deps = makeRuntimeDeps();
      const runtime = new SessionRuntime(
        createMockSession({ id: "s1", backendSession: backendSession as any }),
        deps,
      );

      runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "CAPABILITIES_INIT_REQUESTED" } });
      const first = runtime.getPendingInitialize();
      expect(first).not.toBeNull();

      runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "CAPABILITIES_INIT_REQUESTED" } });

      expect(runtime.getPendingInitialize()).toBe(first);
      expect(backendSession.initialize).toHaveBeenCalledTimes(1);
    });

    describe("timer behavior", () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it("clears pendingInitialize and emits capabilities:timeout on timeout", () => {
        const deps = makeRuntimeDeps();
        const runtime = new SessionRuntime(
          createMockSession({ id: "s1", backendSession: createBackendWithInit() as any }),
          deps,
        );

        runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "CAPABILITIES_INIT_REQUESTED" } });
        expect(runtime.getPendingInitialize()).not.toBeNull();

        vi.advanceTimersByTime(60);

        expect(runtime.getPendingInitialize()).toBeNull();
        expect(deps.emitEvent).toHaveBeenCalledWith(
          "capabilities:timeout",
          expect.objectContaining({ sessionId: "s1" }),
        );
      });

      it("SESSION_CLOSING clears timer so timeout does not fire", () => {
        const deps = makeRuntimeDeps();
        const runtime = new SessionRuntime(
          createMockSession({ id: "s1", backendSession: createBackendWithInit() as any }),
          deps,
        );

        runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "CAPABILITIES_INIT_REQUESTED" } });
        expect(runtime.getPendingInitialize()).not.toBeNull();

        runtime.process({ type: "SYSTEM_SIGNAL", signal: { kind: "SESSION_CLOSING" } });
        expect(runtime.getPendingInitialize()).toBeNull();

        (deps.emitEvent as ReturnType<typeof vi.fn>).mockClear();
        vi.advanceTimersByTime(100);

        const capTimeoutCalls = (deps.emitEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
          ([eventName]: [string]) => eventName === "capabilities:timeout",
        );
        expect(capTimeoutCalls).toHaveLength(0);
      });
    });
  });

  describe("orchestrateSessionInit", () => {
    function createSessionWithBackend(dataOverrides?: Record<string, unknown>) {
      return createMockSession({
        id: "s1",
        backendSession: createBackendWithInit() as any,
        data: {
          lifecycle: "idle",
          state: {
            ...createMockSession().data.state,
            cwd: "",
            ...dataOverrides,
          },
        },
      });
    }

    function makeSessionInitMessage(metadataOverrides?: Record<string, unknown>) {
      return createUnifiedMessage({
        type: "session_init",
        role: "system",
        content: [],
        metadata: {
          session_id: "b1",
          model: "claude-opus-4-6",
          cwd: "/project",
          tools: [],
          permissionMode: "default",
          claude_code_version: "1.0",
          mcp_servers: [],
          slash_commands: [],
          skills: [],
          ...metadataOverrides,
        },
      });
    }

    it("calls sendInitializeRequest when metadata has no capabilities", () => {
      const deps = makeRuntimeDeps();
      const runtime = new SessionRuntime(createSessionWithBackend(), deps);

      runtime.process({ type: "BACKEND_MESSAGE", message: makeSessionInitMessage() });

      expect(deps.capabilitiesPolicy.sendInitializeRequest).toHaveBeenCalledWith(
        expect.objectContaining({ id: "s1" }),
      );
      expect(deps.capabilitiesPolicy.applyCapabilities).not.toHaveBeenCalled();
    });

    it("calls applyCapabilities when metadata includes capabilities", () => {
      const deps = makeRuntimeDeps();
      const runtime = new SessionRuntime(createSessionWithBackend(), deps);

      const capabilities = {
        commands: [{ name: "/help", description: "Show help" }],
        models: [{ id: "claude-opus-4-6", name: "Opus" }],
        account: { plan: "pro" },
      };

      runtime.process({
        type: "BACKEND_MESSAGE",
        message: makeSessionInitMessage({ capabilities }),
      });

      expect(deps.capabilitiesPolicy.applyCapabilities).toHaveBeenCalledWith(
        expect.objectContaining({ id: "s1" }),
        capabilities.commands,
        capabilities.models,
        capabilities.account,
      );
      expect(deps.capabilitiesPolicy.sendInitializeRequest).not.toHaveBeenCalled();
    });

    it("resolves git info and broadcasts session_update when gitResolver is present", () => {
      const gitResolver = {
        resolve: vi.fn(() => ({
          branch: "main",
          isWorktree: false,
          repoRoot: "/project",
          ahead: 0,
          behind: 0,
        })),
      };
      const deps = makeRuntimeDeps({ gitResolver: gitResolver as any });
      const runtime = new SessionRuntime(createSessionWithBackend({ cwd: "/project" }), deps);

      runtime.process({ type: "BACKEND_MESSAGE", message: makeSessionInitMessage() });

      expect(gitResolver.resolve).toHaveBeenCalledWith("/project");
      expect(deps.broadcaster.broadcast).toHaveBeenCalled();
    });
  });

  describe("CAPABILITIES_APPLIED", () => {
    it("registers commands when commands array is non-empty", () => {
      const session = createMockSession({ id: "s1" });
      const registerFromCLI = vi.fn();
      session.registry = { ...session.registry, registerFromCLI } as any;
      const runtime = new SessionRuntime(session, makeRuntimeDeps());

      const commands = [
        { name: "/help", description: "Show help" },
        { name: "/clear", description: "Clear history" },
      ];
      runtime.process({
        type: "SYSTEM_SIGNAL",
        signal: { kind: "CAPABILITIES_APPLIED", commands, models: [], account: null },
      });

      expect(registerFromCLI).toHaveBeenCalledWith(commands);
    });

    it("does not call registerFromCLI when commands array is empty", () => {
      const session = createMockSession({ id: "s1" });
      const registerFromCLI = vi.fn();
      session.registry = { ...session.registry, registerFromCLI } as any;
      const runtime = new SessionRuntime(session, makeRuntimeDeps());

      runtime.process({
        type: "SYSTEM_SIGNAL",
        signal: { kind: "CAPABILITIES_APPLIED", commands: [], models: [], account: null },
      });

      expect(registerFromCLI).not.toHaveBeenCalled();
    });
  });
});
