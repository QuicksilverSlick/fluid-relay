import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../interfaces/logger.js";
import type { PolicyCommand } from "../interfaces/runtime-commands.js";
import type { Session, SessionRepository } from "../session-repository.js";
import { RuntimeApi } from "./runtime-api.js";
import type { RuntimeManager } from "./runtime-manager.js";

function stubSession(id: string): Session {
  return { id } as Session;
}

function createRuntimeStub() {
  return {
    sendUserMessage: vi.fn(),
    sendPermissionResponse: vi.fn(),
    sendInterrupt: vi.fn(),
    sendSetModel: vi.fn(),
    sendSetPermissionMode: vi.fn(),
    getSupportedModels: vi.fn().mockReturnValue([{ id: "m1", display_name: "Model 1" }]),
    getSupportedCommands: vi.fn().mockReturnValue([{ name: "/help", description: "help" }]),
    getAccountInfo: vi.fn().mockReturnValue({ plan_type: "pro" }),
    executeSlashCommand: vi.fn().mockResolvedValue({ content: "ok", source: "emulated" }),
    handlePolicyCommand: vi.fn(),
    sendToBackend: vi.fn(),
  };
}

function createApi() {
  const sessions = new Map<string, Session>();
  const store = {
    get: vi.fn((sessionId: string) => sessions.get(sessionId)),
  } as unknown as SessionRepository;

  const runtime = createRuntimeStub();
  const runtimeManager = {
    getOrCreate: vi.fn().mockReturnValue(runtime),
  } as unknown as RuntimeManager;

  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const api = new RuntimeApi({ store, runtimeManager, logger });
  return { api, sessions, runtime, runtimeManager, logger };
}

describe("RuntimeApi", () => {
  it("delegates sendUserMessage when session exists", () => {
    const { api, sessions, runtime, runtimeManager } = createApi();
    const session = stubSession("s1");
    sessions.set("s1", session);

    api.sendUserMessage("s1", "hello");

    expect(runtimeManager.getOrCreate).toHaveBeenCalledWith(session);
    expect(runtime.sendUserMessage).toHaveBeenCalledWith("hello", undefined);
  });

  it("sendUserMessage is a no-op when session does not exist", () => {
    const { api, runtime, runtimeManager } = createApi();
    api.sendUserMessage("missing", "hello");
    expect(runtimeManager.getOrCreate).not.toHaveBeenCalled();
    expect(runtime.sendUserMessage).not.toHaveBeenCalled();
  });

  it("returns empty command/model defaults when session does not exist", () => {
    const { api } = createApi();
    expect(api.getSupportedModels("missing")).toEqual([]);
    expect(api.getSupportedCommands("missing")).toEqual([]);
    expect(api.getAccountInfo("missing")).toBeNull();
  });

  it("delegates command/model/account getters when session exists", () => {
    const { api, sessions, runtime } = createApi();
    sessions.set("s1", stubSession("s1"));

    expect(api.getSupportedModels("s1")).toEqual([{ id: "m1", display_name: "Model 1" }]);
    expect(api.getSupportedCommands("s1")).toEqual([{ name: "/help", description: "help" }]);
    expect(api.getAccountInfo("s1")).toEqual({ plan_type: "pro" });
    expect(runtime.getSupportedModels).toHaveBeenCalled();
    expect(runtime.getSupportedCommands).toHaveBeenCalled();
    expect(runtime.getAccountInfo).toHaveBeenCalled();
  });

  it("delegates executeSlashCommand and returns null for missing session", async () => {
    const { api, sessions, runtime } = createApi();
    sessions.set("s1", stubSession("s1"));

    await expect(api.executeSlashCommand("s1", "/help")).resolves.toEqual({
      content: "ok",
      source: "emulated",
    });
    await expect(api.executeSlashCommand("missing", "/help")).resolves.toBeNull();
    expect(runtime.executeSlashCommand).toHaveBeenCalledWith("/help");
  });

  it("delegates applyPolicyCommand when session exists", () => {
    const { api, sessions, runtime } = createApi();
    sessions.set("s1", stubSession("s1"));
    const cmd: PolicyCommand = { type: "capabilities_timeout" };

    api.applyPolicyCommand("s1", cmd);
    api.applyPolicyCommand("missing", cmd);

    expect(runtime.handlePolicyCommand).toHaveBeenCalledTimes(1);
    expect(runtime.handlePolicyCommand).toHaveBeenCalledWith(cmd);
  });

  it("warns and skips sendToBackend for missing session", () => {
    const { api, logger, runtime } = createApi();
    const msg = { type: "interrupt", metadata: {} } as any;

    api.sendToBackend("missing", msg);

    expect(logger.warn).toHaveBeenCalledWith("No backend session for missing, cannot send message");
    expect(runtime.sendToBackend).not.toHaveBeenCalled();
  });

  it("delegates sendToBackend for existing session", () => {
    const { api, sessions, runtime } = createApi();
    const session = stubSession("s1");
    sessions.set("s1", session);
    const msg = { type: "interrupt", metadata: {} } as any;

    api.sendToBackend("s1", msg);
    expect(runtime.sendToBackend).toHaveBeenCalledWith(msg);
  });

  it("delegates interrupt/model/mode/permission response when session exists", () => {
    const { api, sessions, runtime } = createApi();
    sessions.set("s1", stubSession("s1"));

    api.sendInterrupt("s1");
    api.sendSetModel("s1", "claude-sonnet");
    api.sendSetPermissionMode("s1", "plan");
    api.sendPermissionResponse("s1", "req-1", "allow", { message: "ok" });

    expect(runtime.sendInterrupt).toHaveBeenCalled();
    expect(runtime.sendSetModel).toHaveBeenCalledWith("claude-sonnet");
    expect(runtime.sendSetPermissionMode).toHaveBeenCalledWith("plan");
    expect(runtime.sendPermissionResponse).toHaveBeenCalledWith("req-1", "allow", {
      message: "ok",
    });
  });
});
