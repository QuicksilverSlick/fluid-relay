/**
 * Team State Integration Tests
 *
 * Tests that the state reducer correctly wires pureAddToolUse/pureConsumeToolResult
 * and reduceTeamState into the existing state reduction pipeline.
 */

import { describe, expect, it } from "vitest";
import { reduce } from "../../core/session/session-state-reducer.js";
import type { PendingToolUse } from "../../core/team/team-tool-correlation.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import {
  makeDefaultSessionState,
  makeToolResultMessage,
  makeToolUseMessage,
} from "../../testing/fixtures.js";
import type { SessionState } from "../../types/session-state.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("state-reducer team integration", () => {
  describe("tool_use buffering", () => {
    it("buffers TeamCreate tool_use AND applies optimistically", () => {
      const state = makeDefaultSessionState();
      const [next, map] = reduce(
        state,
        makeToolUseMessage("TeamCreate", "tu-1", { team_name: "my-team" }),
      );
      // Optimistic: team state applied immediately on tool_use
      expect(next.team).toBeDefined();
      expect(next.team!.name).toBe("my-team");
      // Still buffered for potential tool_result correlation
      expect(map.size).toBe(1);
    });
  });

  describe("TeamCreate lifecycle", () => {
    it("applies TeamCreate when tool_result correlates with buffered tool_use", () => {
      const state = makeDefaultSessionState();
      const [s1, map1] = reduce(
        state,
        makeToolUseMessage("TeamCreate", "tu-1", { team_name: "my-team" }),
      );
      const [s2] = reduce(s1, makeToolResultMessage("tu-1", '{"success": true}'), map1);

      expect(s2.team).toBeDefined();
      expect(s2.team!.name).toBe("my-team");
      expect(s2.team!.role).toBe("lead");
      expect(s2.team!.members).toEqual([]);
      expect(s2.team!.tasks).toEqual([]);
    });
  });

  describe("Task spawn (member add)", () => {
    it("adds member via Task(team_name) tool_use + result", () => {
      const state: SessionState = {
        ...makeDefaultSessionState(),
        team: { name: "my-team", role: "lead", members: [], tasks: [] },
      };

      const [s1, map1] = reduce(
        state,
        makeToolUseMessage("Task", "tu-2", {
          team_name: "my-team",
          name: "worker-1",
          model: "claude-sonnet-4-5-20250929",
        }),
      );
      const [s2] = reduce(s1, makeToolResultMessage("tu-2", '{"success": true}'), map1);

      expect(s2.team!.members).toHaveLength(1);
      expect(s2.team!.members[0]!.name).toBe("worker-1");
      expect(s2.team!.members[0]!.status).toBe("active");
    });
  });

  describe("TeamDelete", () => {
    it("removes team state", () => {
      const state: SessionState = {
        ...makeDefaultSessionState(),
        team: {
          name: "my-team",
          role: "lead",
          members: [
            { name: "worker-1", agentId: "w1", agentType: "general-purpose", status: "active" },
          ],
          tasks: [],
        },
      };

      const [s1, map1] = reduce(state, makeToolUseMessage("TeamDelete", "tu-del", {}));
      const [s2] = reduce(s1, makeToolResultMessage("tu-del", '{"success": true}'), map1);

      expect(s2.team).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("optimistic task persists even when error tool_result arrives later", () => {
      const state: SessionState = {
        ...makeDefaultSessionState(),
        team: { name: "my-team", role: "lead", members: [], tasks: [] },
      };

      const [s1, map1] = reduce(
        state,
        makeToolUseMessage("TaskCreate", "tu-err", { subject: "Fix bug" }),
      );
      // Optimistic: task created with synthetic ID
      expect(s1.team!.tasks).toHaveLength(1);
      expect(s1.team!.tasks[0]!.subject).toBe("Fix bug");

      const [s2] = reduce(s1, makeToolResultMessage("tu-err", "Something went wrong", true), map1);

      // Error result skips state mutation — optimistic task remains
      expect(s2.team!.tasks).toHaveLength(1);
      expect(s2.team!.tasks[0]!.subject).toBe("Fix bug");
    });
  });

  describe("non-team tools", () => {
    it("does not affect state for regular tool_use blocks", () => {
      const state = makeDefaultSessionState();
      const [next, map] = reduce(
        state,
        makeToolUseMessage("Read", "tu-read", { file_path: "/tmp/test.ts" }),
      );

      expect(next.team).toBeUndefined();
      expect(map.size).toBe(0);
    });
  });

  describe("full lifecycle", () => {
    it("create → member → task → complete → delete (tool_use only, CLI flow)", () => {
      let state = makeDefaultSessionState();
      let map: ReadonlyMap<string, PendingToolUse> = new Map();

      // TeamCreate — optimistic
      [state, map] = reduce(
        state,
        makeToolUseMessage("TeamCreate", "tu-1", { team_name: "my-team" }),
        map,
      );
      expect(state.team?.name).toBe("my-team");

      // Add member — optimistic
      [state, map] = reduce(
        state,
        makeToolUseMessage("Task", "tu-2", { team_name: "my-team", name: "dev-1" }),
        map,
      );
      expect(state.team?.members).toHaveLength(1);
      expect(state.team!.members[0]!.name).toBe("dev-1");

      // Create task — optimistic with synthetic ID
      [state, map] = reduce(
        state,
        makeToolUseMessage("TaskCreate", "tu-3", { subject: "Fix bug" }),
        map,
      );
      expect(state.team?.tasks).toHaveLength(1);
      expect(state.team!.tasks[0]!.subject).toBe("Fix bug");
      const syntheticTaskId = state.team!.tasks[0]!.id;

      // Complete task via synthetic ID
      [state, map] = reduce(
        state,
        makeToolUseMessage("TaskUpdate", "tu-4", { taskId: syntheticTaskId, status: "completed" }),
        map,
      );
      expect(state.team!.tasks[0]!.status).toBe("completed");

      // Delete team — optimistic
      [state, map] = reduce(state, makeToolUseMessage("TeamDelete", "tu-5", {}), map);
      expect(state.team).toBeUndefined();
    });

    it("dual-path: tool_use + tool_result — synthetic replaced by real ID", () => {
      let state = makeDefaultSessionState();
      let map: ReadonlyMap<string, PendingToolUse> = new Map();

      // TeamCreate — optimistic + correlation (idempotent)
      [state, map] = reduce(
        state,
        makeToolUseMessage("TeamCreate", "tu-1", { team_name: "my-team" }),
        map,
      );
      [state, map] = reduce(state, makeToolResultMessage("tu-1", "{}"), map);
      expect(state.team?.name).toBe("my-team");

      // Add member — optimistic + correlation (idempotent)
      [state, map] = reduce(
        state,
        makeToolUseMessage("Task", "tu-2", { team_name: "my-team", name: "dev-1" }),
        map,
      );
      [state, map] = reduce(state, makeToolResultMessage("tu-2", "{}"), map);
      expect(state.team?.members).toHaveLength(1);

      // TaskCreate — synthetic entry created optimistically, then replaced by real ID
      [state, map] = reduce(
        state,
        makeToolUseMessage("TaskCreate", "tu-3", { subject: "Fix bug" }),
        map,
      );
      expect(state.team?.tasks).toHaveLength(1);
      expect(state.team!.tasks[0]!.id).toBe("tu-tu-3"); // synthetic

      [state, map] = reduce(state, makeToolResultMessage("tu-3", '{"id": "1"}'), map);
      // Synthetic replaced by real — still 1 entry
      expect(state.team?.tasks).toHaveLength(1);
      expect(state.team!.tasks[0]!.id).toBe("1");
      expect(state.team!.tasks[0]!.subject).toBe("Fix bug");
    });
  });

  describe("optimistic: CLI flow without tool_result", () => {
    it("creates team, adds members, and creates tasks with only tool_use messages", () => {
      let state = makeDefaultSessionState();
      let map: ReadonlyMap<string, PendingToolUse> = new Map();

      // TeamCreate — tool_use only, no tool_result
      [state, map] = reduce(
        state,
        makeToolUseMessage("TeamCreate", "tu-10", { team_name: "cli-team" }),
        map,
      );
      expect(state.team).toBeDefined();
      expect(state.team!.name).toBe("cli-team");

      // Task spawn — tool_use only, no tool_result
      [state, map] = reduce(
        state,
        makeToolUseMessage("Task", "tu-11", { team_name: "cli-team", name: "researcher" }),
        map,
      );
      expect(state.team!.members).toHaveLength(1);
      expect(state.team!.members[0]!.name).toBe("researcher");

      // Second member
      [state, map] = reduce(
        state,
        makeToolUseMessage("Task", "tu-12", { team_name: "cli-team", name: "implementer" }),
        map,
      );
      expect(state.team!.members).toHaveLength(2);
      expect(state.team!.members.map((m) => m.name)).toEqual(["researcher", "implementer"]);

      // TaskCreate — uses synthetic ID since no tool_result
      [state, map] = reduce(
        state,
        makeToolUseMessage("TaskCreate", "tc-aabbccdd-1234", {
          subject: "Research API",
          description: "Look into REST APIs",
        }),
        map,
      );
      expect(state.team!.tasks).toHaveLength(1);
      expect(state.team!.tasks[0]!.subject).toBe("Research API");
      expect(state.team!.tasks[0]!.id).toBe("tu-tc-aabbccdd-1234");
    });

    it("idempotency: duplicate tool_use does not double-apply", () => {
      let state = makeDefaultSessionState();
      let map: ReadonlyMap<string, PendingToolUse> = new Map();

      const teamCreateMsg = makeToolUseMessage("TeamCreate", "tu-dup", { team_name: "dup-team" });

      [state, map] = reduce(state, teamCreateMsg, map);
      expect(state.team!.name).toBe("dup-team");

      // Apply same message again — idempotent, no change
      const stateRef = state;
      [state, map] = reduce(state, teamCreateMsg, map);
      expect(state.team).toBe(stateRef.team);
    });

    it("optimistic + late correlation: both paths coexist", () => {
      let state = makeDefaultSessionState();
      let map: ReadonlyMap<string, PendingToolUse> = new Map();

      // TeamCreate tool_use → optimistic applies immediately
      [state, map] = reduce(
        state,
        makeToolUseMessage("TeamCreate", "tu-both", { team_name: "both-team" }),
        map,
      );
      expect(state.team!.name).toBe("both-team");

      // Late tool_result arrives — correlation fires but idempotent (team already exists)
      const stateBeforeResult = state;
      [state, map] = reduce(state, makeToolResultMessage("tu-both", "{}"), map);
      expect(state.team!.name).toBe("both-team");
      expect(state.team).toBe(stateBeforeResult.team);
    });
  });

  describe("existing reducers unchanged", () => {
    it("session_init still works with team state", () => {
      const state: SessionState = {
        ...makeDefaultSessionState(),
        team: {
          name: "my-team",
          role: "lead",
          members: [
            { name: "w1", agentId: "w1@t", agentType: "general-purpose", status: "active" },
          ],
          tasks: [],
        },
      };

      const msg = createUnifiedMessage({
        type: "session_init",
        role: "system",
        metadata: { model: "claude-opus-4-6" },
      });

      const [next] = reduce(state, msg);
      expect(next.model).toBe("claude-opus-4-6");
      // team state is preserved
      expect(next.team?.name).toBe("my-team");
    });
  });
});
