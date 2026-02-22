import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import type { MemoryStorage } from "../adapters/memory-storage.js";
import { createBridgeWithAdapter } from "../testing/adapter-test-helpers.js";
import type { SessionBridge } from "./session-bridge.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge", () => {
  let bridge: SessionBridge;
  let storage: MemoryStorage;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    storage = created.storage;
  });
  describe("Persistence", () => {
    it("restoreFromStorage loads persisted sessions", () => {
      // Persist a session manually into storage
      storage.save({
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

      const count = bridge.restoreFromStorage();
      expect(count).toBe(1);

      const snapshot = bridge.getSession("restored-sess");
      expect(snapshot).toBeDefined();
      expect(snapshot!.state.model).toBe("claude-sonnet-4-5-20250929");
      expect(snapshot!.state.cwd).toBe("/restored");
      expect(snapshot!.messageHistoryLength).toBe(1);
    });
  });
});
