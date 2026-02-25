/**
 * Coverage tests for team-state-reducer.ts — targeting lines 262-263.
 *
 * Lines 262-263 are inside the `catch` block of `extractTaskId`, which handles
 * TaskCreate tool_result content that is NOT valid JSON.  Two branches exist:
 *
 *   1. Non-JSON content that IS a plain numeric string (e.g. "42") → returns it.
 *   2. Non-JSON content that is NOT a plain numeric string (e.g. "abc") → falls
 *      through and returns undefined (task creation skipped).
 */

import { describe, expect, it } from "vitest";
import type { TeamState } from "../types/team-types.js";
import { reduceTeamState } from "./team-state-reducer.js";
import type { CorrelatedToolUse } from "./team-tool-correlation.js";
import type { RecognizedTeamToolUse } from "./team-tool-recognizer.js";

// ---------------------------------------------------------------------------
// Helpers (mirrors pattern from team-state-reducer.test.ts)
// ---------------------------------------------------------------------------

function makeCorrelated(overrides: {
  toolName: string;
  toolUseId?: string;
  category?: RecognizedTeamToolUse["category"];
  input?: Record<string, unknown>;
  result?: { content: string; is_error?: boolean };
}): CorrelatedToolUse {
  return {
    recognized: {
      toolName: overrides.toolName,
      toolUseId: overrides.toolUseId ?? "tu-coverage-1",
      category: overrides.category ?? "team_state_change",
      input: overrides.input ?? {},
    },
    result: overrides.result
      ? {
          type: "tool_result",
          tool_use_id: overrides.toolUseId ?? "tu-coverage-1",
          content: overrides.result.content,
          is_error: overrides.result.is_error,
        }
      : undefined,
  };
}

function makeTeamState(overrides?: Partial<TeamState>): TeamState {
  return {
    name: "my-team",
    role: "lead",
    members: [],
    tasks: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractTaskId — non-JSON catch block (lines 262-263)
// ---------------------------------------------------------------------------

describe("extractTaskId — non-JSON result content", () => {
  it("creates task when result content is a leading-zero numeric string (catch branch, regex true)", () => {
    // JSON.parse("07") throws (leading zeros are invalid JSON integers).
    // After trimming, "07" matches /^\d+$/ — so the TRUE branch of line 263 fires.
    // This hits line 262 (trimmed assignment) and the TRUE branch of line 263.
    const state = makeTeamState();
    const correlated = makeCorrelated({
      toolName: "TaskCreate",
      toolUseId: "tu-leading-zero",
      category: "team_task_update",
      input: { subject: "Leading-zero ID task" },
      result: { content: "07" }, // invalid JSON (leading zero) but pure digits
    });

    const result = reduceTeamState(state, correlated);

    expect(result!.tasks).toHaveLength(1);
    expect(result!.tasks[0]!.id).toBe("07");
    expect(result!.tasks[0]!.subject).toBe("Leading-zero ID task");
  });

  it("creates task when result content has leading zeros and surrounding whitespace (catch branch, regex true)", () => {
    // " 007 " — JSON.parse throws (leading zeros), trimmed is "007" which matches /^\d+$/.
    // Exercises the .trim() call on line 262 and the TRUE branch of line 263.
    const state = makeTeamState();
    const correlated = makeCorrelated({
      toolName: "TaskCreate",
      toolUseId: "tu-leading-zero-ws",
      category: "team_task_update",
      input: { subject: "Whitespace leading-zero ID task" },
      result: { content: " 007 " }, // invalid JSON, digit-only after trim
    });

    const result = reduceTeamState(state, correlated);

    expect(result!.tasks).toHaveLength(1);
    expect(result!.tasks[0]!.id).toBe("007");
  });

  it("skips task creation when result content is non-JSON and non-numeric (catch branch, regex false)", () => {
    // Content is not valid JSON and is NOT a digit-only string.
    // This hits line 262 (trimmed assignment) and the FALSE branch of line 263,
    // causing extractTaskId to return undefined → state returned unchanged.
    const state = makeTeamState();
    const correlated = makeCorrelated({
      toolName: "TaskCreate",
      toolUseId: "tu-non-numeric",
      category: "team_task_update",
      input: { subject: "Non-numeric non-JSON task" },
      result: { content: "task-created-ok" }, // not JSON, not a number
    });

    const result = reduceTeamState(state, correlated);

    // extractTaskId returns undefined → no task appended
    expect(result!.tasks).toHaveLength(0);
  });

  it("skips task creation when result content is an empty string (catch branch, regex false)", () => {
    // Empty string: JSON.parse("") throws, trimmed is "", /^\d+$/ is false.
    const state = makeTeamState();
    const correlated = makeCorrelated({
      toolName: "TaskCreate",
      toolUseId: "tu-empty",
      category: "team_task_update",
      input: { subject: "Empty content task" },
      result: { content: "" }, // empty string — not JSON, not numeric
    });

    const result = reduceTeamState(state, correlated);

    expect(result!.tasks).toHaveLength(0);
  });
});
