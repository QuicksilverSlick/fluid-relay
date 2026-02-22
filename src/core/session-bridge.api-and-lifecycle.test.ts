import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import {
  createBridgeWithAdapter,
  type MockBackendSession,
} from "../testing/adapter-test-helpers.js";
import {
  authContext,
  createTestSocket as createMockSocket,
} from "../testing/cli-message-factories.js";
import type { SessionBridge as SessionBridgeType } from "./session-bridge.js";
import { SessionBridge } from "./session-bridge.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge — Programmatic API", () => {
  let bridge: SessionBridgeType;
  let backendSession: MockBackendSession;

  beforeEach(async () => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;

    // Connect backend (adapter path)
    await bridge.connectBackend("sess-1");
    backendSession = created.adapter.getSession("sess-1")!;
  });

  it("sendUserMessage sends unified user_message to backend", async () => {
    bridge.sendUserMessage("sess-1", "Hello world");

    expect(backendSession.sentMessages).toHaveLength(1);
    const msg = backendSession.sentMessages[0];
    expect(msg.type).toBe("user_message");
    expect(msg.role).toBe("user");
    const textBlock = msg.content.find((b) => b.type === "text");
    expect(textBlock).toBeDefined();
    expect(textBlock!.type === "text" && textBlock!.text).toBe("Hello world");
  });

  it("restoreFromStorage rehydrates persisted session snapshots", () => {
    const created = createBridgeWithAdapter();
    const localBridge = created.bridge;
    const localStorage = created.storage;

    localStorage.save({
      id: "restored-sess",
      state: {
        session_id: "restored-sess",
        model: "claude-sonnet-4-5-20250929",
        cwd: "/restored",
        tools: ["Bash"],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0.5,
        num_turns: 10,
        context_used_percent: 25,
        is_compacting: false,
        git_branch: "main",
        is_worktree: false,
        repo_root: "/repo",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 100,
        total_lines_removed: 50,
      },
      messageHistory: [{ type: "user_message", content: "hi", timestamp: 12345 }],
      pendingMessages: [],
      pendingPermissions: [],
    });

    expect(localBridge.restoreFromStorage()).toBe(1);
    const snapshot = localBridge.getSession("restored-sess");
    expect(snapshot).toBeDefined();
    expect(snapshot!.state.model).toBe("claude-sonnet-4-5-20250929");
    expect(snapshot!.state.cwd).toBe("/restored");
    expect(snapshot!.messageHistoryLength).toBe(1);
  });

  it("seedSessionState applies seeded and git-resolved fields to consumer session_init", () => {
    const mockGitResolver = {
      resolve: vi.fn().mockReturnValue({
        branch: "develop",
        isWorktree: false,
        repoRoot: "/project",
        ahead: 0,
        behind: 0,
      }),
    };
    const seededBridge = new SessionBridge({
      gitResolver: mockGitResolver,
      config: { port: 3456 },
    });

    seededBridge.seedSessionState("seed-1", { cwd: "/project", model: "opus" });

    const ws = createMockSocket();
    seededBridge.handleConsumerOpen(ws, authContext("seed-1"));

    const parsed = ws.sentMessages.map((m: string) => JSON.parse(m));
    const initMsg = parsed.find((m: any) => m.type === "session_init");
    expect(initMsg).toBeDefined();
    expect(initMsg.session.cwd).toBe("/project");
    expect(initMsg.session.model).toBe("opus");
    expect(initMsg.session.git_branch).toBe("develop");
    expect(mockGitResolver.resolve).toHaveBeenCalledWith("/project");
  });
});
